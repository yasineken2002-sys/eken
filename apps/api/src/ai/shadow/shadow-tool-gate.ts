import { EFFECT_DECLARATIONS } from '../tools/effect-idempotency'
import { HUMAN_PATHS, arSaknad } from '../tools/human-path'

import type { EffectDeclaration } from '../tools/effect-idempotency'

/**
 * VILKA VERKTYG FÅR ALLS FÖRESLÅS I SKUGGLÄGE?
 *
 * Ren funktion, ingen databas. Grinden bor här och inte i körningen av samma
 * skäl som `assignment-eligibility.ts`: den går att pröva ensam mot påhittade
 * deklarationer, utan en halv Nest-graf — och den går att räkna upp, så mängden
 * är MÄTT och inte skriven.
 *
 * ── TRE VILLKOR, ALLA HÄRLEDDA ──────────────────────────────────────────────
 *
 * 1. Verktyget är klassificerat. Ett okänt namn är antingen ett läsverktyg, ett
 *    stavfel eller något ingen tagit ställning till — alla tre ska stoppas, och
 *    samma svar duger för alla tre.
 * 2. `humanPath` FINNS. Delmängdsregeln (planens Regel 2): agenten får aldrig
 *    föreslå något hyresvärden inte kan göra själv. Fem verktyg saknar väg i
 *    dag, och ett förslag om ett av dem hade varit ett förslag hyresvärden inte
 *    kan verkställa ens för hand.
 * 3. `authorityScope !== 'MOT_TREDJE_PART'`. Skuggläget prövas mot VERKLIGA
 *    fall, och ett förslag som handlar om en myndighet, ett inkassobolag eller
 *    en signeringsprovider är fel sak att öva på först — där är kostnaden av ett
 *    dåligt förslag inte hyresvärdens tid utan en tredje parts förtroende.
 *
 * ── VAD DEN HÄR GRINDEN INTE ÄR ─────────────────────────────────────────────
 *
 * Den är INTE `agentAllowlist`. Det fältet svarar på "får en agent UTFÖRA detta
 * obevakat", och i skuggläge utförs ingenting alls — att låna det hade stängt ute
 * 21 av 30 verktyg från att ens FÖRESLÅS, vilket är exakt fel: hela poängen med
 * skuggläget är att se vad agenten skulle ha gjort med det den inte får göra.
 * Se CLAUDE.md, "Återanvänd inte ett fält som svarar på en ANNAN fråga".
 */
export type SkuggDuglighet =
  | { duglig: true }
  | { duglig: false; skäl: 'OKÄNT_VERKTYG' | 'SAKNAR_MÄNSKLIG_VÄG' | 'TREDJE_PART'; text: string }

export function provaSkuggDuglighet(
  toolName: string,
  deklarationer: Record<string, EffectDeclaration> = EFFECT_DECLARATIONS,
  vagar: typeof HUMAN_PATHS = HUMAN_PATHS,
): SkuggDuglighet {
  const dekl = deklarationer[toolName]
  if (!dekl)
    return {
      duglig: false,
      skäl: 'OKÄNT_VERKTYG',
      text: `Verktyget ${toolName} har ingen effektklassificering och kan inte föreslås.`,
    }

  const vag = vagar[toolName]
  if (!vag || arSaknad(vag))
    return {
      duglig: false,
      skäl: 'SAKNAR_MÄNSKLIG_VÄG',
      text:
        `Verktyget ${toolName} saknar mänsklig väg. Agenten får aldrig föreslå något ` +
        'hyresvärden inte kan göra själv i gränssnittet.',
    }

  if (dekl.authorityScope === 'MOT_TREDJE_PART')
    return {
      duglig: false,
      skäl: 'TREDJE_PART',
      text:
        `Verktyget ${toolName} riktar sig mot en tredje part. Skuggläget övar inte ` +
        'på förslag där ett dåligt utfall kostar någon annan än hyresvärden.',
    }

  return { duglig: true }
}

/**
 * Hela mängden verktyg som får föreslås — HÄRLEDD, aldrig skriven som en lista.
 *
 * En uppräkning som skrivs för hand blir fel första gången någon lägger till ett
 * verktyg, och felet är tyst åt det farliga hållet.
 */
export function skuggdugligaVerktyg(
  deklarationer: Record<string, EffectDeclaration> = EFFECT_DECLARATIONS,
  vagar: typeof HUMAN_PATHS = HUMAN_PATHS,
): string[] {
  return Object.keys(deklarationer)
    .filter((n) => provaSkuggDuglighet(n, deklarationer, vagar).duglig)
    .sort()
}

/**
 * VILKA VERKTYG HÖR HEMMA PÅ EN NY FELANMÄLAN?
 *
 * ── EN ANDRA FRÅGA, INTE ETT LÅN AV DEN FÖRSTA ──────────────────────────────
 *
 *     provaSkuggDuglighet    får det här verktyget alls föreslås?
 *     RELEVANTA_*            är det meningsfullt för DEN HÄR källan?
 *
 * De är olika frågor och därför två mängder. Den första är härledd ur
 * deklarationerna och gäller alla skuggkällor; den andra är ett redaktionellt
 * val per källa. Att lösa det andra genom att skärpa det första hade gjort
 * grinden källspecifik, och nästa skuggkälla hade ärvt en avgränsning som inte
 * gällde den.
 *
 * ── VARFÖR DEN BEHÖVS — MÄTT, INTE BEFARAT ──────────────────────────────────
 *
 * En AI-arkitekturgranskning körde 33 skarpa modellanrop mot den här promptens
 * faktiska utdata (2026-09-05). Utfallet:
 *
 *     hela mängden (24 verktyg)      11/11 föreslog `create_maintenance_ticket`
 *     …även med tool use + enum      11/14 samma sak
 *     avgränsad meny                  0/8  — create_inspection, update_maintenance_status
 *
 * Alltså: modellen föreslog att SKAPA EN DUBBLETT av det ärende den analyserade,
 * i praktiken varje gång. Orsaken är inte formatet utan menyn — av 24 dugliga
 * verktyg är bara tre underhållsformade, resten är bokföring, avtal och
 * avisering, och modellen sträcker sig efter det enda namn som innehåller
 * "maintenance". Strukturerad utdata löste det INTE.
 *
 * ── SNITTET, INTE KOPIAN ────────────────────────────────────────────────────
 *
 * Listan nedan snittas med den härledda mängden. Förlorar ett av verktygen sin
 * mänskliga väg eller blir MOT_TREDJE_PART faller det ur menyn av sig självt —
 * en handskriven kopia hade glidit från grinden utan att något blev rött.
 */
const RELEVANTA_FOR_FELANMALAN = [
  'update_maintenance_status',
  'create_inspection',
  'compose_and_send_email',
  'record_expense',
] as const

/**
 * Menyn för en felanmälan: snittet av "får föreslås" och "hör hemma här".
 *
 * `create_maintenance_ticket` står MED FLIT inte i listan. Ärendet finns redan —
 * det är själva anledningen till att körningen sker.
 */
export function skuggverktygForFelanmalan(
  deklarationer: Parameters<typeof skuggdugligaVerktyg>[0] = EFFECT_DECLARATIONS,
  vagar: Parameters<typeof skuggdugligaVerktyg>[1] = HUMAN_PATHS,
): string[] {
  const dugliga = new Set(skuggdugligaVerktyg(deklarationer, vagar))
  return RELEVANTA_FOR_FELANMALAN.filter((n) => dugliga.has(n))
}

/** Modellen måste kunna avstå. Se noten i prompten om att den sällan gör det. */
export const INGEN_ATGARD = 'INGEN_ATGARD'
