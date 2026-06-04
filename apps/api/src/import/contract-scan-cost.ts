import { calculateCost } from '../ai/usage/ai-pricing'
import { AI_MODELS } from '../ai/ai.config'

/**
 * Förhandsestimat av kostnaden för batch-kontraktsskanning (PR1 batch-tak).
 *
 * Syftet är ett SKYDD mot oförutsedd AI-kostnad: innan en batch enqueueas
 * beräknar vi en konservativ uppskattning av vad skanningen kommer kosta och
 * jämför mot organisationens tak. Estimatet behöver inte vara exakt — det ska
 * vara tillräckligt nära och hellre överskatta än underskatta (då hellre
 * blockera en gränsfallsbatch än överspendera).
 *
 * Det verkliga utfallet loggas per skanning av ContractScannerService via
 * AiUsageService; en exakt per-batch-avräkning (kräver batchId på AiUsageLog)
 * är en v2-fråga.
 *
 * VIKTIGT: per-batch-estimatet är ett TIDIGT varningslager, inte ett ACID-hårt
 * tak. Det BINDANDE skyddet mot overshoot är den dagliga org-kostnadsbromsen
 * (AiQuotaService.checkOrgDailyCostCap) som körs i workern före varje skanning
 * och räknar FAKTISKT spenderade kronor. Estimatet är medvetet konservativt
 * (överskattar hellre än underskattar) men kan inte vara exakt — sidantal och
 * vision-tokens per sida varierar med dokumentets täthet.
 */

// Absolut, hårdkodad övre gräns på antal filer per batch — analogt med
// MAX_TX_AMOUNT i bank-flödet. Den per-org konfigurerbara gränsen
// (Organization.maxContractBatchFiles) klampas alltid till detta tak.
export const MAX_BATCH_FILES_ABSOLUTE = 200

// Heuristik-konstanter. En kontrakts-PDF kostar ungefär (sidor × tokens/sida)
// input plus ett litet JSON-svar. Vi skattar sidor från filstorleken och väljer
// medvetet KONSERVATIVA värden (få byte/sida → fler sidor; höga tokens/sida) så
// estimatet hellre överskattar. Filstorleken är redan begränsad till
// MAX_CONTRACT_BYTES (10 MB) av validateUploadedFile innan estimatet körs, så
// sidtaket nedan behöver bara täcka en 10 MB-fil — det får INTE vara så lågt att
// det klampar ner (och därmed UNDERskattar) en tät max-storleksfil.
const BYTES_PER_PAGE = 40_000 // ~40 kB/sida (konservativt → fler sidor → högre estimat)
const EST_INPUT_TOKENS_PER_PAGE = 3_000 // vision-tokens per sida inkl. bild-overhead
const EST_OUTPUT_TOKENS = 700 // JSON-svaret (motorn kör max_tokens=1024)
// Täcker en hel 10 MB-fil (10 MB / 40 kB ≈ 262 sidor). Taket finns bara som
// skydd mot en absurd storlek som tagit sig förbi storleksgränsen — det ska
// ligga ÖVER det realistiska maxet, inte under.
const MAX_PAGES_PER_FILE = 300

/** Skatta antal sidor i en PDF från dess storlek (klampat till [1, 300]). */
export function estimatePagesFromSize(fileSize: number): number {
  if (fileSize <= 0) return 1
  const pages = Math.ceil(fileSize / BYTES_PER_PAGE)
  return Math.min(Math.max(pages, 1), MAX_PAGES_PER_FILE)
}

/** Konservativt kostnadsestimat (SEK) för att skanna EN fil av given storlek. */
export function estimateContractScanCostSek(fileSize: number): number {
  const pages = estimatePagesFromSize(fileSize)
  const { costSek } = calculateCost({
    model: AI_MODELS.VISION_CONTRACT,
    inputTokens: pages * EST_INPUT_TOKENS_PER_PAGE,
    outputTokens: EST_OUTPUT_TOKENS,
  })
  return costSek
}

/** Summerat kostnadsestimat (SEK) för en hel batch. */
export function estimateBatchCostSek(fileSizes: number[]): number {
  const total = fileSizes.reduce((sum, size) => sum + estimateContractScanCostSek(size), 0)
  // Avrunda till 4 decimaler (samma upplösning som calculateCost).
  return Math.round(total * 10_000) / 10_000
}
