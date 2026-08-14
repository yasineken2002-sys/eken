import { Injectable, NotFoundException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../common/prisma/prisma.service'
import { SAFE_ORGANIZATION_SELECT } from './organization-select'
import { StorageService } from '../storage/storage.service'
import { UpdateOrganizationDto } from './dto/update-organization.dto'
import {
  validateUploadedFile,
  extensionForDetectedMime,
  DETECTED_WEB_IMAGE_TYPES,
  MAX_LOGO_BYTES,
} from '../common/utils/file-validation'

interface MultipartFile {
  toBuffer(): Promise<Buffer>
}

@Injectable()
export class OrganizationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  // Returtypen härleds UR SELECTEN (`OrganizationGetPayload`), inte skrivs
  // separat. Då snävas typen i takt med queryn: läser en anropare ett fält som
  // lyfts ur selecten faller `pnpm typecheck`, i stället för att fältet tyst blir
  // `undefined` i runtime. Samma mekanik som avslöjade fyra vägar i #349.
  async findMyOrganization(
    organizationId: string,
  ): Promise<Prisma.OrganizationGetPayload<{ select: typeof SAFE_ORGANIZATION_SELECT }>> {
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      // Prenumerations- och faktureringsblocket lämnar inte den här endpointen.
      // Se organization-select.ts för hela resonemanget.
      select: SAFE_ORGANIZATION_SELECT,
    })
    if (!org) throw new NotFoundException('Organisationen hittades inte')

    // logoStorageUrl i databasen är en presignerad R2-URL från upload-tillfället
    // (TTL 1h) och blir därför stale. Skriv över med en färsk presigned URL
    // varje gång org:t hämtas så att <img src> i settings/PDF-genereringen
    // alltid funkar oavsett när logon laddades upp.
    if (org.logoStorageKey) {
      try {
        return { ...org, logoStorageUrl: await this.storage.getPresignedUrl(org.logoStorageKey) }
      } catch {
        // Faller tillbaka på lagrad URL om R2 är otillgängligt — bättre att
        // visa en eventuellt utgången URL än att hela settings-sidan kraschar.
        return org
      }
    }
    return org
  }

  async update(organizationId: string, dto: UpdateOrganizationDto) {
    // F-skatt-datum: bara meningsfullt när hasFSkatt = true. Om
    // användaren bockar av F-skatt nollställer vi datumet samtidigt.
    const fSkattDateUpdate = (() => {
      if (dto.hasFSkatt === false) return { fSkattApprovedDate: null }
      if (dto.fSkattApprovedDate != null) {
        return { fSkattApprovedDate: new Date(dto.fSkattApprovedDate) }
      }
      return {}
    })()

    return this.prisma.organization.update({
      where: { id: organizationId },
      data: {
        ...(dto.bankgiro != null ? { bankgiro: dto.bankgiro } : {}),
        ...(dto.paymentTermsDays != null ? { paymentTermsDays: dto.paymentTermsDays } : {}),
        ...(dto.invoiceColor != null ? { invoiceColor: dto.invoiceColor } : {}),
        ...(dto.invoiceTemplate != null ? { invoiceTemplate: dto.invoiceTemplate } : {}),
        ...(dto.brandFont != null ? { brandFont: dto.brandFont } : {}),
        ...(dto.brandSecondaryColor != null
          ? { brandSecondaryColor: dto.brandSecondaryColor }
          : {}),
        ...(dto.morningReportEnabled != null
          ? { morningReportEnabled: dto.morningReportEnabled }
          : {}),
        ...(dto.remindersEnabled != null ? { remindersEnabled: dto.remindersEnabled } : {}),
        ...(dto.reminderFeeSek != null ? { reminderFeeSek: dto.reminderFeeSek } : {}),
        ...(dto.reminderFormalDay != null ? { reminderFormalDay: dto.reminderFormalDay } : {}),
        ...(dto.reminderCollectionDay != null
          ? { reminderCollectionDay: dto.reminderCollectionDay }
          : {}),
        ...(dto.collectionAgencyName != null
          ? { collectionAgencyName: dto.collectionAgencyName }
          : {}),
        ...(dto.hasFSkatt != null ? { hasFSkatt: dto.hasFSkatt } : {}),
        ...fSkattDateUpdate,
        ...(dto.vatNumber != null ? { vatNumber: dto.vatNumber } : {}),
        ...(dto.vatReportingPeriod != null ? { vatReportingPeriod: dto.vatReportingPeriod } : {}),
        ...(dto.daysBeforeMoveInForFirstPayment != null
          ? { daysBeforeMoveInForFirstPayment: dto.daysBeforeMoveInForFirstPayment }
          : {}),
        ...(dto.maxBankTxAmount != null ? { maxBankTxAmount: dto.maxBankTxAmount } : {}),
      },
    })
  }

  async uploadLogo(organizationId: string, file: MultipartFile) {
    // SECURITY (H3): buffra FÖRST, validera sedan mot innehållet. Den gamla
    // koden avgjorde både typ och filändelse på `file.mimetype` — en header
    // klienten sätter själv — så en omdöpt .svg eller .html blev
    // organisationens logotyp och renderades sedan i fakturor och PDF:er.
    const buffer = await file.toBuffer()
    const detected = validateUploadedFile(buffer, {
      allowedDetectedMimes: DETECTED_WEB_IMAGE_TYPES,
      maxBytes: MAX_LOGO_BYTES,
    })

    // Ändelsen (och därmed nyckeln) följer den validerade typen.
    const storageKey = `logos/${organizationId}.${extensionForDetectedMime(detected)}`

    const existing = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { logoStorageKey: true },
    })
    if (existing?.logoStorageKey && existing.logoStorageKey !== storageKey) {
      await this.storage.deleteFile(existing.logoStorageKey)
    }

    const storageUrl = await this.storage.uploadFile(buffer, storageKey, detected ?? 'image/png')

    const updated = await this.prisma.organization.update({
      where: { id: organizationId },
      data: { logoStorageKey: storageKey, logoStorageUrl: storageUrl },
    })

    // Returnera samma färska URL som findMyOrganization annars genererar — så
    // att frontend kan visa logon direkt efter upload utan att behöva göra
    // en extra refetch först.
    return { ...updated, logoStorageUrl: await this.storage.getPresignedUrl(storageKey) }
  }
}
