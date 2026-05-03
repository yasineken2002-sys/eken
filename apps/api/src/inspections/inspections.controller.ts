import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  Req,
  Res,
  HttpCode,
  HttpStatus,
  BadRequestException,
} from '@nestjs/common'
import type { FastifyReply, FastifyRequest } from 'fastify'
import * as path from 'path'
import { v4 as uuid } from 'uuid'
import { InspectionsService } from './inspections.service'
import { InspectionAnalyzerService } from './inspection-analyzer.service'
import { ImageInput } from './inspection-analyzer.service'
import { CreateInspectionDto } from './dto/create-inspection.dto'
import { UpdateInspectionDto } from './dto/update-inspection.dto'
import { UpdateInspectionItemDto } from './dto/update-inspection-item.dto'
import { OrgId } from '../common/decorators/org-id.decorator'
import { CurrentUser } from '../common/decorators/current-user.decorator'
import { PrismaService } from '../common/prisma/prisma.service'
import { StorageService } from '../storage/storage.service'
import type { JwtPayload } from '@eken/shared'
import type { InspectionType, InspectionStatus } from '@prisma/client'

@Controller('inspections')
export class InspectionsController {
  constructor(
    private readonly inspectionsService: InspectionsService,
    private readonly analyzerService: InspectionAnalyzerService,
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  @Get('stats')
  async stats(@OrgId() orgId: string) {
    return this.inspectionsService.getStats(orgId)
  }

  @Get()
  async findAll(
    @OrgId() orgId: string,
    @Query('unitId') unitId?: string,
    @Query('propertyId') propertyId?: string,
    @Query('type') type?: string,
    @Query('status') status?: string,
  ) {
    return this.inspectionsService.findAll(orgId, {
      ...(unitId ? { unitId } : {}),
      ...(propertyId ? { propertyId } : {}),
      ...(type ? { type: type as InspectionType } : {}),
      ...(status ? { status: status as InspectionStatus } : {}),
    })
  }

  @Get(':id/pdf')
  async pdf(@OrgId() orgId: string, @Param('id') id: string, @Res() reply: FastifyReply) {
    const buffer = await this.inspectionsService.generateProtocolPdf(id, orgId)
    void reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', 'attachment; filename="besiktningsprotokoll.pdf"')
      .send(buffer)
  }

  @Get(':id')
  async findOne(@OrgId() orgId: string, @Param('id') id: string) {
    return this.inspectionsService.findOne(id, orgId)
  }

  @Post()
  async create(
    @OrgId() orgId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateInspectionDto,
  ) {
    return this.inspectionsService.create(dto, orgId, user.sub)
  }

  @Patch(':id')
  async update(@OrgId() orgId: string, @Param('id') id: string, @Body() dto: UpdateInspectionDto) {
    return this.inspectionsService.update(id, dto, orgId)
  }

  @Patch(':id/items/:itemId')
  async updateItem(
    @OrgId() orgId: string,
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Body() dto: UpdateInspectionItemDto,
  ) {
    return this.inspectionsService.updateItem(id, itemId, dto, orgId)
  }

  @Post(':id/analyze')
  async analyze(
    @Req() request: FastifyRequest,
    @OrgId() orgId: string,
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
  ) {
    const inspection = await this.inspectionsService.findOne(id, orgId)
    const ALLOWED = ['image/jpeg', 'image/png', 'image/webp']
    const files: Array<{ buffer: Buffer; filename: string; mimetype: string }> = []
    const captions: Record<string, string> = {}

    for await (const part of request.parts()) {
      if (part.type === 'file') {
        const buffer = await part.toBuffer()
        files.push({ buffer, filename: part.filename, mimetype: part.mimetype })
      } else {
        captions[part.fieldname] = part.value as string
      }
    }

    if (files.length === 0) throw new BadRequestException('Inga bilder hittades')
    if (files.length > 10) throw new BadRequestException('Max 10 bilder per analys')
    for (const f of files) {
      if (!ALLOWED.includes(f.mimetype))
        throw new BadRequestException(`Filtypen ${f.mimetype} stöds inte`)
    }

    const imageInputs: ImageInput[] = []
    for (let i = 0; i < files.length; i++) {
      const f = files[i]!
      const ext = path.extname(f.filename) || `.${f.mimetype.split('/')[1]}`
      const safeName = `${uuid()}${ext}`
      const storageKey = `inspections/${orgId}/${safeName}`
      const storageUrl = await this.storage.uploadFile(f.buffer, storageKey, f.mimetype)
      const caption = captions[`caption_${i}`] ?? null
      await this.prisma.inspectionImage.create({
        data: {
          inspectionId: id,
          filename: f.filename,
          storageKey,
          storageUrl,
          caption,
          room: null,
          size: f.buffer.length,
        },
      })
      imageInputs.push({
        buffer: f.buffer,
        mimeType: f.mimetype as ImageInput['mimeType'],
        ...(caption ? { caption } : {}),
      })
    }

    const analysis = await this.analyzerService.analyzeImages(imageInputs, orgId, user.sub)

    let updatedCount = 0
    let createdCount = 0
    for (const ai of analysis.items) {
      const existing = inspection.items.find((it) => it.room === ai.room && it.item === ai.item)
      if (existing) {
        await this.prisma.inspectionItem.update({
          where: { id: existing.id },
          data: {
            condition: ai.condition,
            ...(ai.notes ? { notes: ai.notes } : {}),
            ...(ai.repairCost != null ? { repairCost: ai.repairCost } : {}),
          },
        })
        updatedCount++
      } else {
        await this.prisma.inspectionItem.create({
          data: {
            inspectionId: id,
            room: ai.room,
            item: ai.item,
            condition: ai.condition,
            notes: ai.notes ?? null,
            repairCost: ai.repairCost ?? null,
          },
        })
        createdCount++
      }
    }

    await this.prisma.inspection.update({
      where: { id },
      data: {
        overallCondition: analysis.overallCondition,
        notes: analysis.notes,
      },
    })

    return { analysis, updatedItems: updatedCount, createdItems: createdCount }
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  async delete(@OrgId() orgId: string, @Param('id') id: string) {
    return this.inspectionsService.delete(id, orgId)
  }
}
