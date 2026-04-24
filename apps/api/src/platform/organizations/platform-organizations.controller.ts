import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common'
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger'
import { Public } from '../../common/decorators/public.decorator'
import { PlatformGuard } from '../auth/platform.guard'
import { PlatformOrganizationsService } from './platform-organizations.service'
import {
  CancelOrganizationDto,
  CreateOrganizationDto,
  SuspendOrganizationDto,
  UpdateOrganizationDto,
} from './dto/platform-organization.dto'

@ApiTags('Platform / Organizations')
@ApiBearerAuth()
@Public()
@UseGuards(PlatformGuard)
@Controller('platform/organizations')
export class PlatformOrganizationsController {
  constructor(private readonly svc: PlatformOrganizationsService) {}

  @Get()
  @ApiOperation({ summary: 'Lista alla organisationer med filter' })
  list(
    @Query('search') search?: string,
    @Query('status') status?: 'ACTIVE' | 'SUSPENDED' | 'CANCELLED',
    @Query('plan') plan?: 'TRIAL' | 'BASIC' | 'STANDARD' | 'PREMIUM',
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.svc.list({
      ...(search ? { search } : {}),
      ...(status ? { status } : {}),
      ...(plan ? { plan } : {}),
      ...(page ? { page: parseInt(page, 10) } : {}),
      ...(pageSize ? { pageSize: parseInt(pageSize, 10) } : {}),
    })
  }

  @Get(':id')
  @ApiOperation({ summary: 'Full organisationsdetalj inkl statistik' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.findOne(id)
  }

  @Post()
  @ApiOperation({ summary: 'Skapa ny kundorganisation + första ADMIN-user' })
  create(@Body() dto: CreateOrganizationDto) {
    return this.svc.create(dto)
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Redigera organisation' })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateOrganizationDto) {
    return this.svc.update(id, dto)
  }

  @Post(':id/suspend')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Suspendera organisation' })
  suspend(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SuspendOrganizationDto) {
    return this.svc.suspend(id, dto.reason)
  }

  @Post(':id/unsuspend')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Återaktivera organisation' })
  unsuspend(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.unsuspend(id)
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Soft-avsluta organisation (CANCELLED)' })
  cancel(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CancelOrganizationDto) {
    return this.svc.cancel(id, dto.reason)
  }
}
