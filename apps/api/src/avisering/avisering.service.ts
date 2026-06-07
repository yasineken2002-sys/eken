import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
} from '@nestjs/common'
import { PrismaService } from '../common/prisma/prisma.service'
import { OcrService } from '../common/ocr/ocr.service'
import { MailService } from '../mail/mail.service'
import { PdfService } from '../invoices/pdf.service'
import { StorageService } from '../storage/storage.service'
import { PdfQueue } from '../pdf-jobs/pdf.queue'
import { AccountingService, vatRateForRent } from '../accounting/accounting.service'
import { ConsumptionService } from '../consumption/consumption.service'
import { rentNoticePayableTotal } from '../common/utils/rent-notice-total.util'
import { PaymentMethod, Prisma, RentNoticeStatus, RentNoticeType } from '@prisma/client'
import type { UnitType } from '@prisma/client'
import type { RentNotice } from '@prisma/client'
import {
  rentDueDateForMonth,
  calculateProratedRent,
  calculateFirstPaymentDueDate,
} from '@eken/shared'
import { SAFE_TENANT_SELECT } from '../tenants/tenants.service'

type NoticeWithRelations = Prisma.RentNoticeGetPayload<{
  include: {
    tenant: { select: typeof SAFE_TENANT_SELECT }
    lease: { include: { unit: { include: { property: true } } } }
    lines: true
  }
}>

export async function getLogoDataUrl(
  storage: StorageService,
  logoStorageKey: string | null,
): Promise<string | null> {
  if (!logoStorageKey) return null
  try {
    const buffer = await storage.getFileBuffer(logoStorageKey)
    const ext = logoStorageKey.split('.').pop()?.toLowerCase() ?? ''
    const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg'
    return `data:${mime};base64,${buffer.toString('base64')}`
  } catch {
    return null
  }
}

function pad2(n: number) {
  return String(n).padStart(2, '0')
}

@Injectable()
export class AviseringService {
  private readonly logger = new Logger(AviseringService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly ocrService: OcrService,
    private readonly mailService: MailService,
    private readonly pdfService: PdfService,
    private readonly storage: StorageService,
    private readonly pdfQueue: PdfQueue,
    private readonly accounting: AccountingService,
    private readonly consumption: ConsumptionService,
  ) {}

  // Beräknar moms på en hyra utifrån enhetens upplåtelsetyp och frivilliga
  // skattskyldighet (ML 1994:200). Bostad → 0 %, lokal → 25 % endast vid
  // frivillig skattskyldighet, parkering → 25 %. Öresavrundning på momsbeloppet.
  //
  // Netto-gate (JB 12 kap 19 § 3 st): moms läggs ENDAST på om hyran uttryckligen
  // är avtalad exkl. moms (lease.monthlyRentExcludingVat). Annars vet vi inte om
  // monthlyRent redan inkluderar moms, och att lägga på 25 % vore en oavtalad
  // hyreshöjning. Är enheten momspliktig men hyran inte markerad netto loggas en
  // varning så att felregistrerade kontrakt kan rättas.
  private rentVat(
    net: number,
    unit: { type: UnitType; voluntaryTaxLiability: boolean },
    lease: { monthlyRentExcludingVat: boolean },
    context?: string,
  ): { vatAmount: number; totalAmount: number } {
    const rate = vatRateForRent(unit.type, unit.voluntaryTaxLiability)
    if (rate === 0) return { vatAmount: 0, totalAmount: net }
    if (!lease.monthlyRentExcludingVat) {
      this.logger.warn(
        `[Moms] Enhet ${unit.type} är momspliktig men hyran är inte markerad som ` +
          `exkl. moms — moms läggs ej på${context ? ` (${context})` : ''}. ` +
          `Kontrollera kontraktsregistreringen.`,
      )
      return { vatAmount: 0, totalAmount: net }
    }
    const vatAmount = Math.round(net * rate) / 100
    return { vatAmount, totalAmount: net + vatAmount }
  }

  // Bokför hyresfordran (intäktsverifikation) för en skapad RENT-avi.
  // BFL kräver att intäkten verifieras när affärshändelsen inträffar — inte
  // först vid betalning. Idempotent i AccountingService; fel loggas men får
  // aldrig fälla avi-genereringen (avin är redan skapad i DB).
  private async bookRentNoticeRevenue(
    orgId: string,
    notice: {
      id: string
      noticeNumber: string
      leaseId: string
      type: RentNoticeType
      amount: Prisma.Decimal | number
      vatAmount: Prisma.Decimal | number
      totalAmount: Prisma.Decimal | number
      year: number
      month: number
    },
  ): Promise<void> {
    if (notice.type === RentNoticeType.DEPOSIT) return
    try {
      await this.accounting.createJournalEntryForRentNotice(notice, orgId, null)
    } catch (err) {
      this.logger.error(
        `[Avisering] Bokföring av hyresavi ${notice.noticeNumber} misslyckades: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }
  }

  // Allokerar nästa avinummer i sekvensen AVI-{year}-{month}-{NNNN}. Vi
  // söker max-suffix per (year, month) och räknar uppåt från den. Detta
  // tål gaps och historik från tidigare format (t.ex. AVI-XXXXXX) — det
  // som spelar roll är att vi får ett ledigt nummer i AVI-{y}-{m}-XXXX.
  //
  // Race-säkerhet: två parallella requests kan teoretiskt hämta samma max
  // och skapa duplicat — vi förlitar oss på @@unique([organizationId,
  // noticeNumber]) och en backoff-retry. För månadscronen körs dock allt
  // sekventiellt.
  private async nextNoticeNumber(
    organizationId: string,
    year: number,
    month: number,
    offset = 0,
  ): Promise<string> {
    const prefix = `AVI-${year}-${pad2(month)}-`
    // SECURITY/korrekthet (H1): scopa sekvensen till organisationen. Utan
    // organizationId-filtret räknades max-sekvensen över ALLA orgars avier,
    // så en ny kunds serie kunde börja på t.ex. AVI-2026-06-0047. Träffar nu
    // @@index([organizationId, noticeNumber]) i stället för full table scan.
    const existing = await this.prisma.rentNotice.findMany({
      where: { organizationId, noticeNumber: { startsWith: prefix } },
      select: { noticeNumber: true },
    })
    let maxSeq = 0
    for (const e of existing) {
      const tail = e.noticeNumber.slice(prefix.length)
      const n = parseInt(tail, 10)
      if (!Number.isNaN(n) && n > maxSeq) maxSeq = n
    }
    const seq = maxSeq + offset + 1
    return `${prefix}${String(seq).padStart(4, '0')}`
  }

  async generateMonthlyNotices(orgId: string, month: number, year: number) {
    const leases = await this.prisma.lease.findMany({
      where: { organizationId: orgId, status: 'ACTIVE' },
      include: {
        tenant: { select: SAFE_TENANT_SELECT },
        unit: { include: { property: true } },
      },
    })

    if (leases.length === 0) {
      return { created: 0, skipped: 0, notices: [] }
    }

    // Idempotens på (lease, year, month, type=RENT) — generering kan köras
    // om utan att dubbla avier skapas (cron-retry, manuell knapptryckning).
    const existing = await this.prisma.rentNotice.findMany({
      where: { organizationId: orgId, month, year, type: RentNoticeType.RENT },
      select: { leaseId: true },
    })
    const existingLeaseIds = new Set(existing.map((n) => n.leaseId))

    let created = 0
    let skipped = 0
    const notices: RentNotice[] = []

    for (const lease of leases) {
      if (existingLeaseIds.has(lease.id)) {
        skipped++
        continue
      }

      // Kontrakt som inte täcker någon dag i månaden hoppas över. Proration
      // tar hand om delmånader (in-/utflyttning).
      const monthEnd = new Date(year, month, 0)
      const monthStart = new Date(year, month - 1, 1)
      if (lease.startDate > monthEnd) {
        skipped++
        continue
      }
      if (lease.endDate && lease.endDate < monthStart) {
        skipped++
        continue
      }

      const proration = calculateProratedRent({
        monthlyRent: Number(lease.monthlyRent),
        year,
        month,
        leaseStart: lease.startDate,
        leaseEnd: lease.endDate,
      })

      if (proration.daysCharged <= 0) {
        skipped++
        continue
      }

      const ocrNumber = await this.ocrService.assignOcrToTenant(lease.tenantId, orgId)
      const noticeNumber = await this.nextNoticeNumber(orgId, year, month, created)
      // Hyreslagen 12 kap. 20 § JB: hyran ska betalas senast sista
      // vardagen i månaden FÖRE den hyresperiod avin avser.
      const dueDate = rentDueDateForMonth(year, month)

      // Moms enligt upplåtelsetyp (ML 3 kap 2 § / 9 kap). Bostad → 0.
      const { vatAmount, totalAmount } = this.rentVat(
        proration.amount,
        lease.unit,
        lease,
        `avi ${noticeNumber}`,
      )

      const notice = await this.prisma.rentNotice.create({
        data: {
          organizationId: orgId,
          tenantId: lease.tenantId,
          leaseId: lease.id,
          noticeNumber,
          ocrNumber,
          month,
          year,
          amount: proration.amount,
          vatAmount,
          totalAmount,
          dueDate,
          status: RentNoticeStatus.PENDING,
          type: RentNoticeType.RENT,
          periodStart: proration.periodStart,
          periodEnd: proration.periodEnd,
          daysCharged: proration.daysCharged,
          totalDays: proration.totalDays,
          isProrated: proration.isProrated,
        },
        include: {
          tenant: { select: SAFE_TENANT_SELECT },
          lease: { include: { unit: { include: { property: true } } } },
        },
      })

      // Intäktsverifikation (BFL): bokför hyresfordran 1510 D / 39xx K.
      // amount/vatAmount/totalAmount = HYRA → hyresverifikatet bokför bara hyran.
      await this.bookRentNoticeRevenue(orgId, notice)

      // IMD (PR 4): koppla lease:ens redan bokförda förbruknings-charges som
      // avi-rader (2-mån-lag). Sätter RentNotice.consumptionAmount; förbrukningen
      // ingår i betalbar total/OCR men har sitt EGNA verifikat (PR 3) — ingen
      // dubbelbokning här. Presentation, ej bokföring.
      try {
        const consumptionAmount = await this.consumption.attachRentNoticeLineCharges({
          organizationId: orgId,
          leaseId: lease.id,
          rentNoticeId: notice.id,
          aviMonth: month,
          aviYear: year,
        })
        if (consumptionAmount > 0) notice.consumptionAmount = new Prisma.Decimal(consumptionAmount)
      } catch (err) {
        // Misslyckad koppling får inte fälla avi-genereringen — avin (hyra) är
        // skapad och bokförd; charges förblir CONFIRMED och fångas nästa månad.
        this.logger.error(
          `[Avisering] Koppling av förbrukning till avi ${notice.noticeNumber} misslyckades: ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      }

      notices.push(notice as unknown as RentNotice)
      created++
    }

    return { created, skipped, notices }
  }

  // ── Auto-skapa avier vid lease-aktivering (DRAFT → ACTIVE) ────────────────
  // Skapar två avier vid behov: deposition (om depositAmount > 0) och första
  // hyresavi (proportionellt om tillträde mitt i månaden). Båda får samma
  // förfallodag = lease.startDate − daysBeforeMoveInForFirstPayment (org-
  // inställning, default 7), justerat till närmaste vardag bakåt.
  //
  // Idempotent via @@unique(leaseId, year, month, type) på RentNotice — om
  // metoden körs två gånger för samma lease tolkar vi P2002 som "redan
  // skapad" och hämtar befintlig istället.
  async createInitialNoticesForLease(leaseId: string): Promise<{
    deposit: RentNotice | null
    firstRent: RentNotice | null
    mailed: boolean
  }> {
    const lease = await this.prisma.lease.findUnique({
      where: { id: leaseId },
      include: {
        tenant: { select: SAFE_TENANT_SELECT },
        unit: { include: { property: true } },
      },
    })
    if (!lease) throw new NotFoundException('Kontraktet hittades inte')
    if (lease.status !== 'ACTIVE') {
      return { deposit: null, firstRent: null, mailed: false }
    }

    const orgId = lease.organizationId
    // Lease-modellen saknar relation till Organization i schema — vi hämtar
    // separat. Settings-fältet (daysBeforeMoveInForFirstPayment) styr
    // förfallodagens offset från tillträdesdatum.
    const org = await this.prisma.organization.findUnique({
      where: { id: orgId },
      select: { daysBeforeMoveInForFirstPayment: true },
    })
    if (!org) throw new NotFoundException('Organisation hittades inte')

    const startDate = lease.startDate
    const year = startDate.getFullYear()
    const month = startDate.getMonth() + 1

    const dueDate = calculateFirstPaymentDueDate(startDate, org.daysBeforeMoveInForFirstPayment)

    const ocrNumber = await this.ocrService.assignOcrToTenant(lease.tenantId, orgId)

    let depositNotice: RentNotice | null = null
    let firstRentNotice: RentNotice | null = null

    // ── 1. Deposition ────────────────────────────────────────────────────
    const depositAmount = Number(lease.depositAmount ?? 0)
    if (depositAmount > 0) {
      try {
        const noticeNumber = await this.nextNoticeNumber(orgId, year, month)
        depositNotice = (await this.prisma.rentNotice.create({
          data: {
            organizationId: orgId,
            tenantId: lease.tenantId,
            leaseId: lease.id,
            noticeNumber,
            ocrNumber,
            month,
            year,
            amount: depositAmount,
            vatAmount: 0,
            totalAmount: depositAmount,
            dueDate,
            status: RentNoticeStatus.PENDING,
            type: RentNoticeType.DEPOSIT,
          },
        })) as unknown as RentNotice
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          depositNotice = (await this.prisma.rentNotice.findFirst({
            where: { leaseId: lease.id, year, month, type: RentNoticeType.DEPOSIT },
          })) as unknown as RentNotice | null
        } else {
          throw err
        }
      }
    }

    // ── 2. Första hyresavi (delmånad eller hel) ──────────────────────────
    const proration = calculateProratedRent({
      monthlyRent: Number(lease.monthlyRent),
      year,
      month,
      leaseStart: lease.startDate,
      leaseEnd: lease.endDate,
    })

    if (proration.daysCharged > 0) {
      try {
        const noticeNumber = await this.nextNoticeNumber(orgId, year, month, depositNotice ? 1 : 0)
        // Moms enligt upplåtelsetyp (ML 3 kap 2 § / 9 kap). Bostad → 0.
        const { vatAmount, totalAmount } = this.rentVat(
          proration.amount,
          lease.unit,
          lease,
          `avi ${noticeNumber}`,
        )
        firstRentNotice = (await this.prisma.rentNotice.create({
          data: {
            organizationId: orgId,
            tenantId: lease.tenantId,
            leaseId: lease.id,
            noticeNumber,
            ocrNumber,
            month,
            year,
            amount: proration.amount,
            vatAmount,
            totalAmount,
            dueDate,
            status: RentNoticeStatus.PENDING,
            type: RentNoticeType.RENT,
            periodStart: proration.periodStart,
            periodEnd: proration.periodEnd,
            daysCharged: proration.daysCharged,
            totalDays: proration.totalDays,
            isProrated: proration.isProrated,
          },
        })) as unknown as RentNotice
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          firstRentNotice = (await this.prisma.rentNotice.findFirst({
            where: { leaseId: lease.id, year, month, type: RentNoticeType.RENT },
          })) as unknown as RentNotice | null
        } else {
          throw err
        }
      }
    }

    // Intäktsverifikation (BFL): bokför hyresfordran för första hyresavin.
    // Depositionsavin bokförs inte som intäkt (skuld — deposits-modulen).
    if (firstRentNotice) {
      await this.bookRentNoticeRevenue(orgId, firstRentNotice)
    }

    // ── 3. Mejla hyresgästen med båda avier som bilagor ─────────────────
    let mailed = false
    if (lease.tenant.email && (depositNotice || firstRentNotice)) {
      try {
        const idsToSend = [depositNotice?.id, firstRentNotice?.id].filter((id): id is string =>
          Boolean(id),
        )
        const result = await this.sendNotices(orgId, idsToSend)
        mailed = result.queued > 0
      } catch (err) {
        // Mejlfel ska inte krascha lease-aktiveringen — avier är skapade,
        // admin kan trigga "Skicka" manuellt om mejlet failar.
        this.logger.warn(
          `[Avisering] Initial mail failed for lease ${lease.id}: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }

    return { deposit: depositNotice, firstRent: firstRentNotice, mailed }
  }

  /**
   * Köar utskick av hyresavier. Varje avi blir ett eget Bull-jobb — granulär
   * retry, idempotens och inget HTTP-blockerande PDF-rendering. Returnerar
   * direkt med jobb-id:n; workern (processNoticeSendJob) gör renderingen.
   */
  async sendNotices(
    orgId: string,
    noticeIds: string[],
  ): Promise<{ queued: number; jobIds: string[] }> {
    const jobIds: string[] = []
    for (const noticeId of noticeIds) {
      const jobId = await this.pdfQueue.enqueue({
        kind: 'avisering-send',
        organizationId: orgId,
        noticeId,
      })
      jobIds.push(jobId)
    }
    return { queued: jobIds.length, jobIds }
  }

  /**
   * Behandlar EN avi — anropas av PdfWorker. Renderar PDF, köar mejlet och
   * sätter status SENT. Idempotent: redan skickade avier hoppas över så en
   * Bull-retry aldrig ger ett dubbelmejl. Vid fel markeras avin FAILED och
   * felet kastas vidare så Bull kan schemalägga retry.
   */
  async processNoticeSendJob(orgId: string, noticeId: string): Promise<void> {
    const org = await this.prisma.organization.findUnique({ where: { id: orgId } })
    if (!org) throw new NotFoundException('Organisation hittades inte')

    const notice = await this.prisma.rentNotice.findFirst({
      where: { id: noticeId, organizationId: orgId },
      include: {
        tenant: { select: SAFE_TENANT_SELECT },
        lease: { include: { unit: { include: { property: true } } } },
        lines: true,
      },
    })
    if (!notice) throw new NotFoundException('Avi hittades inte')

    // Idempotens: hoppa över avier som redan skickats.
    if (notice.sentAt || notice.status === RentNoticeStatus.SENT) return

    // Saknad e-post är ett permanent fel — markera FAILED utan att kasta,
    // annars gör Bull fem meningslösa retries.
    if (!notice.tenant.email) {
      await this.prisma.rentNotice
        .update({
          where: { id: noticeId },
          data: { status: RentNoticeStatus.FAILED, sendError: 'Hyresgästen saknar e-postadress' },
        })
        .catch(() => undefined)
      return
    }

    try {
      const pdfHtml = await this.buildNoticePdfHtml(notice, org)
      const pdfBuffer = await this.pdfService.generateFromHtml(pdfHtml)

      const tenantName =
        notice.tenant.type === 'INDIVIDUAL'
          ? `${notice.tenant.firstName ?? ''} ${notice.tenant.lastName ?? ''}`.trim()
          : (notice.tenant.companyName ?? notice.tenant.email)

      // Mejlet köas med idempotencyKey så att en Bull-retry (om DB-uppdateringen
      // nedan misslyckas efter att mejlet redan köats) inte ger dubbelmejl.
      await this.mailService.sendRentNotice({
        to: notice.tenant.email,
        tenantName,
        ocrNumber: notice.ocrNumber,
        // Betalbar total = hyra + förbrukning (IMD). Vad hyresgästen ska betala.
        amount: rentNoticePayableTotal(notice),
        dueDate: notice.dueDate,
        pdfBuffer,
        organizationName: org.name,
        noticeNumber: notice.noticeNumber,
        accentColor: org.invoiceColor ?? '#2563EB',
        idempotencyKey: `rent-notice-${notice.id}`,
      })

      await this.prisma.rentNotice.update({
        where: { id: noticeId },
        data: {
          status: RentNoticeStatus.SENT,
          sentAt: new Date(),
          sentTo: notice.tenant.email,
          sendError: null,
        },
      })
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      await this.prisma.rentNotice
        .update({
          where: { id: noticeId },
          data: { status: RentNoticeStatus.FAILED, sendError: errorMessage },
        })
        .catch(() => undefined)
      throw err
    }
  }

  async getNoticePdfBuffer(noticeId: string, orgId: string): Promise<Buffer> {
    const notice = await this.prisma.rentNotice.findFirst({
      where: { id: noticeId, organizationId: orgId },
      include: {
        tenant: { select: SAFE_TENANT_SELECT },
        lease: { include: { unit: { include: { property: true } } } },
        lines: true,
      },
    })
    if (!notice) throw new NotFoundException('Avi hittades inte')

    const org = await this.prisma.organization.findUnique({ where: { id: orgId } })
    if (!org) throw new NotFoundException('Organisation hittades inte')

    const html = await this.buildNoticePdfHtml(notice, org)
    return this.pdfService.generateFromHtml(html)
  }

  private async buildNoticePdfHtml(
    notice: NoticeWithRelations,
    org: {
      name: string
      street?: string | null
      postalCode?: string | null
      city?: string | null
      email?: string | null
      bankgiro?: string | null
      invoiceColor?: string | null
      logoStorageKey?: string | null
    },
  ): Promise<string> {
    const logoDataUrl = await getLogoDataUrl(this.storage, org.logoStorageKey ?? null)
    const primaryColor = org.invoiceColor ?? '#1a6b3c'
    const bankgiro = org.bankgiro ?? '0000-0000'

    // Konsekvent beloppsformat med hyresfakturan: alltid två decimaler (ören).
    // Tidigare visade avin ören bara när de fanns medan fakturan rundade till
    // hela kronor — nu använder båda dokumenten samma 2-decimalsformat.
    const fmt = (n: number): string =>
      Number(n).toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

    // Betalbar total = hyra + förbrukning (IMD-rader). Hyresgästen betalar EN
    // summa med ETT OCR. notice.totalAmount avser bara hyran (hyresverifikatet).
    const payable = rentNoticePayableTotal(notice)
    const consumptionLines = notice.lines ?? []
    // HTML för förbrukningsrader (visas mellan hyra och totalsumma).
    const consumptionRowsHtml = consumptionLines
      .map(
        (l) => `
      <tr>
        <td>${l.description}</td>
        <td>${fmt(Number(l.total))} kr</td>
      </tr>`,
      )
      .join('')

    const tenantName =
      notice.tenant.type === 'INDIVIDUAL'
        ? `${notice.tenant.firstName ?? ''} ${notice.tenant.lastName ?? ''}`.trim()
        : (notice.tenant.companyName ?? '')

    const tenant = notice.tenant
    const unit = notice.lease?.unit
    const property = notice.lease?.unit?.property

    function formatBankgiroLine(ocrNumber: string, totalAmount: number, bg: string): string {
      const kronor = Math.floor(totalAmount).toString()
      const oren = Math.round((totalAmount % 1) * 100)
        .toString()
        .padStart(2, '0')
      const digits = (kronor + oren).split('').map(Number)
      let sum = 0
      let isEven = false
      for (let i = digits.length - 1; i >= 0; i--) {
        let d = digits[i]!
        if (isEven) {
          d *= 2
          if (d > 9) d -= 9
        }
        sum += d
        isEven = !isEven
      }
      const checkDigit = (10 - (sum % 10)) % 10
      const bgFormatted = bg.replace('-', '')
      return `# ${ocrNumber} # ${kronor} ${oren} ${checkDigit} > ${bgFormatted}#41#`
    }

    const ocrLine = formatBankgiroLine(notice.ocrNumber, payable, bankgiro)

    const monthLabel = new Date(notice.year, notice.month - 1, 1).toLocaleDateString('sv-SE', {
      month: 'long',
      year: 'numeric',
    })

    const isDeposit = notice.type === RentNoticeType.DEPOSIT
    const isProrated = notice.isProrated

    const monthlyRent = Number(notice.lease?.monthlyRent ?? 0)
    const dailyRate =
      notice.totalDays && notice.totalDays > 0
        ? Math.round((monthlyRent / notice.totalDays) * 100) / 100
        : 0

    const specRowsHtml = isDeposit
      ? `
      <tr>
        <td>${unit?.unitNumber ?? notice.ocrNumber.slice(-6)}</td>
        <td>
          <strong>Deposition</strong>
          ${unit ? ` — ${unit.name as string}` : ''}
          ${property ? `, ${(property.street as string | null | undefined) ?? (property.name as string)}` : ''}
          <div style="font-size:10px;color:#666;margin-top:4px">
            Säkerhet enligt 12 kap. 21 § JB. Återbetalas vid avflyttning efter slutbesiktning.
          </div>
        </td>
        <td>${fmt(Number(notice.amount))} kr</td>
      </tr>`
      : isProrated
        ? `
      <tr>
        <td>${unit?.unitNumber ?? notice.ocrNumber.slice(-6)}</td>
        <td>
          <strong>Hyra ${monthLabel} (delmånad)</strong>
          ${unit ? ` — ${unit.name as string}` : ''}
          ${property ? `, ${(property.street as string | null | undefined) ?? (property.name as string)}` : ''}
          <div style="font-size:10px;color:#666;margin-top:4px;line-height:1.5">
            Period: ${notice.periodStart ? new Date(notice.periodStart).toLocaleDateString('sv-SE', { day: 'numeric', month: 'long' }) : ''}
            – ${notice.periodEnd ? new Date(notice.periodEnd).toLocaleDateString('sv-SE', { day: 'numeric', month: 'long' }) : ''}
            (${notice.daysCharged} av ${notice.totalDays} dagar)<br>
            Dagshyra: ${fmt(monthlyRent)} / ${notice.totalDays} =
            ${fmt(dailyRate)} kr
          </div>
        </td>
        <td>${fmt(Number(notice.amount))} kr</td>
      </tr>`
        : `
      <tr>
        <td>${unit?.unitNumber ?? notice.ocrNumber.slice(-6)}</td>
        <td>
          Hyra ${monthLabel}
          ${unit ? ` — ${unit.name as string}` : ''}
          ${property ? `, ${(property.street as string | null | undefined) ?? (property.name as string)}` : ''}
        </td>
        <td>${fmt(Number(notice.amount))} kr</td>
      </tr>`

    const aviTitle = isDeposit ? 'Depositionsavi' : 'Hyresavi'

    return `<!DOCTYPE html>
<html lang="sv">
<head>
<meta charset="UTF-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: Arial, sans-serif;
    font-size: 11px;
    color: #333;
    background: white;
  }

  /* ── UPPER SECTION ── */
  .upper { padding: 30px 40px 20px 40px; }

  .header-row {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 24px;
  }
  .org-name {
    font-size: 20px;
    font-weight: bold;
    color: ${primaryColor};
    margin-bottom: 4px;
  }
  .org-details { font-size: 10px; color: #555; line-height: 1.6; }

  .avi-header { text-align: right; }
  .avi-title {
    font-size: 18px;
    font-weight: bold;
    color: ${primaryColor};
    letter-spacing: 2px;
    text-transform: uppercase;
  }
  .avi-meta {
    font-size: 10px;
    color: #666;
    margin-top: 6px;
    line-height: 1.8;
  }
  .avi-meta span { font-weight: bold; color: #333; }

  .recipient-box {
    border-left: 3px solid ${primaryColor};
    padding: 10px 16px;
    margin: 20px 0;
    background: #fafafa;
  }
  .recipient-name { font-size: 13px; font-weight: bold; }
  .recipient-detail { font-size: 10px; color: #666; margin-top: 2px; }

  .spec-table {
    width: 100%;
    border-collapse: collapse;
    margin: 20px 0;
  }
  .spec-table th {
    background: ${primaryColor};
    color: white;
    padding: 8px 12px;
    text-align: left;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .spec-table th:last-child { text-align: right; }
  .spec-table td {
    padding: 8px 12px;
    border-bottom: 1px solid #eee;
    font-size: 11px;
  }
  .spec-table td:last-child { text-align: right; font-weight: 500; }
  .spec-table tr:nth-child(even) td { background: #f9f9f9; }

  .totals-row {
    display: flex;
    justify-content: flex-end;
    margin-top: 8px;
    padding-right: 12px;
  }
  .totals-table { font-size: 11px; }
  .totals-table td { padding: 3px 12px; }
  .totals-table td:last-child { text-align: right; font-weight: 500; }
  .total-final td {
    font-size: 14px;
    font-weight: bold;
    color: ${primaryColor};
    border-top: 2px solid ${primaryColor};
    padding-top: 6px;
  }

  .due-notice {
    background: #fff3cd;
    border: 1px solid #ffc107;
    border-radius: 4px;
    padding: 8px 12px;
    margin: 16px 0;
    font-size: 10px;
    color: #856404;
  }

  /* ── TEAR OFF LINE ── */
  .tearoff {
    border-top: 2px dashed #999;
    margin: 10px 40px;
    position: relative;
    text-align: center;
  }
  .tearoff-label {
    position: absolute;
    top: -8px;
    left: 50%;
    transform: translateX(-50%);
    background: white;
    padding: 0 10px;
    font-size: 9px;
    color: #999;
    white-space: nowrap;
  }

  /* ── PAYMENT SLIP ── */
  .payment-slip {
    padding: 16px 40px 20px 40px;
    background: white;
  }

  .slip-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 16px;
  }
  .bankgiro-logo {
    font-size: 16px;
    font-weight: bold;
    color: #003087;
    border: 2px solid #003087;
    padding: 4px 10px;
    border-radius: 3px;
    letter-spacing: 1px;
  }
  .slip-title {
    font-size: 12px;
    font-weight: bold;
    color: #333;
    text-align: center;
    text-transform: uppercase;
    letter-spacing: 2px;
  }

  .slip-grid {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    gap: 16px;
    margin: 12px 0;
  }
  .slip-field .label {
    font-size: 9px;
    color: #666;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 3px;
  }
  .slip-field .value {
    font-size: 13px;
    font-weight: bold;
    color: #333;
  }

  .ocr-section {
    background: #f5f5f5;
    border: 1px solid #ddd;
    border-radius: 4px;
    padding: 12px 16px;
    margin: 12px 0;
    text-align: center;
  }
  .ocr-label {
    font-size: 9px;
    color: #666;
    text-transform: uppercase;
    margin-bottom: 6px;
    letter-spacing: 1px;
  }
  .ocr-number {
    font-size: 28px;
    font-weight: bold;
    font-family: 'Courier New', monospace;
    letter-spacing: 4px;
    color: ${primaryColor};
  }
  .ocr-instruction {
    font-size: 9px;
    color: #888;
    margin-top: 4px;
  }

  .bankgiro-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin: 10px 0;
    padding: 8px 0;
    border-top: 1px solid #eee;
  }
  .bankgiro-number {
    font-size: 16px;
    font-weight: bold;
    color: #003087;
  }
  .amount-box { text-align: right; }
  .amount-label { font-size: 9px; color: #666; }
  .amount-value {
    font-size: 22px;
    font-weight: bold;
    color: #c0392b;
  }

  .ocr-machine-line {
    margin-top: 16px;
    padding-top: 12px;
    border-top: 1px solid #ccc;
    font-family: 'OCR-B', 'Courier New', monospace;
    font-size: 14px;
    letter-spacing: 3px;
    color: #000;
    text-align: center;
  }
  .ocr-warning {
    font-size: 8px;
    color: #999;
    text-align: center;
    margin-top: 4px;
    font-family: Arial, sans-serif;
    letter-spacing: normal;
  }

  @page { margin: 10mm; size: A4; }
</style>
</head>
<body>

<!-- ═══ UPPER SECTION ═══ -->
<div class="upper">
  <div class="header-row">
    <div>
      ${
        logoDataUrl
          ? `<img src="${logoDataUrl}" style="height:48px;max-width:180px;object-fit:contain;" alt="${org.name}">`
          : `<div style="font-size:20px;font-weight:bold;color:${primaryColor}">${org.name}</div>`
      }
      <div style="font-size:11px;color:#666">${org.name}</div>
      <div class="org-details">
        ${org.street ? `${org.street}, ${org.postalCode ?? ''} ${org.city ?? ''}<br>` : ''}
        ${org.bankgiro ? `Bankgiro: ${bankgiro}<br>` : ''}
        ${org.email ? `E-post: ${org.email}` : ''}
      </div>
    </div>
    <div class="avi-header">
      <div class="avi-title">${aviTitle}</div>
      <div class="avi-meta">
        Datum: <span>${new Date().toLocaleDateString('sv-SE')}</span><br>
        Avinummer: <span>${notice.noticeNumber}</span><br>
        ${isDeposit ? '' : `Period: <span>${monthLabel}</span><br>`}
        Kundnr: <span>${notice.ocrNumber.slice(-6)}</span>
      </div>
    </div>
  </div>

  <div class="recipient-box">
    <div class="recipient-name">${tenantName}</div>
    <div class="recipient-detail">${tenant.email}</div>
    ${tenant.phone ? `<div class="recipient-detail">${tenant.phone as string}</div>` : ''}
  </div>

  <table class="spec-table">
    <thead>
      <tr>
        <th>Objekt</th>
        <th>Specifikation</th>
        <th>Summa</th>
      </tr>
    </thead>
    <tbody>
      ${specRowsHtml}
      ${
        Number(notice.vatAmount) > 0
          ? `
      <tr>
        <td></td>
        <td>Moms ${((Number(notice.vatAmount) / Number(notice.amount)) * 100).toFixed(0)}%</td>
        <td>${fmt(Number(notice.vatAmount))} kr</td>
      </tr>`
          : ''
      }
    </tbody>
  </table>

  <div class="totals-row">
    <table class="totals-table">
      ${
        Number(notice.vatAmount) > 0
          ? `
      <tr>
        <td>Delsumma:</td>
        <td>${fmt(Number(notice.amount))} kr</td>
      </tr>
      <tr>
        <td>Moms:</td>
        <td>${fmt(Number(notice.vatAmount))} kr</td>
      </tr>`
          : ''
      }
      ${
        consumptionLines.length > 0
          ? `
      <tr>
        <td>Hyra:</td>
        <td>${fmt(Number(notice.totalAmount))} kr</td>
      </tr>
      ${consumptionRowsHtml}`
          : ''
      }
      <tr class="total-final">
        <td>Att betala:</td>
        <td>${fmt(payable)} kr</td>
      </tr>
    </table>
  </div>

  <div class="due-notice">
    &#9888; Dröjsmål debiteras med referensränta + 8% —
    Förfallodatum: <strong>${notice.dueDate.toLocaleDateString('sv-SE')}</strong>
  </div>
</div>

<!-- ═══ TEAR OFF LINE ═══ -->
<div class="tearoff">
  <span class="tearoff-label">&#9986; Avrivningskupong — skicka in vid betalning</span>
</div>

<!-- ═══ PAYMENT SLIP ═══ -->
<div class="payment-slip">
  <div class="slip-header">
    <div class="bankgiro-logo">bankgirot</div>
    <div class="slip-title">Inbetalning / Girering AVI</div>
    <div style="width:80px"></div>
  </div>

  <div class="slip-grid">
    <div class="slip-field">
      <div class="label">Betalningsmottagare</div>
      <div class="value" style="font-size:12px">${org.name}</div>
    </div>
    <div class="slip-field">
      <div class="label">Förfallodatum</div>
      <div class="value" style="color:#c0392b">
        ${notice.dueDate.toLocaleDateString('sv-SE')}
      </div>
    </div>
    <div class="slip-field">
      <div class="label">${isDeposit ? 'Avser' : 'Period'}</div>
      <div class="value" style="font-size:12px">${isDeposit ? 'Deposition' : monthLabel}</div>
    </div>
  </div>

  <div class="ocr-section">
    <div class="ocr-label">OCR-nummer — ange alltid vid betalning</div>
    <div class="ocr-number">${notice.ocrNumber}</div>
    <div class="ocr-instruction">
      Detta nummer identifierar din betalning automatiskt
    </div>
  </div>

  <div class="bankgiro-row">
    <div>
      <div style="font-size:9px; color:#666; margin-bottom:3px">TILL BANKGIRO</div>
      <div class="bankgiro-number">${bankgiro}</div>
    </div>
    <div class="amount-box">
      <div class="amount-label">ATT BETALA</div>
      <div class="amount-value">
        ${fmt(payable)} kr
      </div>
    </div>
  </div>

  <!-- Machine-readable OCR line -->
  <div class="ocr-machine-line">
    ${ocrLine}
  </div>
  <div class="ocr-warning">
    VAR GOD GÖR INGA ÄNDRINGAR — DEN AVLÄSES MASKINELLT
  </div>
</div>

</body>
</html>`
  }

  // Registrerar en hyresavi som betald OCH bokför betalningen (FIX 9 · PR 6).
  // Sluter intäktscykeln: utan denna bokning skulle kundfordran 1510 växa
  // obegränsat eftersom PR 2 endast bokade fordran vid avisering.
  //
  // Flödet är race-säkert och har invarianten "ingen PAID-avi utan verifikat":
  //   1. Atomisk statusövergång (updateMany med status-guard) tar avin från
  //      obetald → PAID. Exakt en process kan vinna — samma mönster som
  //      bankavstämningen (applyMatchToRentNotice) — så en manuell markering och
  //      en parallell bankavstämning av samma avi utesluter varandra och kan
  //      aldrig skapa två betalningsverifikat mot 1510.
  //   2. Bokför betalningen (likvidkonto D / 1510 K) EFTER övergången. Kan
  //      verifikatet inte skapas (saknat konto eller DB-fel) ångras
  //      statusövergången och felet propageras — avin kan då regleras på nytt
  //      när orsaken är åtgärdad (BFL 5 kap 6 §).
  async markAsPaid(
    noticeId: string,
    orgId: string,
    paidAmount: number,
    paymentMethod: PaymentMethod,
    paidAt?: string,
    createdById?: string | null,
  ) {
    const notice = await this.prisma.rentNotice.findFirst({
      where: { id: noticeId, organizationId: orgId },
    })
    if (!notice) throw new NotFoundException('Avi hittades inte')
    if (notice.status === RentNoticeStatus.CANCELLED) {
      throw new BadRequestException('Kan inte markera avbruten avi som betald')
    }
    if (notice.status === RentNoticeStatus.PAID) {
      throw new BadRequestException('Avin är redan betald')
    }

    const paymentDate = paidAt ? new Date(paidAt) : new Date()

    // ── 1. Atomisk, race-säker statusövergång ────────────────────────────────
    const claim = await this.prisma.rentNotice.updateMany({
      where: {
        id: noticeId,
        organizationId: orgId,
        status: {
          in: [
            RentNoticeStatus.PENDING,
            RentNoticeStatus.SENT,
            RentNoticeStatus.OVERDUE,
            RentNoticeStatus.FAILED,
          ],
        },
      },
      data: {
        status: RentNoticeStatus.PAID,
        paidAt: paymentDate,
        paidAmount,
        paymentMethod,
      },
    })
    if (claim.count === 0) {
      // En parallell process (t.ex. bankavstämning) hann reglera eller avbryta avin.
      throw new ConflictException(
        'Avin är redan reglerad eller avbruten — uppdatera sidan och försök igen',
      )
    }

    // ── 2. Bokför betalningen; ångra statusövergången om verifikatet uteblir ──
    // Bankavstämnings-härdning PR 1 — additiv MANUAL-allokering (ingen bank-tx).
    // Skrivs FÖRST i try-blocket så att samma revert som ångrar statusen även
    // städar bort allokeringen om verifikatet uteblir. Härledd spegel av
    // paidAmount; rör inte huvudboken.
    let allocationId: string | null = null
    try {
      const allocation = await this.prisma.rentNoticePayment.create({
        data: {
          rentNoticeId: noticeId,
          bankTransactionId: null,
          amount: paidAmount,
          paidAt: paymentDate,
          source: 'MANUAL',
        },
      })
      allocationId = allocation.id

      const entry = await this.accounting.createJournalEntryForRentNoticeManualPayment(
        { id: notice.id, noticeNumber: notice.noticeNumber, type: notice.type },
        paidAmount,
        paymentDate,
        paymentMethod,
        orgId,
        createdById ?? null,
      )
      // null för en RENT-avi = saknat likvidkonto/1510 → bokföringsfel, inte
      // ett giltigt no-op. (DEPOSIT returnerar null avsiktligt — deposits-modulen
      // äger 1510/2890-flödet — och får behålla PAID-statusen.)
      if (entry === null && notice.type !== RentNoticeType.DEPOSIT) {
        throw new InternalServerErrorException(
          `Betalningsverifikat kunde inte skapas för avi ${notice.noticeNumber} — ` +
            'kontrollera att kontoplanen innehåller konto 1510 och rätt likvidkonto.',
        )
      }
    } catch (err) {
      // Städa bort allokeringen (PR 1) så spegeln Σ allokeringar == paidAmount
      // hålls konsekvent när statusen ångras nedan.
      if (allocationId) {
        await this.prisma.rentNoticePayment
          .delete({ where: { id: allocationId } })
          .catch((cleanupErr) => {
            this.logger.error(
              `[Avisering] Kunde inte städa allokering för avi ${notice.noticeNumber}: ` +
                `${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`,
            )
          })
      }
      // Återställ avin till obetald så att den kan regleras på nytt.
      await this.prisma.rentNotice
        .updateMany({
          where: { id: noticeId, organizationId: orgId, status: RentNoticeStatus.PAID },
          data: {
            status: notice.status,
            paidAt: null,
            paidAmount: null,
            paymentMethod: null,
          },
        })
        .catch((revertErr) => {
          this.logger.error(
            `[Avisering] Kunde inte ångra betalningsstatus för avi ${notice.noticeNumber}: ` +
              `${revertErr instanceof Error ? revertErr.message : String(revertErr)}`,
          )
        })
      throw err
    }

    return this.prisma.rentNotice.findFirst({
      where: { id: noticeId, organizationId: orgId },
    })
  }

  async cancelNotice(noticeId: string, orgId: string) {
    const notice = await this.prisma.rentNotice.findFirst({
      where: { id: noticeId, organizationId: orgId },
    })
    if (!notice) throw new NotFoundException('Avi hittades inte')
    if (notice.status === RentNoticeStatus.PAID) {
      throw new BadRequestException('Kan inte avbryta en betald avi')
    }

    return this.prisma.rentNotice.update({
      where: { id: noticeId },
      data: { status: RentNoticeStatus.CANCELLED },
    })
  }

  async checkAndMarkOverdue(orgId: string) {
    const now = new Date()
    const overdue = await this.prisma.rentNotice.findMany({
      where: {
        organizationId: orgId,
        status: { in: [RentNoticeStatus.PENDING, RentNoticeStatus.SENT] },
        dueDate: { lt: now },
      },
    })

    if (overdue.length > 0) {
      await this.prisma.rentNotice.updateMany({
        where: { id: { in: overdue.map((n) => n.id) } },
        data: { status: RentNoticeStatus.OVERDUE },
      })
    }

    return overdue
  }

  async findAll(
    orgId: string,
    filters?: {
      month?: number
      year?: number
      status?: RentNoticeStatus
      search?: string
      tenantId?: string
    },
  ) {
    await this.checkAndMarkOverdue(orgId)

    // Fritext-sök på hyresgäst (för-/efter-/företagsnamn) + OCR/avinummer.
    // Speglar tenants.service.findAll. När sök används utelämnar frontend
    // månad/år så hela hyresgästens historik visas över alla perioder.
    const search = filters?.search?.trim()

    return this.prisma.rentNotice.findMany({
      where: {
        organizationId: orgId,
        ...(filters?.month ? { month: filters.month } : {}),
        ...(filters?.year ? { year: filters.year } : {}),
        ...(filters?.status ? { status: filters.status } : {}),
        ...(filters?.tenantId ? { tenantId: filters.tenantId } : {}),
        ...(search
          ? {
              OR: [
                { tenant: { firstName: { contains: search, mode: 'insensitive' } } },
                { tenant: { lastName: { contains: search, mode: 'insensitive' } } },
                { tenant: { companyName: { contains: search, mode: 'insensitive' } } },
                { ocrNumber: { contains: search, mode: 'insensitive' } },
                { noticeNumber: { contains: search, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      include: {
        tenant: { select: SAFE_TENANT_SELECT },
        lease: { include: { unit: { include: { property: true } } } },
      },
      // Interna infrastrukturfält ska aldrig nå klienten (security-auditor MEDIUM):
      // R2-lagringsnyckeln och Resends message-id är inte presigned URL:er och har
      // ingen frontend-användning — exponera dem inte för VIEWER m.fl.
      omit: { reminderPdfStorageKey: true, reminderMessageId: true },
      orderBy: { dueDate: 'desc' },
    })
  }

  async findOne(noticeId: string, orgId: string) {
    const notice = await this.prisma.rentNotice.findFirst({
      where: { id: noticeId, organizationId: orgId },
      include: {
        tenant: { select: SAFE_TENANT_SELECT },
        lease: { include: { unit: { include: { property: true } } } },
      },
      // Interna fält döljs för klienten (se findMany ovan).
      omit: { reminderPdfStorageKey: true, reminderMessageId: true },
    })
    if (!notice) throw new NotFoundException('Avi hittades inte')
    return notice
  }

  async getStats(orgId: string, month: number, year: number) {
    await this.checkAndMarkOverdue(orgId)

    const [grouped, aggregate] = await Promise.all([
      this.prisma.rentNotice.groupBy({
        by: ['status'],
        where: { organizationId: orgId, month, year },
        _count: true,
      }),
      this.prisma.rentNotice.aggregate({
        where: { organizationId: orgId, month, year },
        _sum: { totalAmount: true, paidAmount: true },
        _count: true,
      }),
    ])

    const byStatus: Record<string, number> = {}
    for (const g of grouped) {
      byStatus[g.status] = g._count
    }

    const totalAmount = Number(aggregate._sum.totalAmount ?? 0)
    const paidAmount = Number(aggregate._sum.paidAmount ?? 0)

    return {
      total: aggregate._count,
      pending: byStatus['PENDING'] ?? 0,
      sent: byStatus['SENT'] ?? 0,
      paid: byStatus['PAID'] ?? 0,
      overdue: byStatus['OVERDUE'] ?? 0,
      cancelled: byStatus['CANCELLED'] ?? 0,
      totalAmount,
      paidAmount,
      outstandingAmount: totalAmount - paidAmount,
    }
  }
}
