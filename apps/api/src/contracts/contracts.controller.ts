import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common'
import { Throttle } from '@nestjs/throttler'
import * as crypto from 'crypto'
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard'
import { OrgId } from '../common/decorators/org-id.decorator'
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
}
