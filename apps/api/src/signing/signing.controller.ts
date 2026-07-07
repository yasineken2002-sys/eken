import { Controller, Post, Get, Param, Body, Req, UseGuards, HttpCode } from '@nestjs/common'
import type { RawBodyRequest } from '@nestjs/common'
import type { FastifyRequest } from 'fastify'
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard'
import { Public } from '../common/decorators/public.decorator'
import { Roles } from '../common/decorators/roles.decorator'
import { OrgId } from '../common/decorators/org-id.decorator'
import { CurrentUser } from '../common/decorators/current-user.decorator'
import type { JwtPayload } from '@eken/shared'
import { SigningService } from './signing.service'
import { CreateSigningRequestDto } from './dto/create-signing-request.dto'

/**
 * Signerings-API. Hela ytan är INERT när SIGNING_ENABLED=false: DI-factoryn väljer
 * då StubSigningProvider som kastar 503 på varje väg som skulle kunna signera.
 * Ingen egen flagg-check behövs i controllern — inaktiveringen bärs av providern.
 */
@Controller('signing')
@UseGuards(JwtAuthGuard)
export class SigningController {
  constructor(private readonly signing: SigningService) {}

  // Bindande handling (skickar ett kontrakt för signering) → hyresvärds-roller.
  @Post('requests')
  @Roles('MANAGER', 'ADMIN', 'OWNER')
  async create(
    @OrgId() organizationId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateSigningRequestDto,
  ) {
    return this.signing.createSigningRequest(organizationId, user.sub, dto.documentId)
  }

  @Get('requests/:id')
  async status(@OrgId() organizationId: string, @Param('id') id: string) {
    return this.signing.getStatusSafe(organizationId, id)
  }

  @Post('requests/:id/refresh')
  @Roles('MANAGER', 'ADMIN', 'OWNER')
  async refresh(@OrgId() organizationId: string, @Param('id') id: string) {
    await this.signing.refreshStatus(organizationId, id)
    return this.signing.getStatusSafe(organizationId, id)
  }

  // Leverantörens callback (Scrive). @Public — ingen JWT; auktorisering sker via
  // signaturverifiering av den oparsade bodyn (mirror av Resend/Svix-webhooken).
  @Public()
  @Post('callback')
  @HttpCode(200)
  async webhook(@Req() req: RawBodyRequest<FastifyRequest>) {
    return this.signing.handleWebhook(
      req.headers as Record<string, string | undefined>,
      req.rawBody ?? Buffer.alloc(0),
    )
  }
}
