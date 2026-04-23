import * as fs from 'fs/promises'
import * as path from 'path'
import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common'
import type { PrismaService } from '../common/prisma/prisma.service'
import type { OcrService } from './ocr.service'
import type { MailService } from '../mail/mail.service'
import type { PdfService } from '../invoices/pdf.service'
import { RentNoticeStatus } from '@prisma/client'
import type { RentNotice, Prisma } from '@prisma/client'

type NoticeWithRelations = Prisma.RentNoticeGetPayload<{
  include: {
    tenant: true
    lease: { include: { unit: { include: { property: true } } } }
  }
}>

async function getLogoDataUrl(logoUrl: string | null): Promise<string | null> {
  if (!logoUrl) return null
  try {
    const filePath = logoUrl.startsWith('/') ? logoUrl : path.join(process.cwd(), logoUrl)
    const buffer = await fs.readFile(filePath)
    const ext = path.extname(logoUrl).slice(1).toLowerCase()
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
  constructor(
    private readonly prisma: PrismaService,
    private readonly ocrService: OcrService,
    private readonly mailService: MailService,
    private readonly pdfService: PdfService,
  ) {}

  async generateMonthlyNotices(orgId: string, month: number, year: number) {
    const leases = await this.prisma.lease.findMany({
      where: { organizationId: orgId, status: 'ACTIVE' },
      include: {
        tenant: true,
        unit: { include: { property: true } },
      },
    })

    if (leases.length === 0) {
      return { created: 0, skipped: 0, notices: [] }
    }

    const existing = await this.prisma.rentNotice.findMany({
      where: { organizationId: orgId, month, year },
      select: { tenantId: true },
    })
    const existingSet = new Set(existing.map((n) => n.tenantId))

    const existingCount = await this.prisma.rentNotice.count()

    let created = 0
    let skipped = 0
    const notices: RentNotice[] = []

    for (const lease of leases) {
      if (existingSet.has(lease.tenantId)) {
        skipped++
        continue
      }

      const ocrNumber = await this.ocrService.assignOcrToTenant(lease.tenantId, orgId)
      const seq = existingCount + created + 1
      const noticeNumber = `AVI-${year}-${pad2(month)}-${String(seq).padStart(4, '0')}`
      const dueDate = new Date(year, month - 1, 25)

      const amount = Number(lease.monthlyRent)
      const notice = await this.prisma.rentNotice.create({
        data: {
          organizationId: orgId,
          tenantId: lease.tenantId,
          leaseId: lease.id,
          noticeNumber,
          ocrNumber,
          month,
          year,
          amount,
          vatAmount: 0,
          totalAmount: amount,
          dueDate,
          status: RentNoticeStatus.PENDING,
        },
        include: { tenant: true, lease: { include: { unit: { include: { property: true } } } } },
      })

      notices.push(notice as unknown as RentNotice)
      created++
    }

    return { created, skipped, notices }
  }

  async sendNotices(orgId: string, noticeIds: string[]) {
    const org = await this.prisma.organization.findUnique({ where: { id: orgId } })
    if (!org) throw new NotFoundException('Organisation hittades inte')

    let sent = 0
    let failed = 0

    for (const id of noticeIds) {
      const notice = await this.prisma.rentNotice.findFirst({
        where: { id, organizationId: orgId },
        include: {
          tenant: true,
          lease: { include: { unit: { include: { property: true } } } },
        },
      })

      if (!notice || !notice.tenant.email) {
        failed++
        continue
      }

      try {
        const pdfHtml = await this.buildNoticePdfHtml(notice, org)
        const pdfBuffer = await this.pdfService.generateFromHtml(pdfHtml)

        const tenantName =
          notice.tenant.type === 'INDIVIDUAL'
            ? `${notice.tenant.firstName ?? ''} ${notice.tenant.lastName ?? ''}`.trim()
            : (notice.tenant.companyName ?? notice.tenant.email)

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
        })

        await this.prisma.rentNotice.update({
          where: { id },
          data: { status: RentNoticeStatus.SENT, sentAt: new Date(), sentTo: notice.tenant.email },
        })
        sent++
      } catch {
        failed++
      }
    }

    return { sent, failed }
  }

  async getNoticePdfBuffer(noticeId: string, orgId: string): Promise<Buffer> {
    const notice = await this.prisma.rentNotice.findFirst({
      where: { id: noticeId, organizationId: orgId },
      include: {
        tenant: true,
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
      logoUrl?: string | null
    },
  ): Promise<string> {
    const logoDataUrl = await getLogoDataUrl(org.logoUrl ?? null)
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
      <div class="avi-title">Hyresavi</div>
      <div class="avi-meta">
        Datum: <span>${new Date().toLocaleDateString('sv-SE')}</span><br>
        Avinummer: <span>${notice.noticeNumber}</span><br>
        Period: <span>${monthLabel}</span><br>
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
      <tr>
        <td>${unit?.unitNumber ?? notice.ocrNumber.slice(-6)}</td>
        <td>
          Hyra ${monthLabel}
          ${unit ? ` — ${unit.name as string}` : ''}
          ${property ? `, ${(property.street as string | null | undefined) ?? (property.name as string)}` : ''}
        </td>
        <td>${Number(notice.amount).toLocaleString('sv-SE')} kr</td>
      </tr>
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
      <div class="label">Period</div>
      <div class="value" style="font-size:12px">${monthLabel}</div>
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
        tenant: true,
        lease: { include: { unit: { include: { property: true } } } },
      },
      orderBy: { dueDate: 'desc' },
    })
  }

  async findOne(noticeId: string, orgId: string) {
    const notice = await this.prisma.rentNotice.findFirst({
      where: { id: noticeId, organizationId: orgId },
      include: {
        tenant: true,
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
