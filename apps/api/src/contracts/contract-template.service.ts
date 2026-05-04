import * as crypto from 'crypto'
import { v4 as uuid } from 'uuid'
import { Injectable, NotFoundException } from '@nestjs/common'
import { PrismaService } from '../common/prisma/prisma.service'
import { PdfService } from '../invoices/pdf.service'
import { StorageService } from '../storage/storage.service'
import { buildResidentialContractHtml } from './residential-contract.template'
import { buildCommercialContractHtml } from './commercial-contract.template'
import { type ContractTemplateInput, tenantDisplayName } from './contract-template.shared'

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

@Injectable()
export class ContractTemplateService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pdfService: PdfService,
    private readonly storage: StorageService,
  ) {}

  // ── Datainsamling och templating ──────────────────────────────────────

  private async fetchLease(leaseId: string, organizationId: string) {
    return this.prisma.lease.findFirst({
      where: { id: leaseId, unit: { property: { organizationId } } },
      include: { tenant: true, unit: { include: { property: true } } },
    })
  }

  private async fetchOrg(organizationId: string) {
    return this.prisma.organization.findUnique({ where: { id: organizationId } })
  }

  private async buildInput(
    lease: NonNullable<Awaited<ReturnType<ContractTemplateService['fetchLease']>>>,
    org: NonNullable<Awaited<ReturnType<ContractTemplateService['fetchOrg']>>>,
  ): Promise<ContractTemplateInput> {
    const logoDataUrl = await getLogoDataUrl(this.storage, org.logoStorageKey ?? null)

    return {
      lease: {
        id: lease.id,
        startDate: lease.startDate,
        endDate: lease.endDate,
        monthlyRent: Number(lease.monthlyRent),
        depositAmount: Number(lease.depositAmount),
        leaseType: lease.leaseType,
        renewalPeriodMonths: lease.renewalPeriodMonths,
        noticePeriodMonths: lease.noticePeriodMonths,
        signedAt: lease.signedAt,
        includesHeating: lease.includesHeating,
        includesWater: lease.includesWater,
        includesHotWater: lease.includesHotWater,
        includesElectricity: lease.includesElectricity,
        includesInternet: lease.includesInternet,
        includesCleaning: lease.includesCleaning,
        includesParking: lease.includesParking,
        includesStorage: lease.includesStorage,
        includesLaundry: lease.includesLaundry,
        parkingFee: lease.parkingFee != null ? Number(lease.parkingFee) : null,
        storageFee: lease.storageFee != null ? Number(lease.storageFee) : null,
        garageFee: lease.garageFee != null ? Number(lease.garageFee) : null,
        usagePurpose: lease.usagePurpose,
        petsAllowed: lease.petsAllowed,
        petsApprovalNotes: lease.petsApprovalNotes,
        sublettingAllowed: lease.sublettingAllowed,
        requiresHomeInsurance: lease.requiresHomeInsurance,
        indexClauseType: lease.indexClauseType,
        indexBaseYear: lease.indexBaseYear,
        indexAdjustmentDate: lease.indexAdjustmentDate,
        indexMaxIncrease: lease.indexMaxIncrease != null ? Number(lease.indexMaxIncrease) : null,
        indexMinIncrease: lease.indexMinIncrease != null ? Number(lease.indexMinIncrease) : null,
        indexNotes: lease.indexNotes,
      },
      organization: {
        name: org.name,
        orgNumber: org.orgNumber,
        vatNumber: org.vatNumber,
        email: org.email,
        phone: org.phone,
        street: org.street,
        postalCode: org.postalCode,
        city: org.city,
        bankgiro: org.bankgiro,
        invoiceColor: org.invoiceColor ?? null,
        logoDataUrl,
      },
      tenant: {
        type: lease.tenant.type,
        firstName: lease.tenant.firstName,
        lastName: lease.tenant.lastName,
        companyName: lease.tenant.companyName,
        contactPerson: lease.tenant.contactPerson,
        personalNumber: lease.tenant.personalNumber,
        orgNumber: lease.tenant.orgNumber,
        email: lease.tenant.email,
        phone: lease.tenant.phone,
        street: lease.tenant.street,
        postalCode: lease.tenant.postalCode,
        city: lease.tenant.city,
      },
      unit: {
        name: lease.unit.name,
        unitNumber: lease.unit.unitNumber,
        type: lease.unit.type,
        area: Number(lease.unit.area),
        floor: lease.unit.floor,
        rooms: lease.unit.rooms,
        hasBalcony: lease.unit.hasBalcony,
        hasStorage: lease.unit.hasStorage,
        storageNumber: lease.unit.storageNumber,
        parkingSpaceNumber: lease.unit.parkingSpaceNumber,
      },
      property: {
        name: lease.unit.property.name,
        propertyDesignation: lease.unit.property.propertyDesignation,
        street: lease.unit.property.street,
        postalCode: lease.unit.property.postalCode,
        city: lease.unit.property.city,
        fireSafetyNotes: lease.unit.property.fireSafetyNotes,
        commonAreasNotes: lease.unit.property.commonAreasNotes,
        garbageDisposalRules: lease.unit.property.garbageDisposalRules,
      },
    }
  }

  private renderHtml(input: ContractTemplateInput): string {
    return input.unit.type === 'APARTMENT'
      ? buildResidentialContractHtml(input)
      : buildCommercialContractHtml(input)
  }

  // ── Publikt API ─────────────────────────────────────────────────────────

  async buildPdfBuffer(leaseId: string, organizationId: string): Promise<Buffer> {
    const [lease, org] = await Promise.all([
      this.fetchLease(leaseId, organizationId),
      this.fetchOrg(organizationId),
    ])
    if (!lease) throw new NotFoundException('Kontraktet hittades inte')
    if (!org) throw new NotFoundException('Organisationen hittades inte')
    const html = this.renderHtml(await this.buildInput(lease, org))
    return this.pdfService.generateFromHtml(html)
  }

  /**
   * Generera kontrakts-PDF, ladda upp till storage och spara en
   * Document-rad. Returnerar dokumentets ID + buffert + content-hash.
   *
   * Om en föregående version finns och `linkPrevious=true` kopplas den
   * nya raden via `previousVersionId` så hela versionskedjan är
   * spårbar (renew, status-change m.m.).
   */
  async generateLeaseContract(
    leaseId: string,
    organizationId: string,
    userId: string,
    options: { linkPrevious?: boolean } = {},
  ): Promise<{ buffer: Buffer; documentId: string; contentHash: string }> {
    const [lease, org] = await Promise.all([
      this.fetchLease(leaseId, organizationId),
      this.fetchOrg(organizationId),
    ])
    if (!lease) throw new NotFoundException('Kontraktet hittades inte')
    if (!org) throw new NotFoundException('Organisationen hittades inte')

    const input = await this.buildInput(lease, org)
    const html = this.renderHtml(input)
    const buffer = await this.pdfService.generateFromHtml(html)
    const contentHash = crypto.createHash('sha256').update(buffer).digest('hex')

    const tenantName = tenantDisplayName(input.tenant)

    const safeName = `${uuid()}.pdf`
    const storageKey = `documents/${organizationId}/${safeName}`
    const storageUrl = await this.storage.uploadFile(buffer, storageKey, 'application/pdf')

    // Hitta senaste icke-låsta CONTRACT-rad för leasen — vi länkar bara
    // versionerna när det är meningsfullt (om previousVersionId redan
    // är satt på en annan rad i kedjan så pekar vi på den raden, inte
    // ursprunget; se `previousVersion`-relationen).
    let previousVersionId: string | null = null
    if (options.linkPrevious) {
      const prev = await this.prisma.document.findFirst({
        where: { leaseId, category: 'CONTRACT' },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      })
      previousVersionId = prev?.id ?? null
    }

    const doc = await this.prisma.document.create({
      data: {
        organizationId,
        uploadedById: userId,
        leaseId: lease.id,
        unitId: lease.unitId,
        propertyId: lease.unit.propertyId,
        tenantId: lease.tenantId,
        name: `Hyreskontrakt – ${tenantName}`,
        storageKey,
        storageUrl,
        fileSize: buffer.length,
        mimeType: 'application/pdf',
        category: 'CONTRACT',
        contentHash,
        ...(previousVersionId ? { previousVersionId } : {}),
      },
    })

    return { buffer, documentId: doc.id, contentHash }
  }

  /**
   * Lås en kontrakts-PDF efter att hyresgästen signerat digitalt.
   * Skriver SHA-256-hash + signaturmetadata på Document-raden så att
   * PDF:en blir oföränderlig (ny version krävs vid framtida ändring).
   */
  async lockContractAfterSignature(
    documentId: string,
    signature: { tenantId: string; ip: string | null; userAgent: string | null },
  ): Promise<void> {
    await this.prisma.document.update({
      where: { id: documentId },
      data: {
        signedAt: new Date(),
        signedByTenantId: signature.tenantId,
        signedFromIp: signature.ip,
        signedUserAgent: signature.userAgent,
        locked: true,
      },
    })
  }

  /** Hitta senaste kontrakts-PDF för ett lease (om någon finns). */
  async findLatestContract(leaseId: string, organizationId: string) {
    return this.prisma.document.findFirst({
      where: { leaseId, organizationId, category: 'CONTRACT' },
      orderBy: { createdAt: 'desc' },
    })
  }
}
