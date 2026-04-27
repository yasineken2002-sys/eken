import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { DocumentCategory } from '@prisma/client'
import * as path from 'path'
import { v4 as uuid } from 'uuid'
import { PrismaService } from '../common/prisma/prisma.service'
import { StorageService } from '../storage/storage.service'

const ALLOWED_MIME_TYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'image/jpeg',
  'image/png',
  'image/webp',
]

const MAX_FILE_SIZE = 20 * 1024 * 1024 // 20 MB

export interface UploadFileData {
  buffer: Buffer
  filename: string
  mimetype: string
  size: number
}

export interface UploadDocumentInput {
  name: string
  description?: string | undefined
  category?: DocumentCategory | undefined
  propertyId?: string | undefined
  unitId?: string | undefined
  leaseId?: string | undefined
  tenantId?: string | undefined
}

@Injectable()
export class DocumentsService {
  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
    private storage: StorageService,
  ) {}

  async findAll(
    organizationId: string,
    filters?: {
      propertyId?: string
      unitId?: string
      leaseId?: string
      tenantId?: string
      category?: DocumentCategory
    },
  ) {
    const documents = await this.prisma.document.findMany({
      where: {
        organizationId,
        ...(filters?.propertyId ? { propertyId: filters.propertyId } : {}),
        ...(filters?.unitId ? { unitId: filters.unitId } : {}),
        ...(filters?.leaseId ? { leaseId: filters.leaseId } : {}),
        ...(filters?.tenantId ? { tenantId: filters.tenantId } : {}),
        ...(filters?.category ? { category: filters.category } : {}),
      },
      include: {
        uploadedBy: { select: { firstName: true, lastName: true } },
        property: { select: { name: true } },
        unit: { select: { name: true } },
        lease: { select: { id: true } },
        tenant: { select: { firstName: true, lastName: true, companyName: true, type: true } },
      },
      orderBy: { createdAt: 'desc' },
    })
    return documents
  }

  async findOne(id: string, organizationId: string) {
    const document = await this.prisma.document.findFirst({
      where: { id, organizationId },
      include: {
        uploadedBy: { select: { firstName: true, lastName: true } },
      },
    })
    if (!document) throw new NotFoundException('Dokumentet hittades inte')
    return document
  }

  async upload(
    file: UploadFileData,
    dto: UploadDocumentInput,
    organizationId: string,
    uploadedById: string,
  ) {
    if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      throw new BadRequestException(
        'Filtypen stöds inte. Tillåtna format: PDF, Word, Excel, JPG, PNG',
      )
    }

    if (file.size > MAX_FILE_SIZE) {
      throw new BadRequestException('Filen är för stor. Maximal filstorlek är 20 MB.')
    }

    const ext = path.extname(file.filename)
    const safeName = `${uuid()}${ext}`
    const storageKey = `documents/${organizationId}/${safeName}`

    const storageUrl = await this.storage.uploadFile(file.buffer, storageKey, file.mimetype)

    const document = await this.prisma.document.create({
      data: {
        organizationId,
        name: dto.name,
        description: dto.description ?? null,
        storageKey,
        storageUrl,
        fileSize: file.size,
        mimeType: file.mimetype,
        category: dto.category ?? DocumentCategory.OTHER,
        propertyId: dto.propertyId ?? null,
        unitId: dto.unitId ?? null,
        leaseId: dto.leaseId ?? null,
        tenantId: dto.tenantId ?? null,
        uploadedById,
      },
      include: {
        uploadedBy: { select: { firstName: true, lastName: true } },
      },
    })

    return document
  }

  async remove(id: string, organizationId: string): Promise<void> {
    const document = await this.findOne(id, organizationId)
    await this.storage.deleteFile(document.storageKey)
    await this.prisma.document.delete({ where: { id } })
  }

  async getDownloadUrl(
    id: string,
    organizationId: string,
  ): Promise<{ url: string; document: Awaited<ReturnType<DocumentsService['findOne']>> }> {
    const document = await this.findOne(id, organizationId)
    const url = await this.storage.getPresignedUrl(document.storageKey, 300)
    return { url, document }
  }
}
