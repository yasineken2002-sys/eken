import type { ZodType } from 'zod'

/**
 * SISTA GRINDEN FÖRE SKICK — nyttolasten prövas mot det DELADE schemat.
 *
 * ── VARFÖR INTE zodResolver ─────────────────────────────────────────────────
 *
 * `zodResolver` är react-hook-forms koppling, och **ingen** av bokföringens tre
 * modaler använder react-hook-form — de är handrullade `useState`-formulär med
 * egen konteringsförhandsvisning. Att skriva om dem till RHF är en egen
 * refaktorering, och den hade dessutom inte gått att pröva här: webbens vitest
 * kör med `environment: 'node'` och renderar ingenting.
 *
 * Grinden nedan ger samma RUNTIME-egenskap som en resolver: det som skickas har
 * prövats mot samma schema som API:ts DTO deklarerar `implements` mot. Skärps
 * schemat blockeras formuläret av sig självt.
 *
 * ── VAD DEN INTE ERSÄTTER ───────────────────────────────────────────────────
 *
 * Fältvisa felmeddelanden medan man skriver. Den ordningen ägs fortfarande av
 * respektive formulärs egen `…Fel()`-funktion, som körs FÖRE den här och som
 * säger vilket fält man ska tillbaka till. Grinden är ett sista nej, inte
 * vägledningen — och den ska normalt aldrig tala, eftersom formulärets egna
 * regler är strängare. Talar den ändå har de två glidit isär, och DÅ är det
 * schemat som gäller.
 */
export function kontraktsfel<T>(schema: ZodType<T>, nyttolast: unknown): string | null {
  const utfall = schema.safeParse(nyttolast)
  if (utfall.success) return null
  const forsta = utfall.error.issues[0]
  if (!forsta) return 'Nyttolasten stämmer inte med API:ts kontrakt.'
  const falt = forsta.path.join('.')
  return falt ? `${falt}: ${forsta.message}` : forsta.message
}
