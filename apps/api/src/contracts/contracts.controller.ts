import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common'
import { IsBoolean, IsEnum, IsInt, IsOptional, Min } from 'class-validator'
import { Throttle } from '@nestjs/throttler'
import * as crypto from 'crypto'
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard'
import { OrgId } from '../common/decorators/org-id.decorator'
import { Roles } from '../common/decorators/roles.decorator'
import { CurrentUser } from '../common/decorators/current-user.decorator'
import type { JwtPayload } from '@eken/shared'
import { PrismaService } from '../common/prisma/prisma.service'
import { StorageService } from '../storage/storage.service'
import { ContractTemplateService } from './contract-template.service'

// PDF:er upp till denna storlek validerar vi med full SHA-256 vid varje
// nedladdning. Större filer skippas (kostsamt att läsa hela bytes från R2)
// och lämnas till stickprovs-jobb vid behov. 10 MB täcker så gott som alla
// kontrakt — typiska hyreskontrakt är 50-300 KB, även med foton.
const HASH_VERIFY_MAX_BYTES = 10 * 1024 * 1024

// DTO för PATCH /contracts/:leaseId/appendices/:documentId. Måste deklareras
// före @Controller-klassen — annars körs decoratorn med ett fortfarande
// odefinierat klassnamn (TDZ) i runtime.
class UpdateAppendixDto {
  @IsBoolean() @IsOptional() attachedToLeaseAsAppendix?: boolean
  @IsEnum(['ENERGY_DECLARATION', 'HOUSE_RULES', 'INSPECTION_PROTOCOL', 'OTHER'])
  @IsOptional()
  category?: 'ENERGY_DECLARATION' | 'HOUSE_RULES' | 'INSPECTION_PROTOCOL' | 'OTHER'
  @IsInt() @Min(0) @IsOptional() appendixOrder?: number
}

@Controller('contracts')
@UseGuards(JwtAuthGuard)
export class ContractsController {
  private readonly logger = new Logger(ContractsController.name)

  constructor(
    private readonly service: ContractTemplateService,
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  // 10 generationer per minut per användare räcker till manuella regenereringar
  // utan att tillåta hamring (varje generation kostar 1-3 s Puppeteer + R2 PUT).
  @Post('generate/:leaseId')
  @Roles('MANAGER', 'ADMIN', 'OWNER')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  async generate(
    @OrgId() orgId: string,
    @CurrentUser() user: JwtPayload,
    @Param('leaseId') leaseId: string,
  ) {
    const { documentId } = await this.service.generateLeaseContract(leaseId, orgId, user.sub, {
      linkPrevious: true,
    })
    return {
      documentId,
      message: 'Hyreskontrakt genererat och sparat under Dokument.',
    }
  }

  /**
   * Returnerar presigned R2-URL till senaste kontrakts-PDF för leasen.
   * Frontend öppnar URL:en direkt mot R2 (ingen auth-header behövs där).
   *
   * Om inget kontrakt har genererats än byggs ett först — det täcker det
   * gamla flödet (knapp som klickades innan auto-generering kördes) och
   * sparar samtidigt PDF:en i R2 så framtida nedladdningar går direkt.
   *
   * Innan presigned URL skickas verifieras filens SHA-256-hash mot
   * Document.contentHash. Vid mismatch (R2-objektet har modifierats utanför
   * vår pipeline, eller laddats upp på fel storageKey) loggas en
   * säkerhetsincident och 500 returneras — vi vill aldrig leverera ett
   * kontrakt som inte längre matchar det vi själva skrev.
   */
  @Get('download/:leaseId')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async download(
    @OrgId() orgId: string,
    @CurrentUser() user: JwtPayload,
    @Param('leaseId') leaseId: string,
  ) {
    let latest = await this.service.findLatestContract(leaseId, orgId)
    if (!latest) {
      const lease = await this.prisma.lease.findFirst({
        where: { id: leaseId, organizationId: orgId },
        select: { id: true },
      })
      if (!lease) throw new NotFoundException('Kontraktet hittades inte')
      const { documentId } = await this.service.generateLeaseContract(leaseId, orgId, user.sub, {
        linkPrevious: false,
      })
      latest = await this.prisma.document.findUnique({ where: { id: documentId } })
      if (!latest) throw new NotFoundException('Kontraktets PDF kunde inte sparas')
    }

    await this.verifyContentHash(latest)

    const url = await this.storage.getPresignedUrl(latest.storageKey, 300)
    return { url, filename: `${latest.name}.pdf`, mimeType: latest.mimeType }
  }

  /**
   * Hämta R2-bytes och jämför SHA-256 mot lagrad contentHash. Vid mismatch
   * är dokumentet manipulerat — logga och kasta 500 så frontend visar
   * "kontraktet kunde inte verifieras" istället för att leverera en URL
   * till ett ev. modifierat dokument.
   *
   * Skip-villkor:
   *   - contentHash saknas (gamla dokument från innan hashen infördes —
   *     dessa kan inte verifieras retroaktivt; vi loggar en warning men
   *     blockar inte download).
   *   - filSize > HASH_VERIFY_MAX_BYTES (för dyr verifiering vid varje
   *     download; lämnas till offline stickprov om det skulle behövas).
   */
  private async verifyContentHash(doc: {
    id: string
    storageKey: string
    contentHash: string | null
    fileSize: number
  }): Promise<void> {
    if (!doc.contentHash) {
      this.logger.warn(
        `[contracts] download utan contentHash docId=${doc.id} — kan inte verifieras retroaktivt`,
      )
      return
    }
    if (doc.fileSize > HASH_VERIFY_MAX_BYTES) {
      return
    }

    const buffer = await this.storage.getFileBuffer(doc.storageKey)
    const actualHash = crypto.createHash('sha256').update(buffer).digest('hex')
    if (actualHash !== doc.contentHash) {
      this.logger.error(
        `[security] contentHash MISMATCH docId=${doc.id} storageKey=${doc.storageKey} expected=${doc.contentHash} actual=${actualHash}`,
      )
      throw new InternalServerErrorException(
        'Kontraktet har modifierats efter upprättandet och kan inte levereras. Kontakta support.',
      )
    }
  }

  /**
   * Hämta status + versionskedja för leasens kontrakts-PDF:er.
   * Returnerar tom lista om inget kontrakt har genererats än.
   */
  @Get('status/:leaseId')
  async status(@OrgId() orgId: string, @Param('leaseId') leaseId: string) {
    const lease = await this.prisma.lease.findFirst({
      where: { id: leaseId, organizationId: orgId },
      select: { id: true, updatedAt: true },
    })
    if (!lease) throw new NotFoundException('Kontraktet hittades inte')

    const documents = await this.prisma.document.findMany({
      where: { leaseId, organizationId: orgId, category: 'CONTRACT' },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        createdAt: true,
        signedAt: true,
        signedFromIp: true,
        signedUserAgent: true,
        signatureName: true,
        contentHash: true,
        locked: true,
        previousVersionId: true,
        signedByTenant: { select: { firstName: true, lastName: true, companyName: true } },
      },
    })

    const latest = documents[0] ?? null
    const staleSinceSigning =
      latest?.signedAt != null && new Date(lease.updatedAt) > new Date(latest.signedAt)

    return {
      latest,
      versions: documents,
      hasPdf: documents.length > 0,
      staleSinceSigning,
    }
  }

  /**
   * Listar dokument som är (eller kan bli) bilagor till leasens kontrakt.
   * Inkluderar redan markerade bilagor sorterade efter `appendixOrder`,
   * samt övriga lease-länkade dokument som hyresvärden kan välja att lägga
   * till. CONTRACT-kategorin filtreras bort — vi vill inte att den
   * genererade kontrakts-PDF:en bifogar sig själv som bilaga.
   */
  @Get(':leaseId/appendices')
  async listAppendices(@OrgId() orgId: string, @Param('leaseId', ParseUUIDPipe) leaseId: string) {
    const lease = await this.prisma.lease.findFirst({
      where: { id: leaseId, organizationId: orgId },
      select: { id: true },
    })
    if (!lease) throw new NotFoundException('Kontraktet hittades inte')

    const docs = await this.prisma.document.findMany({
      where: {
        leaseId,
        organizationId: orgId,
        NOT: { category: 'CONTRACT' },
      },
      orderBy: [
        { attachedToLeaseAsAppendix: 'desc' },
        { appendixOrder: 'asc' },
        { createdAt: 'desc' },
      ],
      select: {
        id: true,
        name: true,
        category: true,
        fileSize: true,
        mimeType: true,
        attachedToLeaseAsAppendix: true,
        appendixOrder: true,
        createdAt: true,
      },
    })

    return { items: docs }
  }

  /**
   * Patch:ar appendix-flaggan + ev. ny kategori/ordning på ett dokument.
   * Vi tillåter alla dokumentkategorier som bilaga, men nya specifika
   * bilage-typer (ENERGY_DECLARATION, HOUSE_RULES, INSPECTION_PROTOCOL)
   * är de som visas tydligast i kontraktets bilageförteckning.
   */
  @Patch(':leaseId/appendices/:documentId')
  @Roles('MANAGER', 'ADMIN', 'OWNER')
  async updateAppendix(
    @OrgId() orgId: string,
    @Param('leaseId', ParseUUIDPipe) leaseId: string,
    @Param('documentId', ParseUUIDPipe) documentId: string,
    @Body() dto: UpdateAppendixDto,
  ) {
    const doc = await this.prisma.document.findFirst({
      where: { id: documentId, organizationId: orgId, leaseId },
      select: { id: true, locked: true, category: true },
    })
    if (!doc) throw new NotFoundException('Dokumentet hittades inte på detta kontrakt')
    if (doc.category === 'CONTRACT') {
      throw new BadRequestException('Själva kontrakts-PDF:en kan inte vara bilaga')
    }

    const data: Record<string, unknown> = {}
    if (dto.attachedToLeaseAsAppendix !== undefined) {
      data['attachedToLeaseAsAppendix'] = dto.attachedToLeaseAsAppendix
    }
    if (dto.category !== undefined) {
      data['category'] = dto.category
    }
    if (dto.appendixOrder !== undefined) {
      data['appendixOrder'] = dto.appendixOrder
    }

    return this.prisma.document.update({
      where: { id: documentId },
      data,
      select: {
        id: true,
        name: true,
        category: true,
        attachedToLeaseAsAppendix: true,
        appendixOrder: true,
      },
    })
  }
}
