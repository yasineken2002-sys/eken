import type { ValidationPipeOptions } from '@nestjs/common'

/**
 * PRODUKTIONENS PIPE-KONFIGURATION — EN KÄLLA.
 *
 * ── VARFÖR DEN FLYTTADES HIT ────────────────────────────────────────────────
 *
 * `dto-contract.spec.ts` byggde sin egen pipe för att pröva DTO-halvan av varje
 * kontrakt. Den skrev fyra av `main.ts` fem inställningar och utelämnade den
 * femte — `transformOptions: { enableImplicitConversion: true }`. Paritetsprovet
 * mätte alltså en pipe som inte finns någonstans, och skillnaden var inte
 * teoretisk:
 *
 *     confirmed="false"   provets pipe  AVVISADE      ← grönt
 *                         main.ts:s     SLÄPPTE → true
 *
 * class-transformer läser TS-typen `boolean` och kör `Boolean(värdet)` INNAN
 * `@IsBoolean()` ser något; `Boolean('false')` är `true`. Provet kunde per
 * konstruktion inte se det, och rapporterade ändå "samma kropp genom båda,
 * samma svar".
 *
 * Två uppräkningar som ska vara lika är inte en uppräkning. Nu är det en, och
 * `dto-contract.spec.ts` har en kanariefågel som kräver att objektet faktiskt
 * bär `enableImplicitConversion` — annars kan raden tyst tappas igen.
 *
 * ── VAD DEN INTE LÖSER ──────────────────────────────────────────────────────
 *
 * Att koercionen FINNS. `enableImplicitConversion` behövs för query- och
 * parameterbindning, där allt anländer som sträng, och att slå av den globalt
 * hade brutit den bindningen överallt. Skyddet ligger därför på det enskilda
 * fältet:
 *
 *     BOOLEANER   `@StrictBoolean()` — godtar true/false och "true"/"false",
 *                 avvisar allt annat med 400. Se
 *                 `strict-boolean.decorator.ts`; `check-strict-boolean.mjs`
 *                 kräver den på VARJE booleskt DTO-fält, utan baslinje.
 *     STRÄNGAR    `@IngenKoercion()` — läser råvärdet, så `42` inte blir "42".
 *                 Se `no-coercion.decorator.ts`.
 *
 * Raden pekade fram till 2026-09-07 på `@Transform(({ value }) => value)` som
 * skyddet. Den formen fungerar INTE — `value` är redan konverterat när
 * transformen körs — och båda dekoratorerna ovan läser därför `obj[key]`.
 *
 * Den här filen ser bara till att provet mäter samma pipe som kunderna träffar.
 */
export const VALIDATION_PIPE_OPTIONS: ValidationPipeOptions = {
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  transformOptions: { enableImplicitConversion: true },
}
