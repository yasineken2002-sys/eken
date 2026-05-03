export const AI_MODELS = {
  CHAT: 'claude-sonnet-4-5',
  STREAM: 'claude-sonnet-4-5',
  ANALYSIS: 'claude-sonnet-4-5',
  MEMORY: 'claude-haiku-4-5-20251001',
  VISION_CONTRACT: 'claude-sonnet-4-5',
  VISION_INSPECTION: 'claude-sonnet-4-5',
} as const

export type AiModel = (typeof AI_MODELS)[keyof typeof AI_MODELS]
