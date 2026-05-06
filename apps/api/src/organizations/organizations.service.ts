import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common'
import { PrismaService } from '../common/prisma/prisma.service'
import { StorageService } from '../storage/storage.service'
import { UpdateOrganizationDto } from './dto/update-organization.dto'

interface MultipartFile {
  mimetype: string
  toBuffer(): Promise<Buffer>
}

const ALLOWED_MIMETYPES = ['image/png', 'image/jpeg', 'image/webp']

function extFromMimetype(mime: string): string {
  if (mime === 'image/png') return 'png'
  if (mime === 'image/webp') return 'webp'
  return 'jpg'
}

@Injectable()
export class OrganizationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  async findMyOrganization(organizationId: string) {
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
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
      },
    })
  }

  async uploadLogo(organizationId: string, file: MultipartFile) {
    if (!ALLOWED_MIMETYPES.includes(file.mimetype)) {
      throw new BadRequestException('Endast PNG, JPEG och WebP tillåts')
    }

    const ext = extFromMimetype(file.mimetype)
    const buffer = await file.toBuffer()
    const storageKey = `logos/${organizationId}.${ext}`

    const existing = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { logoStorageKey: true },
    })
    if (existing?.logoStorageKey && existing.logoStorageKey !== storageKey) {
      await this.storage.deleteFile(existing.logoStorageKey)
    }

    const storageUrl = await this.storage.uploadFile(buffer, storageKey, file.mimetype)

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
