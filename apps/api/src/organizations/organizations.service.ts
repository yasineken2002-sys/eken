import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common'
import * as fs from 'fs/promises'
import * as path from 'path'
import type { PrismaService } from '../common/prisma/prisma.service'
import type { UpdateOrganizationDto } from './dto/update-organization.dto'

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
  constructor(private readonly prisma: PrismaService) {}

  async findMyOrganization(organizationId: string) {
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
    })
    if (!org) throw new NotFoundException('Organisationen hittades inte')
    return org
  }

  async update(organizationId: string, dto: UpdateOrganizationDto) {
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
      },
    })
  }

  async uploadLogo(organizationId: string, file: MultipartFile) {
    if (!ALLOWED_MIMETYPES.includes(file.mimetype)) {
      throw new BadRequestException('Endast PNG, JPEG och WebP tillåts')
    }

    const ext = extFromMimetype(file.mimetype)
    const dir = path.join(process.cwd(), 'uploads', 'logos')
    await fs.mkdir(dir, { recursive: true })

    const buffer = await file.toBuffer()
    const filename = `${organizationId}.${ext}`
    await fs.writeFile(path.join(dir, filename), buffer)

    return this.prisma.organization.update({
      where: { id: organizationId },
      data: { logoUrl: `uploads/logos/${filename}` },
    })
  }
}
