import type { RentNoticeStatus } from '@prisma/client'

/**
 * G15 (FORTNOX-100): de avistatusar som får TA EMOT en betalning i bankavstämningen —
 * OCR-grenen, referensgrenen, vattenfallet, den manuella matchningen och statusguarden
 * som sätter PAID. EN lista, så att vägarna inte kan glida isär igen.
 *
 * FAILED ingår. FAILED betyder att UTSKICKET misslyckades (saknat bankgiro vid
 * aktiveringen, saknad e-post, pdf-fel) — avin är skapad och fordran bokförd (D 1510,
 * se `AviseringService.sendNotices`). Hyresgästens OCR är fast och gäller alla hennes
 * avier, så betalningen kommer ofta ändå. Utan FAILED blev den liggande omatchad och
 * fordran stod kvar. Den manuella registreringen (`AviseringService.markAsPaid`) har
 * redan FAILED i sin lista; bankvägen var den som avvek.
 *
 * Utanför listan: PAID (reglerad), CANCELLED (makulerad — ingen fordran). Beloppsgissningen
 * (fuzzy-grenen) använder MEDVETET inte listan: den gissar på belopp och ska inte vidgas.
 */
export const BETALBARA_AVISTATUSAR = [
  'SENT',
  'PENDING',
  'OVERDUE',
  'FAILED',
] as const satisfies readonly RentNoticeStatus[]

export function ärBetalbarAvistatus(status: RentNoticeStatus): boolean {
  return (BETALBARA_AVISTATUSAR as readonly RentNoticeStatus[]).includes(status)
}

/**
 * KUNDSTART-001 §12.2 (K-B2): OPENING är en historisk öppen fordran ur ett verkställt
 * öppningspaket. Den får reglera en verklig ny betalning — men BARA när en människa
 * uttryckligen valt just den avin (manuell matchning). Automatiken (OCR, referens,
 * vattenfall, beloppsgissning) använder BETALBARA_AVISTATUSAR ovan och allokerar därför
 * aldrig till OPENING: vi gissar inte vilket krav hyresgästen betalat, och dagens
 * hyresbetalning kan inte tyst hamna på gammal skuld så att den nya avin blir förfallen
 * och kravtrappan startar på den.
 *
 * Används av statusguarden som sätter PAID (som är gemensam för manuell och automatisk
 * väg — de automatiska urvalen släpper aldrig in en OPENING-avi dit) och av den
 * manuella matchningens tillåtelse.
 */
export const MANUELLT_BETALBARA_AVISTATUSAR = [
  ...BETALBARA_AVISTATUSAR,
  'OPENING',
] as const satisfies readonly RentNoticeStatus[]
