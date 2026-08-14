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

  // Rollistan är TVILLINGENS, inte #440:s enhetliga ACCOUNTANT+.
  //
  // `GET /contracts/status/:leaseId` är ADMIN/MANAGER/OWNER. Båda endpointsen
  // svarar på samma fråga — hur långt har ett dokumentflöde kommit — och en
  // signeringsbegäran finns bara för att någon körde POST /signing/requests
  // (MANAGER+). Att två statusytor för samma sorts flöde har olika gräns är just
  // den odeklarerade avvikelsen #267 finns för att fånga, så den matchas i stället
  // för att uppfinna en tredje lista.
  //
  // Fältnivån var redan härdad: SAFE_SIGNATURE_EVIDENCE_SELECT, och
  // `projectRequest` lyfter bort `expectedPersonalNumberHash` ur `requiredRoles`.
  // Modulen är dessutom inert i produktion (SIGNING_ENABLED=false → stub som
  // kastar 503) — vilket gör det här det billigaste tillfället att sätta gränsen
  // rätt, innan S3 tänds.
  @Get('requests/:id')
  @Roles('MANAGER', 'ADMIN', 'OWNER')
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
