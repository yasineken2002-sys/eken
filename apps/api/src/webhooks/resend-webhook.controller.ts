import { Controller, HttpCode, Post, Req, type RawBodyRequest } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import type { FastifyRequest } from 'fastify'
import { Public } from '../common/decorators/public.decorator'
import { ResendWebhookService } from './resend-webhook.service'

/**
 * Publik webhook-endpoint för Resends leverans-/bounce-event.
 *
 * @Public() — ingen JWT (Resend skickar ingen). Auktoriseringen sker uteslutande
 * via Svix-signaturverifieringen i servicen, som körs FÖRE all behandling.
 *
 * Endpointen läser den oparsade bodyn (req.rawBody, aktiverad via rawBody:true i
 * main.ts) eftersom signaturen är beräknad på exakt de bytes Resend skickade.
 */
@ApiTags('webhooks')
@Controller('webhooks')
export class ResendWebhookController {
  constructor(private readonly service: ResendWebhookService) {}

  @Public()
  @Post('resend')
  @HttpCode(200)
  @ApiOperation({ summary: 'Resend leverans-/bounce-webhook (Svix-signerad)' })
  async handle(@Req() req: RawBodyRequest<FastifyRequest>): Promise<{ received: true }> {
    await this.service.handle(req.rawBody, req.headers)
    return { received: true }
  }
}
