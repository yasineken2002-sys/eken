// Importkedjan ReconciliationService → InvoicesService → PdfService →
// StorageService drar in @aws-sdk/client-s3, som publicerar ESM jest inte
// transformerar. Mocken stoppar kedjan vid BIBLIOTEKET — inte vid koden som
// mäts. Samma grepp som backup.service.spec.ts.
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {},
  PutObjectCommand: class {},
  DeleteObjectCommand: class {},
  GetObjectCommand: class {},
}))
jest.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: async () => '' }))

/**
 * VATTENFALLET MOT RIKTIG POSTGRES — de fyra formerna, hela vägen till kontot.
 *
 * ── VAD DEN HÄR ÄGER SOM DEN MOCKADE INTE KAN SE ────────────────────────────
 *
 * `waterfall-allocation.spec.ts` är helt mockad och står kvar: den är snabb och
 * äger formlogiken (ordningen, toleransen, same-tenant-invarianten). Men en
 * attrapp returnerar det den blivit tillsagd att returnera oavsett `where`, så
 * den kan per konstruktion inte se:
 *
 *   • att `where`/`orderBy` i kandidatfrågan faktiskt väljer rätt rader
 *   • att `FOR UPDATE`-låsen går att ta i den ordningen
 *   • att bokföringen blir av, och blir 1930 D / 1510 K per allokering
 *   • att `hasReceivableAccrual` släpper igenom — en avi utan bokförd fordran
 *     får INTE betalas (fail-closed mot spökkredit på 1510)
 *
 * Det sista är inte teoretiskt: riggen byggdes först utan accrual-verifikat och
 * varje fall kastade. Ett mockat prov hade varit grönt.
 *
 * ── VAD DEN HÄR INTE KAN SE ─────────────────────────────────────────────────
 *
 * Samtidighet. Låsen tas här av EN körning; att svält uteblir under last mäts av
 * `waterfall-lock-order.concurrency.spec.ts`, som äger den frågan.
 *
 * ── FÖRUTSÄTTNINGARNA ÄR RIGGENS EGNA ───────────────────────────────────────
 *
 * Ingen `findFirst` mot befintlig data. CI:s databas är tom, och ett prov som
 * lånar omgivningens rader mäter omgivningen. Id:n bär en körningsstämpel så två
 * samtidiga körningar inte kan ta varandras rader.
 */
import { PrismaClient, Prisma } from '@prisma/client'
import { ReconciliationService } from './reconciliation.service'
import { AccountingService } from '../accounting/accounting.service'
import { VerifikationsnummerService } from '../accounting/verifikationsnummer.service'
import { RentNoticeEventsService } from '../avisering/rent-notice-events.service'
import type { PrismaService } from '../common/prisma/prisma.service'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

const KORNING = `wf-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
const ORG = `${KORNING}-org`
const PROPERTY = `${ORG}-p`

/**
 * VARJE FALL FÅR EGEN HYRESGÄST, EGEN ENHET, EGET AVTAL OCH EGET OCR.
 *
 * Inte kosmetik. Kandidatfrågan väljer på OCR-STRÄNGEN, så delade fallen
 * hyresgäst skulle ett tidigare falls kvarvarande öppna avi bli kandidat i ett
 * senare — och utfallet bero på körordningen. Uppmätt när riggen byggdes: fall 4
 * matchade fall 2:s delbetalda avi och drog in vattenfallet som aldrig skulle
 * körts. Ett prov vars svar beror på vad ett annat prov lämnade efter sig mäter
 * inte det det påstår.
 *
 * Egen enhet per fall behövs dessutom för `lease_unit_active_unique` (ett aktivt
 * avtal per enhet), och egen månadsserie faller bort helt när avtalet är eget —
 * `@@unique([leaseId, year, month, type])` gäller per avtal.
 */
interface Fallfixtur {
  tenant: string
  unit: string
  lease: string
  ocr: string
}

/** Två avier: 5 000 (förfaller först) och 7 000. Total skuld 12 000. */
const AVI_A = 5000
const AVI_B = 7000

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot en RIKTIG databas', () => {
    expect(HAR_DB).toBe(true)
  })
})

medDb('vattenfallet mot riktig Postgres', () => {
  let prisma: PrismaClient
  let service: ReconciliationService
  let kontoFordran = ''
  let kontoIntakt = ''
  // Riggens egna accrual-verifikat får inte krocka med
  // VerifikationsnummerService, som allokerar från 1.
  let verLopnummer = 9000

  beforeAll(async () => {
    prisma = new PrismaClient()
    const p = prisma as unknown as PrismaService
    // Riktig Prisma, riktig bokföring. Stubben kastar om vattenfallsvägen skulle
    // röra fakturagrenen — en tyst returnerad `undefined` hade dolt det.
    const stub = (namn: string) =>
      new Proxy(
        {},
        {
          get: (_t, prop) => () => {
            throw new Error(
              `OVÄNTAT ANROP: ${namn}.${String(prop)} — vattenfallsvägen rör den inte`,
            )
          },
        },
      )
    service = new ReconciliationService(
      p,
      stub('InvoicesService') as never,
      stub('InvoiceEventsService') as never,
      new AccountingService(p, new VerifikationsnummerService(p)),
      { markPaymentDataThrough: async () => undefined } as never,
      new RentNoticeEventsService(p),
    )

    await prisma.organization.create({
      data: {
        id: ORG,
        name: 'Vattenfallsriggen AB',
        email: `${KORNING}@example.invalid`,
        street: 'Gatan 1',
        city: 'Staden',
        postalCode: '12345',
      },
    })
    await prisma.property.create({
      data: {
        id: PROPERTY,
        organizationId: ORG,
        name: 'Riggfastigheten',
        propertyDesignation: `${KORNING}-1:1`,
        type: 'RESIDENTIAL',
        street: 'Gatan 1',
        city: 'Staden',
        postalCode: '12345',
        totalArea: new Prisma.Decimal('100'),
      },
    })
    for (const [number, name, type] of [
      [1930, 'Företagskonto', 'ASSET'],
      [1510, 'Kundfordringar', 'ASSET'],
      [3011, 'Hyresintäkter bostäder', 'REVENUE'],
    ] as const) {
      const konto = await prisma.account.create({
        data: { organizationId: ORG, number, name, type },
      })
      if (number === 1510) kontoFordran = konto.id
      if (number === 3011) kontoIntakt = konto.id
    }
  })

  afterAll(async () => {
    // FK-riktning, barn före förälder. Varje steg är villkorslöst och tål att
    // beforeAll föll halvvägs — deleteMany på en tom mängd är en no-op, och
    // JournalEntrySequence måste med (den FK:n fällde städningen en gång).
    if (!prisma) return
    try {
      await prisma.$executeRawUnsafe(
        `DELETE FROM "JournalEntryLine" WHERE "journalEntryId" IN (SELECT id FROM "JournalEntry" WHERE "organizationId" = $1)`,
        ORG,
      )
      await prisma.journalEntry.deleteMany({ where: { organizationId: ORG } })
      await prisma.journalEntrySequence.deleteMany({ where: { organizationId: ORG } })
      await prisma.rentNoticePayment.deleteMany({ where: { rentNotice: { organizationId: ORG } } })
      await prisma.rentNoticeEvent.deleteMany({ where: { rentNotice: { organizationId: ORG } } })
      await prisma.rentNotice.deleteMany({ where: { organizationId: ORG } })
      await prisma.bankTransaction.deleteMany({ where: { organizationId: ORG } })
      await prisma.account.deleteMany({ where: { organizationId: ORG } })
      await prisma.lease.deleteMany({ where: { organizationId: ORG } })
      await prisma.unit.deleteMany({ where: { propertyId: PROPERTY } })
      await prisma.property.deleteMany({ where: { organizationId: ORG } })
      await prisma.tenant.deleteMany({ where: { organizationId: ORG } })
      await prisma.organization.deleteMany({ where: { id: ORG } })
    } finally {
      await prisma.$disconnect()
    }
  })

  /**
   * Två öppna avier med bokförd fordran.
   *
   * Accrual-verifikatet är inte pynt: `hasReceivableAccrual` nekar
   * betalningsbokningen fail-closed utan det, eftersom en 1510-kredit då saknar
   * motsvarande debet. Nyckeln är produktionens egen — `source: 'INVOICE'`,
   * `sourceId: 'rent-notice:<id>'`.
   */
  /** Hyresgäst + enhet + avtal + OCR, allt eget för fallet. */
  async function riggaFall(prefix: string, ocrSuffix: number): Promise<Fallfixtur> {
    const f: Fallfixtur = {
      tenant: `${ORG}-${prefix}-t`,
      unit: `${ORG}-${prefix}-u`,
      lease: `${ORG}-${prefix}-l`,
      ocr: `7770000${String(1000 + ocrSuffix)}`,
    }
    await prisma.tenant.create({
      data: {
        id: f.tenant,
        organizationId: ORG,
        type: 'INDIVIDUAL',
        firstName: 'Vatten',
        lastName: prefix,
        email: `${KORNING}-${prefix}@example.invalid`,
        ocrNumber: f.ocr,
      },
    })
    await prisma.unit.create({
      data: {
        id: f.unit,
        propertyId: PROPERTY,
        name: `Lgh ${prefix}`,
        unitNumber: `${prefix}-1001`,
        type: 'APARTMENT',
        area: new Prisma.Decimal('50'),
        monthlyRent: new Prisma.Decimal(String(AVI_A)),
      },
    })
    await prisma.lease.create({
      data: {
        id: f.lease,
        organizationId: ORG,
        unitId: f.unit,
        tenantId: f.tenant,
        startDate: new Date('2026-01-01'),
        tenancyStartDate: new Date('2026-01-01'),
        monthlyRent: new Prisma.Decimal(String(AVI_A)),
        depositAmount: new Prisma.Decimal('0'),
      },
    })
    return f
  }

  async function riggaTvaAvier(prefix: string, f: Fallfixtur): Promise<{ a: string; b: string }> {
    const skapa = async (
      suffix: string,
      status: 'OVERDUE' | 'SENT',
      manad: number,
      forfaller: string,
      belopp: number,
    ) => {
      const avi = await prisma.rentNotice.create({
        data: {
          organizationId: ORG,
          tenantId: f.tenant,
          leaseId: f.lease,
          noticeNumber: `${prefix}-${suffix}`,
          ocrNumber: f.ocr,
          type: 'RENT',
          status,
          month: manad,
          year: 2026,
          dueDate: new Date(forfaller),
          amount: new Prisma.Decimal(String(belopp)),
          totalAmount: new Prisma.Decimal(String(belopp)),
        },
      })
      await prisma.journalEntry.create({
        data: {
          organizationId: ORG,
          date: new Date('2026-01-01'),
          fiscalYear: 2026,
          verNumber: verLopnummer++,
          description: 'Hyresintäkt (riggens bokförda fordran)',
          source: 'INVOICE',
          sourceId: `rent-notice:${avi.id}`,
          lines: {
            create: [
              {
                accountId: kontoFordran,
                debit: new Prisma.Decimal(String(belopp)),
                credit: new Prisma.Decimal('0'),
                description: 'Kundfordran',
              },
              {
                accountId: kontoIntakt,
                debit: new Prisma.Decimal('0'),
                credit: new Prisma.Decimal(String(belopp)),
                description: 'Hyresintäkt',
              },
            ],
          },
        },
      })
      return avi.id
    }
    return {
      a: await skapa('A', 'OVERDUE', 1, '2026-01-27', AVI_A),
      b: await skapa('B', 'SENT', 2, '2026-02-27', AVI_B),
    }
  }

  async function skapaTransaktion(belopp: string, ocr: string): Promise<string> {
    const tx = await prisma.bankTransaction.create({
      data: {
        organizationId: ORG,
        date: new Date('2026-03-01'),
        amount: new Prisma.Decimal(belopp),
        description: 'Inbetalning',
        rawOcr: ocr,
        status: 'UNMATCHED',
      },
    })
    return tx.id
  }

  async function kor(txId: string): Promise<boolean> {
    const rad = await prisma.bankTransaction.findUniqueOrThrow({ where: { id: txId } })
    return service.matchTransaction(rad as never, ORG)
  }

  /** Allokeringar per avinummer, i allokeringsordning. */
  async function allokeringar(txId: string) {
    const rader = await prisma.rentNoticePayment.findMany({
      where: { bankTransactionId: txId },
      orderBy: { createdAt: 'asc' },
      include: { rentNotice: { select: { noticeNumber: true } } },
    })
    return rader.map((r) => ({
      avi: r.rentNotice.noticeNumber,
      belopp: r.amount.toString(),
      id: r.id,
    }))
  }

  /**
   * Betalverifikaten för DE HÄR allokeringarna.
   *
   * NYCKELN ÄR MÄTT, INTE GISSAD. Bankvägen använder `bankPaymentSourceId`
   * (accounting.service.ts:311) → `rent-notice-bank-payment:<allocationId>`.
   * Det RÅA allokerings-id:t gav 0 träffar, och `rent-notice-payment:` — den
   * MANUELLA vägens nyckel — gav också 0. Två sonder som inte kunde ge något
   * annat än noll. Fel prefix här gör provet grönt av fel skäl.
   */
  async function betalverifikat(allocIds: string[]) {
    return prisma.journalEntry.findMany({
      where: {
        organizationId: ORG,
        source: 'PAYMENT',
        sourceId: { in: allocIds.map((id) => `rent-notice-bank-payment:${id}`) },
      },
      include: {
        lines: {
          orderBy: { debit: 'desc' },
          select: { debit: true, credit: true, account: { select: { number: true } } },
        },
      },
    })
  }

  async function avistatus(ids: string[]) {
    const rader = await prisma.rentNotice.findMany({
      where: { id: { in: ids } },
      orderBy: { dueDate: 'asc' },
      select: { noticeNumber: true, status: true, paidAmount: true },
    })
    return rader.map((r) => ({
      avi: r.noticeNumber,
      status: r.status,
      betalt: r.paidAmount?.toString() ?? '0',
    }))
  }

  it('FALL 1 — exakt summan av två avier → båda PAID, ett verifikat per allokering', async () => {
    const f = await riggaFall('F1', 1)
    const { a, b } = await riggaTvaAvier('F1', f)
    const txId = await skapaTransaktion('12000', f.ocr)

    expect(await kor(txId)).toBe(true)

    const tx = await prisma.bankTransaction.findUniqueOrThrow({ where: { id: txId } })
    expect(tx.status).toBe('MATCHED')
    // Spegeln pekar på den ÄLDSTA avin — den betalningen började på.
    expect(tx.matchedRentNoticeId).toBe(a)

    const alloc = await allokeringar(txId)
    expect(alloc.map(({ avi, belopp }) => ({ avi, belopp }))).toEqual([
      { avi: 'F1-A', belopp: '5000' },
      { avi: 'F1-B', belopp: '7000' },
    ])

    expect(await avistatus([a, b])).toEqual([
      { avi: 'F1-A', status: 'PAID', betalt: '5000' },
      { avi: 'F1-B', status: 'PAID', betalt: '7000' },
    ])

    const verifikat = await betalverifikat(alloc.map((x) => x.id))
    expect(verifikat).toHaveLength(2)
    for (const v of verifikat) {
      const konton = v.lines.map((l) => ({
        konto: l.account.number,
        debet: l.debit?.toString() ?? '0',
        kredit: l.credit?.toString() ?? '0',
      }))
      // 1930 D / 1510 K, och beloppet är DENNA allokerings del.
      expect(konton).toHaveLength(2)
      expect(konton.find((k) => k.konto === 1930)?.debet).toMatch(/^(5000|7000)$/)
      expect(konton.find((k) => k.konto === 1510)?.kredit).toBe(
        konton.find((k) => k.konto === 1930)?.debet,
      )
    }
  })

  it('FALL 2 — en och en halv avi → PAID + PARTIAL, verifikat på delbeloppet', async () => {
    const f = await riggaFall('F2', 2)
    const { a, b } = await riggaTvaAvier('F2', f)
    const txId = await skapaTransaktion('8500', f.ocr)

    expect(await kor(txId)).toBe(true)
    expect((await prisma.bankTransaction.findUniqueOrThrow({ where: { id: txId } })).status).toBe(
      'MATCHED',
    )

    const alloc = await allokeringar(txId)
    expect(alloc.map(({ avi, belopp }) => ({ avi, belopp }))).toEqual([
      { avi: 'F2-A', belopp: '5000' },
      { avi: 'F2-B', belopp: '3500' },
    ])

    // Den andra avin är DELBETALD: status oförändrad, paidAmount satt.
    expect(await avistatus([a, b])).toEqual([
      { avi: 'F2-A', status: 'PAID', betalt: '5000' },
      { avi: 'F2-B', status: 'SENT', betalt: '3500' },
    ])

    const verifikat = await betalverifikat(alloc.map((x) => x.id))
    expect(verifikat).toHaveLength(2)
    const bokfordaBelopp = verifikat
      .map((v) => v.lines.find((l) => l.account.number === 1930)?.debit?.toString())
      .sort()
    // 3 500 — inte 7 000. Verifikatet bär allokeringen, inte avins totalbelopp.
    expect(bokfordaBelopp).toEqual(['3500', '5000'])
  })

  it('FALL 3 — överstiger hela skulden → UNMATCHED, NOLL allokeringar, NOLL verifikat', async () => {
    const f = await riggaFall('F3', 3)
    const { a, b } = await riggaTvaAvier('F3', f)
    const txId = await skapaTransaktion('15000', f.ocr)
    // Ordningsoberoende: mät FÖRE och EFTER i stället för att anta ett tal från
    // föregående fall.
    const verifikatFore = await prisma.journalEntry.count({
      where: { organizationId: ORG, source: 'PAYMENT' },
    })

    expect(await kor(txId)).toBe(false)

    const tx = await prisma.bankTransaction.findUniqueOrThrow({ where: { id: txId } })
    expect(tx.status).toBe('UNMATCHED')
    expect(tx.matchedRentNoticeId).toBeNull()

    expect(await allokeringar(txId)).toEqual([])
    // Avierna är ORÖRDA — inte delbetalda, inte nollställda i kravtrappan.
    expect(await avistatus([a, b])).toEqual([
      { avi: 'F3-A', status: 'OVERDUE', betalt: '0' },
      { avi: 'F3-B', status: 'SENT', betalt: '0' },
    ])
    // INGA NYA betalverifikat — avvisningen bokför ingenting.
    expect(
      await prisma.journalEntry.count({ where: { organizationId: ORG, source: 'PAYMENT' } }),
    ).toBe(verifikatFore)
  })

  it('FALL 4 — mindre än äldsta avin → ENSKILDVÄGEN tar det, vattenfallet anropas ALDRIG', async () => {
    const f = await riggaFall('F4', 4)
    const { a, b } = await riggaTvaAvier('F4', f)
    const txId = await skapaTransaktion('3000', f.ocr)

    // Att utfallet blir rätt räcker inte som belägg för VEM som gjorde det:
    // en enda allokering är också vad vattenfallet skulle lämna om det bröt mot
    // sitt eget `allokerade < 2`-villkor. Spionen svarar på frågan direkt.
    const vattenfall = jest.spyOn(
      service as unknown as {
        applyWaterfallToRentNotices: (...args: unknown[]) => Promise<boolean>
      },
      'applyWaterfallToRentNotices',
    )

    expect(await kor(txId)).toBe(true)
    expect(vattenfall).not.toHaveBeenCalled()
    vattenfall.mockRestore()

    const alloc = await allokeringar(txId)
    expect(alloc.map(({ avi, belopp }) => ({ avi, belopp }))).toEqual([
      { avi: 'F4-A', belopp: '3000' },
    ])
    // Delbetalning: äldsta avin behåller OVERDUE, den yngre är orörd.
    expect(await avistatus([a, b])).toEqual([
      { avi: 'F4-A', status: 'OVERDUE', betalt: '3000' },
      { avi: 'F4-B', status: 'SENT', betalt: '0' },
    ])

    const verifikat = await betalverifikat(alloc.map((x) => x.id))
    expect(verifikat).toHaveLength(1)
    expect(verifikat[0]!.lines.find((l) => l.account.number === 1930)?.debit?.toString()).toBe(
      '3000',
    )
    expect(verifikat[0]!.lines.find((l) => l.account.number === 1510)?.credit?.toString()).toBe(
      '3000',
    )
  })
})
