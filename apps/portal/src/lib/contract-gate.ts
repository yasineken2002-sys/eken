import type { ZodType } from 'zod'

/**
 * SISTA GRINDEN FÖRE SKICK — nyttolasten prövas mot det DELADE schemat.
 *
 * Syskon till `apps/web/src/lib/contract-gate.ts`, och avsiktligt en KOPIA av
 * fyra rader kod i stället för ett delat paket: den enda gemensamma nämnaren
 * hade varit en `zod`-import, och att skapa ett paket för det hade kostat mer än
 * det band. Det som MÅSTE vara delat — schemana — är delat.
 *
 * ── VARFÖR PORTALEN BEHÖVER DEN ─────────────────────────────────────────────
 *
 * Portalens formulär är `useState`-formulär utan react-hook-form, så det finns
 * ingen resolver att fästa schemat i. Grinden ger samma RUNTIME-egenskap:
 * det som skickas har prövats mot samma schema som API:ts DTO deklarerar
 * `implements` mot. Skärps schemat blockeras anropet av sig självt.
 *
 * ── VAD DEN INTE ERSÄTTER ───────────────────────────────────────────────────
 *
 * Fältvisa felmeddelanden medan man skriver. Den ordningen ägs av respektive
 * formulärs egna kontroller, som körs FÖRE den här. Grinden är ett sista nej,
 * inte vägledningen — och den ska normalt aldrig tala. Talar den ändå har de två
 * beskrivningarna glidit isär, och DÅ är det schemat som gäller.
 */
export function kontraktsfel<T>(schema: ZodType<T>, nyttolast: unknown): string | null {
  const utfall = schema.safeParse(nyttolast)
  if (utfall.success) return null
  const forsta = utfall.error.issues[0]
  if (!forsta) return 'Nyttolasten stämmer inte med API:ts kontrakt.'
  const falt = forsta.path.join('.')
  return falt ? `${falt}: ${forsta.message}` : forsta.message
}
