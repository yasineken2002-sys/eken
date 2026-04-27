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
  HttpStatus,
} from '@nestjs/common'
import { ApiBearerAuth, ApiTags, ApiOperation } from '@nestjs/swagger'
import { OrgId } from '../common/decorators/org-id.decorator'
import { CustomersService } from './customers.service'
import { CreateCustomerDto } from './dto/create-customer.dto'
import { UpdateCustomerDto } from './dto/update-customer.dto'

@ApiTags('Customers')
@ApiBearerAuth()
@Controller('customers')
export class CustomersController {
  constructor(private readonly service: CustomersService) {}

  @Get()
  @ApiOperation({ summary: 'Lista kunder med valfria filter' })
  findAll(
    @OrgId() orgId: string,
    @Query('search') search?: string,
    @Query('type') type?: 'INDIVIDUAL' | 'COMPANY',
    @Query('isActive') isActive?: string,
  ) {
    return this.service.findAll(orgId, {
      ...(search ? { search } : {}),
      ...(type ? { type } : {}),
      ...(isActive != null ? { isActive: isActive === 'true' } : {}),
    })
  }

  @Get(':id')
  @ApiOperation({ summary: 'Hämta kund med fakturahistorik' })
  findOne(@Param('id') id: string, @OrgId() orgId: string) {
    return this.service.findOne(id, orgId)
  }

  @Post()
  @ApiOperation({ summary: 'Skapa ny kund' })
  create(@OrgId() orgId: string, @Body() dto: CreateCustomerDto) {
    return this.service.create(dto, orgId)
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Uppdatera kund' })
  update(@Param('id') id: string, @OrgId() orgId: string, @Body() dto: UpdateCustomerDto) {
    return this.service.update(id, dto, orgId)
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Arkivera kund (soft delete) eller ta bort om utan historik' })
  remove(@Param('id') id: string, @OrgId() orgId: string) {
    return this.service.remove(id, orgId)
  }
}
