/**
 * KREDITNOTAN MOT RIKTIG POSTGRES — och det RIKTADE SPÄRRPARET.
 *
 * ── VARFÖR FILEN FINNS VID SIDAN AV DE TRE MOCKADE SPECARNA ─────────────────
 *
 * `credit-note.spec.ts`, `credit-note-debt.spec.ts` och `credit-note-guard.spec.ts`
 * täcker samma flöde — men alla tre kör mot ATTRAPP (uppmätt: noll riktiga
 * `PrismaClient`). En attrapp returnerar det den blev tillsagd att returnera
 * oavsett `where`, och kan därför inte pröva tre saker som är hela frågan här:
 *
 *   1. att `@@unique([organizationId, source, sourceId])` verkligen skiljer
 *      `<invoiceId>`, `credit-note:<id>` och `entry-reversal:<id>` åt
 *   2. vad SALDOT på 1510 och 39xx blir efter en SEKVENS av operationer
 *   3. att en spärr som slår upp rader (kreditnotor, `reversedBy`) fäller på
 *      det den påstår, och inte på att attrappen svarade ja
 *
 * Punkt 2 är kärnan. Varje verifikat balanserar för sig; felet uppstår först
 * när två poster i SKILDA namnrymder bokar bort samma belopp. Ett prov som
 * bara kräver "kastade" ser inte det — därför assertar varje fall nedan
 * BÅDA saldona, inte bara utfallet.
 *
 * ── VAD DEN HÄR FILEN INTE KAN SE ───────────────────────────────────────────
 *
 * Den mäter SEKVENSER, en operation i taget, i en process. Den kan inte se:
 *
 *   • SAMTIDIGHET. `reverseJournalEntry` tar inget radlås på fakturan och
 *     skriver först i `createReversalEntry`, som öppnar sin egen transaktion.
 *     En kreditnota som skapas mellan grindens läsning och rättelsens commit
 *     passerar. Fönstret är asymmetriskt — `createCreditNote` läser innanför
 *     `FOR UPDATE` och ser en committad rättelse — och att stänga det ägs av
 *     ett eget ärende, inte av den här filen.
 *   • UI:t. `ReverseEntryModal` härleder "redan rättat" ur `reversedBy` och
 *     känner inte till kreditnotor; knappen erbjuds alltså fortfarande och
 *     felet syns först vid klick. Ägs av web, inte av den här filen.
 *   • Den BETALDA vägen. Kreditering av en betald faktura är spärrad och
 *     väntar på kontobeslutet i #535. Fall 3 nedan mäter att spärren FINNS,
 *     inte hur den betalda vägen ska bokföras.
 *
 * ── RIGGEN LÅNAR INGENTING ──────────────────────────────────────────────────
 *
 * Egen org, egen hyresgäst, egen användare, egen kontoplan via produktionens
 * `seedDefaultAccounts`. `afterEach` nollställer mellan fallen, `afterAll`
 * städar i FK-riktning och BEVISAR att inget står kvar.
 *
 * ── POOLEN ÄR SATT EXPLICIT (samma skäl som #695) ───────────────────────────
 *
 * Prismas pool är `num_physical_cpus × 2 + 1` när `connection_limit` inte är
 * satt — 5 på utvecklingsmaskinen (nproc 2), ~97 i produktionscontainern
 * (nproc 48). Filen är inte en samtidighetsrigg, men en pool som varierar med
 * runnerns kärnantal gör en eventuell `P2028` omöjlig att tolka. Klienten får
 * därför en egen URL med `connection_limit`, och `beforeAll` assertar den.
 */
import { randomUUID } from 'node:crypto'

import { ConflictException } from '@nestjs/common'
import { PrismaClient, Prisma, UserRole } from '@prisma/client'

import { AccountingService } from '../accounting/accounting.service'
import { VerifikationsnummerService } from '../accounting/verifikationsnummer.service'
import { CreditNoteService } from './credit-note.service'
import { InvoiceEventsService } from './invoice-events.service'
import { InvoicesService } from './invoices.service'
import { computeInvoiceAmounts } from './invoice-amounts'
import { computeInvoiceDebt } from './invoice-debt'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

/** Se poolstycket i huvudet. Litet och explicit — inget beror på nproc. */
const POOL = 5

function urlMedPool(bas: string, pool: number): string {
  const u = new URL(bas)
  u.searchParams.set('connection_limit', String(pool))
  return u.toString()
}

/** En rad: 8 000 kr netto @ 25 % → 10 000 kr brutto. Talen räknas av KODEN. */
const RADER = [{ description: 'Hyra oktober', quantity: 1, unitPrice: 8_000, vatRate: 25 }]
const BELOPP = computeInvoiceAmounts(RADER)

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot en RIKTIG databas', () => {
    expect(HAR_DB).toBe(true)
  })
})

medDb('kreditnota mot riktig Postgres — sekvensen, inte verifikatet', () => {
  let prisma: PrismaClient
  let accounting: AccountingService
  let credit: CreditNoteService
  let invoices: InvoicesService
  let orgId: string
  let tenantId: string
  let aktorId: string

  /** Skapar en BOKFÖRD faktura via produktionens verifikatväg. */
  async function bokfordFaktura() {
    const inv = await prisma.invoice.create({
      data: {
        organizationId: orgId,
        tenantId,
        invoiceNumber: `F-${randomUUID().slice(0, 8)}`,
        type: 'RENT',
        issueDate: new Date('2026-10-01'),
        dueDate: new Date('2026-10-31'),
        subtotal: BELOPP.subtotal,
        vatTotal: BELOPP.vatTotal,
        total: BELOPP.total,
        status: 'SENT',
        lines: {
          createMany: {
            data: BELOPP.lines.map((l) => ({
              description: l.description,
              quantity: l.quantity,
              unitPrice: l.unitPrice,
              vatRate: l.vatRate,
              total: l.total,
            })),
          },
        },
      },
      include: { lines: true },
    })
    await accounting.createJournalEntryForInvoice(inv, orgId, aktorId)
    return inv
  }

  /**
   * Saldon per kontogrupp, härledda ur konteringsraderna — inte ur ett tal som
   * skrivits en andra gång i provet. Debet positivt, kredit negativt, så en
   * kundfordran är positiv och en intäkt negativ.
   */
  async function saldon(): Promise<{ kundfordran: string; intakt: string }> {
    const rader = await prisma.journalEntryLine.findMany({
      where: { journalEntry: { organizationId: orgId } },
      include: { account: { select: { number: true } } },
    })
    const per = new Map<number, Prisma.Decimal>()
    for (const r of rader) {
      const d = new Prisma.Decimal(r.debit ?? 0).minus(r.credit ?? 0)
      per.set(r.account.number, (per.get(r.account.number) ?? new Prisma.Decimal(0)).plus(d))
    }
    const intakt = [...per.keys()]
      .filter((n) => n >= 3900 && n < 4000)
      .reduce((s, n) => s.plus(per.get(n)!), new Prisma.Decimal(0))
    return {
      kundfordran: (per.get(1510) ?? new Prisma.Decimal(0)).toFixed(2),
      intakt: intakt.toFixed(2),
    }
  }

  /** Verifikatens namnrymder, i nummerordning. */
  async function namnrymder(): Promise<string[]> {
    const v = await prisma.journalEntry.findMany({
      where: { organizationId: orgId },
      orderBy: { verNumber: 'asc' },
      select: { source: true, sourceId: true },
    })
    return v.map((x) => `${x.source}:${(x.sourceId ?? '—').replace(/[0-9a-f-]{36}/i, '<id>')}`)
  }

  const dto = (belopp: number, radId: string) => ({
    reason: 'Mätning',
    lines: [{ invoiceLineId: radId, quantity: 1, unitPrice: belopp }],
  })

  /** Fakturans EGET verifikat (utan namnrymdsprefix). */
  const eget = (invoiceId: string) =>
    prisma.journalEntry.findFirstOrThrow({
      where: { organizationId: orgId, source: 'INVOICE', sourceId: invoiceId },
      select: { id: true },
    })

  const rattaVerifikat = (entryId: string) =>
    accounting.reverseJournalEntry({
      entryId,
      organizationId: orgId,
      actorRole: UserRole.OWNER,
      actorUserId: aktorId,
      reason: 'Rättelse i mätriggen',
    })

  beforeAll(async () => {
    prisma = new PrismaClient({
      datasources: { db: { url: urlMedPool(process.env.DATABASE_URL as string, POOL) } },
    })
    // Poolen är en FÖRUTSÄTTNING, inte en detalj — se huvudet.
    const url = new URL(
      (prisma as unknown as { _engineConfig?: { overrideDatasources?: { db?: { url?: string } } } })
        ._engineConfig?.overrideDatasources?.db?.url ??
        urlMedPool(process.env.DATABASE_URL as string, POOL),
    )
    expect(url.searchParams.get('connection_limit')).toBe(String(POOL))

    const verif = Object.create(VerifikationsnummerService.prototype) as VerifikationsnummerService
    Object.assign(verif, { prisma })
    accounting = Object.create(AccountingService.prototype) as AccountingService
    Object.assign(accounting, { prisma, verifikationsnummer: verif })
    const events = Object.create(InvoiceEventsService.prototype) as InvoiceEventsService
    Object.assign(events, { prisma })
    credit = Object.create(CreditNoteService.prototype) as CreditNoteService
    Object.assign(credit, { prisma, eventsService: events, accountingService: accounting })
    invoices = Object.create(InvoicesService.prototype) as InvoicesService
    Object.assign(invoices, { prisma, eventsService: events, accountingService: accounting })

    const sfx = randomUUID().slice(0, 8)
    const org = await prisma.organization.create({
      data: {
        name: `kn-${sfx}`,
        email: `kn-${sfx}@example.se`,
        street: 'a',
        city: 'b',
        postalCode: '11111',
      },
      select: { id: true },
    })
    orgId = org.id
    await accounting.seedDefaultAccounts(orgId)
    const t = await prisma.tenant.create({
      data: { organizationId: orgId, type: 'INDIVIDUAL', email: `kn-t-${sfx}@example.se` },
      select: { id: true },
    })
    tenantId = t.id
    // `JournalEntry.createdById` har en FK mot User. Riggen skapar sin egen —
    // att låna en användare ur omgivningen vore att låna förutsättningen.
    const u = await prisma.user.create({
      data: {
        organizationId: orgId,
        email: `kn-u-${sfx}@example.se`,
        firstName: 'Mät',
        lastName: 'Ning',
        role: UserRole.OWNER,
      },
      select: { id: true },
    })
    aktorId = u.id
  })

  afterEach(async () => {
    // FK-riktning: konteringsrader före verifikat, kreditnotor före original.
    await prisma.journalEntryLine.deleteMany({
      where: { journalEntry: { organizationId: orgId } },
    })
    await prisma.journalEntry.deleteMany({ where: { organizationId: orgId } })
    await prisma.invoiceEvent.deleteMany({ where: { invoice: { organizationId: orgId } } })
    await prisma.invoiceLine.deleteMany({ where: { invoice: { organizationId: orgId } } })
    await prisma.invoice.deleteMany({ where: { organizationId: orgId, isCreditNote: true } })
    await prisma.invoice.deleteMany({ where: { organizationId: orgId } })
  })

  afterAll(async () => {
    await prisma.account.deleteMany({ where: { organizationId: orgId } })
    // Sekvenstabellerna pekar på Organization med Restrict, inte Cascade.
    await prisma.journalEntrySequence.deleteMany({ where: { organizationId: orgId } })
    await prisma.invoiceNumberSequence.deleteMany({ where: { organizationId: orgId } })
    await prisma.tenantOcrSequence.deleteMany({ where: { organizationId: orgId } })
    await prisma.user.deleteMany({ where: { organizationId: orgId } })
    await prisma.tenant.deleteMany({ where: { organizationId: orgId } })
    await prisma.organization.delete({ where: { id: orgId } })
    await prisma.$disconnect()
  })

  // ── DE FALL SOM REDAN FUNGERAR ────────────────────────────────────────────

  it('FALL 1 — full kreditering nollar fordran OCH intäkten', async () => {
    const inv = await bokfordFaktura()
    const r = await credit.createCreditNote(inv.id, orgId, aktorId, dto(8_000, inv.lines[0]!.id))

    expect(r.creditedInvoice.outstanding).toBe(0)
    expect(await namnrymder()).toEqual(['INVOICE:<id>', 'INVOICE:credit-note:<id>'])
    expect(await saldon()).toEqual({ kundfordran: '0.00', intakt: '0.00' })
  })

  it('FALL 2 — delkreditering sänker BÅDA med exakt det krediterade', async () => {
    const inv = await bokfordFaktura()
    const r = await credit.createCreditNote(inv.id, orgId, aktorId, dto(2_400, inv.lines[0]!.id))

    expect(r.creditedInvoice.outstanding).toBe(7_000)
    // 10 000 − 3 000 = 7 000 kvar på 1510; 8 000 − 2 400 = 5 600 intäkt kvar.
    expect(await saldon()).toEqual({ kundfordran: '7000.00', intakt: '-5600.00' })
  })

  it('FALL 3 — kreditering av redan fullt krediterad nekas, saldona orörda', async () => {
    const inv = await bokfordFaktura()
    await credit.createCreditNote(inv.id, orgId, aktorId, dto(8_000, inv.lines[0]!.id))
    const fore = await saldon()

    await expect(
      credit.createCreditNote(inv.id, orgId, aktorId, dto(8_000, inv.lines[0]!.id)),
    ).rejects.toThrow(/redan fullt krediterad/)

    expect(await saldon()).toEqual(fore)
    expect((await namnrymder()).length).toBe(2)
  })

  it('FALL 4 — kreditering av MAKULERAD faktura nekas (#517)', async () => {
    const inv = await bokfordFaktura()
    await invoices.transitionStatus(inv.id, orgId, 'VOID', aktorId, 'USER')
    const fore = await saldon()
    expect(await namnrymder()).toEqual(['INVOICE:<id>', 'INVOICE:invoice-reversal:<id>'])

    await expect(
      credit.createCreditNote(inv.id, orgId, aktorId, dto(8_000, inv.lines[0]!.id)),
    ).rejects.toThrow(/redan reverserad/)

    expect(await saldon()).toEqual(fore)
    expect(fore).toEqual({ kundfordran: '0.00', intakt: '0.00' })
  })

  it('FALL 5 — MAKULERING av krediterad faktura nekas (#518-riktningen)', async () => {
    const inv = await bokfordFaktura()
    await credit.createCreditNote(inv.id, orgId, aktorId, dto(2_400, inv.lines[0]!.id))
    const fore = await saldon()

    await expect(invoices.transitionStatus(inv.id, orgId, 'VOID', aktorId, 'USER')).rejects.toThrow(
      /redan har en kreditnota/,
    )

    // Utan spärren: 1510 = −3 000 och 39xx = +2 400. Assertionen är därför inte
    // "kastade" utan att saldona står KVAR på delkrediteringens värden.
    expect(await saldon()).toEqual(fore)
    expect(fore).toEqual({ kundfordran: '7000.00', intakt: '-5600.00' })
  })

  it('FALL 6 — kredit över restbeloppet nekas av RADTAKET', async () => {
    const inv = await bokfordFaktura()
    const fore = await saldon()

    await expect(
      credit.createCreditNote(inv.id, orgId, aktorId, dto(9_000, inv.lines[0]!.id)),
    ).rejects.toThrow(/återstår att kreditera på den raden/)

    expect(await saldon()).toEqual(fore)
    expect(fore).toEqual({ kundfordran: '10000.00', intakt: '-8000.00' })
  })

  it('FALL 7 — computeInvoiceDebt och huvudboken säger samma sak', async () => {
    const inv = await bokfordFaktura()
    await credit.createCreditNote(inv.id, orgId, aktorId, dto(2_400, inv.lines[0]!.id))

    const full = await prisma.invoice.findUniqueOrThrow({
      where: { id: inv.id },
      include: { payments: { select: { amount: true } }, creditNotes: { select: { total: true } } },
    })
    const skuld = computeInvoiceDebt({
      total: full.total,
      allocations: full.payments.map((p) => p.amount),
      credits: full.creditNotes.map((c) => c.total),
    })

    expect(skuld.outstanding.toFixed(2)).toBe((await saldon()).kundfordran)
  })

  // ── DET RIKTADE PARET: BÅDA RIKTNINGARNA ──────────────────────────────────
  //
  // De två fallen nedan var RÖDA före den här ändringen. Fall 8 gav en negativ
  // kundfordran på −10 000 och en reverserad intäkt på +8 000; fall 9 gav
  // detsamma med operationerna i omvänd ordning. Att bara bygga den ena
  // riktningen är samma hål sett från andra hållet.

  it('FALL 8 — operatörsrättelse av ett KREDITERAT fakturaverifikat nekas', async () => {
    const inv = await bokfordFaktura()
    await credit.createCreditNote(inv.id, orgId, aktorId, dto(8_000, inv.lines[0]!.id))
    const fore = await saldon()
    const post = await eget(inv.id)

    await expect(rattaVerifikat(post.id)).rejects.toBeInstanceOf(ConflictException)
    await expect(rattaVerifikat(post.id)).rejects.toThrow(/redan krediterad med kreditnota/)

    // UTAN spärren blev det här −10 000 / +8 000. Assertionen på SALDOT är det
    // som skiljer "spärren finns" från "spärren gör det den finns för".
    expect(await saldon()).toEqual(fore)
    expect(fore).toEqual({ kundfordran: '0.00', intakt: '0.00' })
    expect((await namnrymder()).length).toBe(2)
  })

  it('FALL 8b — spärren gäller även DELKREDITERING, inte bara full', async () => {
    const inv = await bokfordFaktura()
    await credit.createCreditNote(inv.id, orgId, aktorId, dto(2_400, inv.lines[0]!.id))
    const post = await eget(inv.id)

    await expect(rattaVerifikat(post.id)).rejects.toThrow(/redan krediterad/)
    expect(await saldon()).toEqual({ kundfordran: '7000.00', intakt: '-5600.00' })
  })

  it('FALL 8c — DISKRIMINERANDE: utan kreditnota går rättelsen igenom som förut', async () => {
    const inv = await bokfordFaktura()
    const post = await eget(inv.id)

    await expect(rattaVerifikat(post.id)).resolves.toBeDefined()

    // Rättelsen vänder fakturan — det är hela poängen med att den går igenom.
    expect(await saldon()).toEqual({ kundfordran: '0.00', intakt: '0.00' })
    expect(await namnrymder()).toEqual(['INVOICE:<id>', 'MANUAL:entry-reversal:<id>'])
  })

  it('FALL 9 — kreditering av en faktura vars verifikat RÄTTATS nekas', async () => {
    const inv = await bokfordFaktura()
    const post = await eget(inv.id)
    await rattaVerifikat(post.id)
    const fore = await saldon()

    await expect(
      credit.createCreditNote(inv.id, orgId, aktorId, dto(8_000, inv.lines[0]!.id)),
    ).rejects.toThrow(/verifikat är redan rättat/)

    expect(await saldon()).toEqual(fore)
    expect(fore).toEqual({ kundfordran: '0.00', intakt: '0.00' })
    expect((await namnrymder()).length).toBe(2)
  })

  it('FALL 9b — gränssnittet får SAMMA besked som API:et (getPreview)', async () => {
    const inv = await bokfordFaktura()
    const post = await eget(inv.id)
    await rattaVerifikat(post.id)

    const preview = await credit.getPreview(inv.id, orgId)

    // Två uppsättningar regler hade glidit isär; `assessCreditability` är EN
    // källa, och det här provet är det som håller den så.
    expect(preview.allowed).toBe(false)
    expect(preview.blockedReason).toMatch(/verifikat är redan rättat/)
  })
})
