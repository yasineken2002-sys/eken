import { randomUUID } from 'node:crypto'
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { arBelagdInnehallsavvisning, vatFromGross } from '@eken/shared'
import { PrismaService } from '../common/prisma/prisma.service'
import { PAYMENT_TX_LIMITS } from '../common/prisma/transaction-limits'
import { originalUtfall } from '../fortnox/fortnox-radklass'
import { AccountingService } from './accounting.service'
import { provaMomsval, type LeverantorsMomsval } from './manual-entry'
import {
  isOverdue,
  paymentLegNumber,
  paymentLegSourceId,
  paymentUndoSourceId,
  receiptSourceId,
  supplierInvoiceStatus,
  vatAdjustmentSourceId,
  type SupplierInvoiceStatus,
} from './supplier-invoice-status'

/** TESTKUND-041: rollerna för leverantörsfakturans skrivvägar (samma som pay/cancel, G5.1). */
const SKRIVROLLER = ['OWNER', 'ADMIN', 'ACCOUNTANT']

type Tx = Prisma.TransactionClient

/** Ett betalningsled (BP1 §2) med sin eventuella ångring och båda exporternas läge. */
export interface Betalningsled {
  k: number
  journalEntry: {
    id: string
    series: string
    verNumber: number
    date: Date
    description: string
    sourceId: string | null
    lines: Array<{
      accountId: string
      debit: Prisma.Decimal | null
      credit: Prisma.Decimal | null
      description: string | null
      account: { number: number }
    }>
  }
  angring: {
    id: string
    series: string
    verNumber: number
    description: string
    sourceId: string | null
  } | null
  export: { state: string; lastOutcome: string | null; sendAttemptId: string | null } | null
  angringExport: { state: string; lastOutcome: string | null } | null
}

/**
 * LEVERANTÖRSFAKTUROR — registret, och de två bokföringsstegen.
 *
 * ── ORDNINGEN ÄR LASTBÄRANDE ────────────────────────────────────────────────
 *
 * Raden skrivs FÖRST, verifikatet sedan, båda i samma transaktion. Skälet är att
 * verifikatets idempotensnyckel härleds ur radens id — utan raden finns ingen
 * nyckel, och en nyckel som hittas på (en uuid per anrop) är ingen nyckel alls:
 * ett omtag hade gett två verifikat för samma faktura.
 *
 * Kastar bokföringen rullas raden tillbaka. Det är rätt håll: en faktura i
 * registret utan verifikat i huvudboken är en skuld som inte syns i
 * balansräkningen, och det är värre än ett fel användaren kan göra om.
 *
 * ── STATUS ÄR BERÄKNAT ──────────────────────────────────────────────────────
 *
 * Ingen `status`-kolumn. Se `supplier-invoice-status.ts`.
 */
@Injectable()
export class SupplierInvoiceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accounting: AccountingService,
  ) {}

  /**
   * Registrera en MOTTAGEN leverantörsfaktura och bokför steg 1.
   *
   * `totalAmount` är BRUTTO — det som ska lämna bankkontot. `vatAmount` bryts UT
   * ur det, inte till. Nettot räknas här och lagras som snapshot; frontend
   * räknar aldrig om det.
   */
  async create(params: {
    organizationId: string
    createdById: string
    supplierName: string
    invoiceNumber?: string | undefined
    description: string
    invoiceDate: Date
    dueDate: Date
    expenseAccount: number
    totalAmount: number
    vatRate: number
    /** Utelämnas → servern räknar. Skickas → måste stämma med serverns tal. */
    vatAmount?: number | undefined
    attachmentUrl?: string | undefined
    /**
     * TESTKUND-041 (B-1): kundens UTTRYCKLIGA momsval ur formuläret. Positiv moms utan val nekas
     * före effekt; ingen standard (vatRate 25 ger aldrig moms utan val).
     */
    vatTreatment?: LeverantorsMomsval | null | undefined
    /** Var valet gjordes (t.ex. HTTP_FORMULAR). Sparas som beslutsproveniens. */
    vatTreatmentSource?: string | undefined
  }) {
    // FRAMTIDA FAKTURADATUM är nästan alltid en felskrivning (fel år), och
    // konsekvensen är att kostnaden hamnar i en period som ännu inte finns —
    // osynlig i årets resultat tills någon undrar var den tog vägen. En dags
    // marginal, eftersom fakturadatumet är leverantörens och tidszonen vår.
    const imorgon = new Date(Date.now() + 24 * 60 * 60 * 1000)
    if (params.invoiceDate.getTime() > imorgon.getTime()) {
      throw new UnprocessableEntityException(
        'Fakturadatum kan inte ligga i framtiden. Kontrollera årtalet.',
      )
    }
    if (params.dueDate.getTime() < params.invoiceDate.getTime()) {
      throw new UnprocessableEntityException('Förfallodatum kan inte ligga före fakturadatum.')
    }
    // ── MOMSEN RÄKNAS HÄR, INTE I WEBBLÄSAREN ──────────────────────────────
    //
    // `vatRate` LAGRAS på raden medan `vatAmount` BOKFÖRS. Kom de från olika
    // uträkningar kunde registret säga 25 % om ett verifikat som bokfört noll,
    // och den motsägelsen hade legat kvar i databasen — inte bara i ett svar.
    // Serverns tal är därför facit, och ett inskickat belopp godtas bara om det
    // stämmer med det.
    const beraknad = vatFromGross(params.totalAmount, params.vatRate)
    const vatAmount = params.vatAmount ?? beraknad

    // TOLERANSEN är ett öre, och den finns för avrundningsriktningen — inte för
    // att släppa igenom "ungefär rätt". 1250 kr med 25 % ger 250,00; formeln
    // belopp × sats/100 hade gett 312,50 och fälls här, vilket är hela poängen:
    // det felet BALANSERAR i verifikatet och syns ingen annanstans.
    if (Math.abs(vatAmount - beraknad) > 0.01) {
      throw new UnprocessableEntityException(
        `Momsbeloppet ${vatAmount.toFixed(2)} kr stämmer inte med ${params.vatRate} % av ${params.totalAmount.toFixed(2)} kr inkl. moms (${beraknad.toFixed(2)} kr). Kontrollera momssatsen — beloppet ska anges INKLUSIVE moms.`,
      )
    }
    if (vatAmount > params.totalAmount) {
      throw new UnprocessableEntityException(
        'Momsen kan inte vara större än beloppet — beloppet ska vara inklusive moms.',
      )
    }

    const momsfel = provaMomsval(vatAmount, params.vatTreatment ?? null)
    if (momsfel) throw new BadRequestException(momsfel)
    const val = params.vatTreatment ?? null

    const netAmount = params.totalAmount - vatAmount

    return this.prisma.$transaction(async (tx) => {
      const faktura = await tx.supplierInvoice.create({
        data: {
          organizationId: params.organizationId,
          createdById: params.createdById,
          supplierName: params.supplierName,
          ...(params.invoiceNumber ? { invoiceNumber: params.invoiceNumber } : {}),
          description: params.description,
          invoiceDate: params.invoiceDate,
          dueDate: params.dueDate,
          expenseAccount: params.expenseAccount,
          netAmount,
          vatRate: params.vatRate,
          vatAmount,
          totalAmount: params.totalAmount,
          ...(params.attachmentUrl ? { attachmentUrl: params.attachmentUrl } : {}),
          ...(val
            ? {
                vatTreatment: val,
                vatTreatmentCurrent: val,
                vatTreatmentDecidedById: params.createdById,
                vatTreatmentDecidedAt: new Date(),
                vatTreatmentDecisionSource: params.vatTreatmentSource ?? 'TJANST',
              }
            : {}),
        },
      })

      // Verifikatet i SAMMA transaktion. `tx` skickas in, så en kastad
      // bokföring rullar tillbaka registerraden — anroparen äger rollbacken,
      // vilket är precis vad createNumberedEntrys docblock föreskriver.
      await this.accounting.bookSupplierInvoiceReceipt({
        organizationId: params.organizationId,
        invoiceId: faktura.id,
        date: params.invoiceDate,
        supplierName: params.supplierName,
        description: params.description,
        expenseAccount: params.expenseAccount,
        totalAmount: params.totalAmount,
        vatAmount,
        momsval: val,
        createdById: params.createdById,
        ...(params.attachmentUrl ? { attachmentUrl: params.attachmentUrl } : {}),
        tx,
      })

      return faktura
      // PAYMENT_TX_LIMITS: samma band som fakturabetalning och bankavstämning.
      // Transaktionen allokerar ett verifikationsnummer under radlås och skriver
      // verifikatet — samma sorts arbete, alltså samma gräns, inte Prismas
      // defaults någon råkade ärva.
    }, PAYMENT_TX_LIMITS)
  }

  /**
   * Markera som betald och bokför steg 2.
   *
   * `paidAt` sätts i SAMMA transaktion som betalningsverifikatet. Det är hela
   * kopplingen mellan det beräknade tillståndet och huvudboken: fältet kan inte
   * vara satt utan att verifikatet finns.
   */
  async markPaid(params: {
    organizationId: string
    invoiceId: string
    paidDate: Date
    createdById: string
  }) {
    const faktura = await this.findOne(params.invoiceId, params.organizationId)

    if (faktura.paidAt) {
      throw new UnprocessableEntityException('Fakturan är redan markerad som betald.')
    }
    if (faktura.cancelledAt) {
      throw new UnprocessableEntityException(
        'Fakturan är makulerad och kan inte betalas. Registrera en ny faktura om den ändå ska betalas.',
      )
    }

    return this.prisma.$transaction(async (tx) => {
      // TESTKUND-041 (BP1 P-1, låsordning faktura → export): fakturans radlås först. Under låset
      // räknas betalningsleden fram; ett nytt led efter en ångring får en EGEN sourceId (led k ≥ 2)
      // och ett historiskt id skrivs aldrig om.
      await this.lasFaktura(tx, faktura.id, params.organizationId)
      const nu = await tx.supplierInvoice.findFirstOrThrow({
        where: { id: faktura.id, organizationId: params.organizationId },
      })
      if (nu.paidAt || nu.cancelledAt)
        throw new ConflictException(
          'Fakturan har just betalats eller makulerats av någon annan — uppdatera sidan. Ingen betalning bokades.',
        )
      const { led } = await this.betalningsled(tx, faktura.id, params.organizationId, nu)
      const legSourceId = paymentLegSourceId(faktura.id, led.length + 1)
      // TESTKUND-027 V-9: villkorat anspråk FÖRE bokningen. Förkontrollen ovan läses utanför
      // transaktionen; en samtidig makulering kan ha committat sedan dess. Bara en av betalning
      // och makulering kan vinna radlåset — den andra får count 0 och 409, utan någon bokning.
      const claim = await tx.supplierInvoice.updateMany({
        where: {
          id: faktura.id,
          organizationId: params.organizationId,
          paidAt: null,
          cancelledAt: null,
        },
        data: { paidAt: params.paidDate },
      })
      if (claim.count !== 1)
        throw new ConflictException(
          'Fakturan har just betalats eller makulerats av någon annan — uppdatera sidan. Ingen betalning bokades.',
        )
      await this.accounting.bookSupplierInvoicePayment({
        organizationId: params.organizationId,
        invoiceId: faktura.id,
        paidDate: params.paidDate,
        supplierName: faktura.supplierName,
        totalAmount: Number(faktura.totalAmount),
        createdById: params.createdById,
        sourceId: legSourceId,
        tx,
      })

      return tx.supplierInvoice.findUniqueOrThrow({ where: { id: faktura.id } })
    }, PAYMENT_TX_LIMITS)
  }

  /**
   * Makulera en OBETALD faktura — och VÄND VERIFIKATET.
   *
   * Att bara sätta `cancelledAt` hade gjort makuleringen till en ren flagga som
   * SÄGER EMOT huvudboken: listan hade visat "Makulerad" medan kostnaden låg
   * kvar i resultatet och skulden kvar på 2440. Ett tillstånd som inte går att
   * härleda ur verifikaten är precis det kodbasen inte får ha (CLAUDE.md:
   * "Skuld är ett beräknat tillstånd, aldrig en flagga").
   *
   * Motverifikatet skrivs i SAMMA transaktion som flaggan, av samma skäl som i
   * `create` och `markPaid`: fältet kan inte vara satt utan att verifikatet
   * finns.
   *
   * Fakturan RADERAS inte. En bokförd affärshändelse ska gå att följa i
   * efterhand (BFL 5 kap) — både mottagningen och rättelsen ligger kvar i
   * journalen.
   */
  async cancel(params: { organizationId: string; invoiceId: string; createdById: string }) {
    const faktura = await this.findOne(params.invoiceId, params.organizationId)
    this.accounting.assertMayCancelSupplierInvoice(faktura)

    // Rättelsedagen, inte fakturadagen. Se bookSupplierInvoiceCancellation.
    const idag = new Date()

    return this.prisma.$transaction(async (tx) => {
      await this.lasFaktura(tx, faktura.id, params.organizationId)
      await this.provaMakuleringskedjor(tx, faktura.id, params.organizationId)
      // TESTKUND-027 V-9: villkorat anspråk FÖRE bokningen (se markPaid).
      const claim = await tx.supplierInvoice.updateMany({
        where: {
          id: faktura.id,
          organizationId: params.organizationId,
          paidAt: null,
          cancelledAt: null,
        },
        data: { cancelledAt: idag },
      })
      if (claim.count !== 1)
        throw new ConflictException(
          'Fakturan har just betalats eller makulerats av någon annan — uppdatera sidan. Ingen makulering bokades.',
        )
      const makulering = await this.accounting.bookSupplierInvoiceCancellation({
        organizationId: params.organizationId,
        invoiceId: faktura.id,
        date: idag,
        supplierName: faktura.supplierName,
        description: faktura.description,
        expenseAccount: faktura.expenseAccount,
        totalAmount: Number(faktura.totalAmount),
        vatAmount: Number(faktura.vatAmount),
        // TESTKUND-041: makuleringen speglar mottagningen ur URSPRUNGLIGT val (MK-1).
        momsval: faktura.vatTreatment,
        createdById: params.createdById,
        tx,
      })

      // TESTKUND-027 V-9 / L3: makuleringen ska vara EXAKT originalverifikatets rader omvända.
      // Har fakturans data ändrats efter mottagandet stoppar vi hellre än bokar nya rader.
      const original = await tx.journalEntry.findFirst({
        where: {
          organizationId: params.organizationId,
          source: 'SUPPLIER_INVOICE',
          sourceId: `supplier-invoice:${faktura.id}`,
        },
        select: { id: true, lines: { select: { accountId: true, debit: true, credit: true } } },
      })
      const ore = (d: Prisma.Decimal | null) => (d === null ? 0 : Math.round(Number(d) * 100))
      const nyckel = (
        l: { accountId: string; debit: Prisma.Decimal | null; credit: Prisma.Decimal | null },
        vand: boolean,
      ) =>
        `${l.accountId}|${vand ? ore(l.credit) : ore(l.debit)}|${vand ? ore(l.debit) : ore(l.credit)}`
      const mak = await tx.journalEntry.findUniqueOrThrow({
        where: { id: makulering.id },
        select: { lines: { select: { accountId: true, debit: true, credit: true } } },
      })
      if (
        !original ||
        JSON.stringify(original.lines.map((l) => nyckel(l, true)).sort()) !==
          JSON.stringify(mak.lines.map((l) => nyckel(l, false)).sort())
      )
        throw new ConflictException(
          'Makuleringen motsvarar inte det bokförda mottagandet (fakturans uppgifter har ändrats) — ' +
            'ingen makulering bokades. Kontakta supporten.',
        )
      // TESTKUND-027 V-7(b): makuleringen går inte via createReversalEntry; samma villkorade spärr
      // av originalets färdiga Fortnox-export ligger därför här, i samma transaktion.
      await tx.fortnoxVoucherExport.updateMany({
        where: {
          organizationId: params.organizationId,
          journalEntryId: original.id,
          state: 'DRY_RUN_READY',
        },
        data: {
          state: 'BLOCKED',
          draft: Prisma.DbNull,
          draftHash: null,
          blockReason:
            'REVERSED_BEFORE_EXPORT: Leverantörsfakturan makulerades innan den exporterades — varken ' +
            'fakturan eller makuleringen skickas till Fortnox; de tar ut varandra i Eveno',
        },
      })
      return tx.supplierInvoice.findUniqueOrThrow({ where: { id: faktura.id } })
    }, PAYMENT_TX_LIMITS)
  }

  // ── TESTKUND-041: GEMENSAMMA PRIMITIVER ────────────────────────────────────────────────────

  /**
   * Fakturans radlås. EN låsordning för pay, cancel, momsjustering och ångra: fakturaraden först,
   * därefter eventuella exportrader. Ingen av vägarna låser i omvänd ordning (ingen deadlock).
   */
  private async lasFaktura(tx: Tx, id: string, organizationId: string): Promise<void> {
    const rad = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "SupplierInvoice" WHERE id = ${id} AND "organizationId" = ${organizationId} FOR UPDATE`
    if (rad.length !== 1) throw new NotFoundException('Leverantörsfakturan hittades inte')
  }

  /**
   * BP1 §2: betalningsleden räknade ur verifikaten (ingen kolumn, ingen backfill), med invarianten
   * «paidAt satt ⇔ exakt ett gällande led». Oklar äldre proveniens → 409 utan effekt.
   */
  async betalningsled(
    db: Tx,
    invoiceId: string,
    organizationId: string,
    faktura: { paidAt: Date | null; totalAmount: Prisma.Decimal; cancelledAt: Date | null },
  ): Promise<{ led: Betalningsled[]; gallande: Betalningsled | null }> {
    const verifikat = await db.journalEntry.findMany({
      where: {
        organizationId,
        source: 'SUPPLIER_INVOICE',
        sourceId: { startsWith: `supplier-invoice-payment:${invoiceId}` },
      },
      select: {
        id: true,
        series: true,
        verNumber: true,
        date: true,
        description: true,
        sourceId: true,
        lines: {
          select: {
            accountId: true,
            debit: true,
            credit: true,
            description: true,
            account: { select: { number: true } },
          },
        },
        reversedBy: {
          select: { id: true, series: true, verNumber: true, description: true, sourceId: true },
        },
      },
    })
    const oklar = (skal: string) =>
      new ConflictException(
        `Fakturans betalningshistorik är oklar (${skal}) — ingenting ändrades. Kontakta supporten.`,
      )
    const led: Betalningsled[] = []
    for (const v of verifikat) {
      const k = paymentLegNumber(v.sourceId, invoiceId)
      if (k === null) continue
      const skuld = v.lines.find((l) => l.account.number === 2440 && l.debit !== null)
      if (
        !skuld ||
        Math.round(Number(skuld.debit) * 100) !== Math.round(Number(faktura.totalAmount) * 100)
      )
        throw oklar(`betalningen ${v.series}${v.verNumber} har inte fakturans belopp på 2440`)
      if (v.reversedBy && v.reversedBy.sourceId !== paymentUndoSourceId(v.id))
        throw oklar(
          `betalningen ${v.series}${v.verNumber} är rättad på annat sätt än via «Ångra betalning»`,
        )
      const [ex, angEx] = await Promise.all([
        db.fortnoxVoucherExport.findFirst({
          where: { organizationId, journalEntryId: v.id },
          select: { state: true, lastOutcome: true, sendAttemptId: true },
        }),
        v.reversedBy
          ? db.fortnoxVoucherExport.findFirst({
              where: { organizationId, journalEntryId: v.reversedBy.id },
              select: { state: true, lastOutcome: true },
            })
          : Promise.resolve(null),
      ])
      const { reversedBy, ...je } = v
      led.push({ k, journalEntry: je, angring: reversedBy, export: ex, angringExport: angEx })
    }
    led.sort((a, b) => a.k - b.k)
    if (led.some((l, i) => l.k !== i + 1)) throw oklar('betalningsleden är inte i följd')
    const oangrade = led.filter((l) => !l.angring)
    if (oangrade.length > 1) throw oklar('fler än en betalning är oångrad')
    if (faktura.paidAt && oangrade.length !== 1)
      throw oklar('fakturan är markerad betald utan betalningsverifikat')
    if (!faktura.paidAt && oangrade.length !== 0)
      throw oklar('en oångrad betalning finns men fakturan är inte markerad betald')
    return { led, gallande: oangrade[0] ?? null }
  }

  /** Är exportläget «avslutat» för ett led eller dess ångring (BP1 C-1)? */
  private static avslutat(l: Betalningsled): boolean {
    const ex = l.export
    const aldrigSkickat =
      !ex || (ex.sendAttemptId === null && (ex.state === 'DRY_RUN_READY' || ex.state === 'BLOCKED'))
    if (aldrigSkickat) return !!l.angring
    return !!l.angring && ex.state === 'CONFIRMED' && l.angringExport?.state === 'CONFIRMED'
  }

  /**
   * MK1-036 + BP1 C-1, under fakturalåset: makulering tillåts bara (i) utan momsjusteringar, eller
   * (ii) när ALLA justeringar är CONFIRMED och gällande val = ursprungligt; och bara när varje
   * betalningsled är avslutat. Annars 409 före effekt.
   */
  private async provaMakuleringskedjor(tx: Tx, invoiceId: string, organizationId: string) {
    const f = await tx.supplierInvoice.findFirstOrThrow({
      where: { id: invoiceId, organizationId },
    })
    const just = await tx.supplierInvoiceVatAdjustment.findMany({
      where: { supplierInvoiceId: invoiceId, organizationId },
      select: { journalEntryId: true },
    })
    if (just.length > 0) {
      const ex = await tx.fortnoxVoucherExport.findMany({
        where: { organizationId, journalEntryId: { in: just.map((j) => j.journalEntryId) } },
        select: { journalEntryId: true, state: true },
      })
      const alla = just.every(
        (j) => ex.find((e) => e.journalEntryId === j.journalEntryId)?.state === 'CONFIRMED',
      )
      if (!alla || f.vatTreatmentCurrent !== f.vatTreatment)
        throw new ConflictException(
          'Fakturan har momsjusteringar som inte är återställda eller avstämda. Gör en justering ' +
            'tillbaka till ursprungligt val och vänta tills den är exporterad, eller stäm av okänt utfall först.',
        )
    }
    const { led } = await this.betalningsled(tx, invoiceId, organizationId, f)
    if (led.some((l) => !SupplierInvoiceService.avslutat(l)))
      throw new ConflictException(
        'Fakturan har en betalningsregistrering vars ångring inte är avslutad i Fortnox — ' +
          'vänta tills ångringen är exporterad (eller stäm av okänt utfall) innan fakturan makuleras.',
      )
  }

  // ── TESTKUND-041 (MJ-1..MJ-11, MJ-4 v2): KÄLLBUNDEN MOMSJUSTERING HELT ↔ INGET ───────────────

  async adjustVat(params: {
    organizationId: string
    invoiceId: string
    user: { sub: string; role: string }
    till: unknown
    date: Date
    reason: unknown
    clientKey: unknown
  }) {
    if (!SKRIVROLLER.includes(params.user.role))
      throw new ForbiddenException('Du saknar behörighet att justera momsbehandlingen')
    const reason = typeof params.reason === 'string' ? params.reason.trim() : ''
    if (reason.length < 5 || reason.length > 500)
      throw new BadRequestException('Ange ett skäl (5–500 tecken)')
    if (params.till !== 'HELT_AVDRAG' && params.till !== 'INGET_AVDRAG')
      throw new BadRequestException(
        'Bara byte mellan «Moms dras av» och «Moms dras inte av» stöds; momsbeloppet ändras inte här.',
      )
    const till = params.till
    const fran: LeverantorsMomsval = till === 'HELT_AVDRAG' ? 'INGET_AVDRAG' : 'HELT_AVDRAG'
    const clientKey = typeof params.clientKey === 'string' ? params.clientKey.trim() : ''
    if (!/^[A-Za-z0-9._:-]{8,100}$/.test(clientKey))
      throw new BadRequestException('clientKey saknas eller är ogiltig (8–100 tecken)')
    if (Number.isNaN(params.date.getTime())) throw new BadRequestException('Ogiltigt datum')
    const { organizationId, invoiceId } = params

    return this.prisma.$transaction(async (tx) => {
      await this.lasFaktura(tx, invoiceId, organizationId)
      const f = await tx.supplierInvoice.findFirstOrThrow({
        where: { id: invoiceId, organizationId },
      })
      // Klientens idempotens (033 §4 nivå 1) — skild från exportens claim.
      const tidigare = await tx.supplierInvoiceVatAdjustment.findUnique({
        where: { supplierInvoiceId_clientKey: { supplierInvoiceId: invoiceId, clientKey } },
      })
      if (tidigare) {
        if (
          tidigare.till === till &&
          tidigare.reason === reason &&
          tidigare.date.toISOString().slice(0, 10) === params.date.toISOString().slice(0, 10)
        )
          return { adjustment: tidigare, journalEntryId: tidigare.journalEntryId, upprepad: true }
        throw new ConflictException(
          'Samma begäran-nyckel användes redan för en annan justering — ingenting ändrades.',
        )
      }
      if (f.cancelledAt) throw new ConflictException('Fakturan är makulerad och kan inte justeras.')
      if (!f.vatTreatment)
        throw new ConflictException(
          'Fakturan saknar sparat momsval (äldre, bokförd som avdragsgill). Den kan inte justeras i ' +
            'Eveno; ingen avdragsrätt gissas i efterhand.',
        )
      if (!(Math.round(Number(f.vatAmount) * 100) > 0) || f.vatTreatment === 'INGEN_MOMS')
        throw new ConflictException('Fakturan har ingen moms att justera.')
      if (f.vatTreatmentCurrent !== fran)
        throw new ConflictException(
          `Fakturans gällande val är redan «${f.vatTreatmentCurrent === 'HELT_AVDRAG' ? 'Moms dras av' : 'Moms dras inte av'}».`,
        )
      // MJ-5: originalet CONFIRMED i SAMMA Fortnox-företag som anslutningen.
      const conn = await tx.fortnoxConnection.findUnique({ where: { organizationId } })
      const orig = await tx.journalEntry.findFirst({
        where: { organizationId, source: 'SUPPLIER_INVOICE', sourceId: receiptSourceId(f.id) },
        select: { id: true },
      })
      if (!conn || conn.status !== 'ACTIVE' || !orig)
        throw new ConflictException(
          'Fakturans originalverifikat är inte bekräftat exporterat till ett anslutet Fortnox-företag — ' +
            'momsjusteringen kräver att originalet finns i Fortnox först.',
        )
      const ex = await tx.fortnoxVoucherExport.findFirst({
        where: { organizationId, journalEntryId: orig.id },
      })
      if (
        !ex ||
        ex.state !== 'CONFIRMED' ||
        ex.fortnoxDatabaseNumber !== conn.fortnoxDatabaseNumber
      ) {
        const u = await originalUtfall(tx, organizationId, orig.id, conn.fortnoxDatabaseNumber)
        throw new ConflictException(
          u.typ === 'OKANT'
            ? `Originalets ${u.text}`
            : `Originalet är ${u.typ === 'CONFIRMED' ? 'exporterat till ett annat Fortnox-företag' : u.text} — momsjusteringen kräver att originalet är bekräftat exporterat först.`,
        )
      }
      // MJ-4 v2: frysta mål. Kostnad ur originalexporten för hela kedjan; momsmål ur originalet
      // (HELT) eller infört EN gång (INGET) och ärvt — aldrig dagens mappning.
      const forra = await tx.supplierInvoiceVatAdjustment.findFirst({
        where: { supplierInvoiceId: f.id },
        orderBy: { seq: 'desc' },
      })
      const km =
        (
          ex.draft as {
            kontomappning?: {
              rader?: Array<{ roll?: string; malkonto?: unknown; kallkonto?: unknown }>
            }
          } | null
        )?.kontomappning?.rader ?? []
      const origMal = (roll: string) => {
        const r = km.find((x) => x.roll === roll)
        return r && Number.isSafeInteger(r.malkonto) ? (r.malkonto as number) : null
      }
      const kostnadMal = forra?.kostnadMal ?? origMal('KOSTNAD')
      if (kostnadMal === null)
        throw new ConflictException(
          'Originalexporten saknar fryst kostnadsmål — justeringen kan inte bokas på originalets konto; stäm av manuellt.',
        )
      let momsMal: number | null = forra?.momsMal ?? null
      let momsMalInfortAv = forra?.momsMalInfortAv ?? 0
      let mappingRevisionId: string | null = null
      if (momsMal === null) {
        if (f.vatTreatment === 'HELT_AVDRAG') {
          momsMal = origMal('INGAENDE_MOMS')
          if (momsMal === null)
            throw new ConflictException('Originalexporten saknar fryst momsmål — stäm av manuellt.')
        } else {
          // INGET-original, första INGET→HELT: målet ur den revision som är godkänd NU för
          // justeringsdatumets räkenskapsår i det anslutna företaget; fryses och ärvs sedan.
          const rev = await tx.fortnoxAccountMappingRevision.findFirst({
            where: {
              organizationId,
              status: 'APPROVED',
              fortnoxDatabaseNumber: conn.fortnoxDatabaseNumber,
              financialYearFrom: { lte: params.date },
              financialYearTo: { gte: params.date },
            },
            orderBy: { revision: 'desc' },
            include: { rows: true },
          })
          const rad = rev?.rows.find(
            (r) =>
              r.role === 'INGAENDE_MOMS' &&
              r.sourceAccountNumber === 2641 &&
              r.vatTreatment === 'AVDRAGSGILL',
          )
          if (!rev || !rad)
            throw new ConflictException(
              'Ingen godkänd kontomappning för ingående moms (2641) i justeringsdatumets räkenskapsår — godkänn mappningen först.',
            )
          momsMal = rad.targetAccountNumber
          mappingRevisionId = rev.id
        }
      }
      const seq = (forra?.seq ?? 0) + 1
      if (momsMalInfortAv === 0 && f.vatTreatment === 'INGET_AVDRAG') momsMalInfortAv = seq
      // MJ-6: villkorad uppdatering av gällande val; en samtidig justering eller makulering får 0.
      const claim = await tx.supplierInvoice.updateMany({
        where: { id: f.id, organizationId, cancelledAt: null, vatTreatmentCurrent: fran },
        data: { vatTreatmentCurrent: till },
      })
      if (claim.count !== 1)
        throw new ConflictException('Fakturan ändrades just av någon annan — ingenting justerades.')
      const id = randomUUID()
      const je = await this.accounting.bookSupplierInvoiceVatAdjustment({
        organizationId,
        adjustmentId: id,
        date: params.date,
        supplierName: f.supplierName,
        description: f.description,
        expenseAccount: f.expenseAccount,
        amount: Number(f.vatAmount),
        fran,
        till,
        createdById: params.user.sub,
        tx,
      })
      const adjustment = await tx.supplierInvoiceVatAdjustment.create({
        data: {
          id,
          organizationId,
          supplierInvoiceId: f.id,
          seq,
          fran,
          till,
          amount: f.vatAmount,
          date: params.date,
          reason,
          clientKey,
          decidedById: params.user.sub,
          decidedRole: params.user.role,
          journalEntryId: je.id,
          originalExportId: ex.id,
          originalSentPayloadHash: ex.sentPayloadHash ?? '',
          fortnoxDatabaseNumber: conn.fortnoxDatabaseNumber,
          kostnadMal,
          momsMal,
          momsMalInfortAv,
          mappingRevisionId,
        },
      })
      return { adjustment, journalEntryId: je.id, upprepad: false }
    }, PAYMENT_TX_LIMITS)
  }

  // ── TESTKUND-041 (BP1 U-1..U-3): ÅNGRA EN BETALNINGSREGISTRERING ────────────────────────────

  async undoPayment(params: {
    organizationId: string
    invoiceId: string
    paymentJournalEntryId: string
    user: { sub: string; role: string }
    reason: unknown
  }) {
    if (!SKRIVROLLER.includes(params.user.role))
      throw new ForbiddenException('Du saknar behörighet att ångra en betalningsregistrering')
    const reason = typeof params.reason === 'string' ? params.reason.trim() : ''
    if (reason.length < 5 || reason.length > 500)
      throw new BadRequestException('Ange ett skäl (5–500 tecken)')
    const { organizationId, invoiceId } = params
    return this.prisma.$transaction(async (tx) => {
      await this.lasFaktura(tx, invoiceId, organizationId)
      const f = await tx.supplierInvoice.findFirstOrThrow({
        where: { id: invoiceId, organizationId },
      })
      if (f.cancelledAt) throw new ConflictException('Fakturan är makulerad.')
      const { led, gallande } = await this.betalningsled(tx, f.id, organizationId, f)
      const l = led.find((x) => x.journalEntry.id === params.paymentJournalEntryId)
      if (!l) throw new NotFoundException('Betalningen hittades inte på den här fakturan')
      const text = (je: { series: string; verNumber: number }) =>
        `Ångrad betalningsregistrering ${je.series}${je.verNumber}: ${reason}`
      if (l.angring) {
        // U-3: samma begäran igen → samma kvitto; annat skäl eller nytt gällande led → 409.
        if (!gallande && l.angring.description === text(l.journalEntry))
          return {
            invoice: f,
            undoJournalEntryId: l.angring.id,
            upprepad: true,
          }
        throw new ConflictException(
          gallande
            ? 'Betalningen är redan ångrad och en ny betalning har registrerats — ingenting ändrades.'
            : 'Betalningen är redan ångrad (med ett annat skäl) — ingenting ändrades.',
        )
      }
      if (!gallande || gallande.journalEntry.id !== l.journalEntry.id)
        throw new ConflictException(
          'Det här är inte fakturans gällande betalning — ingenting ändrades.',
        )
      // Låsordning: faktura → ledets export.
      await tx.$queryRaw`SELECT id FROM "FortnoxVoucherExport" WHERE "organizationId" = ${organizationId} AND "journalEntryId" = ${l.journalEntry.id} FOR UPDATE`
      const ex = await tx.fortnoxVoucherExport.findFirst({
        where: { organizationId, journalEntryId: l.journalEntry.id },
        select: { state: true, lastOutcome: true },
      })
      if (ex?.state === 'SENDING')
        throw new ConflictException(
          'Betalningen skickas till Fortnox just nu — försök igen när utfallet är känt. Ingenting ändrades.',
        )
      const lagrad = /^REJECTED_(\d{3}|NA)_(\d+|NA)$/.exec(ex?.lastOutcome ?? '')
      const belagdAvvisning =
        ex?.state === 'REJECTED' &&
        !!lagrad &&
        arBelagdInnehallsavvisning(
          lagrad[1] === 'NA' ? null : Number(lagrad[1]),
          lagrad[2] === 'NA' ? null : Number(lagrad[2]),
        )
      if (
        ex &&
        (ex.state === 'UNKNOWN' ||
          ex.state === 'RECEIPT_IDENTIFIED' ||
          ex.state === 'RECEIPT_MISMATCH' ||
          (ex.state === 'REJECTED' && !belagdAvvisning))
      )
        throw new ConflictException(
          'Betalningens utfall i Fortnox är okänt — stäm av först (reconcile). Ingenting ändrades.',
        )
      const claim = await tx.supplierInvoice.updateMany({
        where: { id: f.id, organizationId, cancelledAt: null, NOT: { paidAt: null } },
        data: { paidAt: null },
      })
      if (claim.count !== 1)
        throw new ConflictException('Fakturan ändrades just av någon annan — ingenting ångrades.')
      const undo = await this.accounting.bookSupplierInvoicePaymentUndo({
        organizationId,
        payment: l.journalEntry,
        reason,
        createdById: params.user.sub,
        tx,
      })
      return {
        invoice: await tx.supplierInvoice.findUniqueOrThrow({ where: { id: f.id } }),
        undoJournalEntryId: undo.id,
        upprepad: false,
      }
    }, PAYMENT_TX_LIMITS)
  }

  /** TESTKUND-041: fakturans fulla historik för vyn — val, justeringar och betalningsled. */
  async details(id: string, organizationId: string) {
    const f = await this.findOne(id, organizationId)
    const just = await this.prisma.supplierInvoiceVatAdjustment.findMany({
      where: { supplierInvoiceId: f.id, organizationId },
      orderBy: { seq: 'asc' },
    })
    const exporter = await this.prisma.fortnoxVoucherExport.findMany({
      where: { organizationId, journalEntryId: { in: just.map((j) => j.journalEntryId) } },
      select: { journalEntryId: true, state: true },
    })
    let led: Betalningsled[] = []
    let ledFel: string | null = null
    try {
      led = (await this.betalningsled(this.prisma, f.id, organizationId, f)).led
    } catch (e) {
      ledFel = e instanceof Error ? e.message : 'oklar betalningshistorik'
    }
    const exportText = (s: string | undefined) => s ?? 'inte exporterad'
    return {
      ...f,
      netAmount: Number(f.netAmount),
      vatAmount: Number(f.vatAmount),
      totalAmount: Number(f.totalAmount),
      status: supplierInvoiceStatus(f),
      momsvalAngivet: f.vatTreatment !== null,
      justeringar: just.map((j) => ({
        id: j.id,
        seq: j.seq,
        fran: j.fran,
        till: j.till,
        belopp: Number(j.amount),
        datum: j.date.toISOString().slice(0, 10),
        skal: j.reason,
        beslutadAv: j.decidedById,
        roll: j.decidedRole,
        beslutadVid: j.decidedAt.toISOString(),
        journalEntryId: j.journalEntryId,
        exportStatus: exportText(
          exporter.find((e) => e.journalEntryId === j.journalEntryId)?.state,
        ),
      })),
      betalningsled: led.map((l) => ({
        k: l.k,
        journalEntryId: l.journalEntry.id,
        verifikat: `${l.journalEntry.series}${l.journalEntry.verNumber}`,
        datum: l.journalEntry.date.toISOString().slice(0, 10),
        gallande: !l.angring,
        exportStatus: exportText(l.export?.state),
        angring: l.angring
          ? {
              journalEntryId: l.angring.id,
              verifikat: `${l.angring.series}${l.angring.verNumber}`,
              text: l.angring.description,
              exportStatus: exportText(l.angringExport?.state),
            }
          : null,
      })),
      betalningshistorikFel: ledFel,
      vatAdjustmentSourceIds: just.map((j) => vatAdjustmentSourceId(j.id)),
    }
  }

  /** Org-scopat uppslag. NotFound, aldrig Forbidden — se documents-mönstret. */
  async findOne(id: string, organizationId: string) {
    const faktura = await this.prisma.supplierInvoice.findFirst({
      where: { id, organizationId },
    })
    if (!faktura) throw new NotFoundException('Leverantörsfakturan hittades inte')
    return faktura
  }

  /**
   * Listan. `status` och `overdue` är BERÄKNADE här, inte lagrade — och de
   * räknas på ETT ställe så att listan och detaljvyn inte kan säga olika.
   */
  async findAll(
    organizationId: string,
    filter?: { status?: SupplierInvoiceStatus },
  ): Promise<
    Array<{
      id: string
      supplierName: string
      invoiceNumber: string | null
      description: string
      invoiceDate: Date
      dueDate: Date
      expenseAccount: number
      netAmount: number
      vatRate: number
      vatAmount: number
      totalAmount: number
      attachmentUrl: string | null
      paidAt: Date | null
      cancelledAt: Date | null
      vatTreatment: LeverantorsMomsval | null
      vatTreatmentCurrent: LeverantorsMomsval | null
      status: SupplierInvoiceStatus
      overdue: boolean
    }>
  > {
    const rader = await this.prisma.supplierInvoice.findMany({
      where: { organizationId },
      orderBy: { dueDate: 'asc' },
    })
    const nu = new Date()
    return rader
      .map((r) => ({
        id: r.id,
        supplierName: r.supplierName,
        invoiceNumber: r.invoiceNumber,
        description: r.description,
        invoiceDate: r.invoiceDate,
        dueDate: r.dueDate,
        expenseAccount: r.expenseAccount,
        netAmount: Number(r.netAmount),
        vatRate: r.vatRate,
        vatAmount: Number(r.vatAmount),
        totalAmount: Number(r.totalAmount),
        attachmentUrl: r.attachmentUrl,
        paidAt: r.paidAt,
        cancelledAt: r.cancelledAt,
        // TESTKUND-041: ursprungligt och gällande momsval (null = äldre, ej angivet).
        vatTreatment: r.vatTreatment,
        vatTreatmentCurrent: r.vatTreatmentCurrent,
        status: supplierInvoiceStatus(r),
        overdue: isOverdue(r, nu),
      }))
      .filter((r) => (filter?.status ? r.status === filter.status : true))
  }
}
