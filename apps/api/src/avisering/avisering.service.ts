import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common'
import { PrismaService } from '../common/prisma/prisma.service'
import { OcrService } from '../common/ocr/ocr.service'
import { MailService } from '../mail/mail.service'
import { PdfService } from '../invoices/pdf.service'
import { StorageService } from '../storage/storage.service'
import { Prisma, RentNoticeStatus, RentNoticeType } from '@prisma/client'
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
  }
}>

async function getLogoDataUrl(
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
  ) {}

  // Allokerar nästa avinummer i sekvensen AVI-{year}-{month}-{NNNN}. Vi
  // söker max-suffix per (year, month) och räknar uppåt från den. Detta
  // tål gaps och historik från tidigare format (t.ex. AVI-XXXXXX) — det
  // som spelar roll är att vi får ett ledigt nummer i AVI-{y}-{m}-XXXX.
  //
  // Race-säkerhet: två parallella requests kan teoretiskt hämta samma max
  // och skapa duplicat — vi förlitar oss på @unique(noticeNumber) och en
  // backoff-retry. För månadscronen körs dock allt sekventiellt.
  private async nextNoticeNumber(year: number, month: number, offset = 0): Promise<string> {
    const prefix = `AVI-${year}-${pad2(month)}-`
    const existing = await this.prisma.rentNotice.findMany({
      where: { noticeNumber: { startsWith: prefix } },
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
      const noticeNumber = await this.nextNoticeNumber(year, month, created)
      // Hyreslagen 12 kap. 20 § JB: hyran ska betalas senast sista
      // vardagen i månaden FÖRE den hyresperiod avin avser.
      const dueDate = rentDueDateForMonth(year, month)

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
          vatAmount: 0,
          totalAmount: proration.amount,
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
        const noticeNumber = await this.nextNoticeNumber(year, month)
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
        const noticeNumber = await this.nextNoticeNumber(year, month, depositNotice ? 1 : 0)
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
            vatAmount: 0,
            totalAmount: proration.amount,
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

    // ── 3. Mejla hyresgästen med båda avier som bilagor ─────────────────
    let mailed = false
    if (lease.tenant.email && (depositNotice || firstRentNotice)) {
      try {
        const idsToSend = [depositNotice?.id, firstRentNotice?.id].filter((id): id is string =>
          Boolean(id),
        )
        const result = await this.sendNotices(orgId, idsToSend)
        mailed = result.sent > 0
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

  async sendNotices(orgId: string, noticeIds: string[]) {
    const org = await this.prisma.organization.findUnique({ where: { id: orgId } })
    if (!org) throw new NotFoundException('Organisation hittades inte')

    let sent = 0
    let failed = 0
    let alreadySent = 0

    for (const id of noticeIds) {
      const notice = await this.prisma.rentNotice.findFirst({
        where: { id, organizationId: orgId },
        include: {
          tenant: { select: SAFE_TENANT_SELECT },
          lease: { include: { unit: { include: { property: true } } } },
        },
      })

      if (!notice || !notice.tenant.email) {
        failed++
        continue
      }

      // Idempotens: hoppa över avier som redan skickats. En retry får aldrig
      // resultera i ett dubbelmejl till hyresgästen.
      if (notice.sentAt || notice.status === RentNoticeStatus.SENT) {
        alreadySent++
        continue
      }

      try {
        const pdfHtml = await this.buildNoticePdfHtml(notice, org)
        const pdfBuffer = await this.pdfService.generateFromHtml(pdfHtml)

        const tenantName =
          notice.tenant.type === 'INDIVIDUAL'
            ? `${notice.tenant.firstName ?? ''} ${notice.tenant.lastName ?? ''}`.trim()
            : (notice.tenant.companyName ?? notice.tenant.email)

        // Mejlet måste bekräftas innan vi flaggar avin som SENT — annars riskerar
        // vi att tenant tror att en avi skickats som aldrig nått fram.
        await this.mailService.sendRentNotice({
          to: notice.tenant.email,
          tenantName,
          ocrNumber: notice.ocrNumber,
          amount: Number(notice.totalAmount),
          dueDate: notice.dueDate,
          pdfBuffer,
          organizationName: org.name,
          noticeNumber: notice.noticeNumber,
          accentColor: org.invoiceColor ?? '#2563EB',
          idempotencyKey: `rent-notice-${notice.id}`,
        })

        await this.prisma.rentNotice.update({
          where: { id },
          data: {
            status: RentNoticeStatus.SENT,
            sentAt: new Date(),
            sentTo: notice.tenant.email,
            sendError: null,
          },
        })
        sent++
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err)
        await this.prisma.rentNotice.update({
          where: { id },
          data: { status: RentNoticeStatus.FAILED, sendError: errorMessage },
        })
        failed++
      }
    }

    return { sent, failed, alreadySent }
  }

  async getNoticePdfBuffer(noticeId: string, orgId: string): Promise<Buffer> {
    const notice = await this.prisma.rentNotice.findFirst({
      where: { id: noticeId, organizationId: orgId },
      include: {
        tenant: { select: SAFE_TENANT_SELECT },
        lease: { include: { unit: { include: { property: true } } } },
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

    const ocrLine = formatBankgiroLine(notice.ocrNumber, Number(notice.totalAmount), bankgiro)

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
        <td>${Number(notice.amount).toLocaleString('sv-SE')} kr</td>
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
            Dagshyra: ${monthlyRent.toLocaleString('sv-SE')} / ${notice.totalDays} =
            ${dailyRate.toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} kr
          </div>
        </td>
        <td>${Number(notice.amount).toLocaleString('sv-SE')} kr</td>
      </tr>`
        : `
      <tr>
        <td>${unit?.unitNumber ?? notice.ocrNumber.slice(-6)}</td>
        <td>
          Hyra ${monthLabel}
          ${unit ? ` — ${unit.name as string}` : ''}
          ${property ? `, ${(property.street as string | null | undefined) ?? (property.name as string)}` : ''}
        </td>
        <td>${Number(notice.amount).toLocaleString('sv-SE')} kr</td>
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
        <td>${Number(notice.vatAmount).toLocaleString('sv-SE')} kr</td>
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
        <td>${Number(notice.amount).toLocaleString('sv-SE')} kr</td>
      </tr>
      <tr>
        <td>Moms:</td>
        <td>${Number(notice.vatAmount).toLocaleString('sv-SE')} kr</td>
      </tr>`
          : ''
      }
      <tr class="total-final">
        <td>Att betala:</td>
        <td>${Number(notice.totalAmount).toLocaleString('sv-SE')} kr</td>
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
        ${Number(notice.totalAmount).toLocaleString('sv-SE')} kr
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

  async markAsPaid(noticeId: string, orgId: string, paidAmount: number, paidAt?: string) {
    const notice = await this.prisma.rentNotice.findFirst({
      where: { id: noticeId, organizationId: orgId },
    })
    if (!notice) throw new NotFoundException('Avi hittades inte')
    if (notice.status === RentNoticeStatus.CANCELLED) {
      throw new BadRequestException('Kan inte markera avbruten avi som betald')
    }

    return this.prisma.rentNotice.update({
      where: { id: noticeId },
      data: {
        status: RentNoticeStatus.PAID,
        paidAt: paidAt ? new Date(paidAt) : new Date(),
        paidAmount,
      },
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
    filters?: { month?: number; year?: number; status?: RentNoticeStatus },
  ) {
    await this.checkAndMarkOverdue(orgId)

    return this.prisma.rentNotice.findMany({
      where: {
        organizationId: orgId,
        ...(filters?.month ? { month: filters.month } : {}),
        ...(filters?.year ? { year: filters.year } : {}),
        ...(filters?.status ? { status: filters.status } : {}),
      },
      include: {
        tenant: { select: SAFE_TENANT_SELECT },
        lease: { include: { unit: { include: { property: true } } } },
      },
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
