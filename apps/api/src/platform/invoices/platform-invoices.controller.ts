import {
  Body,
  Controller,
  Get,
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
import { PlatformInvoicesService } from './platform-invoices.service'
import {
  CreatePlatformInvoiceDto,
  UpdatePlatformInvoiceStatusDto,
} from './dto/platform-invoice.dto'

@ApiTags('Platform / Invoices')
@ApiBearerAuth()
@Public()
@UseGuards(PlatformGuard)
@Controller('platform/invoices')
export class PlatformInvoicesController {
  constructor(private readonly svc: PlatformInvoicesService) {}

  @Get()
  @ApiOperation({ summary: 'Lista plattformsfakturor' })
  list(
    @Query('status') status?: 'PENDING' | 'PAID' | 'OVERDUE' | 'VOID',
    @Query('organizationId') organizationId?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.svc.list({
      ...(status ? { status } : {}),
      ...(organizationId ? { organizationId } : {}),
      ...(page ? { page: parseInt(page, 10) } : {}),
      ...(pageSize ? { pageSize: parseInt(pageSize, 10) } : {}),
    })
  }

  @Post()
  @ApiOperation({ summary: 'Skapa ny plattformsfaktura' })
  create(@Body() dto: CreatePlatformInvoiceDto) {
    return this.svc.create(dto)
  }

  @Patch(':id/status')
  @ApiOperation({ summary: 'Uppdatera fakturans status' })
  updateStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePlatformInvoiceStatusDto,
  ) {
    return this.svc.updateStatus(id, dto.status)
  }
}
