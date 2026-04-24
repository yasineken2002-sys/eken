import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common'
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger'
import type { FastifyRequest } from 'fastify'
import { Public } from '../../common/decorators/public.decorator'
import { PlatformGuard } from '../auth/platform.guard'
import { CurrentPlatformUser } from '../auth/current-platform-user.decorator'
import { ImpersonationService } from './impersonation.service'
import { EndImpersonationDto, ImpersonateDto } from './dto/impersonate.dto'
import type { PlatformJwtPayload } from '../platform-token.types'

@ApiTags('Platform / Impersonation')
@ApiBearerAuth()
@Public()
@UseGuards(PlatformGuard)
@Controller('platform/impersonate')
export class ImpersonationController {
  constructor(private readonly svc: ImpersonationService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Skapa impersonation-token mot en kund' })
  start(
    @CurrentPlatformUser() platformUser: PlatformJwtPayload,
    @Body() dto: ImpersonateDto,
    @Req() req: FastifyRequest,
  ) {
    const ipAddress = req.ip
    const userAgent = (req.headers['user-agent'] as string | undefined) ?? undefined
    return this.svc.start({
      platformUserId: platformUser.sub,
      organizationId: dto.organizationId,
      ...(dto.userId ? { userId: dto.userId } : {}),
      ...(dto.reason ? { reason: dto.reason } : {}),
      ...(ipAddress ? { ipAddress } : {}),
      ...(userAgent ? { userAgent } : {}),
    })
  }

  @Post('end')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Markera impersonation-session som avslutad' })
  async end(
    @CurrentPlatformUser() platformUser: PlatformJwtPayload,
    @Body() dto: EndImpersonationDto,
  ) {
    await this.svc.end(platformUser.sub, dto.logId)
    return null
  }

  @Get('logs')
  @ApiOperation({ summary: 'Senaste impersonation-sessioner' })
  recent(@Query('limit') limit?: string) {
    return this.svc.listRecent(undefined, limit ? parseInt(limit, 10) : 50)
  }
}
