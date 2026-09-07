import { Process, Processor } from '@nestjs/bull'
import { Logger } from '@nestjs/common'

import { PaymentShadowService } from './payment-shadow.service'
import { QUEUE_AI_PAYMENT_SHADOW, type AiPaymentShadowJobPayload } from './payment-shadow.types'

import type { Job } from 'bull'

/**
 * Workern för skuggkörningar på bankrader.
 *
 * Gör INGENTING annat än att slå upp tjänsten — samma hållning som
 * `AiShadowWorker`: en worker som bär logik är en logik som bara går att pröva
 * genom en kö.
 */
@Processor(QUEUE_AI_PAYMENT_SHADOW)
export class AiPaymentShadowWorker {
  private readonly logger = new Logger(AiPaymentShadowWorker.name)

  constructor(private readonly shadow: PaymentShadowService) {}

  @Process()
  async handle(job: Job<AiPaymentShadowJobPayload>): Promise<void> {
    const { organizationId, bankTransactionId } = job.data
    const r = await this.shadow.korForBankrad(organizationId, bankTransactionId)
    // UTFALLET LOGGAS ALLTID, även "hände ingenting". Ett tyst överhopp är
    // oskiljbart från ett jobb som aldrig kördes.
    this.logger.log(
      `[ai-payment-shadow] tx=${bankTransactionId} utfall=${r.utfall}` +
        `${r.assignmentId ? ` assignment=${r.assignmentId}` : ''}` +
        `${r.detalj ? ` (${r.detalj})` : ''}`,
    )
  }
}
