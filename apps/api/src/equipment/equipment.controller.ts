import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, UseGuards } from '@nestjs/common'
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard'
import { OrgId } from '../common/decorators/org-id.decorator'
import { Roles } from '../common/decorators/roles.decorator'
import { EquipmentService } from './equipment.service'
// VÄRDEIMPORT, inte `import type` — NestJS läser reflect-metadata i runtime, och
// en typimport gör klassen borta då. Se DTO-regeln i CLAUDE.md.
import { CreateEquipmentDto } from './dto/create-equipment.dto'
import { UpdateEquipmentDto } from './dto/update-equipment.dto'
import { RegisterReplacementDto } from './dto/register-replacement.dto'
import { CorrectEventDto } from './dto/correct-event.dto'

@Controller('equipment')
@UseGuards(JwtAuthGuard)
export class EquipmentController {
  constructor(private readonly equipment: EquipmentService) {}

  /** Utrustningen i en lägenhet, med sina händelser. */
  @Get('unit/:unitId')
  findByUnit(@Param('unitId', ParseUUIDPipe) unitId: string, @OrgId() organizationId: string) {
    return this.equipment.findByUnit(unitId, organizationId)
  }

  @Post()
  @Roles('MANAGER', 'ADMIN', 'OWNER')
  create(@OrgId() organizationId: string, @Body() dto: CreateEquipmentDto) {
    return this.equipment.create(dto, organizationId)
  }

  @Patch(':id')
  @Roles('MANAGER', 'ADMIN', 'OWNER')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateEquipmentDto,
    @OrgId() organizationId: string,
  ) {
    return this.equipment.update(id, dto, organizationId)
  }

  /**
   * REGISTRERA ETT BYTE. `POST`, inte `PATCH`: det är en händelse som skapas,
   * inte ett fält som ändras — och den är inte idempotent.
   */
  @Post(':id/replacement')
  @Roles('MANAGER', 'ADMIN', 'OWNER')
  registerReplacement(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RegisterReplacementDto,
    @OrgId() organizationId: string,
  ) {
    return this.equipment.registerReplacement(id, dto, organizationId)
  }

  /** RÄTTA en händelse — en NY händelse som pekar tillbaka. Aldrig PATCH. */
  @Post(':id/events/correction')
  @Roles('MANAGER', 'ADMIN', 'OWNER')
  correctEvent(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CorrectEventDto,
    @OrgId() organizationId: string,
  ) {
    return this.equipment.correctEvent(id, dto, organizationId)
  }
}
