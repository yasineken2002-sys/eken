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
  ConflictException,
  Logger,
} from '@nestjs/common'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { createHash } from 'node:crypto'
import { v4 as uuid } from 'uuid'
import { InspectionsService } from './inspections.service'
import { InspectionAnalyzerService } from './inspection-analyzer.service'
import { ImageInput } from './inspection-analyzer.service'
import { CreateInspectionDto } from './dto/create-inspection.dto'
import { UpdateInspectionDto } from './dto/update-inspection.dto'
import { UpdateInspectionItemDto } from './dto/update-inspection-item.dto'
import { CreateInspectionCorrectionDto } from './dto/create-inspection-correction.dto'
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

/** Återförsöksnyckel för ett användarval (OB5): en UUID, inget annat — den hamnar i en lagringsnyckel. */
const ATERFORSOKSNYCKEL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

@Controller('inspections')
export class InspectionsController {
  private readonly logger = new Logger(InspectionsController.name)
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

  /**
   * Versionskedjan: vilka versioner som finns, vilken som gäller, varför varje
   * rättelse gjordes och av vem.
   *
   * Egen endpoint UTÖVER att kedjan följer med `GET /inspections/:id`, därför
   * att historikpanelen ska kunna läsas om utan att dra hela protokollet med
   * poster och bilder.
   */
  @Get(':id/versioner')
  async versioner(@OrgId() orgId: string, @Param('id') id: string) {
    return this.inspectionsService.hamtaVersioner(id, orgId)
  }

  /**
   * FAKTISK kontroll av bilagornas bytes mot den lagrade digesten.
   *
   * GET och inte POST fastän den gör ett nätverksanrop per bilaga: den skriver
   * ingenting och är omkörbar. Att den kostar är skälet till att den är en EGEN
   * endpoint i stället för ett fält i detaljsvaret — inte ett skäl att göra den
   * muterande.
   */
  @Get(':id/bildkontroll')
  async bildkontroll(@OrgId() orgId: string, @Param('id') id: string) {
    return this.inspectionsService.kontrolleraBilder(id, orgId)
  }

  /**
   * Rättelseversion av ett slutfört protokoll.
   *
   * Samma rollkrav som övriga skrivvägar in i ett protokoll. `VIEWER` och
   * `ACCOUNTANT` ska inte kunna öppna ett nytt utkast ovanpå ett signerat
   * bevisunderlag, och `userId` kommer ur JWT — aldrig ur body.
   */
  @Post(':id/rattelse')
  @Roles('MANAGER', 'ADMIN', 'OWNER')
  @HttpCode(HttpStatus.CREATED)
  async rattelse(
    @OrgId() orgId: string,
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: CreateInspectionCorrectionDto,
  ) {
    return this.inspectionsService.skapaRattelse(id, dto, orgId, user.sub)
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

    // ── ÅTERFÖRSÖK AV SAMMA VAL (OB5) ─────────────────────────────────────────
    //
    // Bilderna sparas FÖRE AI-anropet. Svarar AI:n fel finns bilagan redan, och
    // ett nytt klick laddade förut upp samma bild igen. Webben ger därför varje
    // användarVAL en återförsöksnyckel (`uploadKey_<i>`, UUID). Samma val som
    // skickas igen bär samma nyckel; ett nytt val av samma fil får en ny — det
    // är en identitet för OPERATIONEN, inte en deduplicering på bytes.
    //
    // Nyckeln bärs i lagringsnyckelns prefix, under DEN besiktning som
    // `findOneUnsigned(id, orgId)` ovan redan verifierat. Uppslaget sker bara
    // där, så en klient kan aldrig nå en annan besiktnings eller orgs bilaga
    // med en nyckel — och klientens bild-id används aldrig. Utan nyckel gäller
    // det tidigare beteendet (en ny bilaga per anrop).
    const nycklar = files.map((_, i) => {
      const nyckel = captions[`uploadKey_${i}`]
      if (nyckel === undefined) return null
      if (!ATERFORSOKSNYCKEL.test(nyckel)) {
        throw new BadRequestException(`Ogiltig återförsöksnyckel för bild ${i + 1}`)
      }
      return nyckel.toLowerCase()
    })
    const digester = files.map((f) => createHash('sha256').update(f.buffer).digest('hex'))
    const prefixFor = (nyckel: string) => `inspections/${orgId}/${id}/${nyckel}/`

    // Uppslag FÖRE varje uppladdning, så att en avvisad nyckel inte lämnar
    // objekt efter sig.
    const återanvända = new Map<number, { id: string; caption: string | null }>()
    for (let i = 0; i < files.length; i++) {
      const nyckel = nycklar[i]
      if (!nyckel) continue
      const befintlig = await this.inspectionsService.findRetryImage(id, orgId, prefixFor(nyckel))
      if (!befintlig) continue
      if (befintlig.contentSha256 !== digester[i]) {
        throw new ConflictException(
          `Bild ${i + 1} har en återförsöksnyckel som redan hör till en annan bild. Välj bilden på nytt.`,
        )
      }
      återanvända.set(i, { id: befintlig.id, caption: befintlig.caption })
    }

    const bildrader: Parameters<InspectionsService['saveAnalysisImages']>[2] = []
    const radIndex: number[] = []
    // Objekt DEN HÄR begäran har laddat upp. Faller en senare uppladdning i
    // samma batch, eller sparandet (transaktionen rullas då tillbaka), finns
    // ingen rad som pekar på dem — de raderas innan felet går vidare (OB5).
    const uppladdade: string[] = []
    let sparat: Awaited<ReturnType<InspectionsService['saveAnalysisImages']>>
    try {
      for (let i = 0; i < files.length; i++) {
        const f = files[i]!
        // Validerad typ hela vägen: nyckelns ändelse, lagringens Content-Type och
        // vision-modellens media_type kommer alla från samma detektion.
        const mimeType = detectedMimes[i] ?? 'image/jpeg'
        const caption = captions[`caption_${i}`] ?? null
        if (återanvända.has(i)) continue
        const nyckel = nycklar[i]
        const safeName = `${uuid()}.${extensionForDetectedMime(mimeType)}`
        const storageKey = nyckel
          ? `${prefixFor(nyckel)}${safeName}`
          : `inspections/${orgId}/${safeName}`
        const storageUrl = await this.storage.uploadFile(f.buffer, storageKey, mimeType)
        uppladdade.push(storageKey)
        radIndex.push(i)
        bildrader.push({
          filename: f.filename,
          storageKey,
          storageUrl,
          caption,
          room: null,
          size: f.buffer.length,
          // Digesten tas ur SAMMA buffer som skrevs till lagringen på raden ovan,
          // inte ur en omläsning: en omläsning hade beskrivit vad lagringen råkar
          // svara med efteråt, vilket är just det digesten ska kunna motsäga.
          contentSha256: digester[i]!,
          ...(nyckel ? { aterforsokPrefix: prefixFor(nyckel) } : {}),
        })
      }

      // Bildraderna gick förut rakt in via `prisma.inspectionImage.create` utan
      // någon kontroll av besiktningens status. De skrivs nu genom tjänsten, i en
      // transaktion som tar samma radlås som signeringen.
      sparat = await this.inspectionsService.saveAnalysisImages(id, orgId, bildrader)
    } catch (err) {
      await this.kompensera(uppladdade, 'uppladdning eller sparande föll')
      throw err
    }
    // En samtidig begäran med samma nyckel hann först (dubbelklick, okänt
    // nätutfall): dess bilaga används och det nyss uppladdade objektet tas bort.
    const ostadade = await this.kompensera(sparat.foraldralosa, 'samtidigt återförsök')

    // Vilken bilaga och vilken bildtext som gäller för varje fil. Återanvänds en
    // bilaga gäller den SPARADE texten — det är den användaren ser och den som
    // står i protokollet, så det är också den analysen ska få (OB5, BILD-02).
    const slutliga = files.map((_, i) => {
      const återanvänd = återanvända.get(i)
      if (återanvänd) return återanvänd
      return sparat.rader[radIndex.indexOf(i)]!
    })
    const bildIds = slutliga.map((b) => b.id)
    const imageInputs: ImageInput[] = files.map((f, i) => {
      const caption = slutliga[i]!.caption
      return {
        buffer: f.buffer,
        mimeType: (detectedMimes[i] ?? 'image/jpeg') as ImageInput['mimeType'],
        ...(caption ? { caption } : {}),
      }
    })

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

    return {
      analysis,
      updatedItems,
      createdItems,
      bildIds,
      ...(ostadade.length ? { ostadadeObjekt: ostadade.length } : {}),
    }
  }

  /**
   * Tar bort lagringsobjekt som ingen bildrad pekar på (OB5). `deleteFile`
   * sväljer fel från lagringen och svarar falskt; det som inte gick att ta bort
   * loggas med nycklarna och räknas — det tigs inte bort.
   */
  private async kompensera(nycklar: string[], skäl: string): Promise<string[]> {
    const kvar: string[] = []
    for (const key of nycklar) {
      if (!(await this.storage.deleteFile(key))) kvar.push(key)
    }
    if (kvar.length) {
      this.logger.error(
        `[bild-kompensation] ${kvar.length} lagringsobjekt utan bildrad kunde inte tas bort (${skäl}): ${kvar.join(', ')}`,
      )
    }
    return kvar
  }

  @Delete(':id')
  @Roles('ADMIN', 'OWNER')
  @HttpCode(HttpStatus.OK)
  async delete(@OrgId() orgId: string, @Param('id') id: string) {
    return this.inspectionsService.delete(id, orgId)
  }
}
