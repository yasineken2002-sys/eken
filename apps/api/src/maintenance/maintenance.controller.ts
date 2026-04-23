import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common'
import type { MaintenanceService } from './maintenance.service'
import type { CreateMaintenanceTicketDto } from './dto/create-maintenance-ticket.dto'
import type { UpdateMaintenanceTicketDto } from './dto/update-maintenance-ticket.dto'
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard'
import { CurrentUser } from '../common/decorators/current-user.decorator'
import { OrgId } from '../common/decorators/org-id.decorator'
import { Public } from '../common/decorators/public.decorator'
import type { JwtPayload } from '@eken/shared'
import type { MaintenanceStatus, MaintenancePriority, MaintenanceCategory } from '@prisma/client'

@Controller('maintenance')
@UseGuards(JwtAuthGuard)
export class MaintenanceController {
  constructor(private readonly maintenanceService: MaintenanceService) {}

  @Get('stats')
  getStats(@OrgId() orgId: string) {
    return this.maintenanceService.getStats(orgId)
  }

  @Get()
  findAll(
    @OrgId() orgId: string,
    @Query('status') status?: MaintenanceStatus,
    @Query('priority') priority?: MaintenancePriority,
    @Query('category') category?: MaintenanceCategory,
    @Query('propertyId') propertyId?: string,
    @Query('unitId') unitId?: string,
  ) {
    return this.maintenanceService.findAll(orgId, {
      ...(status ? { status } : {}),
      ...(priority ? { priority } : {}),
      ...(category ? { category } : {}),
      ...(propertyId ? { propertyId } : {}),
      ...(unitId ? { unitId } : {}),
    })
  }

  @Get(':id')
  findOne(@Param('id') id: string, @OrgId() orgId: string) {
    return this.maintenanceService.findOne(id, orgId)
  }

  @Post()
  create(
    @Body() dto: CreateMaintenanceTicketDto,
    @OrgId() orgId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.maintenanceService.create(dto, orgId, user.sub)
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateMaintenanceTicketDto, @OrgId() orgId: string) {
    return this.maintenanceService.update(id, dto, orgId)
  }

  @Post(':id/comments')
  addComment(
    @Param('id') id: string,
    @Body() body: { content: string; isInternal?: boolean },
    @OrgId() orgId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.maintenanceService.addComment(
      id,
      body.content,
      body.isInternal ?? true,
      orgId,
      user.sub,
    )
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  delete(@Param('id') id: string, @OrgId() orgId: string) {
    return this.maintenanceService.deleteTicket(id, orgId)
  }

  // ── Tenant portal endpoints (no auth — token-based) ───────────────────────

  @Public()
  @Get('tenant/:token')
  getTenantTicket(@Param('token') token: string) {
    return this.maintenanceService.findByTenantToken(token)
  }

  @Public()
  @Post('tenant/:token/comment')
  addTenantComment(@Param('token') token: string, @Body() body: { content: string }) {
    return this.maintenanceService.addTenantComment(token, body.content)
  }
}
