import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common'
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger'
import { Public } from '../../common/decorators/public.decorator'
import { PlatformGuard } from '../auth/platform.guard'
import { PlatformPropertiesService } from './platform-properties.service'
import { CreatePropertyDto } from '../../properties/dto/create-property.dto'

@ApiTags('Platform / Properties')
@ApiBearerAuth()
@Public()
@UseGuards(PlatformGuard)
@Controller('platform/organizations/:orgId/properties')
export class PlatformPropertiesController {
  constructor(private readonly svc: PlatformPropertiesService) {}

  @Get()
  @ApiOperation({ summary: 'Lista fastigheter för en kund' })
  list(@Param('orgId', ParseUUIDPipe) orgId: string) {
    return this.svc.listForOrganization(orgId)
  }

  @Post()
  @ApiOperation({ summary: 'Skapa fastighet åt en kund' })
  create(@Param('orgId', ParseUUIDPipe) orgId: string, @Body() dto: CreatePropertyDto) {
    return this.svc.createForOrganization(orgId, {
      ...dto,
      address: { ...dto.address, country: dto.address.country ?? 'SE' },
    })
  }
}
