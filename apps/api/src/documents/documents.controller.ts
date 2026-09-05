import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Query,
  Body,
  HttpCode,
  HttpStatus,
  Req,
  BadRequestException,
} from '@nestjs/common'
import { ApiBearerAuth, ApiTags, ApiOperation, ApiConsumes } from '@nestjs/swagger'
import type { FastifyRequest } from 'fastify'
import { DocumentsService } from './documents.service'
// VÄRDE-import, aldrig `import type` — ValidationPipe läser reflect-metadata.
import { SendDocumentToTenantDto } from './dto/send-document-to-tenant.dto'
import { OrgId } from '../common/decorators/org-id.decorator'
import { Roles } from '../common/decorators/roles.decorator'
import { CurrentUser } from '../common/decorators/current-user.decorator'
import type { JwtPayload } from '@eken/shared'
import type { DocumentCategory } from '@prisma/client'
import { MAX_DOCUMENT_BYTES } from '../common/utils/file-validation'
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
    @CurrentUser() user: JwtPayload,
    @Query('propertyId') propertyId?: string,
    @Query('unitId') unitId?: string,
    @Query('leaseId') leaseId?: string,
    @Query('tenantId') tenantId?: string,
    @Query('category') category?: DocumentCategory,
  ) {
    // Aktörsrollen skickas vidare — grinden mot hyreskontrakt bor i tjänsten
    // (documents-authz.ts), inte här, eftersom den ska gälla varje anropare.
    return this.service.findAll(
      orgId,
      {
        ...(propertyId ? { propertyId } : {}),
        ...(unitId ? { unitId } : {}),
        ...(leaseId ? { leaseId } : {}),
        ...(tenantId ? { tenantId } : {}),
        ...(category ? { category } : {}),
      },
      user.role,
    )
  }

  @Post()
  @Roles('MANAGER', 'ADMIN', 'OWNER')
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
    // Samma tak som DocumentsService.upload (delad konstant) — controller och
    // service ska aldrig glida isär (H3).
    const MAX_FILE_SIZE = MAX_DOCUMENT_BYTES

    if (!ALLOWED_MIME_TYPES.includes(mimetype)) {
      throw new BadRequestException('Filtyp inte tillåten')
    }
    if (fileSize > MAX_FILE_SIZE) {
      throw new BadRequestException('Filen är för stor (max 20MB)')
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
  async download(@Param('id') id: string, @OrgId() orgId: string, @CurrentUser() user: JwtPayload) {
    // Returnerar presigned R2-URL (~5 min TTL) som JSON istället för 302-redirect.
    // Tidigare lösning krävde att webbläsaren skickade Authorization-headern på
    // den initiala GET:en, vilket är omöjligt vid window.open() — resultatet
    // blev 401 UNAUTHORIZED. Frontend hämtar nu URL:en med auth via fetch och
    // öppnar sedan den signerade URL:en direkt mot R2.
    const { url, document } = await this.service.getDownloadUrl(id, orgId, user.role)
    return { url, filename: document.name, mimeType: document.mimeType }
  }

  /**
   * SKICKA ETT BEFINTLIGT DOKUMENT TILL EN HYRESGÄSTS PORTAL.
   *
   * Människans väg till AI-verktyget `send_document_to_tenant`, som stod i
   * `tool-human-path.baseline.json` med skälet att `deliverToTenant` hade exakt
   * en anropare och att den var verktyget.
   *
   * ROLLERNA är MANAGER och uppåt — samma som uppladdningen (`@Post()` ovan).
   * Att skicka ett dokument till en hyresgäst är en förvaltningsåtgärd, inte en
   * redovisningshandling, och den som får lägga in dokumentet ska kunna skicka
   * det. En snävare mängd hade gjort uppladdningen till en återvändsgränd för
   * MANAGER.
   *
   * ORG-SCOPINGEN LIGGER INTE HÄR. Dokumentet slås upp med
   * `{ id, organizationId }` i `findOne` och hyresgästen i `deliverToTenant` —
   * båda kastar NotFound. Ett 403 hade avslöjat att raden finns i en annan
   * organisation.
   */
  @Post(':id/send-to-tenant')
  @Roles('MANAGER', 'ADMIN', 'OWNER')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Skicka ett befintligt dokument till en hyresgästs portal' })
  sendToTenant(
    @Param('id') id: string,
    @OrgId() orgId: string,
    @Body() dto: SendDocumentToTenantDto,
  ) {
    return this.service.sendToTenant({
      documentId: id,
      tenantId: dto.tenantId,
      organizationId: orgId,
      // UTELÄMNAD = JA, samma default som AI-verktyget (`notifyTenant !== false`).
      // Att i stället skicka vidare `undefined` hade gett NEJ, eftersom
      // deliverToTenant gör `if (input.notify && …)` — och samma utelämnade fält
      // hade då betytt olika saker beroende på vem som skickade. Se DTO:n.
      notify: dto.notify !== false,
    })
  }

  @Delete(':id')
  @Roles('ADMIN', 'OWNER')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Ta bort dokument' })
  remove(@Param('id') id: string, @OrgId() orgId: string) {
    return this.service.remove(id, orgId)
  }
}
