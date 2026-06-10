export const AI_MODELS = {
  CHAT: 'claude-sonnet-4-5',
  STREAM: 'claude-sonnet-4-5',
  ANALYSIS: 'claude-sonnet-4-5',
  MEMORY: 'claude-haiku-4-5-20251001',
  VISION_CONTRACT: 'claude-sonnet-4-5',
  VISION_INSPECTION: 'claude-sonnet-4-5',
} as const

export type AiModel = (typeof AI_MODELS)[keyof typeof AI_MODELS]

/**
 * Voyage-embeddings för juridik-RAG:ens semantiska sökning (Etapp 3).
 *
 * `voyage-4`: nyaste generella/flerspråkiga flaggskeppet, 1024-dim. VALT EFTER
 * MÄTNING (2026-06-10): den domänspecifika `voyage-law-2` är engelsk/US-lag-
 * centrerad och presterade SÄMST på svensk hyresrätt (besittningsskydd §46 på
 * rank #53/560 för den vardagliga flaggskeppsfrågan). voyage-4 rankar samma §46
 * på #1 och lyfter besittningsskydd in i topp-3 — det BM25 missade.
 *
 * DIM måste matcha vector(1024)-kolumnen i LegalChunkEmbedding (PR 3.1) — byter
 * man modell till en annan dimension krävs en ny migration på vektorkolumnen.
 */
export const VOYAGE_EMBEDDINGS = {
  MODEL: 'voyage-4',
  DIM: 1024,
} as const
