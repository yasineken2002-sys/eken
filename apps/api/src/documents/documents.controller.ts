import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  Req,
  BadRequestException,
} from '@nestjs/common'
import { ApiBearerAuth, ApiTags, ApiOperation, ApiConsumes } from '@nestjs/swagger'
import type { FastifyRequest } from 'fastify'
import { DocumentsService } from './documents.service'
import { OrgId } from '../common/decorators/org-id.decorator'
import { CurrentUser } from '../common/decorators/current-user.decorator'
import type { JwtPayload } from '@eken/shared'
import type { DocumentCategory } from '@prisma/client'
import * as path from 'path'

@ApiTags('Documents')
@ApiBearerAuth()
@Controller('documents')
export class DocumentsController {
  constructor(private service: DocumentsService) {}

  @Get()
  @ApiOperation({ summary: 'Lista dokument med valfria filter' })
  findAll(
    @OrgId() orgId: string,
    @Query('propertyId') propertyId?: string,
    @Query('unitId') unitId?: string,
    @Query('leaseId') leaseId?: string,
    @Query('tenantId') tenantId?: string,
    @Query('category') category?: DocumentCategory,
  ) {
    return this.service.findAll(orgId, {
      ...(propertyId ? { propertyId } : {}),
      ...(unitId ? { unitId } : {}),
      ...(leaseId ? { leaseId } : {}),
      ...(tenantId ? { tenantId } : {}),
      ...(category ? { category } : {}),
    })
  }

  @Post()
  @ApiOperation({ summary: 'Ladda upp dokument (multipart/form-data)' })
  @ApiConsumes('multipart/form-data')
  async upload(
    @Req() request: FastifyRequest,
    @OrgId() orgId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    const data = request.parts()

    let fileBuffer: Buffer | null = null
    let filename = ''
    let mimetype = ''
    let fileSize = 0
    const dto: Record<string, string> = {}

    for await (const part of data) {
      if (part.type === 'file') {
        fileBuffer = await part.toBuffer()
        filename = part.filename
        mimetype = part.mimetype
        fileSize = fileBuffer.length
      } else {
        dto[part.fieldname] = part.value as string
      }
    }

    if (!fileBuffer || !filename) {
      throw new BadRequestException('Ingen fil hittades i formuläret')
    }

    const ALLOWED_MIME_TYPES = [
      'application/pdf',
      'image/jpeg',
      'image/png',
      'image/webp',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ]
    const MAX_FILE_SIZE = 10 * 1024 * 1024

    if (!ALLOWED_MIME_TYPES.includes(mimetype)) {
      throw new BadRequestException('Filtyp inte tillåten')
    }
    if (fileSize > MAX_FILE_SIZE) {
      throw new BadRequestException('Filen är för stor (max 10MB)')
    }

    return this.service.upload(
      { buffer: fileBuffer, filename, mimetype, size: fileSize },
      {
        name: dto['name'] ?? path.parse(filename).name,
        ...(dto['description'] ? { description: dto['description'] } : {}),
        ...(dto['category'] ? { category: dto['category'] as DocumentCategory } : {}),
        ...(dto['propertyId'] ? { propertyId: dto['propertyId'] } : {}),
        ...(dto['unitId'] ? { unitId: dto['unitId'] } : {}),
        ...(dto['leaseId'] ? { leaseId: dto['leaseId'] } : {}),
        ...(dto['tenantId'] ? { tenantId: dto['tenantId'] } : {}),
      },
      orgId,
      user.sub,
    )
  }

  @Get(':id/download')
  @ApiOperation({ summary: 'Hämta presignerad nedladdnings-URL för dokument' })
  async download(@Param('id') id: string, @OrgId() orgId: string) {
    // Returnerar presigned R2-URL (~5 min TTL) som JSON istället för 302-redirect.
    // Tidigare lösning krävde att webbläsaren skickade Authorization-headern på
    // den initiala GET:en, vilket är omöjligt vid window.open() — resultatet
    // blev 401 UNAUTHORIZED. Frontend hämtar nu URL:en med auth via fetch och
    // öppnar sedan den signerade URL:en direkt mot R2.
    const { url, document } = await this.service.getDownloadUrl(id, orgId)
    return { url, filename: document.name, mimeType: document.mimeType }
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Ta bort dokument' })
  remove(@Param('id') id: string, @OrgId() orgId: string) {
    return this.service.remove(id, orgId)
  }
}
