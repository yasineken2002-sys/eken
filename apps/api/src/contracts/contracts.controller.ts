import { Controller, Get, HttpCode, HttpStatus, Param, Post, Res, UseGuards } from '@nestjs/common'
import type { FastifyReply } from 'fastify'
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard'
import { OrgId } from '../common/decorators/org-id.decorator'
import { CurrentUser } from '../common/decorators/current-user.decorator'
import type { JwtPayload } from '@eken/shared'
import { ContractTemplateService } from './contract-template.service'

@Controller('contracts')
@UseGuards(JwtAuthGuard)
export class ContractsController {
  constructor(private readonly service: ContractTemplateService) {}

  @Post('generate/:leaseId')
  @HttpCode(HttpStatus.OK)
  async generate(
    @OrgId() orgId: string,
    @CurrentUser() user: JwtPayload,
    @Param('leaseId') leaseId: string,
  ) {
    const { documentId } = await this.service.generateLeaseContract(leaseId, orgId, user.sub)
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
}
