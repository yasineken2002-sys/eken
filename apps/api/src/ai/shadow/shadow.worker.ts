import { Process, Processor } from '@nestjs/bull'
import { Logger } from '@nestjs/common'

import { MaintenanceShadowService } from './maintenance-shadow.service'
import { QUEUE_AI_SHADOW, type AiShadowJobPayload } from './shadow.types'

import type { Job } from 'bull'

/**
 * Workern för skuggkörningar.
 *
 * Den gör INGENTING annat än att slå upp tjänsten. All logik — flaggan,
 * dubbletten, grinden, kvoten — ligger i `MaintenanceShadowService`, som går att
 * pröva utan Bull och utan Redis. En worker som bär logik är en logik som bara
 * går att pröva genom en kö.
 */
@Processor(QUEUE_AI_SHADOW)
export class AiShadowWorker {
  private readonly logger = new Logger(AiShadowWorker.name)

  constructor(private readonly shadow: MaintenanceShadowService) {}

  @Process()
  async handle(job: Job<AiShadowJobPayload>): Promise<void> {
    const { organizationId, ticketId } = job.data
    const r = await this.shadow.korForArende(organizationId, ticketId)
    // UTFALLET LOGGAS ALLTID, även "hände ingenting". Ett tyst överhopp är
    // oskiljbart från ett jobb som aldrig kördes, och skuggläget mäts på hur
    // ofta det producerar något.
    this.logger.log(
      `[ai-shadow] ticket=${ticketId} utfall=${r.utfall}` +
        `${r.assignmentId ? ` assignment=${r.assignmentId}` : ''}` +
        `${r.detalj ? ` (${r.detalj})` : ''}`,
    )
  }
}
