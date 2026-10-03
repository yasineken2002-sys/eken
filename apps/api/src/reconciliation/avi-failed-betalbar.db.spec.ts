/**
 * G15 (FORTNOX-100): en avi vars UTSKICK misslyckades (status FAILED — saknat bankgiro
 * vid aktiveringen, saknad e-post, pdf-fel) är ändå en bokförd fordran (D 1510 / K 39xx, se
 * `avisering.service.ts` sendNotices: "Avierna FINNS och är korrekt bokförda — det är
 * utskicket som uteblir"). Hyresgästens fasta OCR gäller alla hennes avier, så pengarna
 * kommer ofta ändå (stående överföring). Före rättningen kunde varken OCR-matchningen,
 * vattenfallet eller den MANUELLA matchningen reglera en FAILED avi: betalningen blev
 * liggande omatchad och fordran stod kvar i 1510.
 *
 * Proven mäter kundeffekten och att spärrarna står kvar: CANCELLED tar inte emot betalning,
 * en annan organisations avi rörs inte, kreditering räknas in i restskulden, en delbetalning
 * lämnar restskuld, och utskicksfelet (`sendError`) står kvar som spår.
 */
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))

import { randomUUID } from 'node:crypto'

import { PrismaClient, RentNoticeStatus, RentNoticeType } from '@prisma/client'
import { generateOcrNumber } from '@eken/shared'

import { AccountingService } from '../accounting/accounting.service'
import { VerifikationsnummerService } from '../accounting/verifikationsnummer.service'
import { RentNoticeEventsService } from '../avisering/rent-notice-events.service'
import { PaymentFreshnessService } from '../payment-freshness/payment-freshness.service'
import { BankImportAttemptService } from './bank-import-attempt.service'
import { ReconciliationService } from './reconciliation.service'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

const HYRA = 8500
// Vanligaste vägen till FAILED i onboarding: avtalen aktiveras innan bankgirot är inlagt.
const UTSKICKSFEL = 'Bankgiro saknas i organisationens inställningar (syntetiskt utskicksfel)'

function klient(): PrismaClient {
  const u = new URL(process.env.DATABASE_URL as string)
  u.searchParams.set('connection_limit', '5')
  return new PrismaClient({ datasources: { db: { url: u.toString() } } })
}

// BgMax enligt Bankgirots tekniska manual (okt 2023): TK05, TK20 per post, TK15 med betalningsdag.
function bgmax(datum: string, poster: Array<{ ocr: string; belopp: number }>): Buffer {
  const h0 = (v: string | number, n: number) => String(v).padStart(n, '0').slice(-n)
  const tk05 = ('05' + h0('56781230', 10) + ' '.repeat(10) + 'SEK').padEnd(80, ' ')
  const rader = poster.map(({ ocr, belopp }, i) =>
    (
      '20' +
      h0('0', 10) +
      ocr.padStart(25, ' ') +
      h0(Math.round(belopp * 100), 18) +
      '2' +
      '1' +
      h0(i + 1, 12) +
      '0'
    ).padEnd(80, ' '),
  )
  const summa = poster.reduce((s, p) => s + Math.round(p.belopp * 100), 0)
  const tk15 = (
    '15' +
    h0('1234000123456', 35) +
    datum.replace(/-/g, '') +
    h0(1, 5) +
    h0(summa, 18) +
    'SEK' +
    h0(poster.length, 8)
  ).padEnd(80, ' ')
  // Filens ram (tabell 2 och 17): startpost och slutpost med antal betalningar/avdrag/extra/insättningar.
  const tk01 = ('01' + 'BGMAX'.padEnd(20, ' ') + '01' + '20261201080000000000' + 'P').padEnd(
    80,
    ' ',
  )
  const tk70 = ('70' + h0(poster.length, 8) + h0(0, 8) + h0(0, 8) + h0(1, 8)).padEnd(80, ' ')
  return Buffer.from([tk01, tk05, ...rader, tk15, tk70].join('\n'), 'utf8')
}

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: riggen körs mot en RIKTIG databas', () => {
    expect(HAR_DB).toBe(true)
  })
})

medDb('G15: en avi med misslyckat utskick kan regleras av en betalning', () => {
  let prisma: PrismaClient
  let service: ReconciliationService
  let accounting: AccountingService
  const orgar: string[] = []
  let orgId: string
  let annanOrgId: string
  let kontoId: string
  let annatKontoId: string
  let användareId: string
  const sfx = randomUUID().slice(0, 8)
  let ocrSerie = 150000 + Math.floor(Math.random() * 800000)

  type Hyresforhallande = { tenantId: string; leaseId: string; unitId: string; ocr: string }

  async function nyOrg(namn: string): Promise<{ orgId: string; kontoId: string; propId: string }> {
    const org = await prisma.organization.create({
      data: {
        name: `g15-${namn}-${sfx}`,
        email: `g15-${namn}-${sfx}@example.se`,
        street: 'a',
        postalCode: '11111',
        city: 'Stockholm',
        orgNumber: `55${namn === 'a' ? '61' : '62'}${sfx.slice(0, 6)}`,
        fiscalYearStartMonth: 1,
      },
      select: { id: true },
    })
    orgar.push(org.id)
    await prisma.account.createMany({
      data: [
        { organizationId: org.id, number: 1510, name: 'Kundfordringar', type: 'ASSET' },
        { organizationId: org.id, number: 1930, name: 'Bank', type: 'ASSET' },
        { organizationId: org.id, number: 3911, name: 'Hyresintäkter bostad', type: 'REVENUE' },
      ],
    })
    const konto = await prisma.bankAccount.create({
      data: { organizationId: org.id, name: 'Företagskonto', accountNumber: '1234-5678' },
      select: { id: true },
    })
    const prop = await prisma.property.create({
      data: {
        organizationId: org.id,
        name: `p-${namn}-${sfx}`,
        propertyDesignation: `G15 ${namn} ${sfx}`,
        type: 'RESIDENTIAL',
        street: 'a',
        city: 'Stockholm',
        postalCode: '11111',
        totalArea: 100,
      },
      select: { id: true },
    })
    return { orgId: org.id, kontoId: konto.id, propId: prop.id }
  }

  async function hyresforhallande(
    org: string,
    propId: string,
    nr: number,
  ): Promise<Hyresforhallande> {
    const unit = await prisma.unit.create({
      data: {
        propertyId: propId,
        name: `Lgh ${nr}-${sfx}`,
        unitNumber: `${nr}-${sfx}`,
        type: 'APARTMENT',
        rooms: 2,
        area: 55,
        monthlyRent: HYRA,
        status: 'OCCUPIED',
      },
      select: { id: true },
    })
    const tenant = await prisma.tenant.create({
      data: {
        organizationId: org,
        type: 'INDIVIDUAL',
        firstName: `H${nr}`,
        lastName: 'Hyresgäst',
        email: `h${nr}-${sfx}@example.se`,
      },
      select: { id: true },
    })
    const lease = await prisma.lease.create({
      data: {
        organizationId: org,
        unitId: unit.id,
        tenantId: tenant.id,
        contractNumber: `G15-${nr}-${sfx}`,
        monthlyRent: HYRA,
        depositAmount: 0,
        startDate: new Date('2026-01-01'),
        tenancyStartDate: new Date('2026-01-01'),
        status: 'ACTIVE',
      },
      select: { id: true },
    })
    return {
      tenantId: tenant.id,
      leaseId: lease.id,
      unitId: unit.id,
      ocr: generateOcrNumber(ocrSerie++),
    }
  }

  async function avi(
    org: string,
    h: Hyresforhallande,
    månad: number,
    status: RentNoticeStatus,
  ): Promise<string> {
    const n = await prisma.rentNotice.create({
      data: {
        organizationId: org,
        tenantId: h.tenantId,
        leaseId: h.leaseId,
        noticeNumber: `G15-${randomUUID().slice(0, 8)}`,
        ocrNumber: h.ocr,
        month: månad,
        year: 2026,
        amount: HYRA,
        totalAmount: HYRA,
        dueDate: new Date(Date.UTC(2026, månad - 1, 0)),
        status,
        ...(status === 'FAILED' ? { sendError: UTSKICKSFEL } : {}),
        collectionStage: 'NONE',
        type: RentNoticeType.RENT,
      },
      select: { id: true, noticeNumber: true, year: true },
    })
    // Fordran bokförs när avin skapas — oavsett om utskicket sedan lyckas.
    await accounting.createJournalEntryForRentNotice(
      {
        id: n.id,
        noticeNumber: n.noticeNumber,
        amount: HYRA,
        vatAmount: 0,
        totalAmount: HYRA,
        year: n.year,
        month: månad,
        unitId: h.unitId,
      } as never,
      org,
      null,
    )
    return n.id
  }

  const läsAvi = (id: string) =>
    prisma.rentNotice.findUniqueOrThrow({
      where: { id },
      select: { status: true, paidAmount: true, sendError: true },
    })

  async function betalningsverifikat(org: string) {
    const v = await prisma.journalEntry.findMany({
      where: { organizationId: org, source: 'PAYMENT' },
      select: {
        date: true,
        lines: { select: { debit: true, credit: true, account: { select: { number: true } } } },
      },
    })
    return v.map((e) => ({
      datum: e.date.toISOString().slice(0, 10),
      rader: e.lines
        .map((l) => [l.account.number, Number(l.debit ?? 0), Number(l.credit ?? 0)])
        .sort((a, b) => Number(a[0]) - Number(b[0])),
    }))
  }

  beforeAll(async () => {
    prisma = klient()
    accounting = new AccountingService(
      prisma as never,
      new VerifikationsnummerService(prisma as never),
    )
    const a = await nyOrg('a')
    orgId = a.orgId
    kontoId = a.kontoId
    const b = await nyOrg('b')
    annanOrgId = b.orgId
    annatKontoId = b.kontoId
    ;(globalThis as Record<string, unknown>).__g15prop = { a: a.propId, b: b.propId }
    const user = await prisma.user.create({
      data: {
        organizationId: orgId,
        email: `g15-${sfx}@example.se`,
        passwordHash: 'x',
        firstName: 'G',
        lastName: 'Femton',
        role: 'OWNER',
      },
      select: { id: true },
    })
    användareId = user.id

    const mail = { send: async () => undefined, sendToOrgRoles: async () => undefined }
    const kastare = new Proxy(
      {},
      {
        get: () => () => {
          throw new Error('orört beroende anropat')
        },
      },
    )
    service = new ReconciliationService(
      prisma as never,
      kastare as never,
      kastare as never,
      accounting as never,
      new PaymentFreshnessService(prisma as never, mail as never) as never,
      new RentNoticeEventsService(prisma as never) as never,
      { enqueue: async () => 'jobb' } as never,
      {
        skrivFacitMatchad: async () => undefined,
        skrivFacitIngen: async () => undefined,
        nollstallFacit: async () => undefined,
      } as never,
      new BankImportAttemptService(prisma as never),
    )
    Object.assign(service, {
      logger: { log: () => undefined, warn: () => undefined, error: () => undefined },
    })
  })

  afterAll(async () => {
    for (const org of orgar) {
      await prisma.rentNoticePayment.deleteMany({ where: { rentNotice: { organizationId: org } } })
      await prisma.rentNoticeEvent.deleteMany({ where: { rentNotice: { organizationId: org } } })
      await prisma.rentNoticeCredit.deleteMany({ where: { rentNotice: { organizationId: org } } })
      await prisma.journalEntryLine.deleteMany({ where: { journalEntry: { organizationId: org } } })
      await prisma.journalEntry.deleteMany({ where: { organizationId: org } })
      await prisma.bankTransaction.deleteMany({ where: { organizationId: org } })
      await prisma.bankImportAttempt.deleteMany({ where: { organizationId: org } })
      await prisma.rentNotice.deleteMany({ where: { organizationId: org } })
      await prisma.bankStatementImport.deleteMany({ where: { organizationId: org } })
      await prisma.lease.deleteMany({ where: { organizationId: org } })
      await prisma.tenant.deleteMany({ where: { organizationId: org } })
      await prisma.unit.deleteMany({ where: { property: { organizationId: org } } })
      await prisma.property.deleteMany({ where: { organizationId: org } })
      await prisma.account.deleteMany({ where: { organizationId: org } })
      await prisma.journalEntrySequence.deleteMany({ where: { organizationId: org } })
      await prisma.user.deleteMany({ where: { organizationId: org } })
      await prisma.bankAccount.deleteMany({ where: { organizationId: org } })
      await prisma.organization.deleteMany({ where: { id: org } })
    }
    await prisma.$disconnect()
  })

  const prop = (k: 'a' | 'b') =>
    ((globalThis as Record<string, unknown>).__g15prop as Record<string, string>)[k]!

  it('OCR-betalning reglerar en FAILED avi: PAID, verifikat 1930/1510 på betalningsdagen, utskicksfelet står kvar', async () => {
    const h = await hyresforhallande(orgId, prop('a'), 1)
    const id = await avi(orgId, h, 11, 'FAILED')
    const r = await service.importBgMaxFile(
      bgmax('2026-11-02', [{ ocr: h.ocr, belopp: HYRA }]),
      'g15-1.txt',
      orgId,
      kontoId,
    )
    expect(r.autoMatched).toBe(1)
    const a = await läsAvi(id)
    expect(a.status).toBe('PAID')
    expect(Number(a.paidAmount)).toBe(HYRA)
    expect(a.sendError).toBe(UTSKICKSFEL)
    expect(await betalningsverifikat(orgId)).toEqual([
      {
        datum: '2026-11-02',
        rader: [
          [1510, 0, HYRA],
          [1930, HYRA, 0],
        ],
      },
    ])
  })

  it('delbetalning på FAILED avi lämnar restskuld; nästa betalning reglerar resten', async () => {
    const h = await hyresforhallande(orgId, prop('a'), 2)
    const id = await avi(orgId, h, 11, 'FAILED')
    await service.importBgMaxFile(
      bgmax('2026-11-02', [{ ocr: h.ocr, belopp: 3000 }]),
      'g15-2a.txt',
      orgId,
      kontoId,
    )
    let a = await läsAvi(id)
    expect(a.status).toBe('FAILED')
    expect(Number(a.paidAmount)).toBe(3000)
    await service.importBgMaxFile(
      bgmax('2026-11-09', [{ ocr: h.ocr, belopp: HYRA - 3000 }]),
      'g15-2b.txt',
      orgId,
      kontoId,
    )
    a = await läsAvi(id)
    expect(a.status).toBe('PAID')
    expect(Number(a.paidAmount)).toBe(HYRA)
  })

  it('klumpbetalning över två FAILED avier fördelas i åldersordning (vattenfallet)', async () => {
    const h = await hyresforhallande(orgId, prop('a'), 3)
    const nov = await avi(orgId, h, 11, 'FAILED')
    const dec = await avi(orgId, h, 12, 'FAILED')
    const r = await service.importBgMaxFile(
      bgmax('2026-11-30', [{ ocr: h.ocr, belopp: 2 * HYRA }]),
      'g15-3.txt',
      orgId,
      kontoId,
    )
    expect(r.autoMatched).toBe(1)
    expect((await läsAvi(nov)).status).toBe('PAID')
    expect((await läsAvi(dec)).status).toBe('PAID')
  })

  it('manuell matchning mot en FAILED avi går igenom och bär användaren', async () => {
    const h = await hyresforhallande(orgId, prop('a'), 4)
    const id = await avi(orgId, h, 11, 'FAILED')
    // Betalning utan OCR (bankens fritext) står omatchad → människan väljer avin.
    const tx2 = await prisma.bankTransaction.create({
      data: {
        organizationId: orgId,
        bankAccountId: kontoId,
        date: new Date('2026-11-03'),
        amount: HYRA,
        description: 'Insättning',
        status: 'UNMATCHED',
      },
      select: { id: true },
    })
    await service.manualMatch(tx2.id, { rentNoticeId: id }, orgId, användareId)
    expect((await läsAvi(id)).status).toBe('PAID')
    const t = await prisma.bankTransaction.findUniqueOrThrow({
      where: { id: tx2.id },
      select: { status: true, matchedBy: true, matchedRentNoticeId: true },
    })
    expect(t).toEqual({ status: 'MATCHED', matchedBy: användareId, matchedRentNoticeId: id })
  })

  it('kreditering räknas in: FAILED avi med 1 000 kr kredit regleras av 7 500 kr', async () => {
    const h = await hyresforhallande(orgId, prop('a'), 5)
    const id = await avi(orgId, h, 11, 'FAILED')
    await prisma.rentNoticeCredit.create({
      data: {
        organizationId: orgId,
        rentNoticeId: id,
        amount: 1000,
        reason: 'G15 synt kredit',
        creditedAt: new Date('2026-11-01'),
        createdById: användareId,
      },
    })
    await service.importBgMaxFile(
      bgmax('2026-11-02', [{ ocr: h.ocr, belopp: HYRA - 1000 }]),
      'g15-5.txt',
      orgId,
      kontoId,
    )
    expect((await läsAvi(id)).status).toBe('PAID')
  })

  it('SPÄRR: en makulerad (CANCELLED) avi tar inte emot betalning — raden blir omatchad', async () => {
    const h = await hyresforhallande(orgId, prop('a'), 6)
    const id = await avi(orgId, h, 11, 'CANCELLED')
    const r = await service.importBgMaxFile(
      bgmax('2026-11-02', [{ ocr: h.ocr, belopp: HYRA }]),
      'g15-6.txt',
      orgId,
      kontoId,
    )
    expect(r.autoMatched).toBe(0)
    expect((await läsAvi(id)).status).toBe('CANCELLED')
  })

  it('SPÄRR: en annan organisations FAILED avi rörs inte av samma OCR', async () => {
    const h = await hyresforhallande(annanOrgId, prop('b'), 7)
    const främmande = await avi(annanOrgId, h, 11, 'FAILED')
    const r = await service.importBgMaxFile(
      bgmax('2026-11-02', [{ ocr: h.ocr, belopp: HYRA }]),
      'g15-7.txt',
      orgId,
      kontoId,
    )
    expect(r.autoMatched).toBe(0)
    expect((await läsAvi(främmande)).status).toBe('FAILED')
    expect(annatKontoId).toBeTruthy()
  })

  it('avmatchning av en reglerad, aldrig skickad avi återställer FAILED (inte SENT) och lämnar spår', async () => {
    const h = await hyresforhallande(orgId, prop('a'), 8)
    const id = await avi(orgId, h, 11, 'FAILED')
    await service.importBgMaxFile(
      bgmax('2026-11-02', [{ ocr: h.ocr, belopp: HYRA }]),
      'g15-8.txt',
      orgId,
      kontoId,
    )
    expect((await läsAvi(id)).status).toBe('PAID')
    const tx = await prisma.bankTransaction.findFirstOrThrow({
      where: { organizationId: orgId, matchedRentNoticeId: id },
      select: { id: true },
    })
    await service.unmatchTransaction(tx.id, orgId, användareId, 'G15: fel avi')
    const a = await läsAvi(id)
    expect(a.status).toBe('FAILED')
    expect(a.sendError).toBe(UTSKICKSFEL)
    expect(a.paidAmount).toBeNull()
    const händelser = await prisma.rentNoticeEvent.count({ where: { rentNoticeId: id } })
    expect(händelser).toBeGreaterThanOrEqual(2)
  })

  // G15-012 (C2 MOTPROV-G15-012): återöppnad status härleds ur leveransfakta.
  it.each([
    ['PENDING utan utskick', 'PENDING' as const, null, 'PENDING'],
    ['verkligt skickad', 'SENT' as const, new Date('2026-10-28T08:00:00Z'), 'SENT'],
  ])('avmatchning: %s → %s', async (_namn, start, sentAt, väntad) => {
    const h = await hyresforhallande(orgId, prop('a'), start === 'PENDING' ? 9 : 10)
    const id = await avi(orgId, h, 11, start)
    if (sentAt) await prisma.rentNotice.update({ where: { id }, data: { sentAt } })
    await service.importBgMaxFile(
      bgmax('2026-11-02', [{ ocr: h.ocr, belopp: HYRA }]),
      `g15-012-${start}.txt`,
      orgId,
      kontoId,
    )
    expect((await läsAvi(id)).status).toBe('PAID')
    const tx = await prisma.bankTransaction.findFirstOrThrow({
      where: { organizationId: orgId, matchedRentNoticeId: id },
      select: { id: true },
    })
    await service.unmatchTransaction(tx.id, orgId, användareId, 'G15-012: fel avi vald')
    const a = await prisma.rentNotice.findUniqueOrThrow({
      where: { id },
      select: { status: true, sentAt: true },
    })
    expect(a.status).toBe(väntad)
    expect(a.sentAt?.toISOString() ?? null).toBe(sentAt?.toISOString() ?? null)
  })

  // ── G20 (FORTNOX-100, BYGGLEDARE-EFFEKT-015): VERKLIG tidsgräns i matchningen ──────
  // Verifikatskrivningen inne i matchningens transaktion fördröjs EN gång förbi
  // PAYMENT_TX_LIMITS (8 s) — Prisma avbryter och rullar tillbaka på riktigt.
  it('G20: tidsgräns ger läsbart besked, ingen allokering/verifikat; uttrycklig matchning sedan exakt en gång', async () => {
    const h = await hyresforhallande(orgId, prop('a'), 11)
    const id = await avi(orgId, h, 11, 'SENT')
    const original = accounting.createJournalEntryForRentNoticePayment.bind(accounting)
    const spion = jest
      .spyOn(accounting, 'createJournalEntryForRentNoticePayment')
      .mockImplementationOnce(async (...args: Parameters<typeof original>) => {
        await new Promise((r) => setTimeout(r, 9_000))
        return original(...args)
      })
    const r = await service.importBgMaxFile(
      bgmax('2026-11-02', [{ ocr: h.ocr, belopp: HYRA }]),
      'g20.txt',
      orgId,
      kontoId,
    )
    spion.mockRestore()
    expect(r.autoMatched).toBe(0)
    expect(r.unmatched).toBe(1)
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0]).toMatch(
      /importerades men kunde inte matchas automatiskt.*innan något bokfördes.*Matcha alla/,
    )
    expect(r.errors[0]).not.toMatch(/Transaction|Prisma|8000 ms/)
    const tx = await prisma.bankTransaction.findFirstOrThrow({
      where: { organizationId: orgId, rawOcr: h.ocr },
      select: { id: true, status: true },
    })
    expect(tx.status).toBe('UNMATCHED')
    expect(await prisma.rentNoticePayment.count({ where: { rentNoticeId: id } })).toBe(0)
    expect((await läsAvi(id)).status).toBe('SENT')
    // Uttrycklig matchning efteråt: samma låsta väg, exakt en allokering och ett verifikat.
    await service.manualMatch(tx.id, { rentNoticeId: id }, orgId, användareId)
    expect(await prisma.rentNoticePayment.count({ where: { rentNoticeId: id } })).toBe(1)
    expect((await läsAvi(id)).status).toBe('PAID')
    const allok = await prisma.rentNoticePayment.findFirstOrThrow({
      where: { rentNoticeId: id },
      select: { id: true },
    })
    expect(
      await prisma.journalEntry.count({
        where: { organizationId: orgId, sourceId: { contains: allok.id } },
      }),
    ).toBe(1)
  }, 60_000)
})
