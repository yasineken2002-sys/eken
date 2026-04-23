import { Controller, Get, Post, BadRequestException, Req } from '@nestjs/common'
import { ApiBearerAuth, ApiTags, ApiOperation, ApiConsumes } from '@nestjs/swagger'
import type { FastifyRequest } from 'fastify'
import { ImportService } from './import.service'
import { ContractScannerService } from './contract-scanner.service'
import { OrgId } from '../common/decorators/org-id.decorator'
import { CurrentUser } from '../common/decorators/current-user.decorator'
import type { JwtPayload } from '@eken/shared'

const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10 MB
const ALLOWED_IMPORT_EXTS = ['.csv', '.xlsx', '.xls']
const ALLOWED_CONTRACT_MIMES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp']

@ApiTags('Import')
@ApiBearerAuth()
@Controller('import')
export class ImportController {
  constructor(
    private readonly importService: ImportService,
    private readonly contractScanner: ContractScannerService,
  ) {}

  // ─── Preview ───────────────────────────────────────────────────────────────

  @Post('preview')
  @ApiOperation({ summary: 'Förhandsgranska fil – inga databasskrivningar' })
  @ApiConsumes('multipart/form-data')
  async preview(@Req() request: FastifyRequest) {
    const { buffer, filename, type } = await this.extractImportFile(request)
    return this.importService.previewImport(buffer, filename, type)
  }

  // ─── Execute ───────────────────────────────────────────────────────────────

  @Post('execute')
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
  @ApiOperation({ summary: 'Lista importjobb för organisationen' })
  getJobs(@OrgId() orgId: string) {
    return this.importService.getImportJobs(orgId)
  }

  // ─── Contract Scan ────────────────────────────────────────────────────────

  @Post('scan-contract')
  @ApiOperation({ summary: 'Skanna hyreskontrakt med AI' })
  @ApiConsumes('multipart/form-data')
  async scanContract(@Req() request: FastifyRequest) {
    let fileBuffer: Buffer | null = null
    let mimeType = ''
    let fileSize = 0

    const parts = request.parts()
    for await (const part of parts) {
      if (part.type === 'file') {
        fileBuffer = await part.toBuffer()
        mimeType = part.mimetype
        fileSize = fileBuffer.length
        break
      }
    }

    if (!fileBuffer) {
      throw new BadRequestException('Ingen fil hittades i formuläret')
    }

    if (fileSize > MAX_FILE_SIZE) {
      throw new BadRequestException('Filen är för stor (max 10 MB)')
    }

    if (!ALLOWED_CONTRACT_MIMES.includes(mimeType)) {
      throw new BadRequestException('Filformatet stöds inte. Ladda upp PDF, JPG, PNG eller WEBP.')
    }

    return this.contractScanner.scanContract(fileBuffer, mimeType)
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
