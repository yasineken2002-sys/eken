import * as crypto from 'crypto'
import { v4 as uuid } from 'uuid'
import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common'
import { SigningRequestStatus } from '@prisma/client'
import { PrismaService } from '../common/prisma/prisma.service'
import { PdfService } from '../invoices/pdf.service'
import { StorageService } from '../storage/storage.service'
import { LockService } from '../common/redis/lock.service'
import { getLogoDataUrl } from '../common/branding/logo.util'
import { buildResidentialContractHtml } from './residential-contract.template'
import { buildCommercialContractHtml } from './commercial-contract.template'
import {
  type ContractTemplateInput,
  contractNumberLabel,
  tenantDisplayName,
} from './contract-template.shared'

// Hur länge en nyligen genererad PDF räknas som "färsk" och kan återanvändas
// av den andra requesten i en race istället för att köra Puppeteer igen. 30 s
// täcker normala dubbelklick utan att gömma riktiga uppdateringar (lease som
// ändras → ny PDF även om någon precis genererat en).
const RECENT_CONTRACT_WINDOW_MS = 30_000

// Stabil JSON-stringify som sorterar nycklar djupt. Behövs för deterministisk
// fingerprint av template-input — annars varierar JSON.stringify-output med
// nyckel-ordning från queries och då dedupar vi inget. Datum hanteras separat
// (Date → ISO-sträng).
function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return JSON.stringify(value)
  if (value instanceof Date) return JSON.stringify(value.toISOString())
  if (typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']'
  }
  const keys = Object.keys(value as Record<string, unknown>).sort()
  return (
    '{' +
    keys
      .map((k) => JSON.stringify(k) + ':' + stableStringify((value as Record<string, unknown>)[k]))
      .join(',') +
    '}'
  )
}

function fingerprintTemplateInput(input: ContractTemplateInput): string {
  return crypto.createHash('sha256').update(stableStringify(input)).digest('hex')
}

@Injectable()
export class ContractTemplateService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pdfService: PdfService,
    private readonly storage: StorageService,
    private readonly locks: LockService,
  ) {}

  // ── Datainsamling och templating ──────────────────────────────────────

  private async fetchLease(leaseId: string, organizationId: string) {
    return this.prisma.lease.findFirst({
      where: { id: leaseId, unit: { property: { organizationId } } },
      include: { tenant: true, unit: { include: { property: true } } },
    })
  }

  // Hämtar dokument som markerats som kontraktsbilagor. Sortering: explicit
  // appendixOrder först (low→high), därefter category-prioritet (energi-
  // deklaration högst — krävs av lag), sedan createdAt. Dokument utan
  // appendixOrder hamnar sist i sin kategori.
  private async fetchAppendices(leaseId: string, organizationId: string) {
    const docs = await this.prisma.document.findMany({
      where: { leaseId, organizationId, attachedToLeaseAsAppendix: true },
      orderBy: [{ appendixOrder: 'asc' }, { createdAt: 'asc' }],
      select: {
        id: true,
        name: true,
        category: true,
        fileSize: true,
      },
    })
    const categoryOrder: Record<string, number> = {
      ENERGY_DECLARATION: 0,
      HOUSE_RULES: 1,
      INSPECTION_PROTOCOL: 2,
      OTHER: 3,
    }
    return docs
      .map((d) => ({
        id: d.id,
        title: d.name,
        category: (categoryOrder[d.category] !== undefined ? d.category : 'OTHER') as
          | 'ENERGY_DECLARATION'
          | 'HOUSE_RULES'
          | 'INSPECTION_PROTOCOL'
          | 'OTHER',
        fileSize: d.fileSize ?? undefined,
      }))
      .sort((a, b) => (categoryOrder[a.category] ?? 99) - (categoryOrder[b.category] ?? 99))
  }

  private async fetchOrg(organizationId: string) {
    return this.prisma.organization.findUnique({ where: { id: organizationId } })
  }

  private async buildInput(
    lease: NonNullable<Awaited<ReturnType<ContractTemplateService['fetchLease']>>>,
    org: NonNullable<Awaited<ReturnType<ContractTemplateService['fetchOrg']>>>,
  ): Promise<ContractTemplateInput> {
    const logoDataUrl = await getLogoDataUrl(this.storage, org.logoStorageKey ?? null)

    const appendices = await this.fetchAppendices(lease.id, lease.organizationId)

    return {
      appendices,
      lease: {
        id: lease.id,
        contractNumber: lease.contractNumber,
        status: lease.status,
        startDate: lease.startDate,
        endDate: lease.endDate,
        monthlyRent: Number(lease.monthlyRent),
        depositAmount: Number(lease.depositAmount),
        leaseType: lease.leaseType,
        renewalPeriodMonths: lease.renewalPeriodMonths,
        noticePeriodMonths: lease.noticePeriodMonths,
        activatedAt: lease.activatedAt,
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
        specialTerms: lease.specialTerms,
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
        // Delar samma template-val som fakturan så kunder ser konsekvent
        // brevpapper. Falls back till "classic" om ingenting är satt.
        invoiceTemplate: org.invoiceTemplate ?? 'classic',
        logoDataUrl,
        companyForm: org.companyForm,
        hasFSkatt: org.hasFSkatt,
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
    const input = await this.buildInput(lease, org)
    const html = this.renderHtml(input)
    return this.pdfService.generateContractFromHtml(html, {
      contractNumber: contractNumberLabel(input),
      organizationName: input.organization.name,
    })
  }

  /**
   * Generera kontrakts-PDF, ladda upp till storage och spara en
   * Document-rad. Returnerar dokumentets ID + buffert + content-hash.
   *
   * Om en föregående version finns och `linkPrevious=true` kopplas den
   * nya raden via `previousVersionId` så hela versionskedjan är
   * spårbar (renew, status-change m.m.).
   *
   * Hela operationen körs under ett distribuerat Redis-lock per leaseId.
   * Två samtidiga klick på "generera" eller en race mellan controller
   * och Bull-jobbet får annars två Document-rader och två R2-objekt.
   *
   * När låset väl tagits kontrollerar vi om någon redan precis genererade
   * en PDF (inom RECENT_CONTRACT_WINDOW_MS) — i så fall returnerar vi
   * den raden istället för att bygga en ny. Det matchar förväntningen att
   * "tryck två gånger snabbt" ger ETT dokument, inte två versioner.
   */
  async generateLeaseContract(
    leaseId: string,
    organizationId: string,
    userId: string | null,
    options: { linkPrevious?: boolean } = {},
  ): Promise<{ buffer: Buffer; documentId: string; contentHash: string }> {
    return this.locks.runWithLock(
      `contract-generation:${leaseId}`,
      () => this.generateLeaseContractUnsafe(leaseId, organizationId, userId, options),
      { ttlSec: 30, waitMs: 25_000 },
    )
  }

  private async generateLeaseContractUnsafe(
    leaseId: string,
    organizationId: string,
    userId: string | null,
    options: { linkPrevious?: boolean },
  ): Promise<{ buffer: Buffer; documentId: string; contentHash: string }> {
    const [lease, org] = await Promise.all([
      this.fetchLease(leaseId, organizationId),
      this.fetchOrg(organizationId),
    ])
    if (!lease) throw new NotFoundException('Kontraktet hittades inte')
    if (!org) throw new NotFoundException('Organisationen hittades inte')

    // WYSIWYS (Item 4, S1): medan ett kontrakt för denna lease är UNDER SIGNERING
    // får PDF:en inte regenereras — den frusna contentHash är exakt det parterna
    // signerar. En input-ändring skulle annars skapa en ny version med annan hash.
    // Avbryt signeringen först.
    const activeSigning = await this.prisma.signingRequest.findFirst({
      where: {
        organizationId,
        leaseId,
        status: { in: [SigningRequestStatus.PENDING, SigningRequestStatus.SIGNING_IN_PROGRESS] },
      },
      select: { id: true },
    })
    if (activeSigning) {
      throw new BadRequestException(
        'Kontraktet är under signering och kan inte regenereras — avbryt signeringen först.',
      )
    }

    // Bygg template-input och dess fingerprint *innan* vi går vidare till
    // Puppeteer. Den hashen är vår dedup-nyckel: alla tidigare CONTRACT-rader
    // för leasen med samma hash beskriver bit-för-bit samma kontrakt och kan
    // återanvändas, oavsett hur många gånger admin har klickat "Generera".
    const input = await this.buildInput(lease, org)
    const inputHash = fingerprintTemplateInput(input)

    // Återanvändbar = (a) samma input-hash, (b) inte låst (en låst PDF är
    // signerad och måste alltid lämnas orörd — ändringar kräver ny version),
    // (c) skapad efter senaste lease-uppdatering så ingen redigering missas.
    // Vi sorterar på createdAt desc så vi får den färskaste raden om flera
    // tidigare jobb råkat skapa identiska dubletter.
    const reusable = await this.prisma.document.findFirst({
      where: {
        leaseId,
        organizationId,
        category: 'CONTRACT',
        templateInputHash: inputHash,
        locked: false,
      },
      orderBy: { createdAt: 'desc' },
    })
    if (reusable && reusable.contentHash && reusable.createdAt >= lease.updatedAt) {
      const buffer = await this.storage.getFileBuffer(reusable.storageKey)
      return { buffer, documentId: reusable.id, contentHash: reusable.contentHash }
    }

    // Race-fönster: två snabba klick kan landa båda inom låset i tur och
    // ordning. Om någon precis hann skriva en CONTRACT-rad inom de senaste
    // 30 sekunderna och lease inte ändrats sedan dess — återanvänd även om
    // hashen råkar skilja (t.ex. äldre rader utan templateInputHash satt).
    const recent = await this.prisma.document.findFirst({
      where: {
        leaseId,
        organizationId,
        category: 'CONTRACT',
        locked: false,
        createdAt: { gt: new Date(Date.now() - RECENT_CONTRACT_WINDOW_MS) },
      },
      orderBy: { createdAt: 'desc' },
    })
    if (recent && recent.contentHash && recent.createdAt >= lease.updatedAt) {
      const buffer = await this.storage.getFileBuffer(recent.storageKey)
      return { buffer, documentId: recent.id, contentHash: recent.contentHash }
    }

    const html = this.renderHtml(input)
    const buffer = await this.pdfService.generateContractFromHtml(html, {
      contractNumber: contractNumberLabel(input),
      organizationName: input.organization.name,
    })
    const contentHash = crypto.createHash('sha256').update(buffer).digest('hex')

    const tenantName = tenantDisplayName(input.tenant)

    const safeName = `${uuid()}.pdf`
    const storageKey = `documents/${organizationId}/${safeName}`
    const storageUrl = await this.storage.uploadFile(buffer, storageKey, 'application/pdf')

    // Hitta senaste CONTRACT-rad för leasen — vi länkar bara versionerna
    // när det är meningsfullt (om previousVersionId redan är satt på en
    // annan rad i kedjan så pekar vi på den raden, inte ursprunget; se
    // `previousVersion`-relationen). Locked rader får också vara previous —
    // det är hela poängen med versionskedjan: behåll signerad version som
    // historik och peka mot den från den nya.
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
        // userId är null för system-genererade dokument (auto-jobb, cron, fix-skript).
        // Document.uploadedById är nullable; vi utelämnar fältet helt vid null så
        // Prisma inte försöker länka mot en obefintlig User.
        ...(userId ? { uploadedById: userId } : {}),
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
        templateInputHash: inputHash,
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
    signature: {
      tenantId: string
      ip: string | null
      userAgent: string | null
      signatureName?: string | null
    },
  ): Promise<void> {
    await this.prisma.document.update({
      where: { id: documentId },
      data: {
        signedAt: new Date(),
        signedByTenantId: signature.tenantId,
        signedFromIp: signature.ip,
        signedUserAgent: signature.userAgent,
        signatureName: signature.signatureName ?? null,
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
