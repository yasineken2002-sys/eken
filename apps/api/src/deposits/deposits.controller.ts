import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common'
import type { DepositStatus } from '@prisma/client'
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard'
import { OrgId } from '../common/decorators/org-id.decorator'
import { CurrentUser } from '../common/decorators/current-user.decorator'
import type { JwtPayload } from '@eken/shared'
import { DepositsService } from './deposits.service'
import { CreateDepositDto } from './dto/create-deposit.dto'
import { RefundDepositDto } from './dto/refund-deposit.dto'

@Controller('deposits')
@UseGuards(JwtAuthGuard)
export class DepositsController {
  constructor(private readonly deposits: DepositsService) {}

  @Get()
  async findAll(
    @OrgId() organizationId: string,
    @Query('status') status?: string,
    @Query('leaseId') leaseId?: string,
  ) {
    const filters: { status?: DepositStatus; leaseId?: string } = {}
    if (status) filters.status = status as DepositStatus
    if (leaseId) filters.leaseId = leaseId
    return this.deposits.findAll(organizationId, filters)
  }

  @Get(':id')
  async findOne(@Param('id') id: string, @OrgId() organizationId: string) {
    return this.deposits.findOne(id, organizationId)
  }

  @Post()
  async create(
    @OrgId() organizationId: string,
    @Body() dto: CreateDepositDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.deposits.create(dto, organizationId, user.sub)
  }

  @Patch(':id/pay')
  async markPaid(
    @Param('id') id: string,
    @OrgId() organizationId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.deposits.markPaid(id, organizationId, user.sub)
  }

  @Patch(':id/refund')
  async refund(
    @Param('id') id: string,
    @OrgId() organizationId: string,
    @Body() dto: RefundDepositDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.deposits.refund(id, dto, organizationId, user.sub)
  }
}
