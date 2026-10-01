import { Body, Controller, Delete, Get, Param, Post, Put, Query, Res } from '@nestjs/common'
import type { FastifyReply } from 'fastify'
import type { JwtPayload } from '@eken/shared'
import { Public } from '../common/decorators/public.decorator'
import { Roles } from '../common/decorators/roles.decorator'
import { OrgId } from '../common/decorators/org-id.decorator'
import { CurrentUser } from '../common/decorators/current-user.decorator'
import { FortnoxConnectionService } from './fortnox-connection.service'
import { FortnoxReadbackService, type StartReadInput } from './fortnox-readback.service'
import { FortnoxExportService } from './fortnox-export.service'
import { FortnoxMappingService } from './fortnox-mapping.service'
import { toStatusResponse } from './fortnox-status'

/**
 * Fortnox (ägarval A: Eveno sköter avier/betalningar, Fortnox är huvudbok).
 *
 * INERT när FORTNOX_ENABLED != true: anslutning svarar 503, och utan ACTIVE
 * anslutning finns inget att läsa. Allt är OWNER/ADMIN (bindande ekonomisk
 * åtkomst). organizationId tas ur JWT, aldrig ur query/body. Callbacken är
 * @Public — auktoriseringen bärs av den single-use state som skapades bakom JWT.
 *
 * Inget svar innehåller token, state, kod eller PKCE-verifier.
 */
@Controller('integrations/fortnox')
export class FortnoxController {
  constructor(
    private readonly connections: FortnoxConnectionService,
    private readonly readback: FortnoxReadbackService,
    private readonly exports: FortnoxExportService,
    private readonly mappings: FortnoxMappingService,
  ) {}

  @Get('status')
  @Roles('OWNER', 'ADMIN')
  async status(@OrgId() organizationId: string) {
    const [connection, mappings, reads, exports] = await Promise.all([
      this.connections.status(organizationId),
      this.mappings.list(organizationId),
      this.readback.latest(organizationId),
      this.exports.counts(organizationId),
    ])
    return toStatusResponse({
      enabled: this.connections.enabled,
      connection,
      mappings,
      ...reads,
      exports,
    })
  }

  @Post('connect')
  @Roles('OWNER', 'ADMIN')
  async connect(@OrgId() organizationId: string, @CurrentUser() user: JwtPayload) {
    return this.connections.begin(organizationId, user.sub)
  }

  @Public()
  @Get('callback')
  async callback(
    @Res() reply: FastifyReply,
    @Query('state') state?: string,
    @Query('code') code?: string,
  ): Promise<void> {
    let ok = true
    try {
      await this.connections.handleCallback(state ?? '', code ?? '')
    } catch {
      ok = false
    }
    // Explicit 302 + Location (samma form som PSD2). Ingen detalj i redirecten.
    void reply.status(302).header('location', this.connections.appReturnUrl(ok)).send()
  }

  @Post('disconnect')
  @Roles('OWNER', 'ADMIN')
  async disconnect(@OrgId() organizationId: string) {
    return this.connections.disconnect(organizationId)
  }

  @Put('mappings')
  @Roles('OWNER', 'ADMIN')
  async upsertMapping(
    @OrgId() organizationId: string,
    @Body() body: { dimensionType?: unknown; code?: unknown; propertyId?: unknown },
  ) {
    return this.mappings.upsert(organizationId, body)
  }

  @Delete('mappings/:id')
  @Roles('OWNER', 'ADMIN')
  async deleteMapping(@OrgId() organizationId: string, @Param('id') id: string) {
    return this.mappings.remove(organizationId, id)
  }

  @Post('reads')
  @Roles('OWNER', 'ADMIN')
  async read(
    @OrgId() organizationId: string,
    @CurrentUser() user: JwtPayload,
    @Body() body: StartReadInput,
  ) {
    return this.readback.read(organizationId, user.sub, body)
  }

  @Get('exports')
  @Roles('OWNER', 'ADMIN')
  async listExports(@OrgId() organizationId: string) {
    return { items: await this.exports.list(organizationId) }
  }

  @Post('exports/dry-run')
  @Roles('OWNER', 'ADMIN')
  async dryRun(@OrgId() organizationId: string, @Body() body: { journalEntryId?: unknown }) {
    return this.exports.dryRun(
      organizationId,
      typeof body?.journalEntryId === 'string' ? body.journalEntryId : '',
    )
  }
}
