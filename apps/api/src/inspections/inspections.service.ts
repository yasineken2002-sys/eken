import { Injectable, NotFoundException } from '@nestjs/common'
import type { PrismaService } from '../common/prisma/prisma.service'
import type { PdfService } from '../invoices/pdf.service'
import { InspectionStatus, InspectionType } from '@prisma/client'
import type { InspectionItemCondition } from '@prisma/client'
import type { CreateInspectionDto } from './dto/create-inspection.dto'
import type { UpdateInspectionDto } from './dto/update-inspection.dto'
import type { UpdateInspectionItemDto } from './dto/update-inspection-item.dto'

const DEFAULT_ITEMS: { room: string; item: string }[] = [
  { room: 'Hall', item: 'Golv' },
  { room: 'Hall', item: 'Väggar' },
  { room: 'Hall', item: 'Tak' },
  { room: 'Kök', item: 'Golv' },
  { room: 'Kök', item: 'Väggar' },
  { room: 'Kök', item: 'Vitvaror' },
  { room: 'Kök', item: 'Köksluckor' },
  { room: 'Kök', item: 'Bänkskiva' },
  { room: 'Badrum', item: 'Golv' },
  { room: 'Badrum', item: 'Väggar' },
  { room: 'Badrum', item: 'Toalett' },
  { room: 'Badrum', item: 'Dusch/Badkar' },
  { room: 'Vardagsrum', item: 'Golv' },
  { room: 'Vardagsrum', item: 'Väggar' },
  { room: 'Vardagsrum', item: 'Tak' },
  { room: 'Sovrum', item: 'Golv' },
  { room: 'Sovrum', item: 'Väggar' },
  { room: 'Övrigt', item: 'Fönster' },
  { room: 'Övrigt', item: 'Dörrar' },
  { room: 'Övrigt', item: 'Lås' },
]

function formatSek(amount: number): string {
  return new Intl.NumberFormat('sv-SE', {
    style: 'currency',
    currency: 'SEK',
    maximumFractionDigits: 0,
  }).format(amount)
}

function formatDateStr(d: Date | string): string {
  return new Date(d).toLocaleDateString('sv-SE', { year: 'numeric', month: 'long', day: 'numeric' })
}

function translateType(type: InspectionType): string {
  const m: Record<InspectionType, string> = {
    MOVE_IN: 'Inflyttningsbesiktning',
    MOVE_OUT: 'Utflyttningsbesiktning',
    PERIODIC: 'Periodisk besiktning',
    DAMAGE: 'Skadebesiktning',
  }
  return m[type]
}

function conditionColor(condition: InspectionItemCondition): string {
  switch (condition) {
    case 'GOOD':
      return '#059669'
    case 'ACCEPTABLE':
      return '#D97706'
    case 'DAMAGED':
      return '#DC2626'
    case 'MISSING':
      return '#DC2626'
  }
}

function conditionLabel(condition: InspectionItemCondition): string {
  const m: Record<InspectionItemCondition, string> = {
    GOOD: 'Bra',
    ACCEPTABLE: 'Acceptabelt',
    DAMAGED: 'Skadat',
    MISSING: 'Saknas',
  }
  return m[condition]
}

const FULL_INCLUDE = {
  property: true,
  unit: true,
  tenant: true,
  lease: true,
  items: true,
  images: true,
} as const

@Injectable()
export class InspectionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pdfService: PdfService,
  ) {}

  async findAll(
    orgId: string,
    filters?: {
      unitId?: string
      propertyId?: string
      type?: InspectionType
      status?: InspectionStatus
    },
  ) {
    return this.prisma.inspection.findMany({
      where: {
        organizationId: orgId,
        ...(filters?.unitId ? { unitId: filters.unitId } : {}),
        ...(filters?.propertyId ? { propertyId: filters.propertyId } : {}),
        ...(filters?.type ? { type: filters.type } : {}),
        ...(filters?.status ? { status: filters.status } : {}),
      },
      include: FULL_INCLUDE,
      orderBy: { scheduledDate: 'desc' },
    })
  }

  async findOne(id: string, orgId: string) {
    const inspection = await this.prisma.inspection.findFirst({
      where: { id, organizationId: orgId },
      include: FULL_INCLUDE,
    })
    if (!inspection) throw new NotFoundException('Besiktning hittades inte')
    return inspection
  }

  async create(dto: CreateInspectionDto, orgId: string, userId: string) {
    const inspection = await this.prisma.inspection.create({
      data: {
        organizationId: orgId,
        inspectedById: userId,
        type: dto.type,
        scheduledDate: new Date(dto.scheduledDate),
        propertyId: dto.propertyId,
        unitId: dto.unitId,
        ...(dto.leaseId ? { leaseId: dto.leaseId } : {}),
        ...(dto.tenantId ? { tenantId: dto.tenantId } : {}),
      },
    })

    if (dto.type === InspectionType.MOVE_IN || dto.type === InspectionType.MOVE_OUT) {
      await this.prisma.inspectionItem.createMany({
        data: DEFAULT_ITEMS.map((i) => ({
          inspectionId: inspection.id,
          room: i.room,
          item: i.item,
        })),
      })
    }

    return this.prisma.inspection.findUnique({
      where: { id: inspection.id },
      include: FULL_INCLUDE,
    })
  }

  async update(id: string, dto: UpdateInspectionDto, orgId: string) {
    await this.findOne(id, orgId)

    return this.prisma.inspection.update({
      where: { id },
      data: {
        ...(dto.status ? { status: dto.status } : {}),
        ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
        ...(dto.overallCondition !== undefined ? { overallCondition: dto.overallCondition } : {}),
        ...(dto.status === InspectionStatus.COMPLETED ? { completedAt: new Date() } : {}),
        ...(dto.completedAt ? { completedAt: new Date(dto.completedAt) } : {}),
        ...(dto.signedAt ? { signedAt: new Date(dto.signedAt) } : {}),
        ...(dto.tenantSignature !== undefined ? { tenantSignature: dto.tenantSignature } : {}),
        ...(dto.landlordSignature !== undefined
          ? { landlordSignature: dto.landlordSignature }
          : {}),
      },
      include: FULL_INCLUDE,
    })
  }

  async updateItem(
    inspectionId: string,
    itemId: string,
    dto: UpdateInspectionItemDto,
    orgId: string,
  ) {
    const inspection = await this.prisma.inspection.findFirst({
      where: { id: inspectionId, organizationId: orgId },
    })
    if (!inspection) throw new NotFoundException('Besiktning hittades inte')

    return this.prisma.inspectionItem.update({
      where: { id: itemId },
      data: {
        ...(dto.condition !== undefined ? { condition: dto.condition } : {}),
        ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
        ...(dto.repairCost !== undefined ? { repairCost: dto.repairCost } : {}),
      },
    })
  }

  async delete(id: string, orgId: string) {
    await this.findOne(id, orgId)
    return this.prisma.inspection.delete({ where: { id } })
  }

  async generateProtocolPdf(id: string, orgId: string): Promise<Buffer> {
    const inspection = await this.findOne(id, orgId)
    const org = await this.prisma.organization.findUnique({ where: { id: orgId } })
    if (!org) throw new NotFoundException('Organisation hittades inte')

    const tenantName = inspection.tenant
      ? inspection.tenant.type === 'INDIVIDUAL'
        ? `${inspection.tenant.firstName ?? ''} ${inspection.tenant.lastName ?? ''}`.trim()
        : (inspection.tenant.companyName ?? '')
      : 'Ej angiven'

    // Group items by room
    const rooms = new Map<string, typeof inspection.items>()
    for (const item of inspection.items) {
      if (!rooms.has(item.room)) rooms.set(item.room, [])
      rooms.get(item.room)!.push(item)
    }

    const damagedItems = inspection.items.filter(
      (i) => i.condition === 'DAMAGED' || i.condition === 'MISSING',
    )
    const totalRepairCost = inspection.items.reduce((sum, i) => sum + Number(i.repairCost ?? 0), 0)

    const roomHtml = Array.from(rooms.entries())
      .map(
        ([room, items]) => `
      <div class="room-section">
        <div class="room-title">${room}</div>
        <table class="items-table">
          <thead>
            <tr>
              <th>Föremål</th>
              <th>Kondition</th>
              <th>Anteckning</th>
              <th>Kostnad</th>
            </tr>
          </thead>
          <tbody>
            ${items
              .map(
                (item) => `
              <tr>
                <td>${item.item}</td>
                <td><span class="condition-badge" style="color:${conditionColor(item.condition as InspectionItemCondition)};background:${conditionColor(item.condition as InspectionItemCondition)}1a">${conditionLabel(item.condition as InspectionItemCondition)}</span></td>
                <td>${item.notes ?? '—'}</td>
                <td>${item.repairCost ? formatSek(Number(item.repairCost)) : '—'}</td>
              </tr>`,
              )
              .join('')}
          </tbody>
        </table>
      </div>`,
      )
      .join('')

    const accent = org.invoiceColor ?? '#2563EB'

    const html = `<!DOCTYPE html>
<html lang="sv">
<head>
  <meta charset="UTF-8" />
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
           color: #111827; background: #fff; padding: 48px; }
    .header { border-bottom: 3px solid ${accent}; padding-bottom: 24px; margin-bottom: 32px;
              display: flex; justify-content: space-between; align-items: flex-start; }
    .org-name { font-size: 22px; font-weight: 700; color: ${accent}; }
    .doc-title { font-size: 28px; font-weight: 700; margin-bottom: 4px; }
    .doc-sub { font-size: 14px; color: #6b7280; }
    .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px 32px; margin-bottom: 32px;
                 background: #f9fafb; border-radius: 10px; padding: 20px 24px; }
    .info-label { font-size: 11px; font-weight: 600; text-transform: uppercase;
                  letter-spacing: 0.06em; color: #9ca3af; margin-bottom: 4px; }
    .info-value { font-size: 14px; font-weight: 500; }
    .room-section { margin-bottom: 24px; }
    .room-title { font-size: 15px; font-weight: 700; color: ${accent};
                  border-bottom: 2px solid ${accent}1a; padding-bottom: 8px; margin-bottom: 12px; }
    .items-table { width: 100%; border-collapse: collapse; font-size: 13px; }
    .items-table th { text-align: left; font-size: 11px; font-weight: 600; text-transform: uppercase;
                      letter-spacing: 0.05em; color: #9ca3af; padding: 6px 8px;
                      border-bottom: 1px solid #e5e7eb; }
    .items-table td { padding: 8px; border-bottom: 1px solid #f3f4f6; }
    .condition-badge { display: inline-block; border-radius: 9999px; padding: 2px 10px;
                       font-size: 12px; font-weight: 600; }
    .summary { background: #f9fafb; border-radius: 10px; padding: 20px 24px; margin: 32px 0;
               display: flex; gap: 32px; }
    .summary-item { flex: 1; }
    .summary-label { font-size: 12px; font-weight: 600; text-transform: uppercase;
                     color: #9ca3af; letter-spacing: 0.06em; margin-bottom: 6px; }
    .summary-value { font-size: 20px; font-weight: 700; }
    .signatures { display: grid; grid-template-columns: 1fr 1fr; gap: 32px; margin-top: 48px; }
    .sig-box { border: 1px solid #e5e7eb; border-radius: 10px; padding: 20px 24px; }
    .sig-title { font-size: 13px; font-weight: 600; color: #374151; margin-bottom: 32px; }
    .sig-line { border-top: 1px solid #374151; padding-top: 8px;
                font-size: 12px; color: #6b7280; }
    .footer { margin-top: 48px; padding-top: 16px; border-top: 1px solid #e5e7eb;
              font-size: 12px; color: #9ca3af; text-align: center; }
  </style>
</head>
<body>
  <div class="header">
    <div class="org-name">${org.name}</div>
    <div style="text-align:right">
      <div class="doc-title">Besiktningsprotokoll</div>
      <div class="doc-sub">${translateType(inspection.type)}</div>
    </div>
  </div>

  <div class="info-grid">
    <div>
      <div class="info-label">Fastighet</div>
      <div class="info-value">${inspection.property.name}</div>
    </div>
    <div>
      <div class="info-label">Enhet</div>
      <div class="info-value">${inspection.unit.name}</div>
    </div>
    <div>
      <div class="info-label">Hyresgäst</div>
      <div class="info-value">${tenantName}</div>
    </div>
    <div>
      <div class="info-label">Datum</div>
      <div class="info-value">${formatDateStr(inspection.scheduledDate)}</div>
    </div>
  </div>

  ${roomHtml}

  <div class="summary">
    <div class="summary-item">
      <div class="summary-label">Skadade föremål</div>
      <div class="summary-value" style="color:${damagedItems.length > 0 ? '#DC2626' : '#059669'}">${damagedItems.length}</div>
    </div>
    <div class="summary-item">
      <div class="summary-label">Bedömd reparationskostnad</div>
      <div class="summary-value" style="color:${totalRepairCost > 0 ? '#DC2626' : '#059669'}">${totalRepairCost > 0 ? formatSek(totalRepairCost) : '0 kr'}</div>
    </div>
    ${inspection.overallCondition ? `<div class="summary-item" style="flex:2"><div class="summary-label">Övergripande kommentar</div><div style="font-size:14px;margin-top:4px">${inspection.overallCondition}</div></div>` : ''}
  </div>

  <div class="signatures">
    <div class="sig-box">
      <div class="sig-title">Hyresvärd</div>
      <div class="sig-line">Namn och underskrift</div>
      <div style="margin-top:16px" class="sig-line">Datum</div>
    </div>
    <div class="sig-box">
      <div class="sig-title">Hyresgäst</div>
      <div class="sig-line">Namn och underskrift</div>
      <div style="margin-top:16px" class="sig-line">Datum</div>
    </div>
  </div>

  <div class="footer">Utfärdad av ${org.name} · Powered by Eken Fastighetsförvaltning</div>
</body>
</html>`

    return this.pdfService.generateFromHtml(html)
  }

  async getStats(orgId: string) {
    const [grouped, byType] = await Promise.all([
      this.prisma.inspection.groupBy({
        by: ['status'],
        where: { organizationId: orgId },
        _count: true,
      }),
      this.prisma.inspection.groupBy({
        by: ['type'],
        where: { organizationId: orgId },
        _count: true,
      }),
    ])

    const byStatus: Record<string, number> = {}
    for (const g of grouped) byStatus[g.status] = g._count

    const byTypeMap: Record<string, number> = {}
    for (const g of byType) byTypeMap[g.type] = g._count

    const total = Object.values(byStatus).reduce((s, n) => s + n, 0)

    return {
      total,
      scheduled: byStatus['SCHEDULED'] ?? 0,
      inProgress: byStatus['IN_PROGRESS'] ?? 0,
      completed: byStatus['COMPLETED'] ?? 0,
      signed: byStatus['SIGNED'] ?? 0,
      byType: {
        MOVE_IN: byTypeMap['MOVE_IN'] ?? 0,
        MOVE_OUT: byTypeMap['MOVE_OUT'] ?? 0,
        PERIODIC: byTypeMap['PERIODIC'] ?? 0,
        DAMAGE: byTypeMap['DAMAGE'] ?? 0,
      },
    }
  }
}
