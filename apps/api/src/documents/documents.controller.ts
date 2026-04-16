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
  Res,
} from '@nestjs/common'
import { ApiBearerAuth, ApiTags, ApiOperation, ApiConsumes } from '@nestjs/swagger'
import type { FastifyRequest, FastifyReply } from 'fastify'
import type { DocumentsService } from './documents.service'
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
      const { BadRequestException } = await import('@nestjs/common')
      throw new BadRequestException('Ingen fil hittades i formuläret')
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
  @ApiOperation({ summary: 'Ladda ner dokument' })
  async download(@Param('id') id: string, @OrgId() orgId: string, @Res() reply: FastifyReply) {
    const { document } = await this.service.getFilePath(id, orgId)
    const relativeUrl = document.fileUrl

    void reply
      .header('Content-Type', document.mimeType)
      .header('Content-Disposition', `attachment; filename="${encodeURIComponent(document.name)}"`)
    // fastify-static serves from the uploads directory via /uploads/ prefix
    // We strip the 'uploads/' prefix since fastify-static root is the uploads folder
    const fileRelativePath = relativeUrl.replace(/^uploads\//, '')
    return reply.sendFile(fileRelativePath)
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Ta bort dokument' })
  remove(@Param('id') id: string, @OrgId() orgId: string) {
    return this.service.remove(id, orgId)
  }
}
