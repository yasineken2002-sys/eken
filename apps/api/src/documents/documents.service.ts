import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common'
import type { ConfigService } from '@nestjs/config'
import { DocumentCategory } from '@prisma/client'
import * as fs from 'fs'
import * as path from 'path'
import { v4 as uuid } from 'uuid'
import type { PrismaService } from '../common/prisma/prisma.service'

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
    const relDir = `uploads/documents/${organizationId}`
    const absDir = path.join(process.cwd(), relDir)

    await fs.promises.mkdir(absDir, { recursive: true })

    const relPath = `${relDir}/${safeName}`
    const absPath = path.join(process.cwd(), relPath)

    await fs.promises.writeFile(absPath, file.buffer)

    const document = await this.prisma.document.create({
      data: {
        organizationId,
        name: dto.name,
        description: dto.description ?? null,
        fileUrl: relPath,
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

    const absPath = path.join(process.cwd(), document.fileUrl)
    try {
      await fs.promises.unlink(absPath)
    } catch {
      // File not found on disk — continue with DB deletion
    }

    await this.prisma.document.delete({ where: { id } })
  }

  async getFilePath(
    id: string,
    organizationId: string,
  ): Promise<{ filePath: string; document: Awaited<ReturnType<DocumentsService['findOne']>> }> {
    const document = await this.findOne(id, organizationId)
    const filePath = path.join(process.cwd(), document.fileUrl)

    try {
      await fs.promises.access(filePath)
    } catch {
      throw new NotFoundException('Filen hittades inte på disk')
    }

    return { filePath, document }
  }
}
