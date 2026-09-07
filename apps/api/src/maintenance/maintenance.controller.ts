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
import { MaintenanceService } from './maintenance.service'
import { CreateMaintenanceTicketDto } from './dto/create-maintenance-ticket.dto'
import { UpdateMaintenanceTicketDto } from './dto/update-maintenance-ticket.dto'
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard'
import { CurrentUser } from '../common/decorators/current-user.decorator'
import { OrgId } from '../common/decorators/org-id.decorator'
import { Roles } from '../common/decorators/roles.decorator'
import type { JwtPayload } from '@eken/shared'
import type { MaintenanceStatus, MaintenancePriority, MaintenanceCategory } from '@prisma/client'
import { AddTicketCommentDto } from './dto/add-ticket-comment.dto'
import { AssignContractorDto } from '../contractors/dto/contractor.dto'

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
  @Roles('MANAGER', 'ADMIN', 'OWNER')
  create(
    @Body() dto: CreateMaintenanceTicketDto,
    @OrgId() orgId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.maintenanceService.create(dto, orgId, user.sub)
  }

  /**
   * TILLDELA HANTVERKARE (etapp 10).
   *
   * Förvaltningsgränsen, samma som att skapa ärendet: `MANAGER, ADMIN, OWNER`
   * (#269). En bokförare eller VIEWER ska kunna SE vem som är tilldelad men
   * inte peka ut vem som ska göra jobbet.
   */
  @Patch(':id/assign')
  @Roles('OWNER', 'ADMIN', 'MANAGER')
  assignContractor(
    @Param('id') id: string,
    @Body() dto: AssignContractorDto,
    @OrgId() orgId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.maintenanceService.assignContractor(id, dto.contractorId, orgId, user.sub)
  }

  @Patch(':id')
  @Roles('MANAGER', 'ADMIN', 'OWNER')
  update(@Param('id') id: string, @Body() dto: UpdateMaintenanceTicketDto, @OrgId() orgId: string) {
    return this.maintenanceService.update(id, dto, orgId)
  }

  @Post(':id/comments')
  @Roles('MANAGER', 'ADMIN', 'OWNER')
  addComment(
    @Param('id') id: string,
    @Body() body: AddTicketCommentDto,
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
  @Roles('ADMIN', 'OWNER')
  @HttpCode(HttpStatus.NO_CONTENT)
  delete(@Param('id') id: string, @OrgId() orgId: string) {
    return this.maintenanceService.deleteTicket(id, orgId)
  }
}
