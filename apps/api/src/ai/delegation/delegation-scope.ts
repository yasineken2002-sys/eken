import { EFFECT_DECLARATIONS } from '../tools/effect-idempotency'

import type { EffectDeclaration } from '../tools/effect-idempotency'

/**
 * VILKA VERKTYG FÅR ALLS DELEGERAS?
 *
 * Ren funktion, ingen databas. Mängden HÄRLEDS ur katalogen och skrivs aldrig —
 * en uppräkning blir fel första gången någon lägger till ett verktyg, och felet
 * är tyst åt det farliga hållet.
 *
 * ── FYRA VILLKOR, OCH DET FJÄRDE ÄR NYTT ────────────────────────────────────
 *
 * 1. `agentAllowlist === true`. Fältet svarar på exakt den här frågan: får en
 *    agent utföra detta utan bekräftelse per handling, givet en delegation?
 * 2. `authorityScope === 'EGEN_ORG'`. Rätten ges i hyresvärdens egna register.
 *    Allt som rör en hyresgäst eller en tredje part kräver ett ja per handling.
 * 3. Inga utåtriktade sänkor i vakt 7:s manifest. Planens Del 6, ordagrant:
 *    *"Aldrig delegerbart: allt klassat som utåtriktat."* Villkoret är
 *    redundant mot (2) i dag — varje verktyg med en sänka har en annan scope —
 *    och står ändå kvar, därför att de två svarar på olika frågor och kan glida
 *    isär: ett verktyg kan få en sänka utan att dess scope ändras.
 * 4. `supportsUndo.kind !== 'INGEN_EFFEKT'`. **Det här villkoret är nytt i
 *    etapp 7.** Ett verktyg utan effekt har ingenting att delegera: `export_sie4`
 *    bygger en buffert och returnerar den. Att ge bort rätten till det är inte
 *    farligt utan MENINGSLÖST — och en meningslös post i en rättighetslista är
 *    värre än ingen, eftersom den ser ut som ett beslut någon fattat.
 *
 * Villkor 4 är därför skrivet HÄR och inte som en ändring av `agentAllowlist`:
 * det fältet svarar på "får en agent göra detta obevakat", och svaret för
 * `export_sie4` är fortfarande ja. Att låna fältet till den nya frågan hade
 * varit precis den betydelseglidning CLAUDE.md varnar för.
 *
 * ── DÄRFÖR ÄR MÄNGDEN ÅTTA OCH INTE NIO ─────────────────────────────────────
 *
 * `agentAllowlist` är sann för nio verktyg. `export_sie4` faller på villkor 4.
 */
export type Delegerbarhet =
  | { delegerbar: true }
  | {
      delegerbar: false
      skäl: 'OKÄNT_VERKTYG' | 'EJ_ALLOWLISTAD' | 'FEL_SCOPE' | 'UTÅTRIKTAD' | 'INGEN_EFFEKT'
      text: string
    }

export function prövaDelegerbarhet(
  toolName: string,
  deklarationer: Record<string, EffectDeclaration> = EFFECT_DECLARATIONS,
  sänkorPerVerktyg: Record<string, unknown> = {},
): Delegerbarhet {
  const d = deklarationer[toolName]
  if (!d)
    return {
      delegerbar: false,
      skäl: 'OKÄNT_VERKTYG',
      text: `Verktyget ${toolName} har ingen effektklassificering och kan inte delegeras.`,
    }

  if (!d.agentAllowlist)
    return {
      delegerbar: false,
      skäl: 'EJ_ALLOWLISTAD',
      text:
        `Verktyget ${toolName} har agentAllowlist: false — en agent får inte utföra det ` +
        'utan bekräftelse per handling, och då finns ingenting att delegera.',
    }

  if (d.authorityScope !== 'EGEN_ORG')
    return {
      delegerbar: false,
      skäl: 'FEL_SCOPE',
      text:
        `Verktyget ${toolName} har authorityScope: ${d.authorityScope}. Rätten kan bara ` +
        'ges i hyresvärdens EGNA register — allt som rör en hyresgäst eller en tredje ' +
        'part kräver ett ja per handling.',
    }

  const sänkor = Object.keys(
    (sänkorPerVerktyg as Record<string, Record<string, unknown>>)[toolName] ?? {},
  )
  if (sänkor.length > 0)
    return {
      delegerbar: false,
      skäl: 'UTÅTRIKTAD',
      text:
        `Verktyget ${toolName} når ${sänkor.join(', ')}. Planens Del 6: aldrig delegerbart, ` +
        'allt klassat som utåtriktat.',
    }

  if (d.supportsUndo?.kind === 'INGEN_EFFEKT')
    return {
      delegerbar: false,
      skäl: 'INGEN_EFFEKT',
      text:
        `Verktyget ${toolName} har ingen effekt att delegera (supportsUndo: INGEN_EFFEKT). ` +
        'En rättighet till något som inte händer är en post som ser ut som ett beslut.',
    }

  return { delegerbar: true }
}

/** Hela mängden delegerbara verktyg — HÄRLEDD, aldrig skriven. */
export function delegerbaraVerktyg(
  deklarationer: Record<string, EffectDeclaration> = EFFECT_DECLARATIONS,
  sänkorPerVerktyg: Record<string, unknown> = {},
): string[] {
  return Object.keys(deklarationer)
    .filter((n) => prövaDelegerbarhet(n, deklarationer, sänkorPerVerktyg).delegerbar)
    .sort()
}

/**
 * Kräver verktyget ett FREKVENSVILLKOR i sin delegation?
 *
 * `DEDUPLICERBAR` men inte `IDEMPOTENT` betyder att en omkörning ger en ANDRA
 * rad: effekten är envägs, och en post KAN konsulteras före utförandet — men
 * "att den kan betyder inte att den gör det". En delegation utan tak hade då
 * gjort en obevakad loop till en obegränsad.
 *
 * `IDEMPOTENT` behöver inget tak: verktygets egen nyckel utesluter dubbletten.
 */
export function kräverFrekvensvillkor(
  toolName: string,
  deklarationer: Record<string, EffectDeclaration> = EFFECT_DECLARATIONS,
): boolean {
  return deklarationer[toolName]?.effectIdempotency === 'DEDUPLICERBAR'
}
