import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common'
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger'
import { Public } from '../../common/decorators/public.decorator'
import { PlatformGuard } from '../auth/platform.guard'
import { PlatformErrorsService } from './platform-errors.service'
import { CreateFrontendErrorDto } from './dto/error-log.dto'

@ApiTags('Platform / Errors')
@Controller('platform/errors')
export class PlatformErrorsController {
  constructor(private readonly svc: PlatformErrorsService) {}

  // Publik endpoint för frontend-fel — ingen auth krävs (annars kan en
  // krashat app aldrig rapportera). Throttlas globalt.
  @Post('report')
  @Public()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Rapportera fel från frontend (WEB/PORTAL/ADMIN)' })
  async report(@Body() dto: CreateFrontendErrorDto) {
    await this.svc.logFrontendError(dto)
    return null
  }

  @Get()
  @Public()
  @UseGuards(PlatformGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Lista fel-logg' })
  list(
    @Query('severity') severity?: 'CRITICAL' | 'ERROR' | 'WARNING',
    @Query('source') source?: 'API' | 'WEB' | 'PORTAL' | 'ADMIN',
    @Query('resolved') resolved?: string,
    @Query('organizationId') organizationId?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.svc.list({
      ...(severity ? { severity } : {}),
      ...(source ? { source } : {}),
      ...(resolved !== undefined ? { resolved: resolved === 'true' } : {}),
      ...(organizationId ? { organizationId } : {}),
      ...(page ? { page: parseInt(page, 10) } : {}),
      ...(pageSize ? { pageSize: parseInt(pageSize, 10) } : {}),
    })
  }

  @Post(':id/resolve')
  @Public()
  @UseGuards(PlatformGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Markera fel som löst' })
  resolve(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.resolve(id)
  }

  @Get('summary')
  @Public()
  @UseGuards(PlatformGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Count per severity (för dashboard-badge)' })
  summary() {
    return this.svc.summary()
  }
}
