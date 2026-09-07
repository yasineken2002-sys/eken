import { Process, Processor } from '@nestjs/bull'
import { Logger } from '@nestjs/common'

import { AiAgentExecutionService } from './agent-execution.service'
import { QUEUE_AI_AGENT_EXECUTION, type AiAgentExecutionJobPayload } from './execution.types'

import type { Job } from 'bull'

/**
 * Workern för skarpt läge. Slår upp tjänsten och loggar utfallet — ingen logik.
 * En worker som bär logik är en logik som bara går att pröva genom en kö.
 */
@Processor(QUEUE_AI_AGENT_EXECUTION)
export class AiAgentExecutionWorker {
  private readonly logger = new Logger(AiAgentExecutionWorker.name)

  constructor(private readonly execution: AiAgentExecutionService) {}

  @Process()
  async handle(job: Job<AiAgentExecutionJobPayload>): Promise<void> {
    const { organizationId, assignmentId } = job.data
    const r = await this.execution.utför(organizationId, assignmentId)
    // ALLA utfall loggas, även de som inte gjorde något. Ett tyst överhopp är
    // oskiljbart från ett jobb som aldrig kördes.
    this.logger.log(`[ai-exec] assignment=${assignmentId} utfall=${r.utfall}`)
  }
}
