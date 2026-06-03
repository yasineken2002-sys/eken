import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common'
import type { KeyStatus } from '@prisma/client'
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard'
import { OrgId } from '../common/decorators/org-id.decorator'
import { Roles } from '../common/decorators/roles.decorator'
import { CurrentUser } from '../common/decorators/current-user.decorator'
import type { JwtPayload } from '@eken/shared'
import { KeysService } from './keys.service'
import { IssueKeysDto } from './dto/issue-keys.dto'
import { ReturnKeyDto } from './dto/return-key.dto'
import { UpdateKeyDto } from './dto/update-key.dto'

@Controller('keys')
@UseGuards(JwtAuthGuard)
export class KeysController {
  constructor(private readonly keys: KeysService) {}

  @Get()
  async findAll(
    @OrgId() organizationId: string,
    @Query('leaseId') leaseId?: string,
    @Query('unitId') unitId?: string,
    @Query('status') status?: string,
  ) {
    const filters: { leaseId?: string; unitId?: string; status?: KeyStatus } = {}
    if (leaseId) filters.leaseId = leaseId
    if (unitId) filters.unitId = unitId
    if (status) filters.status = status as KeyStatus
    return this.keys.findAll(organizationId, filters)
  }

  @Get(':id')
  async findOne(@Param('id') id: string, @OrgId() organizationId: string) {
    return this.keys.findOne(id, organizationId)
  }

  // Utlämning/retur/statusbyte gatas som deposits: MANAGER och uppåt.
  @Post()
  @Roles('MANAGER', 'ADMIN', 'OWNER')
  async issue(
    @OrgId() organizationId: string,
    @Body() dto: IssueKeysDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.keys.issue(dto, organizationId, user.sub)
  }

  @Patch(':id/return')
  @Roles('MANAGER', 'ADMIN', 'OWNER')
  async returnKey(
    @Param('id') id: string,
    @OrgId() organizationId: string,
    @Body() dto: ReturnKeyDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.keys.returnKey(id, dto, organizationId, user.sub)
  }

  @Patch(':id')
  @Roles('MANAGER', 'ADMIN', 'OWNER')
  async update(
    @Param('id') id: string,
    @OrgId() organizationId: string,
    @Body() dto: UpdateKeyDto,
  ) {
    return this.keys.update(id, dto, organizationId)
  }
}
