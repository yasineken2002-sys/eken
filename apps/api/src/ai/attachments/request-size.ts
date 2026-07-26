import { PayloadTooLargeException } from '@nestjs/common'
import type Anthropic from '@anthropic-ai/sdk'

/**
 * REQUEST-STORLEK MOT ANTHROPICS 32 MB-TAK.
 *
 * Taket gäller HELA requesten — system, verktygsdefinitioner, historik och alla
 * bilagor tillsammans — inte en fil i taget. `CHAT_MAX_ATTACHMENTS = 5` räcker
 * därför inte som skydd: fem PDF:er på 20 MB var är 100 MB råa och ~133 MB som
 * base64. Utan en kontroll här får användaren ett API-fel efter att servern
 * läst 100 MB ur R2 och skickat dem över nätet.
 *
 * BASE64 ÄR POÄNGEN MED DEN HÄR FILEN. Bilagor skickas base64-kodade i JSON,
 * vilket kostar 4 byte per 3 råa — en fil på 24 MB råa byte blir 32 MB på
 * tråden. Alla budgetar nedan räknas därför i KODADE byte, aldrig råa. Att
 * blanda ihop de två är hela felet den här modulen finns för att undvika.
 */

/** Anthropics tak på en enskild request. */
export const ANTHROPIC_MAX_REQUEST_BYTES = 32 * 1024 * 1024

/**
 * Marginal för det JSON-skal mätningen inte räknar exakt: fältnamn, klammer,
 * escaping i textblock, HTTP-headers. Mätningen nedan är noggrann på
 * nyttolasten men avsiktligt approximativ på strukturen — marginalen täcker
 * skillnaden med god råge (skalet är kilobyte, inte megabyte).
 */
export const REQUEST_SAFETY_MARGIN_BYTES = 512 * 1024

/**
 * Reserv för allt som INTE är bilagor, satt i förväg så att pre-flight-kollen
 * kan köras innan vi läser en enda byte ur R2.
 *
 * UPPMÄTT (2026-07-26): `JSON.stringify(TOOLS)` = 27 407 byte, `SYSTEM_PROMPT`
 * = 20 212 byte, alltså ~46 KB som är konstant. Därtill portföljkontexten
 * (begränsad av `take`-taken i DataContextService), minnen, ev. lagtextblock
 * och 20 meddelanden historiktext (glidfönstret) — tillsammans i
 * storleksordningen hundratals KB, inte megabyte. 2 MB är alltså ~4× det
 * realistiska värsta fallet.
 *
 * Reserven behöver inte vara exakt: den skyddar bara pre-flight-kollen. Den
 * SANNA garantin är `assertRequestWithinLimit`, som mäter det faktiska
 * innehållet strax före anropet.
 */
export const REQUEST_TEXT_RESERVE_BYTES = 2 * 1024 * 1024

/**
 * Hur många KODADE byte bilagor får uppta i en request — nya bilagor och
 * rehydrerad historik tillsammans.
 */
export const ATTACHMENT_PAYLOAD_BUDGET_BYTES =
  ANTHROPIC_MAX_REQUEST_BYTES - REQUEST_SAFETY_MARGIN_BYTES - REQUEST_TEXT_RESERVE_BYTES

/** Storleken en buffert får som base64: 4 byte per påbörjad 3-bytegrupp. */
export function base64Bytes(rawBytes: number): number {
  return Math.ceil(rawBytes / 3) * 4
}

/** `12,3 MB` — för felmeddelanden som ska gå att förstå utan att räkna byte. */
export function formatMb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`
}

/**
 * Mäter en requests storlek utan att serialisera om nyttolasten.
 *
 * `JSON.stringify` på hela requesten hade fungerat men byggt en 30 MB-sträng i
 * minnet bara för att mäta den — på en request som redan bär 30 MB. I stället
 * summeras base64-strängarnas längd direkt (de ÄR redan sin egen storlek) och
 * bara det som inte är bilagor serialiseras.
 */
export function measureRequestBytes(parts: {
  system?: unknown
  tools?: unknown
  messages: Anthropic.MessageParam[]
}): number {
  let total = 0
  if (parts.system !== undefined) total += Buffer.byteLength(JSON.stringify(parts.system))
  if (parts.tools !== undefined) total += Buffer.byteLength(JSON.stringify(parts.tools))

  for (const message of parts.messages) {
    if (typeof message.content === 'string') {
      total += Buffer.byteLength(message.content)
      continue
    }
    for (const block of message.content) {
      const data = extractBase64Data(block)
      if (data !== null) {
        // base64-strängen är redan sin egen storlek på tråden.
        total += data.length
        continue
      }
      total += Buffer.byteLength(JSON.stringify(block))
    }
  }
  return total
}

/** base64-nyttolasten i ett image-/document-block, eller null för andra block. */
function extractBase64Data(block: unknown): string | null {
  if (typeof block !== 'object' || block === null) return null
  const { type, source } = block as { type?: unknown; source?: unknown }
  if (type !== 'image' && type !== 'document') return null
  if (typeof source !== 'object' || source === null) return null
  const { type: sourceType, data } = source as { type?: unknown; data?: unknown }
  if (sourceType !== 'base64' || typeof data !== 'string') return null
  return data
}

/**
 * Sista grinden före modellanropet.
 *
 * Pre-flight-kollen i `buildContentBlocks` fångar det stora fallet (för många
 * eller för stora bilagor i ETT meddelande), men bara den här ser hela
 * requesten: bilagor + rehydrerad historik + system + verktyg. Kastar
 * `PayloadTooLargeException` (413) — ett tydligt fel med siffror, inte ett
 * modell-500 långt senare.
 */
export function assertRequestWithinLimit(parts: {
  system?: unknown
  tools?: unknown
  messages: Anthropic.MessageParam[]
}): void {
  const measured = measureRequestBytes(parts)
  if (measured + REQUEST_SAFETY_MARGIN_BYTES > ANTHROPIC_MAX_REQUEST_BYTES) {
    throw new PayloadTooLargeException(
      `Meddelandet blir för stort att skicka (${formatMb(measured)} av högst ` +
        `${formatMb(ANTHROPIC_MAX_REQUEST_BYTES)} inklusive bilagor och tidigare ` +
        `meddelanden). Ta bort en bilaga eller börja en ny konversation.`,
    )
  }
}
