/** Bull-kön för skuggkörningar på felanmälan (etapp 6). */
export const QUEUE_AI_SHADOW = 'ai-shadow'

/**
 * Jobbet bär BARA identiteter, aldrig ärendetexten.
 *
 * Ett Bull-jobb ligger i Redis i sju dygn. Att lägga hyresgästens beskrivning av
 * felet där hade skapat en andra kopia av persondata utanför databasen, med egen
 * livslängd och utan anonymiseringsväg — exakt den parallella sanningskälla
 * planens Del 16 förbjuder. Workern läser ärendet på nytt, vilket dessutom är
 * det enda sättet att låta ett fördröjt jobb se världen som den faktiskt är.
 */
export interface AiShadowJobPayload {
  organizationId: string
  ticketId: string
}
