// Anthropic-prislista (USD per miljon tokens) per januari 2026.
// Källa: https://www.anthropic.com/pricing
//
// Värdena ska uppdateras vid prisförändring. Cachat input ger ~90% rabatt
// vid läsning (samma som SDK:n rapporterar). Cache-skrivning kostar mer än
// vanlig input (1,25× för Sonnet, 1,25× för Haiku).

export interface ModelPricing {
  input: number // USD per 1M input tokens
  cacheWrite: number // USD per 1M tokens skrivna till cache (5 min TTL)
  cacheRead: number // USD per 1M tokens lästa från cache
  output: number // USD per 1M output tokens
}

const PRICING: Record<string, ModelPricing> = {
  // Sonnet 4.x
  'claude-sonnet-4-5': { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 },
  'claude-sonnet-4-6': { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 },
  'claude-sonnet-4-7': { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 },
  // Haiku 4.x
  'claude-haiku-4-5-20251001': { input: 0.8, cacheWrite: 1.0, cacheRead: 0.08, output: 4 },
  // Opus 4.x
  'claude-opus-4-7': { input: 15, cacheWrite: 18.75, cacheRead: 1.5, output: 75 },
}

const DEFAULT_PRICING: ModelPricing = PRICING['claude-sonnet-4-5']!

export function getPricing(model: string): ModelPricing {
  // Dropp eventuell suffix som "-1m" eller "[1m]" för att hitta basmodellen.
  const base = model.replace(/\[.*\]$/, '').replace(/-1m$/, '')
  return PRICING[base] ?? PRICING[model] ?? DEFAULT_PRICING
}

// Anthropic prissätter i USD; vi visar/förbjuder i SEK. Default-kursen
// är konservativ. Vid prismätning bör en daglig FX-snapshot persisteras
// senare — för nu håller en konstant räcken.
export const USD_TO_SEK = 10.5

export interface UsageInput {
  model: string
  inputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  outputTokens: number
}

export interface UsageCost {
  inputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
  costUsd: number
  costSek: number
}

export function calculateCost(usage: UsageInput): UsageCost {
  const pricing = getPricing(usage.model)
  const cacheRead = usage.cacheReadTokens ?? 0
  const cacheWrite = usage.cacheWriteTokens ?? 0
  const costUsd =
    (usage.inputTokens * pricing.input +
      cacheRead * pricing.cacheRead +
      cacheWrite * pricing.cacheWrite +
      usage.outputTokens * pricing.output) /
    1_000_000

  const costSek = costUsd * USD_TO_SEK

  return {
    inputTokens: usage.inputTokens,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    outputTokens: usage.outputTokens,
    costUsd: Math.round(costUsd * 1_000_000) / 1_000_000,
    costSek: Math.round(costSek * 10_000) / 10_000,
  }
}
