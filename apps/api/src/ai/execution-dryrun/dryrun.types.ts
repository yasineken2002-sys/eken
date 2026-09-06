/** Könamnet. Egen kö, inte en gren i skuggkön — se `dryrun.queue.ts`. */
export const QUEUE_AI_EXECUTION_DRYRUN = 'ai-execution-dryrun'

export interface AiExecutionDryRunJobPayload {
  organizationId: string
  /** `AiAssignment.id` — förslaget domen gäller. */
  assignmentId: string
}
