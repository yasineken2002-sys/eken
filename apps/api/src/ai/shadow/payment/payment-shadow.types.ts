/** Bull-kön för skuggkörningar på omatchade bankrader (agent 2, etapp A). */
export const QUEUE_AI_PAYMENT_SHADOW = 'ai-payment-shadow'

export interface AiPaymentShadowJobPayload {
  organizationId: string
  bankTransactionId: string
}
