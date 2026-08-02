import {
  ACTION_TOOLS,
  ACCOUNTING_ONLY_ACTIONS,
  MANAGEMENT_ONLY_ACTIONS,
  MANAGER_ALLOWED_ACTIONS,
} from '../../ai/tools/ai-tools.definition'

/**
 * VEM FÅR ANVÄNDA ETT AI-HANDLINGSVERKTYG? (R4.0)
 *
 * ── Varför grinden vändes ────────────────────────────────────────────────────
 *
 * Den var DENY-BY-EXCEPTION: VIEWER nekades, MANAGER krävde whitelist, och två
 * neka-listor täckte bokföring respektive förvaltning. En roll som inte var
 * någon av de fem föll igenom allt och landade i "tillåtet".
 *
 * Det upptäcktes i R4-kartläggningen, innan någon femte roll fanns: en tilltänkt
 * REVISOR hade fått 14 av 30 handlingsverktyg direkt — create_invoice,
 * mark_invoice_paid, match_bank_transaction, import_bgmax_file,
 * apply_rent_increase, send_invoice_email. Alltså kunnat skapa fakturor, markera
 * dem betalda och stämma av banken, utan att någon skrivit en rad.
 *
 * De tre lagren hade olika standard för en okänd roll:
 *
 *   HTTP `@Roles`      allow-list sedan R2 → nekar
 *   frontend useCanWrite  allow-list       → read-only
 *   AI-grinden            deny-by-exception → TILLÄT
 *
 * Det är driften. En ny roll ska inte kunna få behörigheter för att ingen kom
 * ihåg att neka den.
 *
 * ── Formen: switch med `default: neka` ───────────────────────────────────────
 *
 * Botten är strukturell, inte en extra kontroll någon kan råka lägga sig före.
 * Varje roll som ska kunna göra något måste stå utskriven här — och en roll som
 * tillkommer i Prisma-enumet utan att nämnas nekas allt tills någon tar
 * ställning. Fail-closed som egenskap hos formen, inte som en rad i den.
 *
 * ── Vad som INTE ändrades ────────────────────────────────────────────────────
 *
 * Besluten för de fem kända rollerna är oförändrade, inklusive VILKET
 * felmeddelande varje nekande ger — behörighetsytans sond klassificerar på
 * meddelandet, och en ny formulering hade sett ut som ett nytt nekande.
 * Ekvivalensen bevisas uttömmande i `ai-tool-authz.spec.ts`: alla verktyg × alla
 * fem roller genom både den gamla och den nya implementationen.
 */

/** Nekandenas ordagranna formuleringar. Ändras de måste sonden veta om det. */
export const AI_TOOL_DENIAL_MESSAGES = {
  viewer: 'Du har inte behörighet att utföra åtgärder.',
  manager: 'Du har inte behörighet för denna åtgärd.',
  accounting: 'Endast bokförare (ACCOUNTANT) eller administratörer får använda bokförings-verktyg.',
  management: 'Endast förvaltare (MANAGER) eller administratörer får använda förvaltnings-verktyg.',
  signing: 'Endast OWNER/ADMIN får förbereda en signering (bindande handling).',
  /** Ny i R4.0 — det som tidigare var ett tyst insläpp. */
  okändRoll: 'Din roll har ingen behörighet att utföra åtgärder via assistenten.',
} as const

export type AiToolDecision = { allowed: true } | { allowed: false; reason: string }

/**
 * Får `userRole` använda `toolName`?
 *
 * Bara HANDLINGSVERKTYG grindas. Läsande verktyg är inte rollgrindade — samma
 * princip som R1 drog för HTTP-lagret (läsa = förvaltning får se, agera bindande
 * = ekonomi), och den gränsen ändras inte här.
 */
export function decideAiToolAccess(toolName: string, userRole: string): AiToolDecision {
  if (!ACTION_TOOLS.has(toolName)) return { allowed: true }

  switch (userRole) {
    // Kontoägaren och administratören har hela handlingsytan. Att skriva ut dem
    // som egna grenar i stället för att låta dem falla igenom är hela poängen:
    // "allt" ska vara ett beslut, inte en konsekvens av att inget nekade.
    case 'OWNER':
    case 'ADMIN':
      return { allowed: true }

    case 'MANAGER': {
      // Förvaltaren har en uttrycklig whitelist. Den bär numera även de nio
      // förvaltningshandlingarna (#269).
      if (!MANAGER_ALLOWED_ACTIONS.has(toolName)) {
        return { allowed: false, reason: AI_TOOL_DENIAL_MESSAGES.manager }
      }
      // Nedanstående två är i dag onåbara — inget bokföringsverktyg och inte
      // prepare_contract_signing står i whitelisten. De står kvar ändå: utan
      // dem skulle ett framtida tillägg i whitelisten tyst ge förvaltaren en
      // bindande ekonomihandling, och whitelisten är lättare att ändra än den
      // här filen är att läsa.
      //
      // Att de FAKTISKT fångar den regressionen är bevisat, inte antaget:
      // ai-tool-authz.spec.ts lägger tillfälligt in verktyget i whitelisten och
      // visar att MANAGER nekas ändå, av rätt skäl. Ett skydd som bara motiveras
      // i en kommentar är ett skydd ingen vet om det håller.
      if (ACCOUNTING_ONLY_ACTIONS.has(toolName)) {
        return { allowed: false, reason: AI_TOOL_DENIAL_MESSAGES.accounting }
      }
      if (toolName === 'prepare_contract_signing') {
        return { allowed: false, reason: AI_TOOL_DENIAL_MESSAGES.signing }
      }
      return { allowed: true }
    }

    case 'ACCOUNTANT': {
      // Bokföraren når hela ytan UTOM förvaltningshandlingarna och signeringen.
      // Att den grenen är formulerad som undantag och inte som en uppräkning är
      // ett bevarat beslut, inte en glömska: den listan hade behövt underhållas
      // vid varje nytt verktyg, och en ruttnad lista är värre än en regel.
      if (MANAGEMENT_ONLY_ACTIONS.has(toolName)) {
        return { allowed: false, reason: AI_TOOL_DENIAL_MESSAGES.management }
      }
      if (toolName === 'prepare_contract_signing') {
        return { allowed: false, reason: AI_TOOL_DENIAL_MESSAGES.signing }
      }
      return { allowed: true }
    }

    case 'VIEWER':
      return { allowed: false, reason: AI_TOOL_DENIAL_MESSAGES.viewer }

    default:
      // Okänd roll. Det här är R4.0:s hela existensberättigande.
      return { allowed: false, reason: AI_TOOL_DENIAL_MESSAGES.okändRoll }
  }
}
