import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
} from '@nestjs/common'
import { ApiBearerAuth, ApiTags, ApiOperation } from '@nestjs/swagger'
import type { PropertiesService } from './properties.service'
import { OrgId } from '../common/decorators/org-id.decorator'
import { Roles } from '../common/decorators/roles.decorator'
import type { CreatePropertyDto } from './dto/create-property.dto'
import type { UpdatePropertyDto } from './dto/update-property.dto'

@ApiTags('Properties')
@ApiBearerAuth()
@Controller('properties')
export class PropertiesController {
  constructor(private service: PropertiesService) {}

  @Get()
  @ApiOperation({ summary: 'Lista alla fastigheter' })
  findAll(@OrgId() orgId: string) {
    return this.service.findAll(orgId)
  }

  @Get(':id')
  @ApiOperation({ summary: 'Hämta en fastighet' })
  findOne(@Param('id', ParseUUIDPipe) id: string, @OrgId() orgId: string) {
    return this.service.findOne(id, orgId)
  }

  @Post()
  @Roles('MANAGER', 'ADMIN', 'OWNER')
  @ApiOperation({ summary: 'Skapa fastighet' })
  create(@OrgId() orgId: string, @Body() dto: CreatePropertyDto) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return this.service.create(orgId, { ...dto, address: dto.address as any })
  }

  @Patch(':id')
  @Roles('MANAGER', 'ADMIN', 'OWNER')
  @ApiOperation({ summary: 'Uppdatera fastighet' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @OrgId() orgId: string,
    @Body() dto: UpdatePropertyDto,
  ) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return this.service.update(id, orgId, { ...dto, address: dto.address as any })
  }

  @Delete(':id')
  @Roles('ADMIN', 'OWNER')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Ta bort fastighet' })
  remove(@Param('id', ParseUUIDPipe) id: string, @OrgId() orgId: string) {
    return this.service.remove(id, orgId)
  }
}
