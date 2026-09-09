/** Intern granskning av samma svar kostnadsförs men förbrukar inte en extra fråga. */
export const MANUAL_AI_CALL_WHERE = {
  isAutomated: false,
  endpoint: { not: 'consumption-judge' },
} as const

export function countsAsManualAiCall(row: { isAutomated: boolean; endpoint: string }): boolean {
  return (
    row.isAutomated === MANUAL_AI_CALL_WHERE.isAutomated &&
    row.endpoint !== MANUAL_AI_CALL_WHERE.endpoint.not
  )
}
