import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common'
import type { MaintenanceCategory } from '@prisma/client'

import { ContractorsService } from './contractors.service'
import { CreateContractorDto, UpdateContractorDto } from './dto/contractor.dto'
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard'
import { CurrentUser } from '../common/decorators/current-user.decorator'
import { OrgId } from '../common/decorators/org-id.decorator'
import { Roles } from '../common/decorators/roles.decorator'
import type { JwtPayload } from '@eken/shared'

/**
 * ROLLGRÄNSEN ÄR FÖRVALTNINGENS, inte bokföringens.
 *
 * Att lägga upp och ändra en hantverkare är samma slags handling som att skapa
 * en felanmälan eller ett hyresavtal, och HTTP säger `MANAGER, ADMIN, OWNER`
 * för dem (#269). En bokförare ska inte kunna ändra vem som anlitas; en VIEWER
 * ska kunna LÄSA registret, eftersom hen ser tilldelningen på ärendet ändå.
 */
@Controller('contractors')
@UseGuards(JwtAuthGuard)
export class ContractorsController {
  constructor(private readonly contractors: ContractorsService) {}

  @Get()
  findAll(
    @OrgId() orgId: string,
    @Query('category') category?: MaintenanceCategory,
    @Query('activeOnly') activeOnly?: string,
  ) {
    return this.contractors.findAll(orgId, {
      ...(category ? { category } : {}),
      // Query-parametrar anländer som sträng. Jämförelsen är EXPLICIT mot
      // 'true' i stället för att lita på pipens konvertering — `Boolean('false')`
      // är `true`, och den fällan står i no-coercion.decorator.ts.
      activeOnly: activeOnly === 'true',
    })
  }

  @Get(':id')
  findOne(@Param('id') id: string, @OrgId() orgId: string) {
    return this.contractors.findOne(id, orgId)
  }

  @Post()
  @Roles('OWNER', 'ADMIN', 'MANAGER')
  create(
    @Body() dto: CreateContractorDto,
    @OrgId() orgId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.contractors.create(dto, orgId, user.sub)
  }

  @Patch(':id')
  @Roles('OWNER', 'ADMIN', 'MANAGER')
  update(@Param('id') id: string, @Body() dto: UpdateContractorDto, @OrgId() orgId: string) {
    return this.contractors.update(id, dto, orgId)
  }

  /**
   * GDPR-radering. Skiljd från `isActive = false`, som bara betyder "anlitas
   * inte längre" — se `ContractorsService.remove`.
   */
  @Delete(':id')
  @Roles('OWNER', 'ADMIN')
  remove(@Param('id') id: string, @OrgId() orgId: string) {
    return this.contractors.remove(id, orgId)
  }
}
