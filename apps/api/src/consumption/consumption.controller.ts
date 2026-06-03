import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common'
import type {
  MeterStatus,
  ConsumptionChargeStatus,
  ConsumptionTariff,
  TariffScope,
} from '@prisma/client'
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard'
import { OrgId } from '../common/decorators/org-id.decorator'
import { Roles } from '../common/decorators/roles.decorator'
import { CurrentUser } from '../common/decorators/current-user.decorator'
import type { JwtPayload } from '@eken/shared'
import { ConsumptionService } from './consumption.service'
import { CreateMeterDto } from './dto/create-meter.dto'
import { UpdateMeterDto } from './dto/update-meter.dto'
import { CreateTariffDto } from './dto/create-tariff.dto'
import { RecordReadingDto } from './dto/record-reading.dto'

@Controller('consumption')
@UseGuards(JwtAuthGuard)
export class ConsumptionController {
  constructor(private readonly consumption: ConsumptionService) {}

  // ── Mätare ───────────────────────────────────────────────────────────────
  @Get('meters')
  async findMeters(
    @OrgId() organizationId: string,
    @Query('unitId') unitId?: string,
    @Query('status') status?: string,
  ) {
    const filters: { unitId?: string; status?: MeterStatus } = {}
    if (unitId) filters.unitId = unitId
    if (status) filters.status = status as MeterStatus
    return this.consumption.findMeters(organizationId, filters)
  }

  @Get('meters/:id')
  async findMeter(@Param('id') id: string, @OrgId() organizationId: string) {
    return this.consumption.findMeter(id, organizationId)
  }

  @Post('meters')
  @Roles('MANAGER', 'ADMIN', 'OWNER')
  async createMeter(@OrgId() organizationId: string, @Body() dto: CreateMeterDto) {
    return this.consumption.createMeter(dto, organizationId)
  }

  @Patch('meters/:id')
  @Roles('MANAGER', 'ADMIN', 'OWNER')
  async updateMeter(
    @Param('id') id: string,
    @OrgId() organizationId: string,
    @Body() dto: UpdateMeterDto,
  ) {
    return this.consumption.updateMeter(id, dto, organizationId)
  }

  // ── Tariffer ─────────────────────────────────────────────────────────────
  @Get('tariffs')
  async findTariffs(
    @OrgId() organizationId: string,
    @Query('meterType') meterType?: string,
    @Query('scope') scope?: string,
  ) {
    const filters: { meterType?: ConsumptionTariff['meterType']; scope?: TariffScope } = {}
    if (meterType) filters.meterType = meterType as ConsumptionTariff['meterType']
    if (scope) filters.scope = scope as TariffScope
    return this.consumption.findTariffs(organizationId, filters)
  }

  @Post('tariffs')
  @Roles('MANAGER', 'ADMIN', 'OWNER')
  async createTariff(@OrgId() organizationId: string, @Body() dto: CreateTariffDto) {
    return this.consumption.createTariff(dto, organizationId)
  }

  // ── Avläsningar (källagnostisk intake) ─────────────────────────────────────
  @Get('readings')
  async findReadings(@OrgId() organizationId: string, @Query('meterId') meterId?: string) {
    const filters: { meterId?: string } = {}
    if (meterId) filters.meterId = meterId
    return this.consumption.findReadings(organizationId, filters)
  }

  @Post('readings')
  @Roles('MANAGER', 'ADMIN', 'OWNER')
  async recordReading(
    @OrgId() organizationId: string,
    @Body() dto: RecordReadingDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.consumption.recordReading(dto, organizationId, user.sub)
  }

  // ── Förbrukningsposter (charges) ───────────────────────────────────────────
  @Get('charges')
  async findCharges(
    @OrgId() organizationId: string,
    @Query('status') status?: string,
    @Query('leaseId') leaseId?: string,
  ) {
    const filters: { status?: ConsumptionChargeStatus; leaseId?: string } = {}
    if (status) filters.status = status as ConsumptionChargeStatus
    if (leaseId) filters.leaseId = leaseId
    return this.consumption.findCharges(organizationId, filters)
  }

  @Get('charges/:id')
  async findCharge(@Param('id') id: string, @OrgId() organizationId: string) {
    return this.consumption.findCharge(id, organizationId)
  }
}
