import { Controller, Get, Post, BadRequestException, Req } from '@nestjs/common'
import { ApiBearerAuth, ApiTags, ApiOperation, ApiConsumes } from '@nestjs/swagger'
import type { FastifyRequest } from 'fastify'
import { ImportService } from './import.service'
import { ContractScannerService } from './contract-scanner.service'
import { ContractArchiveService } from './contract-archive.service'
import { OrgId } from '../common/decorators/org-id.decorator'
import { Roles } from '../common/decorators/roles.decorator'
import { CurrentUser } from '../common/decorators/current-user.decorator'
import { MAX_CONTRACT_BYTES } from '../common/utils/file-validation'
import type { JwtPayload } from '@eken/shared'

const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10 MB (CSV/Excel-import)
const ALLOWED_IMPORT_EXTS = ['.csv', '.xlsx', '.xls']
const ALLOWED_CONTRACT_MIMES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp']

@ApiTags('Import')
@ApiBearerAuth()
@Controller('import')
export class ImportController {
  constructor(
    private readonly importService: ImportService,
    private readonly contractScanner: ContractScannerService,
    private readonly archive: ContractArchiveService,
  ) {}

  // ─── Preview ───────────────────────────────────────────────────────────────

  @Post('preview')
  @Roles('ADMIN', 'OWNER')
  @ApiOperation({ summary: 'Förhandsgranska fil – inga databasskrivningar' })
  @ApiConsumes('multipart/form-data')
  async preview(@Req() request: FastifyRequest) {
    const { buffer, filename, type } = await this.extractImportFile(request)
    return this.importService.previewImport(buffer, filename, type)
  }

  // ─── Execute ───────────────────────────────────────────────────────────────

  @Post('execute')
  @Roles('ADMIN', 'OWNER')
  @ApiOperation({ summary: 'Kör fullständig import till databasen' })
  @ApiConsumes('multipart/form-data')
  async execute(
    @Req() request: FastifyRequest,
    @OrgId() orgId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    const { buffer, filename, type } = await this.extractImportFile(request)
    return this.importService.processImport(buffer, filename, type, orgId, user.sub)
  }

  // ─── Jobs ──────────────────────────────────────────────────────────────────

  @Get('jobs')
  // Samma nivå som handlingen vars utfall listan visar: jobben SKAPAS av
  // POST /import/execute (ADMIN, OWNER). Utan raden ärvde endpointen bara det
  // globala JwtAuthGuard, så varje inloggad roll — inklusive VIEWER — kunde
  // läsa organisationens importhistorik (#81).
  //
  // Ingen persondata låg exponerad: ImportJob.errors är `{ row, message }` med
  // rena valideringstexter ("Namn saknas"), aldrig radinnehåll. Det som stod
  // öppet var filnamn och importaktivitet — och framför allt asymmetrin: att
  // läsa utfallet av en handling bara ADMIN/OWNER får utföra.
  @Roles('ADMIN', 'OWNER')
  @ApiOperation({ summary: 'Lista importjobb för organisationen' })
  getJobs(@OrgId() orgId: string) {
    return this.importService.getImportJobs(orgId)
  }

  // ─── Contract Scan ────────────────────────────────────────────────────────

  @Post('scan-contract')
  @Roles('ADMIN', 'OWNER')
  @ApiOperation({ summary: 'Skanna hyreskontrakt med AI' })
  @ApiConsumes('multipart/form-data')
  async scanContract(
    @Req() request: FastifyRequest,
    @OrgId() organizationId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    let fileBuffer: Buffer | null = null
    let mimeType = ''
    let fileName = 'kontrakt'
    let fileSize = 0

    const parts = request.parts()
    for await (const part of parts) {
      if (part.type === 'file') {
        fileBuffer = await part.toBuffer()
        mimeType = part.mimetype
        fileName = part.filename
        fileSize = fileBuffer.length
        break
      }
    }

    if (!fileBuffer) {
      throw new BadRequestException('Ingen fil hittades i formuläret')
    }

    if (fileSize > MAX_CONTRACT_BYTES) {
      throw new BadRequestException('Filen är för stor (max 10 MB)')
    }

    if (!ALLOWED_CONTRACT_MIMES.includes(mimeType)) {
      throw new BadRequestException('Filformatet stöds inte. Ladda upp PDF, JPG, PNG eller WEBP.')
    }

    // #473: arkivera originalet FÖRE skanningen. Den här vägen persisterade
    // tidigare INGENTING — bufferten kastades när requesten tog slut, så det
    // uppladdade kontraktet fanns aldrig kvar. Skanningen fyller ett formulär
    // som operatören sedan skapar ett avtal ur; utan arkivet förvaltar Eveno
    // ett avtal vars underlag det inte kan visa.
    //
    // scanContract validerar magiska byten själv och kastar på fel innehåll.
    // Arkiveringen sker ändå först: en fil som avvisas av skannern är fortfarande
    // något hyresvärden laddade upp, och ett dokument utan skanningsresultat är
    // ett mindre problem än ett avtal utan underlag.
    const { documentId } = await this.archive.archive({
      buffer: fileBuffer,
      fileName,
      mimeType,
      organizationId,
      uploadedById: user.sub,
    })
    const scan = await this.contractScanner.scanContract(fileBuffer, organizationId, user.sub)
    return { ...scan, documentId }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private async extractImportFile(request: FastifyRequest) {
    let fileBuffer: Buffer | null = null
    let filename = ''
    let type = ''

    const parts = request.parts()
    for await (const part of parts) {
      if (part.type === 'file') {
        fileBuffer = await part.toBuffer()
        filename = part.filename
      } else if (part.fieldname === 'type') {
        type = part.value as string
      }
    }

    if (!fileBuffer || !filename) {
      throw new BadRequestException('Ingen fil hittades i formuläret')
    }

    if (fileBuffer.length > MAX_FILE_SIZE) {
      throw new BadRequestException('Filen är för stor (max 10 MB)')
    }

    const ext = '.' + (filename.toLowerCase().split('.').pop() ?? '')
    if (!ALLOWED_IMPORT_EXTS.includes(ext)) {
      throw new BadRequestException('Filformatet stöds inte. Ladda upp CSV, XLSX eller XLS.')
    }

    if (!type) {
      throw new BadRequestException('Importtyp saknas (type: PROPERTIES|UNITS|TENANTS|LEASES)')
    }

    return { buffer: fileBuffer, filename, type }
  }
}
