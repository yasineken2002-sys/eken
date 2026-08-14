/**
 * FÅR AUTH-STRYPNINGEN MJUKAS UPP? — och varför frågan är känsligare än den låter.
 *
 * `POST /auth/register`, `/auth/login` och `/auth/accept-invite` är strypta till
 * 5 anrop per 60 s respektive 5 per 10 min. Det är inte ett testhinder utan
 * BRUTE FORCE-SKYDDET på inloggning och kontoaktivering. Samma mekanism körs i
 * produktion.
 *
 * E2E-sviten behöver ändå gå runt det: åtta specar gör tillsammans ~18
 * auth-anrop, och körda i följd slår de i taket. Ett 429 mitt i ett E2E ser ut
 * som ett testfel utan att vara det — vilket gör sviten obrukbar i CI.
 *
 * ── Varför INTE en fri miljövariabel ─────────────────────────────────────────
 *
 * Den uppenbara lösningen — `THROTTLE_AUTH_LIMIT` som CI sätter högt — skapar en
 * väg att stänga av brute force-skyddet med en felaktig variabel, och prod läser
 * samma mekanism. Det är den farligaste formen av dagens återkommande mönster:
 * en kontroll som kan vara AVSTÄNGD utan att någonting blir rött.
 *
 * Uppmjukningen är därför bunden till KÖRNINGSLÄGET, inte till ett värde:
 *
 *   1. Flaggan saknas, är tom eller har ett okänt värde  → STRIKT. Alltid.
 *      Det finns inget värde som "råkar" mjuka upp den; bara exakt 'true'.
 *   2. Flaggan är 'true' OCH NODE_ENV=production          → KASTAR.
 *      Inte "olämpligt" — omöjligt. Appen vägrar starta.
 *
 * Punkt 2 kontrolleras vid boot av `validateEnv` OCH i guardens konstruktor, så
 * en felkonfigurerad produktionsmiljö kraschar innan den tar emot en request —
 * aldrig efter. Samma fail-fast-mönster som `signing.module.ts` använder när
 * SIGNING_ENABLED=true men nycklarna saknas.
 *
 * Frågan "vad händer om någon sätter testkonfigurationen i prod?" har alltså
 * exakt ett svar: ingenting — den vägrar starta.
 */

export const E2E_AUTH_THROTTLE_FLAG = 'E2E_RELAX_AUTH_THROTTLE'

export class ProductionThrottleRelaxationError extends Error {
  constructor() {
    super(
      `[throttler] ${E2E_AUTH_THROTTLE_FLAG}=true är satt samtidigt som NODE_ENV=production. ` +
        'Uppmjukad auth-strypning är brute force-skyddet avstängt och får aldrig gälla i ' +
        'produktion — fail-fast. Ta bort variabeln, eller kör inte med NODE_ENV=production.',
    )
  }
}

/**
 * Ren funktion, tar env explicit så den går att testa utan att röra process.env.
 *
 * @throws ProductionThrottleRelaxationError om uppmjukningen begärs i produktion.
 */
export function authThrottleRelaxed(env: NodeJS.ProcessEnv = process.env): boolean {
  // Steg 1: allt utom exakt 'true' är strikt. Saknad, tom, 'TRUE', '1', 'yes' —
  // alla ger strikt. En slarvig konfiguration ska falla åt det säkra hållet.
  if (env[E2E_AUTH_THROTTLE_FLAG] !== 'true') return false

  // Steg 2: begärd uppmjukning i produktion är ett konfigurationsfel, inte ett
  // val. Kasta — anroparen (validateEnv / guardens konstruktor) fail-fastar.
  if (env['NODE_ENV'] === 'production') throw new ProductionThrottleRelaxationError()

  return true
}
