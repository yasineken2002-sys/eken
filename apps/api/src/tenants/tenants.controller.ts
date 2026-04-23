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
} from '@nestjs/common'
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard'
import { OrgId } from '../common/decorators/org-id.decorator'
import { TenantsService } from './tenants.service'
import { CreateTenantDto } from './dto/create-tenant.dto'
import { UpdateTenantDto } from './dto/update-tenant.dto'

@Controller('tenants')
@UseGuards(JwtAuthGuard)
export class TenantsController {
  constructor(private readonly tenantsService: TenantsService) {}

  @Get()
  async findAll(@OrgId() organizationId: string, @Query('search') search?: string) {
    return this.tenantsService.findAll(organizationId, search)
  }

  @Get(':id')
  async findOne(@Param('id') id: string, @OrgId() organizationId: string) {
    return this.tenantsService.findOne(id, organizationId)
  }

  @Post()
  async create(@OrgId() organizationId: string, @Body() dto: CreateTenantDto) {
    return this.tenantsService.create(dto, organizationId)
  }

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @OrgId() organizationId: string,
    @Body() dto: UpdateTenantDto,
  ) {
    return this.tenantsService.update(id, dto, organizationId)
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id') id: string, @OrgId() organizationId: string): Promise<void> {
    await this.tenantsService.remove(id, organizationId)
  }
}
