import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
} from '@nestjs/common'
// `Prisma` som VÄRDE — Prisma.Decimal används för betalningsaritmetiken
// (belopp får aldrig passera float på väg till ett bokföringsbeslut).
import { Prisma } from '@prisma/client'
import type { Invoice, InvoiceStatus, InvoiceEventType, PaymentMethod } from '@prisma/client'
import { computeInvoiceDebt, invoiceOutstanding, invoiceOverpaid } from './invoice-debt'
import { computeInvoiceAmounts } from './invoice-amounts'
import { paymentTargetStatus, isPaymentTransitionAllowed } from './invoice-payment-status'
import { REMINDER_FEE_LINE_DESCRIPTION } from './reminder-fee-line'

// Speglar avi-sidans konstant och AccountingService.REVERSAL_REASON_MIN_LENGTH.
const REMINDER_FEE_REVERSAL_REASON_MIN_LENGTH = 10
import { PrismaService } from '../common/prisma/prisma.service'
import { stockholmCivilDate } from '../common/time/stockholm-period'
import { rentPeriodFalt, ärHyresperiodskonflikt, DUBBEL_HYRESFAKTURA_TEXT } from './rent-period'
import { DUBBLETT_FAKTURA_FONSTER_MS } from './duplicate-invoice-window'
import { OcrService } from '../common/ocr/ocr.service'
import { InvoiceEventsService } from './invoice-events.service'
import { PdfService } from './pdf.service'
import { MailService } from '../mail/mail.service'
import { AccountingService, vatRateForRent } from '../accounting/accounting.service'
import { NotificationsService } from '../notifications/notifications.service'
import { isValidTransition, DEFAULT_BRAND_COLOR } from '@eken/shared'
import { allocateInvoiceNumber } from './invoice-number'
import { SAFE_INVOICE_BANK_TRANSACTION_SELECT } from '../reconciliation/bank-transaction-views'
import { CreateInvoiceDto } from './dto/create-invoice.dto'
import { UpdateInvoiceDto } from './dto/update-invoice.dto'
import { SAFE_TENANT_SELECT } from '../tenants/tenants.service'
import { PdfQueue } from '../pdf-jobs/pdf.queue'
import { SAFE_CUSTOMER_SELECT } from '../customers/customers.service'
import { assertPaymentWithinDebt } from '../common/payments/payment-within-debt'
import { assertNoRecentIdenticalManualPayment } from '../common/payments/duplicate-payment-window'
import { PAYMENT_TX_LIMITS, PRISMA_DEFAULT_TX_LIMITS } from '../common/prisma/transaction-limits'

// Mappar InvoiceStatus → Prisma InvoiceEventType enum-värde
const STATUS_TO_EVENT_TYPE: Partial<Record<InvoiceStatus, InvoiceEventType>> = {
  SENT: 'SENT',
  PARTIAL: 'PAYMENT_PARTIAL',
  PAID: 'PAYMENT_RECEIVED',
  OVERDUE: 'OVERDUE',
  VOID: 'VOIDED',
}

// Fakturor från vilka en manuell betalning får registreras (status → PAID giltig
// enligt INVOICE_TRANSITIONS). Används som atomisk status-guard i markAsPaidManually.
const PAYABLE_STATUSES: InvoiceStatus[] = ['SENT', 'PARTIAL', 'OVERDUE', 'SENT_TO_COLLECTION']

// Frontend/AI skickar visningssträngar ('Bankgiro', 'Swish', …) eller inget alls —
// inte PaymentMethod-enumen som styr likvidkontot. Mappa till enumen; okänt eller
// utelämnat betalsätt → MANUAL (bokförs konservativt mot 1930, se PAYMENT_METHOD_TO_ACCOUNT).
export function toPaymentMethod(raw: unknown): PaymentMethod {
  switch (String(raw ?? '').toLowerCase()) {
    case 'swish':
      return 'SWISH'
    case 'kontant':
    case 'cash':
      return 'CASH'
    case 'bankgiro':
    case 'plusgiro':
    case 'autogiro':
    case 'bank':
      return 'BANK'
    default:
      return 'MANUAL'
  }
}

@Injectable()
export class InvoicesService {
  private readonly logger = new Logger(InvoicesService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventsService: InvoiceEventsService,
    private readonly pdfService: PdfService,
    private readonly mailService: MailService,
    private readonly accountingService: AccountingService,
    private readonly notificationsService: NotificationsService,
    private readonly ocrService: OcrService,
    private readonly pdfQueue: PdfQueue,
  ) {}

  // ── Queries ────────────────────────────────────────────────────────────────

  async findAll(
    organizationId: string,
    filters?: {
      status?: InvoiceStatus
      tenantId?: string
    },
  ) {
    const invoices = await this.prisma.invoice.findMany({
      where: {
        organizationId,
        ...(filters?.status && { status: filters.status }),
        ...(filters?.tenantId && { tenantId: filters.tenantId }),
      },
      include: {
        lines: true,
        tenant: {
          select: { id: true, firstName: true, lastName: true, companyName: true, type: true },
        },
        customer: {
          select: { id: true, firstName: true, lastName: true, companyName: true, type: true },
        },
        bankTransactions: {
          where: { status: 'MATCHED' },
          select: SAFE_INVOICE_BANK_TRANSACTION_SELECT,
          orderBy: { date: 'desc' },
        },
        // #325 — allokeringarna, för `outstanding` nedan.
        payments: { select: { amount: true } },
        creditNotes: { select: { total: true } },
      },
      orderBy: { createdAt: 'desc' },
    })

    // ── #325: RESTSKULDEN BERÄKNAS HÄR, INTE I KLIENTEN ─────────────────────
    //
    // Fakturalistans KPI "Försenat belopp" summerade `total` över OVERDUE-rader
    // och visade alltså ursprungsbeloppet på en delbetald faktura. Fältet
    // beräknas server-side med SAMMA `invoiceOutstanding` som dashboarden,
    // månadsrapporten och breven — hade klienten summerat `payments` själv vore
    // det en FJÄRDE kopia av uttrycket, och det är just spretandet #329 tog bort.
    //
    // `total` behålls: fakturerat belopp och återstående belopp är två olika,
    // båda sanna, uppgifter. `where` är orört — samma fakturor returneras.
    //
    // `payments` plockas BORT ur svaret. Den hämtas bara för att kunna räkna
    // `outstanding` här; att skicka med den hade lagt ett fält på tråden som
    // `Invoice`-typen inte deklarerar, och bjudit in nästa yta att summera
    // allokeringarna själv i stället för att läsa `outstanding`.
    // #378: `overpaid` följer med bredvid `outstanding`. Exakt ett av dem kan
    // vara skilt från noll. Innan detta klampades överbetalningen bort av
    // `max(0, claim)` och fanns kvar bara som ett tecken på `claim`, som lästes
    // av EN grind i hela kodbasen — pengarna var alltså osynliga för varje yta.
    // #517: `creditNotes` plockas bort av samma skäl som `payments` — den
    // hämtas för att kunna räkna `outstanding`, inte för att skickas vidare.
    return invoices.map(({ payments: _payments, creditNotes: _creditNotes, ...inv }) => ({
      ...inv,
      outstanding: invoiceOutstanding({
        total: inv.total,
        payments: _payments,
        creditNotes: _creditNotes,
      }),
      overpaid: invoiceOverpaid({
        total: inv.total,
        payments: _payments,
        creditNotes: _creditNotes,
      }),
    }))
  }

  async findOne(id: string, organizationId: string) {
    const invoice = await this.prisma.invoice.findFirst({
      where: { id, organizationId },
      include: {
        lines: true,
        tenant: { select: SAFE_TENANT_SELECT },
        customer: { select: SAFE_CUSTOMER_SELECT },
        lease: true,
        // `events` BORTTAGET (#440-rättelse). Detaljsvaret bar hela
        // InvoiceEvent[] — aktörsfält och payload — till varje roll, medan
        // GET /invoices/:id/events grindades till ACCOUNTANT+ i samma PR. Grinden
        // satt rätt och var ändå verkningslös: samma data låg i det öppna
        // detaljsvaret. Ingen yta i web/admin/portal läste fältet härifrån —
        // InvoicesPage hämtar tidslinjen via det grindade anropet
        // (useInvoiceEvents), och `getTimeline` nedan är den enda vägen som ska
        // finnas.
        bankTransactions: {
          where: { status: 'MATCHED' },
          select: SAFE_INVOICE_BANK_TRANSACTION_SELECT,
          orderBy: { date: 'desc' },
        },
        // #349 — allokeringarna, för `outstanding` nedan. Samma skäl som i
        // findAll: restskulden räknas HÄR, inte i klienten.
        payments: { select: { amount: true } },
        // #517 — KOPPLINGEN ÅT BÅDA HÅLL. Samma include tjänar två syften:
        // `total` är allt skuldberäkningen behöver, och resten är vad
        // detaljvyn visar. Utan dokumenten kan en operatör se att fordran
        // krympt men inte vilket dokument som gjorde det.
        creditNotes: {
          select: { id: true, invoiceNumber: true, total: true, issueDate: true, notes: true },
          orderBy: { issueDate: 'asc' },
        },
        // Andra riktningen: är DETTA en kreditnota, vilken faktura avser den?
        creditedInvoice: { select: { id: true, invoiceNumber: true, total: true } },
      },
    })
    if (!invoice) throw new NotFoundException('Faktura hittades inte')
    // ── #349: DETALJSVARET BÄR OCKSÅ RESTSKULDEN ────────────────────────────
    //
    // `outstanding` fanns bara på listsvaret. Betalningsmodalen kan öppnas från
    // listan (där fältet finns) men också via deep-link från notifikationer, där
    // raden kommer från `useInvoice(id)` — och då saknades det. En
    // `?? total`-fallback i klienten hade smugit tillbaka bruttot, vilket är
    // exakt fällan #325 stängde på KPI-sidan.
    //
    // `payments` plockas BORT ur svaret, av samma skäl som i findAll: att skicka
    // med den hade bjudit in nästa yta att summera allokeringarna själv i
    // stället för att läsa `outstanding`.
    const { payments: _payments, creditNotes: _creditNotes, ...inv } = invoice
    return {
      ...inv,
      // #517 — kreditnotorna som DOKUMENT på tråden. Beloppen används dessutom
      // som ingång till skuldberäkningen nedan; samma rader, två användningar.
      creditNotes: _creditNotes.map((c) => ({
        id: c.id,
        invoiceNumber: c.invoiceNumber,
        total: Number(c.total),
        issueDate: c.issueDate,
        reason: c.notes,
      })),
      outstanding: invoiceOutstanding({
        total: inv.total,
        payments: _payments,
        creditNotes: _creditNotes,
      }),
      // #378 — samma skäl som i findAll: detaljvyn ska kunna visa en
      // överbetalning utan att räkna ut den själv.
      overpaid: invoiceOverpaid({
        total: inv.total,
        payments: _payments,
        creditNotes: _creditNotes,
      }),
    }
  }

  async getTimeline(id: string, organizationId: string) {
    // Verifiera att fakturan tillhör organisationen
    await this.findOne(id, organizationId)
    return this.eventsService.getTimeline(id)
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async generateInvoiceNumber(
    organizationId: string,
    tx: Prisma.TransactionClient,
  ): Promise<{ invoiceNumber: string; sequence: number }> {
    // Delad allokering (samma sekvens som deposits) — se allocateInvoiceNumber.
    return allocateInvoiceNumber(tx, organizationId)
  }

  // ── Mutations ──────────────────────────────────────────────────────────────

  async create(organizationId: string, actorId: string, dto: CreateInvoiceDto): Promise<Invoice> {
    // XOR: exakt en av leaseId / customerId. CHECK-constraint i DB är sista
    // försvarslinjen — vi vill ge tydligt fel innan vi når dit.
    const hasLease = dto.leaseId != null
    const hasCustomer = dto.customerId != null
    if (hasLease === hasCustomer) {
      throw new BadRequestException(
        'Faktura måste vara kopplad till antingen hyresavtal eller extern kund — inte båda eller ingen',
      )
    }

    let leaseTenantId: string | null = null
    let leaseId: string | null = null
    let customerId: string | null = null

    if (hasLease) {
      // Hämta avtalet org-scopat. unit.property.organizationId är källan till sanning
      // (Lease saknar eget organizationId-fält).
      const lease = await this.prisma.lease.findFirst({
        where: {
          id: dto.leaseId!,
          unit: { property: { organizationId } },
        },
        select: {
          id: true,
          status: true,
          tenantId: true,
          unit: { select: { type: true, voluntaryTaxLiability: true } },
        },
      })
      if (!lease) throw new NotFoundException('Hyresavtal hittades inte')
      if (lease.status !== 'ACTIVE' && lease.status !== 'DRAFT') {
        throw new BadRequestException('Endast aktiva eller utkast-avtal kan faktureras')
      }

      // Momskontroll (ML 2023:200): en momsfri upplåtelse får inte faktureras
      // med moms. Bostad (APARTMENT) är alltid undantagen (ML 10 kap. 35 §); lokal
      // utan frivillig skattskyldighet likaså. Annars skulle felaktig moms
      // debiteras hyresgästen och redovisas till staten.
      const allowedVatRate = vatRateForRent(lease.unit.type, lease.unit.voluntaryTaxLiability)
      if (allowedVatRate === 0) {
        // Momsfri upplåtelse får inte faktureras med moms.
        const offending = dto.lines.find((l) => l.vatRate !== 0)
        if (offending) {
          throw new BadRequestException(
            lease.unit.type === 'APARTMENT'
              ? 'Bostadshyra är undantagen från moms enligt ML 10 kap. 35 § — vatRate måste vara 0'
              : 'Lokalen saknar frivillig beskattning — hyran är momsfri (ML 12 kap. 5 §). ' +
                  'Sätt frivillig beskattning på enheten eller använd vatRate 0.',
          )
        }
      } else {
        // Omvänd kontroll: en i lag momspliktig upplåtelse får inte faktureras
        // momsfritt — det vore underredovisning av utgående moms till staten.
        const offending = dto.lines.find((l) => l.vatRate !== allowedVatRate)
        if (offending) {
          throw new BadRequestException(
            lease.unit.type === 'PARKING'
              ? `Parkeringsplats är momspliktig enligt ML 10 kap. 36 § — vatRate måste vara ${allowedVatRate}`
              : `Lokalen har frivillig beskattning — vatRate måste vara ${allowedVatRate} (ML 12 kap.)`,
          )
        }
      }

      await this.assertNoDuplicateInvoice(dto, lease.id)

      leaseId = lease.id
      leaseTenantId = lease.tenantId
    } else {
      const customer = await this.prisma.customer.findFirst({
        where: { id: dto.customerId!, organizationId },
        select: { id: true, isActive: true },
      })
      if (!customer) throw new NotFoundException('Kunden hittades inte')
      if (!customer.isActive) {
        throw new BadRequestException('Kunden är arkiverad och kan inte faktureras')
      }
      customerId = customer.id
    }

    // ── KONFLIKTEN ÄR DEN SKARPA HALVAN AV SPÄRREN ──────────────────────
    //
    // `assertNoDuplicateInvoice` ovan är en LÄSNING FÖRE en skrivning och kan
    // därför inte hindra två samtidiga anrop. Det partiella unika indexet
    // `invoice_rent_period_unique` kan, för faktura-mot-faktura. Konflikten
    // översätts till samma text som uppslaget ger, så svaret inte beror på
    // vilken av de två som råkade träffa först.
    let invoice: Invoice
    try {
      invoice = await this.prisma.$transaction(async (tx) => {
        const { invoiceNumber, sequence } = await this.generateInvoiceNumber(organizationId, tx)

        // Auto-generera Luhn-validerat OCR från fakturasekvensen.
        // Lagras alltid på Invoice.ocrNumber. Reference defaultar till OCR
        // om klienten inte angett egen referens.
        const ocrNumber = this.ocrService.generateForInvoiceSequence(sequence)
        const reference = dto.reference != null ? dto.reference : ocrNumber

        // Beräkna belopp server-side (lita aldrig på klienten). Öresavrundat så
        // att Σ rader = total och subtotal + moms = total exakt (se round2 ovan).
        const { subtotal, vatTotal, total, lines: computedLines } = computeInvoiceAmounts(dto.lines)

        const created = await tx.invoice.create({
          data: {
            organizationId,
            invoiceNumber,
            ocrNumber,
            reference,
            type: dto.type,
            status: 'DRAFT',
            tenantId: leaseTenantId,
            leaseId,
            customerId,
            subtotal,
            vatTotal,
            total,
            dueDate: new Date(dto.dueDate),
            issueDate: new Date(dto.issueDate),
            // Perioden LAGRAS, inte härleds vid läsning. Samma
            // `stockholmCivilDate` som uppslaget använder — se
            // assertNoDuplicateInvoice och kolumnens docblock i schema.prisma för
            // varför en genererad kolumn hade gett två sanningar i stället för en.
            ...rentPeriodFalt(dto.type, dto.issueDate),
            ...(dto.notes != null ? { notes: dto.notes } : {}),
            lines: {
              createMany: {
                data: computedLines.map((l) => ({
                  description: l.description,
                  quantity: l.quantity,
                  unitPrice: l.unitPrice,
                  vatRate: l.vatRate,
                  total: l.total,
                })),
              },
            },
          },
          // H3: hämta med rader direkt i transaktionen — bokföringen behöver dem,
          // och vi slipper den extra findUnique-rundturen som fanns tidigare.
          include: { lines: true },
        })

        await this.eventsService.record(
          created.id,
          'CREATED',
          'USER',
          actorId,
          { invoiceNumber: created.invoiceNumber },
          { tx },
        )

        // T5 A1 (BFL 5:6): bokför intäktsverifikatet i SAMMA transaktion som
        // fakturan. Kastar bokföringen (stängd period, DB-fel ELLER saknad kontoplan
        // — createJournalEntryForInvoice loggar + kastar i tx-läge, symmetriskt med
        // avi-vägen) rullas HELA fakturan tillbaka → ingen orphan. Tidigare låg detta
        // utanför tx och sväljdes/loggades, så fakturan kunde bli kvar UTAN verifikat.
        await this.accountingService.createJournalEntryForInvoice(
          created,
          organizationId,
          actorId,
          tx,
        )

        return created
      }, PRISMA_DEFAULT_TX_LIMITS)
    } catch (err) {
      if (!ärHyresperiodskonflikt(err)) throw err
      throw new ConflictException(DUBBEL_HYRESFAKTURA_TEXT)
    }

    return invoice
  }

  async update(
    id: string,
    organizationId: string,
    actorId: string,
    dto: UpdateInvoiceDto,
  ): Promise<Invoice> {
    const invoice = await this.prisma.invoice.findFirst({
      where: { id, organizationId },
    })
    if (!invoice) throw new NotFoundException('Faktura hittades inte')
    if (invoice.status !== 'DRAFT') {
      throw new BadRequestException('Endast utkast kan redigeras')
    }

    return this.prisma.$transaction(async (tx) => {
      const updateData: Prisma.InvoiceUncheckedUpdateInput = {}

      if (dto.type != null) updateData.type = dto.type
      // tenantId kan aldrig ändras manuellt – det härleds alltid från leaseId.
      if (dto.leaseId != null) {
        const lease = await tx.lease.findFirst({
          where: { id: dto.leaseId, unit: { property: { organizationId } } },
          select: { id: true, status: true, tenantId: true },
        })
        if (!lease) throw new NotFoundException('Hyresavtal hittades inte')
        if (lease.status !== 'ACTIVE' && lease.status !== 'DRAFT') {
          throw new BadRequestException('Endast aktiva eller utkast-avtal kan faktureras')
        }
        updateData.leaseId = lease.id
        updateData.tenantId = lease.tenantId
      }
      if (dto.dueDate != null) updateData.dueDate = new Date(dto.dueDate)
      if (dto.issueDate != null) updateData.issueDate = new Date(dto.issueDate)

      // ── PERIODEN MÅSTE FÖLJA MED ────────────────────────────────────────
      //
      // Utan det här blocket upprätthåller det partiella unika indexet en
      // INAKTUELL period utan att något blir rött — spärren skulle gälla den
      // månad fakturan en gång hade. Ett prov faller om blocket försvinner:
      // `invoice-rent-period.db.spec.ts`, "uppdateringsvägen räknar om".
      //
      // Härleds ur den EFFEKTIVA typen OCH det effektiva datumet. Båda kan
      // ändras i samma anrop, och en ändring av bara den ena räcker: byter en
      // faktura typ från SERVICE till RENT ska den plötsligt göra anspråk på en
      // period, och tvärtom ska anspråket släppas.
      if (dto.issueDate != null || dto.type != null) {
        Object.assign(
          updateData,
          rentPeriodFalt(dto.type ?? invoice.type, dto.issueDate ?? invoice.issueDate),
        )
      }
      if (dto.reference != null) updateData.reference = dto.reference
      if (dto.notes != null) updateData.notes = dto.notes

      if (dto.lines && dto.lines.length > 0) {
        // Ta bort alla befintliga rader och skapa nya (replace-all)
        await tx.invoiceLine.deleteMany({ where: { invoiceId: id } })

        // Öresavrundat i beräkningslagret (se round2/computeInvoiceAmounts ovan).
        const { subtotal, vatTotal, total, lines: computedLines } = computeInvoiceAmounts(dto.lines)

        updateData.subtotal = subtotal
        updateData.vatTotal = vatTotal
        updateData.total = total
        updateData.lines = {
          createMany: {
            data: computedLines.map((l) => ({
              description: l.description,
              quantity: l.quantity,
              unitPrice: l.unitPrice,
              vatRate: l.vatRate,
              total: l.total,
            })),
          },
        }
      }

      const updated = await tx.invoice.update({
        where: { id },
        data: updateData,
      })

      await this.eventsService.record(id, 'UPDATED', 'USER', actorId, {}, { tx })

      return updated
    }, PRISMA_DEFAULT_TX_LIMITS)
  }

  // Soft-delete (LAGBROTT 1, BFL 1999:1078): en faktura och dess append-only
  // händelselogg får ALDRIG raderas hårt. Ett utkast har dessutom redan
  // förbrukat ett fakturanummer ur InvoiceNumberSequence (PR 4) — en hård
  // radering skulle lämna ett oförklarat hål i den fortlöpande nummerserien.
  // I stället makuleras utkastet (DRAFT → VOID) via state machine:n, vilket
  // bevarar fakturan, loggar en VOIDED-händelse (vem + när + varför) och gör
  // hålet i serien spårbart (behandlingshistorik, BFL 5 kap 11 §).
  async remove(id: string, organizationId: string, actorId: string): Promise<void> {
    const invoice = await this.prisma.invoice.findFirst({
      where: { id, organizationId },
      select: { id: true, status: true },
    })
    if (!invoice) throw new NotFoundException('Faktura hittades inte')
    if (invoice.status !== 'DRAFT') {
      throw new BadRequestException('Endast utkast kan tas bort. Makulera fakturan istället.')
    }

    await this.transitionStatus(id, organizationId, 'VOID', actorId, 'USER', {
      reason: 'draft_voided',
    })
  }

  /**
   * Statusövergång med state machine-validering.
   *
   * Faktura-raden och event-raden skrivs i samma transaktion.
   * Om något felar rullar båda tillbaka – status och historik hålls alltid i sync.
   */
  async transitionStatus(
    id: string,
    organizationId: string,
    newStatus: InvoiceStatus,
    actorId: string | null,
    actorType: 'USER' | 'SYSTEM',
    payload: Record<string, unknown> = {},
  ): Promise<Invoice> {
    // ── SENT_TO_COLLECTION ÄR INGET MANUELLT MÅLVÄRDE (#307 PR 2b) ───────────
    //
    // VAD DEN HÄR RADEN ÄR — OCH INTE ÄR. Den stänger inget öppet hål idag:
    // TransitionStatusDto:s `@IsEnum` räknar inte upp SENT_TO_COLLECTION, så
    // ValidationPipe avvisar redan värdet på PATCH /invoices/:id/status (mätt,
    // se invoices.collection-status-block.spec.ts). Spärren LÅSER FAST att det
    // förblir så.
    //
    // Varför det behövs: DTO-enumet är en HANDSKRIVEN statuslista vid sidan av
    // statusmaskinen — exakt den sortens andra lista som PR 2b finns för att bli
    // av med. PR 2b vidgar INVOICE_TRANSITIONS med PARTIAL → SENT_TO_COLLECTION;
    // den dagen någon utökar DTO-enumet (eller lägger en ny anropare på den här
    // publika metoden) öppnas inkassovägen här utan skuldgrind och utan
    // assertMayActOnCollections. Grinden hör hemma vid statusen, inte bara i DTO:n.
    //
    // MINIMAL MED FLIT. Att i stället bygga skuldgrind + rollgrind här vore en
    // TREDJE kopia av inkassovägen, och frågan "ska inkasso kunna nås manuellt
    // alls?" är ett produktbeslut, inte en teknisk konsekvens av PR 2b. Öppet
    // ärende: #323. Väljs alternativ (b) där — samma grindar som exportvägen —
    // ska den här spärren tas bort igen.
    if (newStatus === 'SENT_TO_COLLECTION') {
      throw new BadRequestException(
        'Inkasso nås via inkassoexporten (POST /collections/export/:invoiceId), inte via manuell statusändring',
      )
    }

    const result = await this.prisma.$transaction(async (tx) => {
      // ── RADLÅS: FAKTURAN FÖRST (#302) ──────────────────────────────────────
      //
      // VAD LÅSET STÄNGER: ett TILLSTÅNDSFEL, inte ett penningfel.
      //
      // Läsningen nedan — inklusive allokeringsgrinden som ska hindra att en
      // BETALD faktura makuleras (C4/C5) — togs utan lås och kunde därför hinna
      // bli inaktuell innan skrivningen:
      //
      //   T1 (VOID)     läser fakturan, ser noll allokeringar
      //   T2 (markPaid) låser fakturan, allokerar, bokför 1930 D / 1510 K, commit
      //   T1            skriver ändå status VOID
      //   → makulerad faktura MED registrerad betalning, rakt förbi grinden
      //
      // Låset måste ligga FÖRE allokeringsgrinden — det är den läsningen som
      // annars fattar beslut på inaktuell grund.
      //
      // MÄTT (#302:s bevisrigg, fönstret vidgat till 200 ms med samma
      // Prisma-middleware-metod som #296 — utan vidgning träffas racet aldrig):
      //   utan låset: 20/20 körningar gav faktura VOID med registrerad betalning
      //   med låset:  0/20
      //
      // ⚠️ OM DU LÄSER DET HÄR SOM "BARA ETT TILLSTÅNDSFEL" — LÄS EN RAD TILL.
      // Konsekvensen skiljer sig åt beroende på FAKTURATYP, och att blanda ihop
      // dem har redan kostat ett scope-beslut på fel underlag en gång:
      //
      //   DEPOSITIONSFAKTURA: huvudboken förblir balanserad även utan låset.
      //     1510 dubbelkrediteras inte, eftersom deposit.status-grinden i
      //     VOID-blocket längre ned (#301) stoppar reverseringen när betalningen
      //     hunnit bokföras. Felet stannar vid tillståndet. (Mätt: S1/S2.)
      //
      //   VANLIG FAKTURA: ingen sådan grind finns. reverseJournalEntryForInvoice
      //     reverserar accrualen OVILLKORLIGT, utan att fråga om fakturan hunnit
      //     bli betald — så samma race ger 1510 debet 13 750 / kredit 27 500.
      //     Ett äkta penningfel. (Mätt: S7, 20/20 utan lås.)
      //
      // Låset stänger alltså BÅDA. Den första versionen av den här kommentaren
      // påstod generellt "aldrig ett penningfel" på grundval av ett testfall som
      // inte kunde visa något annat — övergeneraliseringen fälldes i granskning.
      //
      // LÅSORDNING: Invoice → Deposit. Samma riktning som alla andra vägar som
      // rör båda raderna:
      //
      //   markPaid (fakturagren):  Invoice (FOR UPDATE) → Deposit (claim)
      //   applyMatchToInvoice:     Invoice (FOR UPDATE) → Deposit (updateMany)
      //   denna väg:               Invoice (FOR UPDATE) → Deposit (läs + reversera)
      //
      // INGEN väg i systemet tar Deposit → Invoice. Den ABBA:n togs bort i #293
      // och får inte återinföras — vänder du ordningen här kan de tre vägarna
      // vänta in varandra korsvis och Postgres döda en av dem.
      //
      // RÖR INTE #296: det som håller det ärendet stängt är att bankvägen och
      // markPaids AVI-gren tar RentNotice/Deposit i motsatta riktningar (se
      // reconciliation.service.ts och deposits.service.ts). Den här raden rör
      // bara Invoice ↔ Deposit och vänder ingen av de pilarna. Verifierat.
      await tx.$queryRaw`SELECT id FROM "Invoice" WHERE id = ${id} AND "organizationId" = ${organizationId} FOR UPDATE`

      const invoice = await tx.invoice.findFirst({
        where: { id, organizationId },
        select: { id: true, status: true, invoiceNumber: true, isCreditNote: true },
      })
      if (!invoice) throw new NotFoundException('Faktura hittades inte')

      // ── EN KREDITNOTA KAN INTE MAKULERAS (#517) ─────────────────────────────
      //
      // Inte en smaksak, utan en följd av var verifikaten ligger.
      // `reverseJournalEntryForInvoice` nedan letar på `sourceId = <invoiceId>`
      // och skulle aldrig hitta kreditnotans verifikat, som bokförts under
      // `credit-note:<id>`. En makulering hade alltså tagit bort dokumentet ur
      // skuldberäkningen — fordran hade STIGIT igen — medan verifikatet stod
      // kvar och sa motsatsen.
      //
      // KOPPLAD TILL `CreditNoteAmount` i invoice-debt.ts, som saknar
      // statusfält just för att en kreditnota inte kan ha status VOID. Tas den
      // här spärren bort måste skuldberäkningen börja filtrera på status i
      // samma ändring. `credit-note-guard.spec.ts` faller annars.
      if (invoice.isCreditNote && newStatus === 'VOID') {
        throw new BadRequestException(
          'En kreditnota kan inte makuleras. Är krediteringen fel bokförs en ny ' +
            'faktura på beloppet — kreditnotans verifikat står kvar oavsett.',
        )
      }

      if (!isValidTransition(invoice.status as InvoiceStatus, newStatus)) {
        throw new BadRequestException(`Ogiltig statusövergång: ${invoice.status} → ${newStatus}`)
      }

      // En faktura med MOTTAGEN BETALNING får inte makuleras rakt av — pengarna
      // skulle lämna en oadresserad kundkredit på 1510. Hantera betalningen
      // först. (Symmetriskt med cancelNotice för hyresavier.)
      //
      // C4/C5: grinden nyckas på FAKTISKA allokeringar, inte på status ===
      // 'PARTIAL'. Statusvarianten (PR #166) räckte så länge PARTIAL i praktiken
      // var onåbart, men med delbetalningsmodellen är den nåbar — och
      // INVOICE_TRANSITIONS tillåter PARTIAL → OVERDUE → VOID. Eftersom
      // PATCH /invoices/:id/status bara blockerar PAID kunde en delbetald
      // faktura annars makuleras i två steg, förbi spärren, med mottagna pengar
      // kvar obokade. (PAID är terminalt i statusmaskinen och kan aldrig
      // makuleras — den vägen var redan stängd.)
      if (newStatus === 'VOID') {
        const allocations = await tx.invoicePayment.findMany({
          where: { invoiceId: id },
          select: { id: true },
        })
        if (allocations.length > 0) {
          throw new BadRequestException(
            'Kan inte makulera en faktura med registrerad betalning — hantera den ' +
              'mottagna betalningen först (avmatcha/återbetala).',
          )
        }

        // ── #517: EN KREDITERAD FAKTURA FÅR INTE MAKULERAS ────────────────────
        //
        // Samma resonemang som betalningsspärren ovan, och samma fysiska orsak
        // som gör att en kreditnota inte kan makuleras: de två verifikaten
        // känner inte till varandra.
        //
        // `reverseJournalEntryForInvoice` nedan letar på `sourceId =
        // <invoiceId>` och vänder HELA originalverifikatet. Kreditnotans
        // verifikat ligger under `credit-note:<id>` och är osynligt för den. En
        // makulering ovanpå en delkreditering reverserar därför det redan
        // krediterade beloppet EN ANDRA GÅNG.
        //
        // Faktura 10 000, delkrediterad 3 000, sedan makulerad:
        //
        //   1510:  D 10 000 − K 3 000 − K 10 000 = −3 000
        //   39xx:  K 10 000 − D 3 000 − D 10 000 = −3 000
        //
        // En negativ kundfordran och en negativ intäkt som inte motsvarar någon
        // affärshändelse — och ingenting i systemet hade visat det.
        //
        // SYMMETRIN ÄR POÄNGEN. CreditNoteService spärrar att kreditera en
        // makulerad faktura. Utan den här raden var bara den ena riktningen
        // stängd, vilket är samma hål sett från andra hållet.
        const creditNotes = await tx.invoice.findMany({
          where: { creditedInvoiceId: id },
          select: { id: true },
        })
        if (creditNotes.length > 0) {
          throw new BadRequestException(
            'Kan inte makulera en faktura som redan har en kreditnota. ' +
              'Makuleringen skulle reversera hela originalbeloppet ovanpå ' +
              'krediteringen och göra kundfordran och intäkten fel i bokföringen.',
          )
        }
      }

      const updated = await tx.invoice.update({
        where: { id },
        data: {
          status: newStatus,
          // exactOptionalPropertyTypes: null för att rensa fältet, undefined utelämnar det
          ...(newStatus === 'PAID' ? { paidAt: new Date() } : {}),
        },
      })

      const eventType = STATUS_TO_EVENT_TYPE[newStatus]
      if (eventType) {
        await this.eventsService.record(
          id,
          eventType,
          actorType,
          actorId,
          { previousStatus: invoice.status, newStatus, ...payload },
          { tx },
        )
      }

      // Makulering: reversera den intäkt som bokades vid create() (createJournal-
      // EntryForInvoice, oavsett status — även DRAFT). Utan motverifikat kvarstår
      // fantomintäkt + utgående moms för en makulerad faktura (BFL 5 kap 5 §/9 §).
      // Körs i SAMMA tx → faller reverseringen rullas statusflippen tillbaka.
      // No-op om fakturan aldrig bokförts.
      if (newStatus === 'VOID') {
        await this.accountingService.reverseJournalEntryForInvoice(id, organizationId, actorId, tx)

        // ── A: PÅMINNELSEAVGIFTEN LIGGER I EN ANNAN NAMNRYMD ─────────────────
        //
        // Raden ovan letar på `sourceId = <invoiceId>` och kan aldrig träffa
        // avgiften, som bokförts under `reminder-fee:<invoiceId>` (1510 D / 3593 K,
        // momsfri). Utan det här anropet står en påminnelseintäkt och en fordran
        // kvar för en makulerad faktura. Samma klass som #301.
        //
        // Räntan har INGEN motsvarighet här: `bookInterest` anropas bara från
        // avi-sidans RentInterestService, och fakturavägen kristalliserar aldrig
        // ränta. Att lägga ett anrop här "för symmetrins skull" hade varit en
        // uppslagning som per konstruktion aldrig kan träffa något.
        await this.accountingService.reverseJournalEntryForReminderFee(
          'INVOICE',
          id,
          organizationId,
          'Makulerad faktura',
          actorId,
          tx,
        )

        // ── …OCH DOKUMENTET MÅSTE FÖLJA MED, INTE BARA HUVUDBOKEN ────────────
        //
        // Avgiften togs på TVÅ ställen: ett verifikat OCH en rad på fakturan med
        // `total` uppräknad (payment-reminder.service.ts). Reverseras bara
        // verifikatet blir dokumentet och räkenskaperna oense — fakturan
        // fortsätter kräva avgiften medan huvudboken inte längre bär den. Det är
        // exakt den divergens #357 stängde, med omvänt tecken.
        //
        // Raden RADERAS, den nollas inte. En rad på 0,00 kr med texten
        // "Påminnelseavgift enligt lag" påstår en lagstadgad avgift på noll
        // kronor och följer med ut på fakturaunderlaget — FAR:s M1 i #357 avvisade
        // just den konstruktionen på skrivsidan, och den är inte bättre här.
        //
        // Summan tas från RADERNA, inte från verifikatet: det är raderna som
        // byggt upp `total`, och det är de två som måste stämma inbördes. Skulle
        // de någon gång ha glidit isär är det radernas summa som gör dokumentet
        // konsistent igen. `deleteMany` + summering hanterar dessutom flera rader
        // utan särfall — efter #357 kan bara en uppstå, men den spärren är ung och
        // koden här ska inte anta att den alltid hållit.
        // ── E: FÖRBRUKNINGSDEBITERINGAR LOSSAS FRÅN DEN MAKULERADE FAKTURAN ──
        //
        // En UTILITY-faktura (`invoiceSeparateCharges`) är ETT RENT DOKUMENT: den
        // bokförs aldrig, eftersom charges redan bär sin egen 1510-fordran från
        // CONFIRM-tillfället. `reverseJournalEntryForInvoice` ovan är därför en
        // no-op för den — det finns ingen post under `<invoiceId>` att hitta.
        //
        // Utan det här blocket blev charges PERMANENT ÖVERGIVNA: `ATTACHED` till
        // en makulerad faktura, utan väg tillbaka till `CONFIRMED` och utan något
        // levande dokument att drivas in mot. Fordran var korrekt bokförd och
        // omöjlig att kräva. Bokföringen rörs inte — grunden består.
        //
        // MISC-CHARGES SAKNAS HÄR MED FLIT, OCH DET ÄR MÄTT: `MiscCharge` har
        // ingen `invoiceId`-kolumn (bara relationen `rentNoticeLine`). En övrig
        // debitering kan bara hamna på en hyresavi, aldrig på en faktura. De fyra
        // teoretiska kombinationerna är alltså tre — ett anrop här hade grindat
        // mot något som inte kan uppstå.
        //
        // FAKTURARADERNA LÄMNAS KVAR, till skillnad från avgiftsraden ovan.
        // Skillnaden är inte godtycklig: avgiftens verifikat REVERSERAS, så
        // dokumentet får inte fortsätta kräva den. Förbrukningens verifikat STÅR
        // KVAR och fordran är alltjämt verklig — raderna är då korrekt historik
        // över vad den makulerade fakturan en gång presenterade. Ingen
        // dubbelkrävning uppstår: en VOID-faktura bär ingen skuld
        // (`bearsOpenDebt`), medan chargen drivs in via sitt nya dokument. Något
        // unikhetsindex som tvingar fram borttagning finns inte här, till skillnad
        // från avi-sidans `RentNoticeLine`.
        await tx.consumptionCharge.updateMany({
          where: { invoiceId: id, organizationId, status: 'ATTACHED' },
          data: { status: 'CONFIRMED', invoiceId: null },
        })

        const feeLines = await tx.invoiceLine.findMany({
          where: { invoiceId: id, description: REMINDER_FEE_LINE_DESCRIPTION },
          select: { id: true, total: true },
        })
        if (feeLines.length > 0) {
          const feeSum = feeLines.reduce(
            (sum, l) => sum.plus(new Prisma.Decimal(l.total)),
            new Prisma.Decimal(0),
          )
          await tx.invoiceLine.deleteMany({
            where: { id: { in: feeLines.map((l) => l.id) } },
          })
          // #363: `subtotal` följer med `total` — avgiften är momsfri
          // (`vatRate: 0`, konto 3593), så hela beloppet hör till nettot och
          // `vatTotal` ska stå still. Utan subtotal-raden lämnar makuleringen
          // dokumentet skevt åt ANDRA hållet än påläggningen gjorde.
          await tx.invoice.update({
            where: { id },
            data: {
              total: { decrement: feeSum },
              subtotal: { decrement: feeSum },
            },
          })
        }

        // ── #301: DEPOSITIONSFAKTURANS ACCRUAL LIGGER I EN ANNAN NAMNRYMD ─────
        //
        // Raden ovan är en no-op för en depositionsfaktura, och det är inte ett
        // fel i den: en DEPOSIT-faktura går ALDRIG genom InvoicesService.create(),
        // så det finns ingen post under sourceId=<invoiceId> att hitta.
        // DepositsService.create() skapar Invoice-raden direkt och bokför
        // 1510 D / 2890 K under `deposit-invoice:<depositId>`.
        //
        // Utan det här anropet stod alltså fordran OCH skulden kvar öppna efter
        // makulering — för en affärshändelse som aldrig fullbordades. FAR:s
        // beslut (#301): reversera alltid. Grunden är INTE fantomintäkt/moms
        // (depositionsfakturan har vatTotal 0 och rör inga 3xxx-konton) utan
        // BFL 5 kap 6 § — efter makulering finns varken en verklig fordran
        // (hyresgästen är inte skyldig att betala en makulerad faktura) eller en
        // verklig skuld (ingen deposition har mottagits).
        //
        // Nyckeln kan bara konstrueras via depositionen, därav uppslaget.
        // Speglar assertInvoiceReceivableBacked, som gör samma namnrymdshopp.
        const deposit = await tx.deposit.findFirst({
          where: { organizationId, invoiceId: id },
          select: { id: true, status: true },
        })

        // SPÄRR: reversera BARA en oreglerad deposition.
        //
        // Allokeringsgrinden ovan blockerar redan VOID när en InvoicePayment
        // finns, så det här är andra försvarslinjen — men den är inte överflödig:
        // den kodar FAR:s villkor ("när ingen betalning inkommit") mot
        // depositionens EGEN status i stället för mot en spegel av den. Är
        // depositionen PAID/REFUNDED/FORFEITED är 1930 D / 1510 K redan bokfört,
        // och en reversering skulle kreditera 1510 en andra gång.
        if (deposit && deposit.status === 'PENDING') {
          await this.accountingService.reverseJournalEntryForDepositAccrual(
            deposit.id,
            organizationId,
            'Makulerad faktura',
            actorId,
            tx,
          )
        }
      }

      return updated
    }, PRISMA_DEFAULT_TX_LIMITS)

    if (newStatus === 'PAID') {
      void this.notificationsService
        .createForAllOrgUsers(
          organizationId,
          'INVOICE_PAID',
          'Faktura betald',
          `Faktura ${result.invoiceNumber} har betalats`,
          { relatedEntityType: 'INVOICE', relatedEntityId: result.id },
        )
        .catch((err) => this.logger.error(`Notification error: ${String(err)}`))
    }

    return result
  }

  /**
   * G4a — STRYK EN FELAKTIGT DEBITERAD PÅMINNELSEAVGIFT på en faktura, utan att
   * makulera fakturan.
   *
   * Syskonet till `AviseringService.reverseReminderFee`; se den för resonemanget
   * om varför strykningen är en RÄTTELSE och inte en eftergift, och varför
   * gränsen är aritmetisk. Skillnaderna mot avi-sidan:
   *
   *   • Avgiften bor på TRE ställen här, inte två: verifikatet, en `InvoiceLine`
   *     och `invoice.total`. Alla tre måste följas åt.
   *   • Raden RADERAS, den nollas inte — en rad på 0,00 kr med texten
   *     "Påminnelseavgift enligt lag" påstår en lagstadgad avgift på noll kronor
   *     (FAR:s M1 i #357). Samma val som VOID-grenen redan gör.
   *   • `total` räknas om FRÅN RADERNAS SUMMA, inte genom att subtrahera
   *     avgiften. Det är raderna som byggt upp totalen, och skulle de någon gång
   *     ha glidit isär är det radernas summa som gör dokumentet konsistent igen.
   *   • Ingen nedskrivningsgrind behövs: `Invoice` saknar `probableLossAt` och
   *     `writtenOffAt` helt — kundförlust finns bara på avi-sidan. Får fakturan
   *     någon gång en sådan väg måste grinden hit, och
   *     `invoices.bad-debt-drift.spec.ts` faller den dagen fältet införs.
   */
  async reverseReminderFee(
    invoiceId: string,
    organizationId: string,
    reason: string,
    actorId: string | null,
    // Se avi-sidans motsvarighet och `impersonatorOf` — spår, inte lösning (#379).
    impersonatedById: string | null = null,
  ) {
    const trimmedReason = reason?.trim() ?? ''
    if (trimmedReason.length < REMINDER_FEE_REVERSAL_REASON_MIN_LENGTH) {
      throw new BadRequestException(
        `Ange varför avgiften stryks (minst ${REMINDER_FEE_REVERSAL_REASON_MIN_LENGTH} tecken). ` +
          'Skälet blir motverifikatets beskrivning i huvudboken och går inte att ändra efteråt.',
      )
    }

    const invoice = await this.prisma.invoice.findFirst({
      where: { id: invoiceId, organizationId },
      include: {
        lines: true,
        payments: { select: { amount: true } },
        creditNotes: { select: { total: true } },
      },
    })
    if (!invoice) throw new NotFoundException('Faktura hittades inte')

    const feeLines = invoice.lines.filter((l) => l.description === REMINDER_FEE_LINE_DESCRIPTION)
    if (feeLines.length === 0) {
      throw new BadRequestException('Fakturan bär ingen påminnelseavgift att stryka')
    }
    const feeSum = feeLines.reduce(
      (sum, l) => sum.plus(new Prisma.Decimal(l.total)),
      new Prisma.Decimal(0),
    )

    // Aritmetiska gränsen — samma som avi-sidan: strykningen får inte kunna
    // skapa en överbetalning, eftersom `invoiceOutstanding` klampar den till 0
    // och pengarna blir osynliga (#378).
    //
    // Meddelandet nedan förklarar SAKEN och nämner inte ärendenumret: #378 är
    // vår arbetslista, inte hyresvärdens. Spåret ligger i den här kommentaren.
    const paid = invoice.payments.reduce(
      (sum, p) => sum.plus(new Prisma.Decimal(p.amount)),
      new Prisma.Decimal(0),
    )
    const takWithoutFee = new Prisma.Decimal(invoice.total).minus(feeSum)
    if (paid.greaterThan(takWithoutFee)) {
      throw new BadRequestException(
        `Avgiften kan inte strykas: betalt belopp (${paid.toFixed(2)} kr) överstiger ` +
          `fakturans belopp utan avgiften (${takWithoutFee.toFixed(2)} kr), så strykningen ` +
          `skulle skapa en överbetalning på ${paid.minus(takWithoutFee).toFixed(2)} kr. ` +
          'Ett överskjutande belopp kan inte bokföras i dag och skulle bli osynligt ' +
          'i fakturans saldo. Avmatcha eller återbetala betalningen först.',
      )
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.invoiceLine.deleteMany({ where: { id: { in: feeLines.map((l) => l.id) } } })

      // Totalen HÄRLEDS ur de kvarvarande raderna.
      const kvar = await tx.invoiceLine.findMany({
        where: { invoiceId },
        select: { total: true },
      })
      const nyTotal = kvar.reduce(
        (sum, l) => sum.plus(new Prisma.Decimal(l.total)),
        new Prisma.Decimal(0),
      )
      // #363: `subtotal` följer med. Den räknas RELATIVT medan `total` sätts
      // absolut, och det är avsiktligt: totalen går att härleda ur raderna
      // (varje rad bär sitt bruttobelopp), men nettot gör det inte utan att
      // dela upp varje rad i net/moms med samma avrundning som
      // `computeInvoiceAmounts` — en dubblering av den logiken här vore en
      // andra sanningskälla för momsen. Avgiften är momsfri, så det som
      // försvinner ur nettot är exakt `feeSum`, och `vatTotal` står still.
      await tx.invoice.update({
        where: { id: invoiceId },
        data: { total: nyTotal, subtotal: { decrement: feeSum } },
      })

      await this.accountingService.reverseJournalEntryForReminderFee(
        'INVOICE',
        invoiceId,
        organizationId,
        `Struken påminnelseavgift (${trimmedReason})`,
        actorId,
        tx,
      )

      await this.eventsService.record(
        invoiceId,
        'REMINDER_FEE_REVERSED',
        actorId ? 'USER' : 'SYSTEM',
        actorId,
        {
          amount: feeSum.toNumber(),
          reason: trimmedReason,
          ...(impersonatedById ? { impersonatedBy: impersonatedById } : {}),
        },
        { tx },
      )
    }, PRISMA_DEFAULT_TX_LIMITS)

    return this.findOne(invoiceId, organizationId)
  }

  /**
   * EN SPÄRR, TVÅ NAMNGIVNA GRENAR — hyra och allt annat är olika frågor.
   *
   * Två parallella vägar hade glidit isär; två grenar med skälet vid var och en
   * gör det inte. Skillnaden mellan dem är inte teknisk utan domänens: den ena
   * halvan HAR en nyckel, den andra har ingen.
   */
  private async assertNoDuplicateInvoice(
    dto: {
      type?: string
      issueDate: string | Date
      dueDate: string | Date
      lines: Array<{ description: string; quantity: number; unitPrice: number; vatRate: number }>
    },
    leaseId: string,
  ): Promise<void> {
    // ── GREN 1: HYRA HAR EN DOMÄNNYCKEL — (avtal, period) ────────────────────
    //
    // Hyra faktureras en gång per avtal och period. Det är inte vår konvention
    // utan hur ett hyresförhållande fungerar, och därför en nyckel som inte kan
    // bli för grov: två hyreskrav för samma avtal och samma månad är aldrig två
    // affärshändelser.
    if (dto.type === 'RENT') {
      const period = new Date(dto.issueDate)
      const { month, year } = stockholmCivilDate(period)

      // ⚠️ POPULATIONEN VAR HALV. Spärren frågade bara `RentNotice`, alltså
      // "har avisering redan tagit den här perioden?". Den kunde INTE se en
      // andra MANUELL faktura: två `create_invoice` med samma avtal och period
      // passerade båda så länge ingen avi fanns, och bokförde hyran två gånger.
      //
      // Nyckeln fanns alltså redan och var rätt — den ställdes bara mot fel
      // mängd rader. Båda tabellerna kan bära perioden, så båda måste frågas.
      const [existingNotice, existingInvoice] = await Promise.all([
        this.prisma.rentNotice.findFirst({
          where: {
            leaseId,
            // Bara HYRES-avin riskerar dubbelbokas — en DEPOSIT-avi för samma
            // period (som avisering skapar vid tillträde) ska inte falskblockera.
            type: 'RENT',
            // Svensk civil tid — annars kunde en avi daterad 1 januari matchas
            // mot december och dubblettspärren missa (eller falskblockera).
            month,
            year,
            status: { not: 'CANCELLED' },
          },
          select: { id: true },
        }),
        this.prisma.invoice.findFirst({
          where: {
            leaseId,
            type: 'RENT',
            // Samma civila månad, uttryckt som ett intervall: `issueDate` är en
            // DATE-kolumn och bär ingen månad att jämföra direkt mot.
            issueDate: {
              gte: new Date(Date.UTC(year, month - 1, 1)),
              lt: new Date(Date.UTC(year, month, 1)),
            },
            // En makulerad faktura gör inte längre anspråk på perioden, och en
            // ny för samma månad är då en legitim andra handling. Samma
            // resonemang som CANCELLED ovan.
            status: { not: 'VOID' },
          },
          select: { id: true },
        }),
      ])

      // ── KÄND GRÄNS: AVI-HALVAN ÄR OCH FÖRBLIR EN LÄSNING ────────────────
      //
      // Faktura-mot-faktura är sedan #b2 DB-enforcerat: `invoice_rent_period_unique`
      // gör två samtidiga `create_invoice` för samma avtal och period omöjliga.
      //
      // Faktura-mot-AVI kan inte bli det. Perioden bärs av TVÅ tabeller —
      // `RentNotice.month/year` och `Invoice.rentPeriodYear/Month` — och ett
      // unikt villkor kan bara spänna en tabell. Uppslaget nedan är därför en
      // läsning före en skrivning, och två samtidiga körningar kan båda passera.
      //
      // NÄR BLIR DET VERKLIGT: en operatör triggar `generateMonthlyNotices` från
      // controllern i samma sekund som AI:n skapar en manuell hyresfaktura för
      // samma avtal och månad. Avigenereringen kör både från cron (månadsvis)
      // och från ett HTTP-anrop, så det kräver ingen olycklig cron-timing —
      // bara två personer, eller en person och en modell, samtidigt.
      //
      // DEN RIKTIGA LÖSNINGEN vore en gemensam ANSPRÅKSTABELL som båda vägarna
      // skriver i (avtal + period + typ, unikt), så att avi och faktura tar
      // samma rad. Det är en strukturell ändring, inte en spärr, och den är
      // därför ett eget ärende — se #658.
      //
      // Ett rådgivande Redis-lås övervägdes och valdes bort: det hade smalnat
      // fönstret utan att upprätthålla invarianten, och en läsare som ser ett
      // lås slutar leta efter den riktiga fixen.
      if (existingNotice) {
        throw new ConflictException(
          'Hyresavtalet har redan en hyresavi för denna period — fakturera hyra via ' +
            'avisering (Generera avier), inte som manuell faktura.',
        )
      }
      if (existingInvoice) {
        throw new ConflictException(DUBBEL_HYRESFAKTURA_TEXT)
      }
      return
    }

    // ── GREN 2: INGEN NYCKEL — MEN ETT KORT FÖNSTER, OCH SKÄLET ÄR MÄTT ─────
    //
    // Två identiska serviceavgifter på samma avtal är i domänen två legitima
    // krav: ingenting i datan skiljer dem åt. En NYCKEL här hade fabricerat en
    // skillnad som inte finns och tyst kastat den andra fakturan.
    //
    // ⚠️ MEN GRENEN KAN INTE STÅ TOM, och det visste jag inte förrän jag mätte:
    // `create()` bokför intäktsverifikatet i SAMMA transaktion som fakturan —
    // även för ett utkast (se createJournalEntryForInvoice nedan, T5 A1). En
    // oavsiktlig dubblett dubbelbokför alltså intäkten och kundfordran; den är
    // inte en extra rad i en lista utan ett fel i huvudboken.
    //
    // ASYMMETRIN GÅR ÅT BÅDA HÅLL HÄR, till skillnad från felanmälan. För grovt
    // = en verklig andra avgift försvinner, hyresgästen underdebiteras och
    // intäkten uteblir. För fint = dubbelbokföring. Båda är bokföringsfel.
    //
    // Därför: ett KORT fönster på det som är ett omtags signatur — samma avtal,
    // typ, belopp och förfallodag — och ett svar i stället för ett tyst hopp, så
    // att en verklig andra avgift kan skrivas om.
    //
    // TALET ÄR RESONERAT, INTE MÄTT: produktionen har noll fakturor. Ett omtag
    // är ett modellvarv (ensiffriga sekunder); två skilda avgifter med exakt
    // samma belopp och förfallodag skrivs inte av en människa på en minut.
    // Samma tal som felanmälningsfönstret, av samma skäl — men mätt om den dag
    // det finns fakturor att mäta på.
    //
    // RADBESKRIVNINGARNA STÅR UTANFÖR signaturen med flit: modellen formulerar
    // om dem vid ett omtag, och en nämnare som innehåller dem hade blivit för
    // fin och dedupat ingenting.
    const sedan = new Date(Date.now() - DUBBLETT_FAKTURA_FONSTER_MS)
    const färsk = await this.prisma.invoice.findFirst({
      where: {
        leaseId,
        type: dto.type as never,
        total: computeInvoiceAmounts(dto.lines).total,
        dueDate: new Date(dto.dueDate),
        status: { not: 'VOID' },
        creditedInvoiceId: null,
        createdAt: { gt: sedan },
      },
      select: { invoiceNumber: true },
    })
    if (färsk) {
      throw new ConflictException(
        `En faktura på samma belopp och förfallodag skapades för det här avtalet ` +
          `för mindre än en minut sedan (${färsk.invoiceNumber}). Ingen ny faktura har ` +
          `skapats.\n\nÄr det en VERKLIG andra avgift: vänta en minut, eller skriv ` +
          `ett belopp eller förfallodatum som skiljer dem åt.`,
      )
    }
  }

  /**
   * Registrera en manuell betalning på en faktura (utan bankavstämning).
   *
   * Denna väg måste GARANTERA att inbetalningen bokförs. Annars markeras fakturan
   * som betald medan 1510 (Kundfordringar) står kvar öppen: en affärshändelse utan
   * verifikation (BFL 5 kap 6 §).
   *
   * ── ATOMICITET (#288) ──────────────────────────────────────────────────────
   *
   * Allt som skrivs — claim, allokering, verifikat och händelsepost — ligger i EN
   * transaktion med radlås. Docblocken sa tidigare att mönstret "speglar
   * AviseringService.markAsPaid: atomisk status-claim → bokför → ångra statusen om
   * verifikatet uteblir". Det stämde: bägge vägarna bar samma KOMPENSERANDE
   * mönster, och avi-vägen skrevs om i #108/#289 just för att det inte håller.
   *
   * Kompensationen förutsätter att processen lever tillräckligt länge för att köra
   * sitt catch — precis vad en SIGKILL, en OOM-dödad container eller en
   * deploy-omstart bryter. Två halvtillstånd kunde överleva:
   *
   *   • allokering utan verifikat → en verklig inbetalning saknar post i
   *     huvudboken. Permanent, ingen självläkning.
   *   • PAID/PARTIAL utan allokering → fakturan ser reglerad ut medan fordran
   *     kvarstår på 1510.
   *
   * RADLÅSET GÖR OCKSÅ SYSKONVÄGENS LÖFTE SANT. `claimPaidWithinTx` (bankvägen)
   * tar `FOR UPDATE` och dess docblock påstod att det serialiserar mot en samtidig
   * markAsPaidManually — men den manuella vägen tog aldrig något lås, så skyddet
   * vilade ensamt på status-guarden i claimen. Nu tar båda vägarna samma lås på
   * samma rad, och påståendet håller.
   *
   * All validering ligger INNANFÖR låset — till skillnad från avi-vägen behövs
   * ingen separat preflight, eftersom varje kontroll läser just den rad vi låser.
   * Statusen kan alltså inte hinna ändras mellan kontroll och claim.
   */
  async markAsPaidManually(
    id: string,
    organizationId: string,
    paymentMethod: PaymentMethod,
    actorId: string | null,
    actorType: 'USER' | 'SYSTEM',
    opts: { enteredAmount?: number; reference?: string; paidAt?: Date } = {},
  ): Promise<Invoice> {
    const paymentDate = opts.paidAt ?? new Date()

    const utfall = await this.prisma.$transaction(
      async (tx) => {
        // Rad-lås FÖRST — serialiserar mot bankvägens claimPaidWithinTx och mot
        // andra manuella registreringar på samma faktura.
        await tx.$queryRaw`SELECT id FROM "Invoice" WHERE id = ${id} AND "organizationId" = ${organizationId} FOR UPDATE`

        const invoice = await tx.invoice.findFirst({
          where: { id, organizationId },
          select: {
            id: true,
            status: true,
            invoiceNumber: true,
            total: true,
            isCreditNote: true,
          },
        })
        if (!invoice) throw new NotFoundException('Faktura hittades inte')
        // #517 — en kreditnota är inget betalbart dokument. Den saknar OCR, så
        // bankvägen kan aldrig hitta hit; den här spärren stänger den MANUELLA
        // vägen, som bara nyckar på status och annars hade tagit emot en
        // betalning mot ett dokument som inte utgör någon fordran.
        if (invoice.isCreditNote) {
          throw new BadRequestException(
            'En kreditnota kan inte betalas — den minskar en fordran, den skapar ingen.',
          )
        }
        if (invoice.status === 'PAID') throw new BadRequestException('Fakturan är redan betald')

        const previousStatus = invoice.status as InvoiceStatus
        // STATUSVALIDERINGEN LIGGER LÄNGRE NED (#307 C) — den kan inte göras här.
        //
        // Här stod tidigare `isValidTransition(invoice.status, 'PAID')`. Kontrollen
        // avsåg en annan övergång än den koden sedan utförde: målstatusen beror på
        // om betalningen REGLERAR fakturan, och det vet vi först när restskulden är
        // beräknad (`debtAfter`, nedan). Se invoice-payment-status.ts för vad den
        // divergensen kostade. Valideringen sker därför på `newStatus` — samma värde
        // som skrivs — så fort det värdet finns.

        // ── C5: beloppet STYR bokföringen ────────────────────────────────────
        //
        // Tidigare stod här `const settlementAmount = Number(invoice.total)` med
        // kommentaren att det inmatade beloppet "sparas i händelseloggen för
        // spårbarhet men styr inte bokföringen". En operatör som registrerade en
        // delbetalning på 500 kr mot en faktura på 10 000 kr bokförde alltså
        // 10 000 kr mot likvidkontot och flippade fakturan till PAID.
        //
        // Nu: det mottagna beloppet allokeras mot fakturan (InvoicePayment) och
        // bokförs som det är. Utelämnat belopp = "betala resten", vilket bevarar
        // det tidigare beteendet för den vanliga full-betalningen.
        //
        // Läsningen ligger INNANFÖR låset (#288): låg den utanför kunde en
        // samtidig bankmatchning skriva en allokering emellan och göra
        // restskulden — och därmed både överbetalningskontrollen och
        // completesInvoice — beräknad på inaktuell grund.
        const priorAllocations = await tx.invoicePayment.findMany({
          where: { invoiceId: id },
          select: { amount: true },
        })
        const priorCreditNotes = await tx.invoice.findMany({
          where: { creditedInvoiceId: id },
          select: { total: true },
        })
        const debtBefore = computeInvoiceDebt({
          total: invoice.total,
          allocations: priorAllocations.map((a) => a.amount),
          // #517 — läses innanför låset av exakt samma skäl som allokeringarna
          // ovan. Krediteringen sänker restskulden, och både
          // överbetalningskontrollen och `completesInvoice` måste se den.
          credits: priorCreditNotes.map((c) => c.total),
        })
        const settlement =
          opts.enteredAmount != null
            ? new Prisma.Decimal(opts.enteredAmount)
            : debtBefore.outstanding

        // De tre kontrollerna låg tidigare inline här. De bor nu i
        // `assertPaymentWithinDebt` och DELAS med avins manuella väg, som saknade
        // dem helt (H4: överbetalning där gav negativ kundfordran). Två kopior av
        // samma regel divergerar — se kommentaren i hjälparen.
        //
        // Meddelandena är därmed subjektsneutrala: "restskulden", inte "fakturans
        // restskuld". Talen står kvar i texten, vilket är det som hjälper den som
        // skrev fel belopp.
        assertPaymentWithinDebt(settlement, debtBefore.outstanding)

        // ── OAVSIKTLIG DUBBLETT: ETT KORT FÖNSTER, INTE EN NYCKEL ───────────
        //
        // Innehållet kan inte identifiera en manuell betalning — två lika
        // delposter på samma faktura ÄR identiska i domänen, och att införa en
        // kolumn som skiljer dem hade fabricerat en skillnad som inte finns.
        // Hela resonemanget, med talen bakom fönstret, står i hjälparen.
        //
        // Ligger HÄR och inte hos anroparen: innanför transaktionen och efter
        // `FOR UPDATE` ovan, så att två samtidiga registreringar serialiseras
        // i stället för att båda passera en läsning. Och den gäller båda
        // manuella anroparna — AI-verktyget och `POST /:id/pay` — eftersom en
        // dubbelsubmit är lika fel oavsett vem som gjorde den.
        await assertNoRecentIdenticalManualPayment(tx, {
          invoiceId: id,
          amount: settlement,
          nu: new Date(),
        })

        const debtAfter = computeInvoiceDebt({
          total: invoice.total,
          allocations: [...priorAllocations.map((a) => a.amount), settlement],
          credits: priorCreditNotes.map((c) => c.total),
        })
        const completesInvoice = debtAfter.isSettled
        // EN uträkning av målstatusen — samma värde valideras, skrivs och loggas.
        const newStatus = paymentTargetStatus(previousStatus, completesInvoice)

        // Valideringen avser nu exakt den övergång som utförs på raden nedan.
        // Delbetalning mot en inkassofaktura ger newStatus === previousStatus:
        // ingen övergång, inget som ska valideras mot statusmaskinen.
        if (!isPaymentTransitionAllowed(previousStatus, newStatus)) {
          throw new BadRequestException(
            `Kan inte registrera betalning: statusövergången ${previousStatus} → ${newStatus} är inte tillåten`,
          )
        }

        // 1. Atomisk, race-säker status-claim.
        //
        //    WHERE nyckas på `previousStatus` — INTE på `PAYABLE_STATUSES`. Det är
        //    den strukturella halvan av #307 C: claimen får bara träffa om raden
        //    fortfarande står i exakt den status vi validerade övergången FRÅN.
        //    Med en bred tillåtlista i WHERE kunde den validerade och den utförda
        //    övergången avse olika utgångsstatusar; nu är de per konstruktion samma.
        //    (Under radlåset ovan kan statusen inte hinna ändras — guarden är
        //    därför ett bevis på plats, inte en aktiv kodväg. Jfr säkerhetsnätet i
        //    markSentToCollection.)
        const claim = await tx.invoice.updateMany({
          where: { id, organizationId, status: previousStatus },
          data: {
            status: newStatus,
            // paidAt sätts bara när fakturan faktiskt är reglerad — en delbetalning
            // gör inte fakturan betald.
            ...(completesInvoice ? { paidAt: paymentDate } : {}),
          },
        })
        if (claim.count === 0) {
          // En parallell process (bankavstämning, makulering) hann reglera/avbryta fakturan.
          throw new ConflictException(
            'Fakturan är redan reglerad eller makulerad — uppdatera sidan och försök igen',
          )
        }

        // 2. Allokering + bokföring. Ingen kompensation längre: kastar något
        //    härifrån rullar transaktionen tillbaka claimen med.
        const allocation = await tx.invoicePayment.create({
          data: {
            invoiceId: id,
            amount: settlement,
            paidAt: paymentDate,
            source: 'MANUAL',
          },
        })

        // #290 (KRITISK): verifikatets idempotens nycklas på ALLOKERINGEN, inte
        // på fakturan — annars bokförs en ANDRA delbetalning aldrig
        // (sourceId-kollision → createNumberedEntry returnerar den förstas
        // verifikat, callern ser ett icke-null-svar och fakturan flippas till
        // PAID) och 1510 understiger Σ allokeringar. Samma nyckelform som
        // avi-vägen. Se createJournalEntryForInvoiceManualPayment.
        const entry = await this.accountingService.createJournalEntryForInvoiceManualPayment(
          { id: invoice.id, invoiceNumber: invoice.invoiceNumber },
          settlement.toNumber(),
          paymentDate,
          paymentMethod,
          organizationId,
          actorId,
          allocation.id,
          tx,
        )
        // null = saknat likvidkonto/1510 → bokföringsfel, inte ett giltigt no-op.
        if (entry === null) {
          throw new InternalServerErrorException(
            `Betalningsverifikat kunde inte skapas för faktura ${invoice.invoiceNumber} — ` +
              'kontrollera att kontoplanen innehåller konto 1510 och rätt likvidkonto.',
          )
        }

        // 3. Append-only händelse i SAMMA transaktion.
        //
        // Avi-vägen (#289) skriver sin trail EFTER commit; här ligger den innanför,
        // och det är avsiktligt. Skillnaden är vad posten ÄR: där en villkorad
        // spårrad om ett nollställt kravsteg, här själva betalningsposten i
        // fakturans append-only logg. Bankvägens claimPaidWithinTx skriver redan
        // sin PAYMENT_RECEIVED innanför transaktionen — låg den manuella vägens
        // utanför skulle två vägar som skriver samma sorts post ge olika garanti,
        // och en krasch mellan commit och loggskrivning lämna en betalning utan
        // spår i loggen.
        await this.eventsService.record(
          id,
          completesInvoice ? 'PAYMENT_RECEIVED' : 'PAYMENT_PARTIAL',
          actorType,
          actorId,
          {
            previousStatus,
            newStatus,
            settlementAmount: settlement.toNumber(),
            outstandingAfter: debtAfter.outstanding.toNumber(),
            paymentMethod,
            ...(opts.enteredAmount != null ? { amount: opts.enteredAmount } : {}),
            ...(opts.reference ? { reference: opts.reference } : {}),
            paidAt: paymentDate.toISOString(),
          },
          { tx },
        )

        return {
          completesInvoice,
          invoiceId: invoice.id,
          invoiceNumber: invoice.invoiceNumber,
        }
      },
      {
        // ── Varför explicita gränser på transaktionen (#288) ──────────────────
        //
        // Samma skäl som avi-vägen (#289): atomiciteten håller radlåset över ett
        // tiotal tur-och-retur i stället för ett par, och en svälten transaktion
        // ska FAILA TYDLIGT (P2028) i stället för att hänga. Ingen deadlock —
        // låsordningen faktura → verifikationsnummer-sekvens är identisk i alla
        // betalvägar.
        //
        // Värdena är MÄTTA FÖR DEN HÄR VÄGEN, inte kopierade från avi-vägen: den
        // skriver dessutom en händelsepost innanför låset, alltså fler rundor.
        //
        // 12 fulla betalningar mot eken_dev MED SKARP AccountingService (inte
        // stubbad — en stubbad mätning utelämnar bokföringens rundor och gav här
        // 5,7 ms, alltså knappt en tredjedel av sanningen): median 16,5 ms,
        // långsammaste 83,0 ms. Produktion går över nät i stället för loopback —
        // räkna med en storleksordning mer.
        //
        //   timeout 8 s — generöst över det projicerade värsta fallet, långt under
        //     det som läser som en hängning. Något över Prismas 5 s-default med
        //     flit: att avbryta en betalning som nästan är klar kostar mer än att
        //     vänta en stund till.
        //   maxWait 3 s — tid att få en anslutning ur poolen. Är poolen slut så
        //     länge är det ett systemfel som ska synas, inte köas.
        //
        // Talen bor i PAYMENT_TX_LIMITS — härledningen (band, inte multiplikator)
        // och regeln för att ändra dem står i dess docblock. Mätningen ovan är
        // kvar här för att den gäller just DEN HÄR vägen.
        ...PAYMENT_TX_LIMITS,
      },
    )

    // Notifikationen ligger UTANFÖR transaktionen — den skickar e-post och får
    // inte gå iväg för en betalning som rullas tillbaka.
    if (utfall.completesInvoice) {
      this.notifyInvoicePaid(organizationId, utfall.invoiceId, utfall.invoiceNumber)
    }

    return this.prisma.invoice.findFirstOrThrow({ where: { id, organizationId } })
  }

  /**
   * Atomisk PAID-claim på en faktura INOM en pågående transaktion — anropas av
   * bankavstämningens applyMatchToInvoice. Rad-lås (FOR UPDATE) + status-guard
   * serialiserar mot en samtidig manuell betalning (markAsPaidManually) så samma
   * faktura aldrig kan dubbelbokföras (BFL 4 kap 2 §).
   *
   * DET PÅSTÅENDET BLEV SANT FÖRST MED #288. Fram till dess tog den manuella vägen
   * inget lås alls — serialiseringen vilade ensamt på dess status-guard, och en
   * samtidig manuell betalning kunde läsa restskulden på inaktuell grund. Nu tar
   * båda vägarna samma `FOR UPDATE` på samma rad.
   *
   * PAYMENT_RECEIVED-eventet
   * skrivs i SAMMA tx. Bokföring och notis ligger UTANFÖR (callern bokför i samma
   * tx och notifierar först efter commit) så att ett bokföringsfel rullar tillbaka
   * hela claimen — ingen faktura kan bli PAID utan verifikat.
   *
   * Returnerar claimed=false om fakturan redan var reglerad/makulerad (callern
   * bokför då inget och låter matchningen falla).
   */
  async claimPaidWithinTx(
    tx: Prisma.TransactionClient,
    id: string,
    organizationId: string,
    paidAt: Date,
    actorId: string | null,
    actorType: 'USER' | 'SYSTEM',
    eventPayload: Record<string, unknown> = {},
  ): Promise<{ claimed: boolean; invoiceNumber: string }> {
    // Rad-lås först: serialiserar mot en samtidig markAsPaidManually eller annan import.
    await tx.$queryRaw`SELECT id FROM "Invoice" WHERE id = ${id} AND "organizationId" = ${organizationId} FOR UPDATE`

    const invoice = await tx.invoice.findFirst({
      where: { id, organizationId },
      select: { id: true, status: true, invoiceNumber: true },
    })
    if (!invoice) throw new NotFoundException('Faktura hittades inte')

    // Bara öppna fakturor kan ta emot en betalning (status-guard = idempotens + race-skydd).
    if (!PAYABLE_STATUSES.includes(invoice.status as InvoiceStatus)) {
      return { claimed: false, invoiceNumber: invoice.invoiceNumber }
    }

    await tx.invoice.updateMany({
      where: { id, organizationId, status: { in: PAYABLE_STATUSES } },
      data: { status: 'PAID', paidAt },
    })

    await this.eventsService.record(
      id,
      'PAYMENT_RECEIVED',
      actorType,
      actorId,
      {
        previousStatus: invoice.status,
        newStatus: 'PAID',
        paidAt: paidAt.toISOString(),
        ...eventPayload,
      },
      { tx },
    )

    return { claimed: true, invoiceNumber: invoice.invoiceNumber }
  }

  /** Fire-and-forget INVOICE_PAID-notis till alla org-användare (påverkar aldrig svaret). */
  notifyInvoicePaid(organizationId: string, invoiceId: string, invoiceNumber: string): void {
    void this.notificationsService
      .createForAllOrgUsers(
        organizationId,
        'INVOICE_PAID',
        'Faktura betald',
        `Faktura ${invoiceNumber} har betalats`,
        { relatedEntityType: 'INVOICE', relatedEntityId: invoiceId },
      )
      .catch((err) => this.logger.error(`Notification error: ${String(err)}`))
  }

  /**
   * Registrera att en inloggad användare har öppnat fakturan i systemet.
   * Fire-and-forget – påverkar aldrig API-svaret.
   */
  recordView(invoiceId: string, actorId: string): void {
    this.eventsService
      .record(invoiceId, 'VIEWED_BY_USER', 'USER', actorId, {})
      .catch((err) =>
        this.logger.error('View tracking error', err instanceof Error ? err.stack : String(err)),
      )
  }

  /**
   * Generera PDF och skicka faktura via e-post till hyresgästen.
   * Om fakturan är DRAFT övergår den till SENT automatiskt.
   */
  /**
   * Validerar fakturan och köar utskicket. Själva PDF-renderingen + mejlet
   * sker i PdfWorker (processInvoiceSendJob) så HTTP-svaret returneras direkt
   * (202) i stället för att blockera tills Chromium renderat klart.
   */
  async sendInvoiceEmail(
    id: string,
    organizationId: string,
    userId: string,
  ): Promise<{ jobId: string }> {
    const invoice = await this.prisma.invoice.findFirst({
      where: { id, organizationId },
      include: {
        tenant: { select: SAFE_TENANT_SELECT },
        customer: { select: SAFE_CUSTOMER_SELECT },
      },
    })
    if (!invoice) throw new NotFoundException('Faktura hittades inte')
    if (invoice.status === 'VOID' || invoice.status === 'PAID') {
      throw new BadRequestException('Fakturan kan inte skickas i nuvarande status')
    }

    // En faktura har antingen tenant eller customer (XOR-constraint).
    const recipient = invoice.tenant ?? invoice.customer
    if (!recipient) throw new BadRequestException('Fakturan saknar mottagare')
    if (!recipient.email) throw new BadRequestException('Mottagaren saknar e-postadress')

    const jobId = await this.pdfQueue.enqueue({
      kind: 'invoice-send',
      organizationId,
      invoiceId: id,
      actorId: userId,
    })
    return { jobId }
  }

  /**
   * Renderar faktura-PDF, köar mejlet och gör statusövergången DRAFT→SENT.
   * Anropas av PdfWorker. Idempotent: en faktura som hunnit bli VOID/PAID
   * hoppas tyst över, och mejlet har en idempotencyKey så en Bull-retry
   * (efter t.ex. ett fel i statusövergången) aldrig ger ett dubbelmejl.
   */
  async processInvoiceSendJob(id: string, organizationId: string, userId: string): Promise<void> {
    const invoice = await this.prisma.invoice.findFirst({
      where: { id, organizationId },
      include: {
        lines: true,
        tenant: { select: SAFE_TENANT_SELECT },
        customer: { select: SAFE_CUSTOMER_SELECT },
        organization: true,
      },
    })
    if (!invoice) throw new NotFoundException('Faktura hittades inte')

    // Status kan ha ändrats mellan enqueue och körning — hoppa tyst över.
    if (invoice.status === 'VOID' || invoice.status === 'PAID') {
      this.logger.warn(`[pdf] hoppar över invoice-send för ${id} — status ${invoice.status}`)
      return
    }

    const recipient = invoice.tenant ?? invoice.customer
    if (!recipient?.email) {
      // Permanent fel — markera synligt UTAN att kasta, annars gör Bull fem
      // meningslösa retries. Samma resonemang som avisering vid saknad e-post.
      await this.recordSendFailure(id, 'Fakturan saknar mottagare med e-postadress')
      return
    }

    try {
      const pdfBuffer = await this.pdfService.generateInvoicePdf(id, organizationId)

      const recipientName =
        recipient.type === 'INDIVIDUAL'
          ? [recipient.firstName, recipient.lastName].filter(Boolean).join(' ')
          : (recipient.companyName ?? recipient.email)

      await this.mailService.sendInvoice({
        to: recipient.email,
        organizationId,
        tenantName: recipientName,
        invoiceNumber: invoice.invoiceNumber,
        total: Number(invoice.total),
        dueDate: invoice.dueDate,
        pdfBuffer,
        organizationName: invoice.organization.name,
        accentColor: invoice.organization.invoiceColor ?? DEFAULT_BRAND_COLOR,
        idempotencyKey: `invoice-send-${id}`,
      })

      // Transition DRAFT → SENT
      if (invoice.status === 'DRAFT') {
        await this.transitionStatus(id, organizationId, 'SENT', userId, 'USER')
      } else {
        // Record send event without status transition
        await this.eventsService.record(id, 'SENT', 'USER', userId, {
          sentTo: recipient.email,
        })
      }

      // Lyckat utskick — nollställ ev. tidigare fel så att UI-varningen försvinner.
      if (invoice.sendError) {
        await this.prisma.invoice.update({ where: { id }, data: { sendError: null } })
      }
    } catch (err) {
      // Transient fel (Puppeteer kraschar, mejlkön/Resend nere) — markera
      // synligt + logga SEND_FAILED, kasta sedan vidare så Bull schemalägger
      // retry (1m→2m→4m→8m). Vid permanent fail blir sendError kvar och syns i
      // UI tills hyresvärden skickar om. Mirror av AviseringService.
      await this.recordSendFailure(id, err instanceof Error ? err.message : String(err))
      throw err
    }
  }

  /**
   * Markerar ett misslyckat faktura-utskick synligt: sätter Invoice.sendError
   * (visas i UI, hyresvärden kan skicka om) och skriver ett immutabelt
   * SEND_FAILED-event i fakturahistoriken. Best-effort — får aldrig dölja det
   * ursprungliga felet; anroparen avgör om jobbet ska retrias eller ej.
   */
  private async recordSendFailure(invoiceId: string, message: string): Promise<void> {
    await this.prisma.invoice
      .update({ where: { id: invoiceId }, data: { sendError: message } })
      .catch((err) => this.logger.error(`Kunde inte spara sendError: ${String(err)}`))
    await this.eventsService
      .record(invoiceId, 'SEND_FAILED', 'SYSTEM', null, { error: message, detail: message })
      .catch((err) => this.logger.error(`Kunde inte logga SEND_FAILED-event: ${String(err)}`))
  }
}
