import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
} from '@nestjs/common'
import type {
  Invoice,
  InvoiceStatus,
  InvoiceEventType,
  PaymentMethod,
  Prisma,
} from '@prisma/client'
import { PrismaService } from '../common/prisma/prisma.service'
import { OcrService } from '../common/ocr/ocr.service'
import { InvoiceEventsService } from './invoice-events.service'
import { PdfService } from './pdf.service'
import { MailService } from '../mail/mail.service'
import { AccountingService, vatRateForRent } from '../accounting/accounting.service'
import { NotificationsService } from '../notifications/notifications.service'
import { isValidTransition } from '@eken/shared'
import { CreateInvoiceDto } from './dto/create-invoice.dto'
import { UpdateInvoiceDto } from './dto/update-invoice.dto'
import { SAFE_TENANT_SELECT } from '../tenants/tenants.service'
import { PdfQueue } from '../pdf-jobs/pdf.queue'

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

// Öresavrundning i beräkningslagret. Belopp lagras till ören (2 decimaler) och
// totalerna HÄRLEDS ur de avrundade radvärdena, så att invarianten
// "Σ rader = total" och "subtotal + moms = total" alltid håller exakt — inte
// bara matematiskt vid full float-precision, utan även efter avrundning på
// utskriften. Tidigare lagrades full precision och visningen rundade varje
// belopp för sig, vilket kunde göra att raderna inte summerade till totalen.
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

interface InvoiceLineInput {
  description: string
  quantity: number
  unitPrice: number
  vatRate: number
}

interface ComputedInvoiceAmounts {
  subtotal: number
  vatTotal: number
  total: number
  lines: Array<InvoiceLineInput & { total: number }>
}

// Per rad: netto och bruttobelopp (inkl. moms) öresavrundas. Radens moms tas som
// (brutto − netto) så ingen separat avrundningsdrift uppstår. subtotal/vatTotal
// summeras ur de avrundade radvärdena och total = subtotal + moms. Då gäller
// alltid total = Σ radbelopp (eftersom netto + moms = brutto per rad).
function computeInvoiceAmounts(lines: InvoiceLineInput[]): ComputedInvoiceAmounts {
  let subtotal = 0
  let vatTotal = 0
  const computed = lines.map((l) => {
    const net = round2(l.quantity * l.unitPrice)
    const gross = round2(l.quantity * l.unitPrice * (1 + l.vatRate / 100))
    const vat = round2(gross - net)
    subtotal = round2(subtotal + net)
    vatTotal = round2(vatTotal + vat)
    return {
      description: l.description,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      vatRate: l.vatRate,
      total: gross,
    }
  })
  return { subtotal, vatTotal, total: round2(subtotal + vatTotal), lines: computed }
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
    return this.prisma.invoice.findMany({
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
          select: { id: true, date: true, amount: true, description: true, rawOcr: true },
          orderBy: { date: 'desc' },
        },
      },
      orderBy: { createdAt: 'desc' },
    })
  }

  async findOne(id: string, organizationId: string) {
    const invoice = await this.prisma.invoice.findFirst({
      where: { id, organizationId },
      include: {
        lines: true,
        tenant: { select: SAFE_TENANT_SELECT },
        customer: true,
        lease: true,
        events: { orderBy: { createdAt: 'asc' } },
        bankTransactions: {
          where: { status: 'MATCHED' },
          orderBy: { date: 'desc' },
        },
      },
    })
    if (!invoice) throw new NotFoundException('Faktura hittades inte')
    return invoice
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
    const year = new Date().getFullYear()
    // Atomär, race-säker allokering via InvoiceNumberSequence (ML 11 kap 8 §:
    // fortlöpande nummerserie). Tidigare count()+1 kunde dela ut samma nummer
    // vid samtidiga anrop och lämna hål vid rollback. UPSERT med increment ger
    // Postgres row-lock; eftersom allokeringen sker i samma transaktion som
    // fakturan skapas blir serien gap-free. Numret är globalt per org (året i
    // F-{år}-{nr} är kosmetiskt) — det bevarar OCR-unikheten som härleds ur
    // sekvensen.
    const row = await tx.invoiceNumberSequence.upsert({
      where: { organizationId },
      create: { organizationId, lastNumber: 1 },
      update: { lastNumber: { increment: 1 } },
      select: { lastNumber: true },
    })
    const sequence = row.lastNumber
    return {
      invoiceNumber: `F-${year}-${String(sequence).padStart(4, '0')}`,
      sequence,
    }
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

      // Momskontroll (ML 1994:200): en momsfri upplåtelse får inte faktureras
      // med moms. Bostad (APARTMENT) är alltid undantagen (ML 3 kap 2 §); lokal
      // utan frivillig skattskyldighet likaså. Annars skulle felaktig moms
      // debiteras hyresgästen och redovisas till staten.
      const allowedVatRate = vatRateForRent(lease.unit.type, lease.unit.voluntaryTaxLiability)
      if (allowedVatRate === 0) {
        // Momsfri upplåtelse får inte faktureras med moms.
        const offending = dto.lines.find((l) => l.vatRate !== 0)
        if (offending) {
          throw new BadRequestException(
            lease.unit.type === 'APARTMENT'
              ? 'Bostadshyra är undantagen från moms enligt ML 3 kap 2 § — vatRate måste vara 0'
              : 'Lokalen saknar frivillig skattskyldighet — hyran är momsfri (ML 3 kap 3 § 2 st). ' +
                  'Sätt frivillig skattskyldighet på enheten eller använd vatRate 0.',
          )
        }
      } else {
        // Omvänd kontroll: en i lag momspliktig upplåtelse får inte faktureras
        // momsfritt — det vore underredovisning av utgående moms till staten.
        const offending = dto.lines.find((l) => l.vatRate !== allowedVatRate)
        if (offending) {
          throw new BadRequestException(
            lease.unit.type === 'PARKING'
              ? `Parkeringsplats är momspliktig enligt ML 3 kap 3 § 5 — vatRate måste vara ${allowedVatRate}`
              : `Lokalen har frivillig skattskyldighet — vatRate måste vara ${allowedVatRate} (ML 9 kap)`,
          )
        }
      }

      // Dubbelbokförings-spärr (BFL 4 kap 2 §): avisering (RentNotice) är den
      // kanoniska hyresmotorn. En manuell RENT-faktura för ett avtal+period som
      // redan aviserats skulle intäktsbokföra samma hyra en andra gång (1510 D /
      // 39xx K två gånger). Blockera — hyra ska faktureras via avisering.
      if (dto.type === 'RENT') {
        const period = new Date(dto.issueDate)
        const existingNotice = await this.prisma.rentNotice.findFirst({
          where: {
            leaseId: lease.id,
            // Bara HYRES-avin riskerar dubbelbokas — en DEPOSIT-avi för samma
            // period (som avisering skapar vid tillträde) ska inte falskblockera.
            type: 'RENT',
            month: period.getUTCMonth() + 1,
            year: period.getUTCFullYear(),
            status: { not: 'CANCELLED' },
          },
          select: { id: true },
        })
        if (existingNotice) {
          throw new ConflictException(
            'Hyresavtalet har redan en hyresavi för denna period — fakturera hyra via ' +
              'avisering (Generera avier), inte som manuell faktura.',
          )
        }
      }

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

    const invoice = await this.prisma.$transaction(async (tx) => {
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

      return created
    })

    // H3 (BFL 5 kap 6 §): bokför intäktsverifikatet SYNKRONT med try/catch —
    // samma mönster som AviseringService.bookRentNoticeRevenue. Tidigare var
    // detta ett fire-and-forget `void ...catch(log)`: om bokföringen kastade
    // (saknad kontoplan, DB-glapp) fanns fakturan kvar UTAN journalpost och
    // utan återhämtning — ett BFL-gap. Saknad kontoplan loggas fortfarande
    // (avin/fakturan är redan skapad) men felet blir nu synligt i request-
    // kedjan i stället för att tystna i en bortglömd promise.
    try {
      await this.accountingService.createJournalEntryForInvoice(invoice, organizationId, actorId)
    } catch (err) {
      this.logger.error(
        `Accounting journal entry failed for invoice ${invoice.invoiceNumber}`,
        err instanceof Error ? err.stack : String(err),
      )
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
    })
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
    const result = await this.prisma.$transaction(async (tx) => {
      const invoice = await tx.invoice.findFirst({
        where: { id, organizationId },
        select: { id: true, status: true, invoiceNumber: true },
      })
      if (!invoice) throw new NotFoundException('Faktura hittades inte')

      if (!isValidTransition(invoice.status as InvoiceStatus, newStatus)) {
        throw new BadRequestException(`Ogiltig statusövergång: ${invoice.status} → ${newStatus}`)
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
      }

      return updated
    })

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
   * Registrera en manuell betalning på en faktura (utan bankavstämning).
   *
   * Till skillnad från bankmatchningen — som bokför via createJournalEntryForPayment
   * SEPARAT efter transitionStatus — måste denna väg GARANTERA att inbetalningen
   * bokförs. Annars markeras fakturan som betald medan 1510 (Kundfordringar) står
   * kvar öppen: en affärshändelse utan verifikation (BFL 5 kap 6 §). Mönstret speglar
   * AviseringService.markAsPaid: atomisk status-claim → bokför → ångra statusen om
   * verifikatet uteblir. Status PAID är terminal (INVOICE_TRANSITIONS) → fakturan
   * regleras i sin helhet, så likvidkontot krediterar 1510 med fakturans totalbelopp.
   */
  async markAsPaidManually(
    id: string,
    organizationId: string,
    paymentMethod: PaymentMethod,
    actorId: string | null,
    actorType: 'USER' | 'SYSTEM',
    opts: { enteredAmount?: number; reference?: string; paidAt?: Date } = {},
  ): Promise<Invoice> {
    const invoice = await this.prisma.invoice.findFirst({
      where: { id, organizationId },
      select: { id: true, status: true, invoiceNumber: true, total: true },
    })
    if (!invoice) throw new NotFoundException('Faktura hittades inte')
    if (invoice.status === 'PAID') throw new BadRequestException('Fakturan är redan betald')
    if (!isValidTransition(invoice.status as InvoiceStatus, 'PAID')) {
      throw new BadRequestException(
        `Kan inte registrera betalning: statusövergången ${invoice.status} → PAID är inte tillåten`,
      )
    }

    const previousStatus = invoice.status as InvoiceStatus
    const paymentDate = opts.paidAt ?? new Date()
    // Status PAID = fakturan reglerad i sin helhet → kreditera 1510 med hela fordran
    // (samma belopp som debiterades vid fakturering). Det inmatade beloppet sparas i
    // händelseloggen för spårbarhet men styr inte bokföringen.
    const settlementAmount = Number(invoice.total)

    // 1. Atomisk, race-säker status-claim — endast från ett betalbart tillstånd.
    const claim = await this.prisma.invoice.updateMany({
      where: { id, organizationId, status: { in: PAYABLE_STATUSES } },
      data: { status: 'PAID', paidAt: paymentDate },
    })
    if (claim.count === 0) {
      // En parallell process (bankavstämning, makulering) hann reglera/avbryta fakturan.
      throw new ConflictException(
        'Fakturan är redan reglerad eller makulerad — uppdatera sidan och försök igen',
      )
    }

    // 2. Bokför betalningen; ångra statusövergången om verifikatet uteblir.
    try {
      const entry = await this.accountingService.createJournalEntryForInvoiceManualPayment(
        { id: invoice.id, invoiceNumber: invoice.invoiceNumber },
        settlementAmount,
        paymentDate,
        paymentMethod,
        organizationId,
        actorId,
      )
      if (entry === null) {
        throw new InternalServerErrorException(
          `Betalningsverifikat kunde inte skapas för faktura ${invoice.invoiceNumber} — ` +
            'kontrollera att kontoplanen innehåller konto 1510 och rätt likvidkonto.',
        )
      }
    } catch (err) {
      // Återställ fakturan till sitt tidigare tillstånd (status-guardad på PAID så vi
      // bara ångrar vår egen claim, inte en betalning en parallell process hunnit boka).
      await this.prisma.invoice
        .updateMany({
          where: { id, organizationId, status: 'PAID' },
          data: { status: previousStatus, paidAt: null },
        })
        .catch((revertErr) => {
          this.logger.error(
            `[Invoices] Kunde inte ångra betalningsstatus för faktura ${invoice.invoiceNumber}: ` +
              `${revertErr instanceof Error ? revertErr.message : String(revertErr)}`,
          )
        })
      throw err
    }

    // 3. Append-only händelse + notifikation (efter lyckad bokning).
    await this.eventsService.record(id, 'PAYMENT_RECEIVED', actorType, actorId, {
      previousStatus,
      newStatus: 'PAID',
      settlementAmount,
      paymentMethod,
      ...(opts.enteredAmount != null ? { amount: opts.enteredAmount } : {}),
      ...(opts.reference ? { reference: opts.reference } : {}),
      paidAt: paymentDate.toISOString(),
    })

    this.notifyInvoicePaid(organizationId, invoice.id, invoice.invoiceNumber)

    return this.prisma.invoice.findFirstOrThrow({ where: { id, organizationId } })
  }

  /**
   * Atomisk PAID-claim på en faktura INOM en pågående transaktion — anropas av
   * bankavstämningens applyMatchToInvoice. Rad-lås (FOR UPDATE) + status-guard
   * serialiserar mot en samtidig manuell betalning (markAsPaidManually) så samma
   * faktura aldrig kan dubbelbokföras (BFL 4 kap 2 §). PAYMENT_RECEIVED-eventet
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
      include: { tenant: { select: SAFE_TENANT_SELECT }, customer: true },
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
        customer: true,
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
        tenantName: recipientName,
        invoiceNumber: invoice.invoiceNumber,
        total: Number(invoice.total),
        dueDate: invoice.dueDate,
        pdfBuffer,
        organizationName: invoice.organization.name,
        accentColor: invoice.organization.invoiceColor ?? '#1a6b3c',
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
