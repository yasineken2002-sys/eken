import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common'
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger'
import { JwtService } from '@nestjs/jwt'
import { ConfigService } from '@nestjs/config'
import type { FastifyRequest } from 'fastify'
import { Public } from '../../common/decorators/public.decorator'
import { PlatformGuard } from '../auth/platform.guard'
import { CurrentPlatformUser } from '../auth/current-platform-user.decorator'
import { ImpersonationService } from './impersonation.service'
import { EndImpersonationDto, ImpersonateDto } from './dto/impersonate.dto'
import type { PlatformJwtPayload } from '../platform-token.types'

interface OrgJwtPayload {
  sub: string
  email: string
  organizationId: string
  role: string
  impersonatedBy?: string
  impersonationLogId?: string
}

@ApiTags('Platform / Impersonation')
@Controller('platform/impersonate')
export class ImpersonationController {
  constructor(
    private readonly svc: ImpersonationService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  @Post()
  @ApiBearerAuth()
  @Public()
  @UseGuards(PlatformGuard)
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

  /**
   * End-endpointen accepterar TVÅ typer av tokens:
   *   1. Platform-JWT — super-admin avslutar från admin-appen
   *   2. Impersonation-JWT — super-admin trycker "Avsluta" i banner:en
   *      från web-tabben. Vi verifierar att `impersonationLogId` i
   *      payloaden matchar `body.logId`, vilket bevisar att detta token
   *      utfärdades för exakt denna session.
   *
   * Lösningen är @Public() för att kringgå den globala JwtAuthGuard-en —
   * vi validerar tokenet manuellt eftersom de två JWT-typerna signeras
   * med olika secrets.
   */
  @Post('end')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Markera impersonation-session som avslutad' })
  async end(@Req() req: FastifyRequest, @Body() dto: EndImpersonationDto) {
    const token = this.extractBearer(req)
    if (!token) throw new UnauthorizedException()

    // Försök först som platform-token (super-admin i admin-tabben).
    const platformPayload = this.tryVerifyPlatformToken(token)
    if (platformPayload) {
      await this.svc.end(platformPayload.sub, dto.logId)
      return null
    }

    // Annars — impersonation-JWT från web-tabben.
    const orgPayload = this.tryVerifyOrgToken(token)
    if (orgPayload?.impersonationLogId) {
      await this.svc.endFromImpersonatedToken(orgPayload.impersonationLogId, dto.logId)
      return null
    }

    throw new UnauthorizedException('Ogiltig eller icke-impersonations-token')
  }

  @Get('logs')
  @ApiBearerAuth()
  @Public()
  @UseGuards(PlatformGuard)
  @ApiOperation({ summary: 'Senaste impersonation-sessioner' })
  recent(@Query('limit') limit?: string) {
    return this.svc.listRecent(undefined, limit ? parseInt(limit, 10) : 50)
  }

  // ─── helpers ────────────────────────────────────────────────────────

  private extractBearer(req: FastifyRequest): string | null {
    const header = req.headers['authorization']
    if (typeof header !== 'string') return null
    const match = header.match(/^Bearer\s+(.+)$/i)
    return match?.[1] ?? null
  }

  private tryVerifyPlatformToken(token: string): PlatformJwtPayload | null {
    try {
      const payload = this.jwt.verify<PlatformJwtPayload>(token, {
        secret: this.config.getOrThrow<string>('PLATFORM_JWT_SECRET'),
      })
      if (payload.type === 'platform' && payload.sub) return payload
      return null
    } catch {
      return null
    }
  }

  private tryVerifyOrgToken(token: string): OrgJwtPayload | null {
    try {
      const payload = this.jwt.verify<OrgJwtPayload>(token, {
        secret: this.config.getOrThrow<string>('JWT_SECRET'),
      })
      return payload.sub ? payload : null
    } catch {
      return null
    }
  }
}
