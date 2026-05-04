import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common'
import type { FastifyReply } from 'fastify'
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard'
import { OrgId } from '../common/decorators/org-id.decorator'
import { CurrentUser } from '../common/decorators/current-user.decorator'
import type { JwtPayload } from '@eken/shared'
import { PrismaService } from '../common/prisma/prisma.service'
import { ContractTemplateService } from './contract-template.service'

@Controller('contracts')
@UseGuards(JwtAuthGuard)
export class ContractsController {
  constructor(
    private readonly service: ContractTemplateService,
    private readonly prisma: PrismaService,
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

  @Get('download/:leaseId')
  async download(
    @OrgId() orgId: string,
    @Param('leaseId') leaseId: string,
    @Res() reply: FastifyReply,
  ) {
    const buffer = await this.service.buildPdfBuffer(leaseId, orgId)
    void reply
      .header('Content-Type', 'application/pdf')
      .header(
        'Content-Disposition',
        `attachment; filename="hyreskontrakt-${leaseId.slice(0, 8)}.pdf"`,
      )
      .send(buffer)
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
