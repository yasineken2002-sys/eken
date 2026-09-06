import { Process, Processor } from '@nestjs/bull'
import { Logger } from '@nestjs/common'

import { AiExecutionDryRunService } from './execution-dryrun.service'
import { QUEUE_AI_EXECUTION_DRYRUN, type AiExecutionDryRunJobPayload } from './dryrun.types'

import type { Job } from 'bull'

/**
 * Workern för torrlägets domar.
 *
 * Den gör INGENTING annat än att slå upp tjänsten — samma hållning som
 * `AiShadowWorker`. En worker som bär logik är en logik som bara går att pröva
 * genom en kö.
 */
@Processor(QUEUE_AI_EXECUTION_DRYRUN)
export class AiExecutionDryRunWorker {
  private readonly logger = new Logger(AiExecutionDryRunWorker.name)

  constructor(private readonly dryrun: AiExecutionDryRunService) {}

  @Process()
  async handle(job: Job<AiExecutionDryRunJobPayload>): Promise<void> {
    const { organizationId, assignmentId } = job.data
    const r = await this.dryrun.bedöm(organizationId, assignmentId)
    // UTFALLET LOGGAS ALLTID, även "redan bedömd". Ett tyst överhopp är
    // oskiljbart från ett jobb som aldrig kördes.
    this.logger.log(
      `[ai-dryrun] assignment=${assignmentId} utfall=${r.utfall}` +
        (r.utfall === 'DOM'
          ? ` dom=${r.dom}${r.delegationId ? ` delegation=${r.delegationId}` : ''}`
          : ''),
    )
  }
}
