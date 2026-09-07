import { Transform } from 'class-transformer'

/**
 * SPÄRR MOT TYST TYPKONVERTERING I EN KROPP.
 *
 * ── PROBLEMET ───────────────────────────────────────────────────────────────
 *
 * Den globala pipen kör `transform: true` med `enableImplicitConversion: true`
 * (`VALIDATION_PIPE_OPTIONS`). class-transformer läser då fältets TS-typ och
 * konverterar värdet INNAN validatorn ser det. Validatorn prövar alltså
 * resultatet av konverteringen, aldrig det klienten skickade:
 *
 *     TS-typ boolean, värde "false"  →  Boolean("false") === true   → @IsBoolean OK
 *     TS-typ boolean, värde "0"      →  true                        → @IsBoolean OK
 *     TS-typ string,  värde 42       →  "42"                        → @IsString  OK
 *
 * Zod-schemat på andra sidan avvisar samtliga. Det är alltså inte en smaksak
 * utan en DIVERGENS: kontraktet säger en sak, servern gör en annan.
 *
 * Skarpast för `confirmed` i `TenantConfirmDto` — hyresgästens uttryckliga ja
 * till att en AI-föreslagen handling ska utföras. Strängen `"false"` betydde JA.
 *
 * ── VARFÖR INTE SLÅ AV KONVERTERINGEN GLOBALT ───────────────────────────────
 *
 * `enableImplicitConversion` behövs för query- och parameterbindning, där ALLT
 * anländer som sträng och `?sida=2` ska bli talet 2. Att slå av den globalt hade
 * brutit varje sådan bindning. Spärren hör därför hemma på det enskilda
 * kroppsfältet, där ingen konvertering är önskad.
 *
 * ── ATT DEN SITTER KVAR BEVISAS, INTE ANTAS ─────────────────────────────────
 *
 * `dto-contract.spec.ts` härleder ur KONTRAKTSREGISTER varje fält vars giltiga
 * värde är en boolean eller en sträng, och kräver att fel typ avvisas av BÅDA
 * halvorna. Tas dekoratorn bort blir provet rött. Det var blint fram till nu av
 * en annan orsak: det byggde sin egen pipe utan `transformOptions`, och mätte
 * alltså en konfiguration som inte finns någonstans.
 */
export const IngenKoercion = (): PropertyDecorator =>
  Transform(({ obj, key }) => (obj as Record<string, unknown>)[key])
