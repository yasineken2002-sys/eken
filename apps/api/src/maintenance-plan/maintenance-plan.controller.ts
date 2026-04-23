import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common'
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard'
import { OrgId } from '../common/decorators/org-id.decorator'
import type { MaintenancePlanService } from './maintenance-plan.service'
import type { CreateMaintenancePlanDto } from './dto/create-maintenance-plan.dto'
import type { UpdateMaintenancePlanDto } from './dto/update-maintenance-plan.dto'
import type { MaintenancePlanCategory, MaintenancePlanStatus } from '@prisma/client'

@Controller('maintenance-plans')
@UseGuards(JwtAuthGuard)
export class MaintenancePlanController {
  constructor(private readonly service: MaintenancePlanService) {}

  @Get('summary')
  getSummary(
    @OrgId() orgId: string,
    @Query('fromYear') fromYear?: string,
    @Query('toYear') toYear?: string,
  ) {
    const currentYear = new Date().getFullYear()
    const from = fromYear ? parseInt(fromYear, 10) : currentYear
    const to = toYear ? parseInt(toYear, 10) : currentYear + 5
    return this.service.getYearlySummary(orgId, from, to)
  }

  @Get()
  findAll(
    @OrgId() orgId: string,
    @Query('propertyId') propertyId?: string,
    @Query('year') year?: string,
    @Query('status') status?: MaintenancePlanStatus,
    @Query('category') category?: MaintenancePlanCategory,
  ) {
    return this.service.findAll(orgId, {
      ...(propertyId ? { propertyId } : {}),
      ...(year ? { year: parseInt(year, 10) } : {}),
      ...(status ? { status } : {}),
      ...(category ? { category } : {}),
    })
  }

  @Get(':id')
  findOne(@OrgId() orgId: string, @Param('id') id: string) {
    return this.service.findOne(id, orgId)
  }

  @Post()
  create(@OrgId() orgId: string, @Body() dto: CreateMaintenancePlanDto) {
    return this.service.create(dto, orgId)
  }

  @Patch(':id')
  update(@OrgId() orgId: string, @Param('id') id: string, @Body() dto: UpdateMaintenancePlanDto) {
    return this.service.update(id, dto, orgId)
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  delete(@OrgId() orgId: string, @Param('id') id: string) {
    return this.service.delete(id, orgId)
  }
}
