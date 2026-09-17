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
import { v4 as uuid } from 'uuid'
import { InspectionsService } from './inspections.service'
import { InspectionAnalyzerService } from './inspection-analyzer.service'
import { ImageInput } from './inspection-analyzer.service'
import { CreateInspectionDto } from './dto/create-inspection.dto'
import { UpdateInspectionDto } from './dto/update-inspection.dto'
import { UpdateInspectionItemDto } from './dto/update-inspection-item.dto'
import { OrgId } from '../common/decorators/org-id.decorator'
import { Roles } from '../common/decorators/roles.decorator'
import { CurrentUser } from '../common/decorators/current-user.decorator'
import { StorageService } from '../storage/storage.service'
import {
  validateUploadedFile,
  extensionForDetectedMime,
  DETECTED_WEB_IMAGE_TYPES,
  MAX_INSPECTION_IMAGE_BYTES,
} from '../common/utils/file-validation'
import type { JwtPayload } from '@eken/shared'
import type { InspectionType, InspectionStatus } from '@prisma/client'

@Controller('inspections')
export class InspectionsController {
  constructor(
    private readonly inspectionsService: InspectionsService,
    private readonly analyzerService: InspectionAnalyzerService,
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
  @Roles('MANAGER', 'ADMIN', 'OWNER')
  async create(
    @OrgId() orgId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateInspectionDto,
  ) {
    return this.inspectionsService.create(dto, orgId, user.sub)
  }

  @Patch(':id')
  @Roles('MANAGER', 'ADMIN', 'OWNER')
  async update(@OrgId() orgId: string, @Param('id') id: string, @Body() dto: UpdateInspectionDto) {
    return this.inspectionsService.update(id, dto, orgId)
  }

  @Patch(':id/items/:itemId')
  @Roles('MANAGER', 'ADMIN', 'OWNER')
  async updateItem(
    @OrgId() orgId: string,
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Body() dto: UpdateInspectionItemDto,
  ) {
    return this.inspectionsService.updateItem(id, itemId, dto, orgId)
  }

  @Post(':id/analyze')
  @Roles('MANAGER', 'ADMIN', 'OWNER')
  async analyze(
    @Req() request: FastifyRequest,
    @OrgId() orgId: string,
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
  ) {
    // TIDIG AVVISNING: en signerad besiktning nekas INNAN bilder laddas upp och
    // innan vision-modellen anropas. Det är bekvämlighet, inte spärr — den
    // riktiga kontrollen görs om under radlås i tjänsten vid varje skrivning,
    // eftersom en signering hinner ske under modellanropet.
    await this.inspectionsService.findOneUnsigned(id, orgId)
    // `mimetype` från multiparten läses INTE — se valideringen nedan.
    const files: Array<{ buffer: Buffer; filename: string }> = []
    const captions: Record<string, string> = {}

    for await (const part of request.parts()) {
      if (part.type === 'file') {
        const buffer = await part.toBuffer()
        files.push({ buffer, filename: part.filename })
      } else {
        captions[part.fieldname] = part.value as string
      }
    }

    if (files.length === 0) throw new BadRequestException('Inga bilder hittades')
    if (files.length > 10) throw new BadRequestException('Max 10 bilder per analys')

    // SECURITY (H3): typen avgörs av MAGISKA BYTEN, inte av klientens
    // Content-Type. Den gamla allowlisten läste `part.mimetype`, en header
    // klienten sätter själv — och typen skickades sedan vidare BÅDE till
    // lagringen och som `media_type` till vision-modellen.
    //
    // Storlekstaket är NYTT: vägen hade inget alls. Med 10 bilder och Fastifys
    // 20 MB-gräns per fil kunde en analys dra in 200 MB.
    const detectedMimes = files.map((f) =>
      validateUploadedFile(f.buffer, {
        allowedDetectedMimes: DETECTED_WEB_IMAGE_TYPES,
        maxBytes: MAX_INSPECTION_IMAGE_BYTES,
      }),
    )

    const imageInputs: ImageInput[] = []
    const bildrader: Parameters<InspectionsService['saveAnalysisImages']>[2] = []
    for (let i = 0; i < files.length; i++) {
      const f = files[i]!
      // Validerad typ hela vägen: nyckelns ändelse, lagringens Content-Type och
      // vision-modellens media_type kommer alla från samma detektion.
      const mimeType = detectedMimes[i] ?? 'image/jpeg'
      const safeName = `${uuid()}.${extensionForDetectedMime(mimeType)}`
      const storageKey = `inspections/${orgId}/${safeName}`
      const storageUrl = await this.storage.uploadFile(f.buffer, storageKey, mimeType)
      const caption = captions[`caption_${i}`] ?? null
      bildrader.push({
        filename: f.filename,
        storageKey,
        storageUrl,
        caption,
        room: null,
        size: f.buffer.length,
      })
      imageInputs.push({
        buffer: f.buffer,
        mimeType: mimeType as ImageInput['mimeType'],
        ...(caption ? { caption } : {}),
      })
    }

    // Bildraderna gick förut rakt in via `prisma.inspectionImage.create` utan
    // någon kontroll av besiktningens status. De skrivs nu genom tjänsten, i en
    // transaktion som tar samma radlås som signeringen.
    await this.inspectionsService.saveAnalysisImages(id, orgId, bildrader)

    const analysis = await this.analyzerService.analyzeImages(imageInputs, orgId, user.sub)

    // Skrivningen tillbaka in i protokollet låg förut här, som fyra ogrindade
    // prisma-anrop mot en `inspection` som lästes FÖRE modellanropet. Mellan den
    // läsningen och den här raden ligger hela vision-anropet — flera sekunder
    // där en signering hinner committas. Tjänsten tar om kontrollen under lås
    // och läser om posterna i samma transaktion.
    const { updatedItems, createdItems } = await this.inspectionsService.applyAnalysis(
      id,
      orgId,
      analysis,
    )

    return { analysis, updatedItems, createdItems }
  }

  @Delete(':id')
  @Roles('ADMIN', 'OWNER')
  @HttpCode(HttpStatus.OK)
  async delete(@OrgId() orgId: string, @Param('id') id: string) {
    return this.inspectionsService.delete(id, orgId)
  }
}
