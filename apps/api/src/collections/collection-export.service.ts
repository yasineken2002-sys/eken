import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common'
import type { Prisma } from '@prisma/client'
import JSZip from 'jszip'
import { PrismaService } from '../common/prisma/prisma.service'
import { PdfService } from '../invoices/pdf.service'
import { StorageService } from '../storage/storage.service'

type InvoiceWithCollectionData = Prisma.InvoiceGetPayload<{
  include: {
    tenant: true
    customer: true
    organization: true
    paymentReminders: { orderBy: { sentAt: 'asc' } }
    lines: true
    lease: { include: { unit: { include: { property: true } } } }
  }
}>

export interface CollectionExportResult {
  invoiceId: string
  invoiceNumber: string
  pdfKey: string
  csvKey: string
  pdfUrl: string
  csvUrl: string
}

@Injectable()
export class CollectionExportService {
  private readonly logger = new Logger(CollectionExportService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly pdf: PdfService,
    private readonly storage: StorageService,
  ) {}

  /**
   * Genererar inkassounderlag (PDF + CSV) för EN faktura. Markerar fakturan
   * som SENT_TO_COLLECTION och pausar automatiska påminnelser så Eveno inte
   * tävlar med inkassobolaget om kommunikation till hyresgästen.
   */
  async exportForInvoice(
    invoiceId: string,
    organizationId: string,
  ): Promise<CollectionExportResult> {
    const invoice = await this.loadInvoice(invoiceId, organizationId)
    if (invoice.status === 'PAID' || invoice.status === 'VOID') {
      throw new BadRequestException(
        'Kan inte skapa inkassounderlag för betald eller makulerad faktura',
      )
    }

    const pdfBuffer = await this.pdf.generateFromHtml(this.buildPdfHtml(invoice))
    const csvBuffer = Buffer.from(this.buildCsv([invoice]), 'utf8')

    const date = new Date().toISOString().slice(0, 10)
    const safeNumber = invoice.invoiceNumber.replace(/[^\w-]/g, '_')
    const pdfKey = `collections/${organizationId}/${date}/inkasso-${safeNumber}.pdf`
    const csvKey = `collections/${organizationId}/${date}/inkasso-${safeNumber}.csv`

    const [pdfUrl, csvUrl] = await Promise.all([
      this.storage.uploadFile(pdfBuffer, pdfKey, 'application/pdf'),
      this.storage.uploadFile(csvBuffer, csvKey, 'text/csv'),
    ])

    // Markera faktura som skickad till inkasso om den inte redan var det.
    // Pausa påminnelser så cron-jobbet inte fortsätter spamma hyresgästen.
    if (invoice.status !== 'SENT_TO_COLLECTION') {
      await this.prisma.invoice.update({
        where: { id: invoice.id },
        data: {
          status: 'SENT_TO_COLLECTION',
          sentToCollectionAt: new Date(),
          remindersPaused: true,
          remindersPausedAt: new Date(),
          remindersPausedReason: 'Skickad till inkasso',
          collectionExportKey: pdfKey,
        },
      })
      await this.prisma.invoiceEvent.create({
        data: {
          invoiceId: invoice.id,
          type: 'DEBT_COLLECTION',
          actorType: 'SYSTEM',
          actorLabel: 'Inkassounderlag genererat',
          payload: { pdfKey, csvKey },
        },
      })
    } else {
      await this.prisma.invoice.update({
        where: { id: invoice.id },
        data: { collectionExportKey: pdfKey },
      })
    }

    return {
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      pdfKey,
      csvKey,
      pdfUrl,
      csvUrl,
    }
  }

  /**
   * Skapar en samlad ZIP med PDF + CSV för flera fakturor i ett svep.
   * Används av "Skicka till inkasso (bulk)"-knappen.
   */
  async exportBulk(
    invoiceIds: string[],
    organizationId: string,
  ): Promise<{ zipKey: string; zipUrl: string; count: number }> {
    if (invoiceIds.length === 0) {
      throw new BadRequestException('Inga fakturor angivna')
    }
    const invoices = await Promise.all(invoiceIds.map((id) => this.loadInvoice(id, organizationId)))

    const zip = new JSZip()
    for (const invoice of invoices) {
      const safeNumber = invoice.invoiceNumber.replace(/[^\w-]/g, '_')
      const pdfBuffer = await this.pdf.generateFromHtml(this.buildPdfHtml(invoice))
      zip.file(`${safeNumber}/inkasso-${safeNumber}.pdf`, pdfBuffer)
    }
    // Samlad CSV med alla fakturor — många inkassobolag (Visma Collectors,
    // Intrum, Lindorff) tar emot batch-import som CSV.
    zip.file('inkasso-batch.csv', this.buildCsv(invoices))

    const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' })
    const date = new Date().toISOString().slice(0, 10)
    const zipKey = `collections/${organizationId}/${date}/inkasso-batch-${Date.now()}.zip`
    const zipUrl = await this.storage.uploadFile(zipBuffer, zipKey, 'application/zip')

    // Markera alla fakturor som skickade till inkasso
    await this.prisma.$transaction(async (tx) => {
      const now = new Date()
      for (const inv of invoices) {
        if (inv.status === 'PAID' || inv.status === 'VOID') continue
        if (inv.status !== 'SENT_TO_COLLECTION') {
          await tx.invoice.update({
            where: { id: inv.id },
            data: {
              status: 'SENT_TO_COLLECTION',
              sentToCollectionAt: now,
              remindersPaused: true,
              remindersPausedAt: now,
              remindersPausedReason: 'Skickad till inkasso (bulk)',
              collectionExportKey: zipKey,
            },
          })
          await tx.invoiceEvent.create({
            data: {
              invoiceId: inv.id,
              type: 'DEBT_COLLECTION',
              actorType: 'SYSTEM',
              actorLabel: 'Inkassounderlag (bulk)',
              payload: { zipKey },
            },
          })
        }
      }
    })

    return { zipKey, zipUrl, count: invoices.length }
  }

  /**
   * Manuell markering — fastighetsägaren har skickat fakturan till sitt
   * inkassobolag genom externt system (t.ex. Vismas portal). Vi pausar
   * påminnelser och loggar att det är gjort.
   */
  async markSentToCollection(
    invoiceId: string,
    organizationId: string,
    note?: string,
  ): Promise<{ id: string; status: 'SENT_TO_COLLECTION' }> {
    const invoice = await this.prisma.invoice.findFirst({
      where: { id: invoiceId, organizationId },
    })
    if (!invoice) throw new NotFoundException('Faktura hittades inte')
    if (invoice.status === 'PAID' || invoice.status === 'VOID') {
      throw new BadRequestException('Fakturan är redan avslutad')
    }

    await this.prisma.invoice.update({
      where: { id: invoice.id },
      data: {
        status: 'SENT_TO_COLLECTION',
        sentToCollectionAt: new Date(),
        remindersPaused: true,
        remindersPausedAt: new Date(),
        remindersPausedReason: note ?? 'Skickad till externt inkassobolag',
      },
    })
    await this.prisma.invoiceEvent.create({
      data: {
        invoiceId: invoice.id,
        type: 'DEBT_COLLECTION',
        actorType: 'USER',
        actorLabel: 'Manuell markering',
        payload: note ? { note } : {},
      },
    })

    return { id: invoice.id, status: 'SENT_TO_COLLECTION' }
  }

  // ── Privata hjälpare ─────────────────────────────────────────────────────

  private async loadInvoice(
    invoiceId: string,
    organizationId: string,
  ): Promise<InvoiceWithCollectionData> {
    const invoice = await this.prisma.invoice.findFirst({
      where: { id: invoiceId, organizationId },
      include: {
        tenant: true,
        customer: true,
        organization: true,
        paymentReminders: { orderBy: { sentAt: 'asc' } },
        lines: true,
        lease: { include: { unit: { include: { property: true } } } },
      },
    })
    if (!invoice) throw new NotFoundException(`Faktura ${invoiceId} hittades inte`)
    return invoice
  }

  private buildCsv(invoices: InvoiceWithCollectionData[]): string {
    const headers = [
      'fakturanummer',
      'forfallodatum',
      'totalbelopp',
      'paminnelseavgifter',
      'organisationsnummer_borgenar',
      'borgenar_namn',
      'galdenar_namn',
      'galdenar_personnummer',
      'galdenar_orgnummer',
      'galdenar_email',
      'galdenar_telefon',
      'galdenar_adress',
      'kontraktsreferens',
      'antal_paminnelser',
      'forsta_paminnelse_datum',
      'senaste_paminnelse_datum',
      'inkassobolag',
    ]
    const rows = invoices.map((inv) => {
      const party = inv.tenant ?? inv.customer
      const partyName = party
        ? (party.companyName ??
          `${party.firstName ?? ''} ${party.lastName ?? ''}`.trim() ??
          party.email)
        : ''
      const reminderFees = inv.paymentReminders.reduce((s, r) => s + Number(r.feeAmount), 0)
      const firstReminder = inv.paymentReminders[0]?.sentAt ?? null
      const lastReminder = inv.paymentReminders[inv.paymentReminders.length - 1]?.sentAt ?? null
      const leaseRef = inv.lease ? `${inv.lease.unit.property.name} / ${inv.lease.unit.name}` : ''
      return [
        inv.invoiceNumber,
        inv.dueDate.toISOString().slice(0, 10),
        Number(inv.total).toFixed(2),
        reminderFees.toFixed(2),
        inv.organization.orgNumber ?? '',
        inv.organization.name,
        partyName,
        party?.personalNumber ?? '',
        party?.orgNumber ?? '',
        party?.email ?? '',
        party?.phone ?? '',
        party ? `${party.street ?? ''}, ${party.postalCode ?? ''} ${party.city ?? ''}`.trim() : '',
        leaseRef,
        String(inv.paymentReminders.length),
        firstReminder ? firstReminder.toISOString().slice(0, 10) : '',
        lastReminder ? lastReminder.toISOString().slice(0, 10) : '',
        inv.organization.collectionAgencyName ?? '',
      ]
    })
    return [headers, ...rows].map((r) => r.map((c) => csvCell(c)).join(',')).join('\n')
  }

  private buildPdfHtml(invoice: InvoiceWithCollectionData): string {
    const party = invoice.tenant ?? invoice.customer
    const partyName = party
      ? (party.companyName ?? `${party.firstName ?? ''} ${party.lastName ?? ''}`.trim())
      : '–'
    const partyAddress = party
      ? `${party.street ?? ''}<br>${party.postalCode ?? ''} ${party.city ?? ''}`
      : ''
    const reminders = invoice.paymentReminders
    const totalFees = reminders.reduce((s, r) => s + Number(r.feeAmount), 0)
    const totalDue = Number(invoice.total)
    const today = new Date().toLocaleDateString('sv-SE')
    const leaseRef = invoice.lease
      ? `${invoice.lease.unit.property.name} – ${invoice.lease.unit.name} (${invoice.lease.unit.unitNumber})`
      : '–'

    const reminderRows = reminders
      .map((r) => {
        const label =
          r.type === 'REMINDER_FRIENDLY'
            ? 'Vänlig påminnelse'
            : r.type === 'REMINDER_FORMAL'
              ? 'Formell påminnelse'
              : 'Markerad redo för inkasso'
        return `<tr>
          <td>${r.sentAt.toLocaleDateString('sv-SE')}</td>
          <td>${label}</td>
          <td style="text-align:right">${formatSek(Number(r.feeAmount))}</td>
        </tr>`
      })
      .join('')

    const lineRows = invoice.lines
      .map(
        (l) => `<tr>
          <td>${escapeHtml(l.description)}</td>
          <td style="text-align:right">${Number(l.quantity).toLocaleString('sv-SE')}</td>
          <td style="text-align:right">${formatSek(Number(l.unitPrice))}</td>
          <td style="text-align:right">${formatSek(Number(l.total))}</td>
        </tr>`,
      )
      .join('')

    return `<!DOCTYPE html>
<html lang="sv">
<head>
<meta charset="UTF-8">
<style>
  body { font-family: Arial, Helvetica, sans-serif; font-size: 12px; color: #1f2937; }
  h1 { font-size: 22px; color: #1a4a28; margin: 0 0 4px; }
  h2 { font-size: 14px; color: #1a4a28; margin: 24px 0 8px; border-bottom: 1px solid #d1d5db; padding-bottom: 4px; }
  .header { border-bottom: 3px solid #1a4a28; padding-bottom: 14px; margin-bottom: 18px; display: flex; justify-content: space-between; align-items: flex-start; }
  .meta { font-size: 11px; color: #4b5563; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
  .box { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 6px; padding: 12px 14px; }
  .label { font-size: 10px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 4px; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  th, td { padding: 6px 8px; border-bottom: 1px solid #e5e7eb; text-align: left; font-size: 11px; }
  th { background: #f3f4f6; color: #374151; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; font-size: 10px; }
  tfoot td { font-weight: 700; }
  .total-box { background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: 14px 16px; margin-top: 18px; display: flex; justify-content: space-between; align-items: center; }
  .total-box .amt { font-size: 22px; font-weight: 700; color: #b91c1c; }
  .legal { font-size: 10px; color: #6b7280; margin-top: 24px; line-height: 1.5; }
</style>
</head>
<body>
  <div class="header">
    <div>
      <h1>Inkassounderlag</h1>
      <div class="meta">Genererat ${today} · Eveno fastighetssystem</div>
    </div>
    <div style="text-align:right">
      <div class="meta"><strong>Faktura</strong></div>
      <div style="font-size:18px;font-weight:700">${invoice.invoiceNumber}</div>
      <div class="meta">Förfallodatum ${invoice.dueDate.toLocaleDateString('sv-SE')}</div>
    </div>
  </div>

  <div class="grid">
    <div class="box">
      <div class="label">Borgenär (fastighetsägare)</div>
      <strong>${escapeHtml(invoice.organization.name)}</strong><br>
      Org.nr: ${invoice.organization.orgNumber ?? '–'}<br>
      ${escapeHtml(invoice.organization.street ?? '')}<br>
      ${invoice.organization.postalCode ?? ''} ${escapeHtml(invoice.organization.city ?? '')}<br>
      ${invoice.organization.email ? `E-post: ${escapeHtml(invoice.organization.email)}` : ''}
    </div>
    <div class="box">
      <div class="label">Gäldenär (hyresgäst)</div>
      <strong>${escapeHtml(partyName)}</strong><br>
      ${
        party?.personalNumber
          ? `Personnr: ${escapeHtml(party.personalNumber)}<br>`
          : party?.orgNumber
            ? `Org.nr: ${escapeHtml(party.orgNumber)}<br>`
            : ''
      }
      ${partyAddress}<br>
      ${party?.email ? `E-post: ${escapeHtml(party.email)}<br>` : ''}
      ${party?.phone ? `Telefon: ${escapeHtml(party.phone)}` : ''}
    </div>
  </div>

  <h2>Skuldspecifikation</h2>
  <table>
    <thead>
      <tr>
        <th>Beskrivning</th>
        <th style="text-align:right">Antal</th>
        <th style="text-align:right">À-pris</th>
        <th style="text-align:right">Summa</th>
      </tr>
    </thead>
    <tbody>${lineRows}</tbody>
  </table>

  <div class="total-box">
    <div>
      <div class="label">Total skuld</div>
      <div class="meta">Inkluderar påminnelseavgifter ${formatSek(totalFees)}</div>
    </div>
    <div class="amt">${formatSek(totalDue)}</div>
  </div>

  <h2>Påminnelsehistorik</h2>
  ${
    reminders.length === 0
      ? '<p class="meta">Inga påminnelser har skickats för denna faktura.</p>'
      : `<table>
          <thead>
            <tr>
              <th>Datum</th>
              <th>Typ</th>
              <th style="text-align:right">Avgift</th>
            </tr>
          </thead>
          <tbody>${reminderRows}</tbody>
        </table>`
  }

  <h2>Kontrakts- och fastighetsreferens</h2>
  <p class="meta">${escapeHtml(leaseRef)}</p>

  <p class="legal">
    Detta dokument är ett underlag för inkassoärende. Borgenären ansvarar för att
    skicka det vidare till sitt valda inkassobolag (t.ex. Visma Collectors, Intrum
    eller Lindorff). Eveno är ett fastighetssystem och bedriver INTE
    inkassoverksamhet. Påminnelseavgift utgår enligt lag (1981:739) om ersättning
    för inkassokostnader.
  </p>
</body>
</html>`
  }
}

function formatSek(amount: number): string {
  return `${amount.toLocaleString('sv-SE', { maximumFractionDigits: 2, minimumFractionDigits: 2 })} kr`
}

function csvCell(value: string): string {
  const needsEscape = /[",\n]/.test(value)
  if (!needsEscape) return value
  return `"${value.replace(/"/g, '""')}"`
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
