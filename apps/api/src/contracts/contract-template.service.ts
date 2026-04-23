import * as fs from 'fs/promises'
import * as path from 'path'
import { v4 as uuid } from 'uuid'
import { Injectable, NotFoundException } from '@nestjs/common'
import { PrismaService } from '../common/prisma/prisma.service'
import { PdfService } from '../invoices/pdf.service'

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

@Injectable()
export class ContractTemplateService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pdfService: PdfService,
  ) {}

  private async buildHtml(
    lease: NonNullable<Awaited<ReturnType<ContractTemplateService['fetchLease']>>>,
    org: NonNullable<Awaited<ReturnType<ContractTemplateService['fetchOrg']>>>,
  ): Promise<string> {
    const tenantName =
      lease.tenant.type === 'INDIVIDUAL'
        ? `${lease.tenant.firstName ?? ''} ${lease.tenant.lastName ?? ''}`.trim()
        : (lease.tenant.companyName ?? '')

    const isResidential = lease.unit.type === 'APARTMENT'

    const noticePeriod =
      lease.noticePeriodMonths > 0
        ? `${lease.noticePeriodMonths} månader`
        : isResidential
          ? '3 månader'
          : '9 månader'

    const logoDataUrl = await getLogoDataUrl(org.logoUrl ?? null)
    const primaryColor = org.invoiceColor ?? '#1a6b3c'
    const contractNumber = lease.id.slice(0, 8).toUpperCase()
    const today = new Date().toLocaleDateString('sv-SE')

    return `<!DOCTYPE html>
<html lang="sv">
<head>
  <meta charset="UTF-8">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: Arial, sans-serif;
      font-size: 11px;
      line-height: 1.6;
      color: #333;
      padding: 40px;
    }
    .header {
      border-bottom: 3px solid ${primaryColor};
      padding-bottom: 20px;
      margin-bottom: 30px;
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
    }
    .header-title { font-size: 22px; font-weight: bold; color: ${primaryColor}; }
    .header-sub { font-size: 12px; color: #666; margin-top: 4px; }
    .contract-number { font-size: 11px; color: #666; text-align: right; }
    h2 {
      font-size: 13px;
      font-weight: bold;
      color: ${primaryColor};
      border-bottom: 1px solid #ddd;
      padding-bottom: 6px;
      margin: 24px 0 12px 0;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .party-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 16px; }
    .party-box { border: 1px solid #ddd; border-radius: 6px; padding: 14px; background: #fafafa; }
    .party-label {
      font-size: 10px; font-weight: bold; color: ${primaryColor};
      text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px;
    }
    .field-row { display: flex; margin-bottom: 4px; }
    .field-label { font-size: 10px; color: #666; width: 120px; flex-shrink: 0; }
    .field-value { font-size: 11px; font-weight: 500; }
    .info-grid {
      display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 16px;
      background: #f5f5f5; border-radius: 6px; padding: 16px; margin: 12px 0;
    }
    .info-item .label { font-size: 10px; color: #666; text-transform: uppercase; }
    .info-item .value { font-size: 13px; font-weight: bold; color: #333; margin-top: 2px; }
    .clause { margin-bottom: 12px; padding-left: 16px; border-left: 2px solid #eee; }
    .clause-number { font-weight: bold; color: ${primaryColor}; }
    .highlight-box {
      background: #fff8e1; border: 1px solid #ffd54f;
      border-radius: 4px; padding: 10px 14px; margin: 12px 0; font-size: 10px;
    }
    .signature-section {
      margin-top: 50px; display: grid; grid-template-columns: 1fr 1fr; gap: 50px;
    }
    .sig-box { border-top: 1px solid #333; padding-top: 8px; }
    .sig-line {
      border-top: 1px solid #999; margin-top: 40px;
      padding-top: 6px; font-size: 10px; color: #666;
    }
    .footer {
      margin-top: 40px; padding-top: 12px; border-top: 1px solid #eee;
      font-size: 9px; color: #aaa; text-align: center;
    }
    @page { margin: 20mm; }
  </style>
</head>
<body>
  <div class="header">
    <div>
      ${
        logoDataUrl
          ? `<img src="${logoDataUrl}" style="height:48px;max-width:180px;object-fit:contain;" alt="${org.name}">`
          : `<div style="font-size:20px;font-weight:bold;color:${primaryColor}">${org.name}</div>`
      }
      <div style="font-size:11px;color:#666">${org.name}</div>
      <div class="header-title">HYRESKONTRAKT</div>
      <div class="header-sub">
        ${isResidential ? 'Bostadslägenhet' : 'Lokal/Kommersiell fastighet'} — ${org.name}
      </div>
    </div>
    <div class="contract-number">
      Upprättat: ${today}<br>
      Kontrakt nr: ${contractNumber}
    </div>
  </div>

  <h2>§ 1 — Parter</h2>
  <div class="party-grid">
    <div class="party-box">
      <div class="party-label">Hyresvärd</div>
      <div class="field-row">
        <span class="field-label">Namn/Företag</span>
        <span class="field-value">${org.name}</span>
      </div>
      <div class="field-row">
        <span class="field-label">Adress</span>
        <span class="field-value">${org.street}, ${org.postalCode} ${org.city}</span>
      </div>
      ${
        org.bankgiro
          ? `<div class="field-row">
        <span class="field-label">Bankgiro</span>
        <span class="field-value">${org.bankgiro}</span>
      </div>`
          : ''
      }
    </div>
    <div class="party-box">
      <div class="party-label">Hyresgäst</div>
      <div class="field-row">
        <span class="field-label">Namn</span>
        <span class="field-value">${tenantName}</span>
      </div>
      <div class="field-row">
        <span class="field-label">E-post</span>
        <span class="field-value">${lease.tenant.email}</span>
      </div>
      ${
        lease.tenant.phone
          ? `<div class="field-row">
        <span class="field-label">Telefon</span>
        <span class="field-value">${lease.tenant.phone}</span>
      </div>`
          : ''
      }
      ${
        lease.tenant.personalNumber
          ? `<div class="field-row">
        <span class="field-label">Personnummer</span>
        <span class="field-value">${lease.tenant.personalNumber}</span>
      </div>`
          : ''
      }
    </div>
  </div>

  <h2>§ 2 — Hyresobjekt</h2>
  <div class="field-row">
    <span class="field-label">Fastighet</span>
    <span class="field-value">${lease.unit.property.name} (${lease.unit.property.propertyDesignation})</span>
  </div>
  <div class="field-row">
    <span class="field-label">Adress</span>
    <span class="field-value">${lease.unit.property.street}, ${lease.unit.property.postalCode} ${lease.unit.property.city}</span>
  </div>
  <div class="field-row">
    <span class="field-label">Lägenhet/Enhet</span>
    <span class="field-value">${lease.unit.name} (nr ${lease.unit.unitNumber})</span>
  </div>
  ${
    lease.unit.area
      ? `<div class="field-row">
    <span class="field-label">Area</span>
    <span class="field-value">${lease.unit.area} m²</span>
  </div>`
      : ''
  }
  ${
    lease.unit.rooms
      ? `<div class="field-row">
    <span class="field-label">Antal rum</span>
    <span class="field-value">${lease.unit.rooms} rum</span>
  </div>`
      : ''
  }

  <h2>§ 3 — Hyrestid</h2>
  <div class="info-grid">
    <div class="info-item">
      <div class="label">Tillträdesdatum</div>
      <div class="value">${new Date(lease.startDate).toLocaleDateString('sv-SE')}</div>
    </div>
    <div class="info-item">
      <div class="label">Kontraktsform</div>
      <div class="value">${lease.endDate ? 'Tidsbegränsat' : 'Tillsvidare'}</div>
    </div>
    <div class="info-item">
      <div class="label">Uppsägningstid</div>
      <div class="value">${noticePeriod}</div>
    </div>
  </div>
  ${
    lease.endDate
      ? `<div class="field-row">
    <span class="field-label">Slutdatum</span>
    <span class="field-value">${new Date(lease.endDate).toLocaleDateString('sv-SE')}</span>
  </div>`
      : ''
  }

  <h2>§ 4 — Hyra och betalning</h2>
  <div class="info-grid">
    <div class="info-item">
      <div class="label">Månadshyra</div>
      <div class="value">${Number(lease.monthlyRent).toLocaleString('sv-SE')} kr</div>
    </div>
    <div class="info-item">
      <div class="label">Betalningsdag</div>
      <div class="value">Senast 1:a varje månad</div>
    </div>
    <div class="info-item">
      <div class="label">Deposition</div>
      <div class="value">${
        Number(lease.depositAmount) > 0
          ? `${Number(lease.depositAmount).toLocaleString('sv-SE')} kr`
          : 'Ingen deposition'
      }</div>
    </div>
  </div>
  ${
    org.bankgiro
      ? `<div class="field-row" style="margin-top:8px">
    <span class="field-label">Betalas till</span>
    <span class="field-value">Bankgiro ${org.bankgiro}</span>
  </div>`
      : ''
  }
  <div class="highlight-box">
    ⚠️ Hyran ska betalas i förskott senast den 1:a varje månad.
    Vid försenad betalning debiteras dröjsmålsränta enligt räntelagen.
  </div>

  <h2>§ 5 — Indexklausul</h2>
  <div class="clause">
    Hyran är kopplad till konsumentprisindex (KPI). Hyran kan justeras
    en gång per år med förändringen i KPI (oktober–oktober).
    Skriftligt meddelande om hyreshöjning lämnas senast 3 månader
    i förväg i enlighet med 12 kap. 55 § Jordabalken.
  </div>

  <h2>§ 6 — Skick och underhåll</h2>
  <div class="clause">
    <span class="clause-number">6.1</span>
    Hyresgästen förbinder sig att väl vårda hyresobjektet och hålla
    det i gott skick under hyrestiden.
  </div>
  <div class="clause">
    <span class="clause-number">6.2</span>
    Hyresgästen ansvarar för reparationer av skador uppkomna genom
    oaktsamhet eller vårdslöshet av hyresgästen eller dennes gäster.
  </div>
  <div class="clause">
    <span class="clause-number">6.3</span>
    Hyresvärden ansvarar för det löpande underhållet av fastigheten
    och gemensamma utrymmen.
  </div>

  <h2>§ 7 — Tillträde</h2>
  <div class="clause">
    Hyresvärden äger rätt att besiktiga hyresobjektet efter
    24 timmars skriftlig varsel. Vid akuta situationer såsom
    vattenläcka eller brandrisk kan tillträde ske utan förvarning.
  </div>

  ${
    isResidential
      ? `
  <h2>§ 8 — Andrahandsuthyrning</h2>
  <div class="clause">
    Andrahandsuthyrning är ej tillåten utan hyresvärdens skriftliga
    godkännande. Ansökan ska inlämnas i god tid och hyresvärden ska
    ge besked inom skälig tid.
  </div>

  <h2>§ 9 — Husdjur</h2>
  <div class="clause">
    Innehav av husdjur kräver hyresvärdens skriftliga godkännande.
  </div>

  <h2>§ 10 — Övriga bestämmelser</h2>`
      : `<h2>§ 8 — Övriga bestämmelser</h2>`
  }
  <div class="clause">
    För detta hyresförhållande gäller i tillämpliga delar
    bestämmelserna i 12 kap. Jordabalken (Hyreslagen).
    Vid tvist ska parterna i första hand söka lösa denna
    genom förhandling. I andra hand kan ärendet hänskjutas
    till Hyresnämnden.
  </div>

  <div class="signature-section">
    <div>
      <div class="sig-box">
        <strong>HYRESVÄRD — ${org.name}</strong>
        <div class="sig-line">Ort och datum</div>
        <div class="sig-line">Underskrift</div>
        <div class="sig-line">Namnförtydligande</div>
      </div>
    </div>
    <div>
      <div class="sig-box">
        <strong>HYRESGÄST — ${tenantName}</strong>
        <div class="sig-line">Ort och datum</div>
        <div class="sig-line">Underskrift</div>
        <div class="sig-line">Namnförtydligande: ${tenantName}</div>
      </div>
    </div>
  </div>

  <div class="footer">
    Detta kontrakt är upprättat i två likalydande exemplar, ett till vardera parten. |
    Genererat av Eken Fastighetsförvaltning ${today}
  </div>
</body>
</html>`
  }

  private async fetchLease(leaseId: string, organizationId: string) {
    return this.prisma.lease.findFirst({
      where: { id: leaseId, unit: { property: { organizationId } } },
      include: {
        tenant: true,
        unit: { include: { property: true } },
      },
    })
  }

  private async fetchOrg(organizationId: string) {
    return this.prisma.organization.findUnique({ where: { id: organizationId } })
  }

  async buildPdfBuffer(leaseId: string, organizationId: string): Promise<Buffer> {
    const [lease, org] = await Promise.all([
      this.fetchLease(leaseId, organizationId),
      this.fetchOrg(organizationId),
    ])
    if (!lease) throw new NotFoundException('Kontraktet hittades inte')
    if (!org) throw new NotFoundException('Organisationen hittades inte')
    const html = await this.buildHtml(lease, org)
    return this.pdfService.generateFromHtml(html)
  }

  async generateLeaseContract(
    leaseId: string,
    organizationId: string,
    userId: string,
  ): Promise<{ buffer: Buffer; documentId: string }> {
    const [lease, org] = await Promise.all([
      this.fetchLease(leaseId, organizationId),
      this.fetchOrg(organizationId),
    ])
    if (!lease) throw new NotFoundException('Kontraktet hittades inte')
    if (!org) throw new NotFoundException('Organisationen hittades inte')

    const tenantName =
      lease.tenant.type === 'INDIVIDUAL'
        ? `${lease.tenant.firstName ?? ''} ${lease.tenant.lastName ?? ''}`.trim()
        : (lease.tenant.companyName ?? '')

    const html = await this.buildHtml(lease, org)
    const buffer = await this.pdfService.generateFromHtml(html)

    const safeName = `${uuid()}.pdf`
    const relDir = `uploads/documents/${organizationId}`
    const absDir = path.join(process.cwd(), relDir)
    await fs.mkdir(absDir, { recursive: true })
    await fs.writeFile(path.join(absDir, safeName), buffer)

    const doc = await this.prisma.document.create({
      data: {
        organizationId,
        uploadedById: userId,
        leaseId: lease.id,
        unitId: lease.unitId,
        propertyId: lease.unit.propertyId,
        tenantId: lease.tenantId,
        name: `Hyreskontrakt – ${tenantName}`,
        fileUrl: `${relDir}/${safeName}`,
        fileSize: buffer.length,
        mimeType: 'application/pdf',
        category: 'CONTRACT',
      },
    })

    return { buffer, documentId: doc.id }
  }
}
