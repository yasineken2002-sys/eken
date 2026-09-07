import { EFFECT_DECLARATIONS } from '../tools/effect-idempotency'
import { HUMAN_PATHS, arSaknad } from '../tools/human-path'

/**
 * VAD HYRESVÄRDEN FÅR VETA NÄR HEN VILL ÅNGRA EN UTFÖRD ÅTGÄRD.
 *
 * ── SYSTEMET BACKAR INGENTING SJÄLVT, OCH DET ÄR ETT BESLUT ─────────────────
 *
 * `supportsUndo` pekar ut en NAMNGIVEN metod i en namngiven fil per verktyg
 * (`properties.service.ts:remove`, `avisering.service.ts:cancelNotice` …). Att
 * anropa dem generiskt hade varit en ANDRA utförandeväg — med samma behov av
 * delegation, bevis, spår och omprövning som den första, byggd i förbifarten och
 * utan någon av grindarna. Ångra är därför en HÄNDELSE: hyresvärden säger att
 * hen vill ha det backat, det blir stående, och texten nedan visar vägen.
 *
 * ── TVÅ KÄLLOR, TVÅ FRÅGOR ─────────────────────────────────────────────────
 *
 *   supportsUndo  KAN effekten backas i systemet, och var bor koden? (utvecklare)
 *   HUMAN_PATHS   VAR i gränssnittet gör en människa det? (hyresvärd)
 *
 * Texten byggs av båda. `supportsUndo` ensam hade gett hyresvärden en filsökväg,
 * vilket är ett svar på fel fråga.
 */
export type Ångravägen =
  | {
      /** Det finns en väg, och hyresvärden kan gå den själv. */
      möjlig: true
      rutt: string
      atgard: string
      text: string
    }
  | {
      /** Ingen väg — texten säger varför, aldrig bara "nej". */
      möjlig: false
      text: string
    }

/**
 * Ångravägen för ett verktyg.
 *
 * FAIL-CLOSED på okänt namn: ett verktyg utan deklaration ska inte kunna se ut
 * som om det går att backa.
 */
export function ångravägen(toolName: string): Ångravägen {
  const dekl = EFFECT_DECLARATIONS[toolName]
  if (!dekl) {
    return {
      möjlig: false,
      text:
        `Verktyget ${toolName} har ingen effektklassificering, så det går inte att säga ` +
        'vad som behöver backas. Kontakta supporten innan du gör något för hand.',
    }
  }

  if (dekl.supportsUndo.kind === 'INGEN_EFFEKT') {
    return {
      möjlig: false,
      text: 'Åtgärden ändrade ingenting som går att backa — det finns inget att ångra.',
    }
  }

  if (dekl.supportsUndo.kind === 'IRREVERSIBEL') {
    // SKÄLET ORDAGRANT. En omformulering här hade blivit en andra uppräkning av
    // samma skäl, och den som syns för hyresvärden hade varit den som ingen
    // prövat. Samma hållning som torrlägets `verdictReason`.
    return {
      möjlig: false,
      text: `Den här åtgärden går inte att backa i systemet: ${dekl.supportsUndo.skäl}`,
    }
  }

  const väg = HUMAN_PATHS[toolName]
  if (!väg || arSaknad(väg)) {
    // KAN backas i koden, men hyresvärden har ingen knapp. Det är ett annat svar
    // än "går inte att backa", och det ska synas som ett annat svar.
    return {
      möjlig: false,
      text:
        'Åtgärden går att backa i systemet, men det finns ingen väg att göra det själv i ' +
        'gränssnittet. Din begäran är noterad — kontakta supporten.',
    }
  }

  return {
    möjlig: true,
    rutt: väg.rutt,
    atgard: väg.atgard,
    text: `Du backar det här själv under ${väg.rutt} — åtgärden heter "${väg.atgard}".`,
  }
}
