import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common'
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard'
import { OrgId } from '../common/decorators/org-id.decorator'
import { CurrentUser } from '../common/decorators/current-user.decorator'
import type { JwtPayload } from '@eken/shared'
import { PrismaService } from '../common/prisma/prisma.service'
import { StorageService } from '../storage/storage.service'
import { ContractTemplateService } from './contract-template.service'

@Controller('contracts')
@UseGuards(JwtAuthGuard)
export class ContractsController {
  constructor(
    private readonly service: ContractTemplateService,
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  @Post('generate/:leaseId')
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
   */
  @Get('download/:leaseId')
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

    const url = await this.storage.getPresignedUrl(latest.storageKey, 300)
    return { url, filename: `${latest.name}.pdf`, mimeType: latest.mimeType }
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
