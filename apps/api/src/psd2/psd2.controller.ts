import { Controller, Get, Post, Delete, Param, Query, Res } from '@nestjs/common'
import type { FastifyReply } from 'fastify'
import { Public } from '../common/decorators/public.decorator'
import { Roles } from '../common/decorators/roles.decorator'
import { OrgId } from '../common/decorators/org-id.decorator'
import { CurrentUser } from '../common/decorators/current-user.decorator'
import type { JwtPayload } from '@eken/shared'
import { Psd2ConsentService } from './psd2-consent.service'
import { Psd2SyncQueue } from './psd2-sync.queue'

/**
 * PSD2-API: bankkoppling (samtycke + sync). Hela ytan är INERT när
 * PSD2_ENABLED=false — DI-factoryn väljer då StubBankDataProvider som kastar 503
 * på varje väg som skulle kunna skapa ett samtycke eller hämta transaktioner.
 *
 * Samtyckes-endpoints kräver OWNER/ADMIN (bindande bankåtkomst). Callbacken är
 * @Public (banken redirectar användarens webbläsare, ingen JWT) — auktorisering
 * bärs av den single-use `state`-bindningen, inte av en query-parameter.
 */
@Controller('reconciliation/psd2')
export class Psd2Controller {
  constructor(
    private readonly consent: Psd2ConsentService,
    private readonly syncQueue: Psd2SyncQueue,
  ) {}

  // Starta bankkoppling → returnerar bankens authUrl (SCA-redirect).
  @Post('consents')
  @Roles('OWNER', 'ADMIN')
  async begin(@OrgId() organizationId: string, @CurrentUser() user: JwtPayload) {
    return this.consent.beginConsent(organizationId, user.sub)
  }

  // Lista samtycken (safe — aldrig tokens).
  @Get('consents')
  @Roles('OWNER', 'ADMIN')
  async list(@OrgId() organizationId: string) {
    return this.consent.listConsents(organizationId)
  }

  // Återkalla ett samtycke.
  @Delete('consents/:id')
  @Roles('OWNER', 'ADMIN')
  async revoke(
    @OrgId() organizationId: string,
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
  ) {
    return this.consent.revokeConsent(organizationId, id, user.sub)
  }

  // Manuell synk-trigger (en cron enqueuear samma jobb i P3).
  @Post('sync')
  @Roles('OWNER', 'ADMIN')
  async sync(@OrgId() organizationId: string) {
    const jobId = await this.syncQueue.enqueueOrgSync(organizationId)
    return { enqueued: true, jobId }
  }

  // Bankens callback efter SCA. @Public — organizationId hämtas ur den server-
  // lagrade `state`, ALDRIG ur queryn. Redirectar tillbaka till frontend.
  @Public()
  @Get('callback')
  async callback(
    @Res() reply: FastifyReply,
    @Query('state') state?: string,
    @Query('code') code?: string,
  ): Promise<void> {
    let ok = true
    try {
      await this.consent.handleCallback(state ?? '', code ?? '')
    } catch {
      // Ogiltig/förbrukad state eller providerfel → tillbaka med felflagga (ingen
      // känslig detalj läcker i redirecten).
      ok = false
    }
    // Explicit 302 + Location (portabelt över Fastify-versioner).
    void reply.status(302).header('location', this.consent.appReturnUrl(ok)).send()
  }
}
