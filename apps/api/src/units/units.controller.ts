import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  HttpCode,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common'
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard'
import { OrgId } from '../common/decorators/org-id.decorator'
import { UnitsService } from './units.service'
import { CreateUnitDto } from './dto/create-unit.dto'
import { UpdateUnitDto } from './dto/update-unit.dto'

@Controller('units')
@UseGuards(JwtAuthGuard)
export class UnitsController {
  constructor(private readonly unitsService: UnitsService) {}

  @Get()
  findAll(@OrgId() organizationId: string, @Query('propertyId') propertyId?: string) {
    return this.unitsService.findAll(organizationId, propertyId)
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string, @OrgId() organizationId: string) {
    return this.unitsService.findOne(id, organizationId)
  }

  @Post()
  create(@OrgId() organizationId: string, @Body() dto: CreateUnitDto) {
    return this.unitsService.create(dto, organizationId)
  }

  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @OrgId() organizationId: string,
    @Body() dto: UpdateUnitDto,
  ) {
    return this.unitsService.update(id, dto, organizationId)
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @OrgId() organizationId: string,
  ): Promise<void> {
    await this.unitsService.remove(id, organizationId)
  }
}
