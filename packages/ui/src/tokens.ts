// ─────────────────────────────────────────────────────────────────────────────
// EVENO DESIGN TOKENS — enda källan till sanning för paletten (PR1, fundament)
// ─────────────────────────────────────────────────────────────────────────────
//
// Detta är KÄLLAN. `src/css/tokens.css` GENERERAS ur värdena nedan
// (`renderTokensCss()` → `pnpm --filter @eken/ui gen:tokens`) och Tailwind-preseten
// (`tailwind-preset.ts`) mappar samma CSS-variabler in i web/admins theme.
// `@eken/shared/branding.ts` importerar `EVENO_BRAND` härifrån, så att PDF/mejl
// och UI aldrig kan glida isär.
//
// VIKTIGT (PR1): ingen app är kopplad än. Att paketet finns ändrar inte hur en
// enda vy, PDF eller ett enda mejl ser ut. Den låsta paletten nedan är MÅLET som
// tas i bruk först vid färgflippen (efter PR2–4:s neutrala token-mappning).

/**
 * EN sanning för Evenos varumärkesgrönt (primär). `@eken/shared/branding.ts`
 * re-exporterar detta som `DEFAULT_BRAND_COLOR`. Ändra brandfärg här — ingen
 * annanstans.
 *
 * OBS: medvetet INTE `as const`. En vanlig const-literal är en *widening* literal
 * som TS breddar till `string` vid t.ex. `useState(DEFAULT_BRAND_COLOR)` — exakt
 * som den gamla `= '#1a6b3c'`. `as const` skulle ge en icke-breddande `"#1a6b3c"`
 * och bryta befintliga useState-initieringar (SettingsPage). Drop-in-identiskt.
 */
export const EVENO_BRAND = '#1a6b3c'

/**
 * Den låsta målpaletten. 9 semantiska tokens. Definieras nu men konsumeras först
 * vid färgflippen — PR2–4 mappar apparnas NUVARANDE värden mot token-namnen
 * (neutralt), och flippen pekar sedan namnen på värdena nedan.
 */
export const EVENO_PALETTE = {
  brand: EVENO_BRAND,
  bg: '#F6F4F0',
  surface: '#FFFFFF',
  text: '#241F1A',
  textMuted: '#5A5248',
  border: '#ECE7E0',
  statusSuccess: '#1a6b3c',
  statusWarning: '#B8791A',
  statusDanger: '#C6402F',
} as const

export type EvenoTokenKey = keyof typeof EVENO_PALETTE

/**
 * KOMPONENT-VARIABLER (PR6) — ligger MEDVETET utanför den låsta 9-token-paletten.
 *
 * Vissa delade komponenter behöver en yta som inte har någon egen semantisk plats
 * i paletten (t.ex. tabellradens hover-tint). Regeln, låst i ADR:n: en
 * komponent-variabel måste ha ett DEFAULTVÄRDE som härleds ur paletten — aldrig
 * en egen hex. Då fortsätter paletten vara enda källan till färg, och flippen
 * (= appen tar bort sitt neutrala override-block) ger komponenten ett korrekt
 * värde utan att någon rör komponentkoden.
 *
 * Apparna pinnar dem till sina NUVARANDE värden i sitt neutrala :root-block
 * (PR2–4-mekaniken) precis som palett-tokens.
 */
export const EVENO_COMPONENT_TOKENS = {
  /** Tabellradens hover-tint. Default: sidbakgrunden (klassisk "rad tonas mot ytan"). */
  '--ev-row-hover': 'var(--ev-bg)',
  /** Avdelare mellan tabellrader. Default: den vanliga kanten. */
  '--ev-row-border': 'var(--ev-border)',
} as const satisfies Record<`--ev-${string}`, string>

/**
 * Låst schema: token-nyckel → CSS custom property-namn. Detta är kontraktet som
 * `tokens.css` (genererad) och `tailwind-preset.ts` (var-referenser) delar.
 */
export const EVENO_CSS_VAR_NAMES = {
  brand: '--ev-brand',
  bg: '--ev-bg',
  surface: '--ev-surface',
  text: '--ev-text',
  textMuted: '--ev-text-muted',
  border: '--ev-border',
  statusSuccess: '--ev-status-success',
  statusWarning: '--ev-status-warning',
  statusDanger: '--ev-status-danger',
} as const satisfies Record<EvenoTokenKey, `--ev-${string}`>

/**
 * Renderar innehållet i `src/css/tokens.css` ur konstanterna ovan. `tokens.css`
 * är en GENERERAD fil — redigera den aldrig för hand; ändra värden i `EVENO_PALETTE`
 * och kör `pnpm --filter @eken/ui gen:tokens`. Pure (ingen I/O).
 */
export function renderTokensCss(): string {
  const keys = Object.keys(EVENO_PALETTE) as EvenoTokenKey[]
  // Gemener på hex — CSS-hex är skiftlägesokänsligt och Prettier normaliserar till
  // gemener. Att emittera gemener redan här gör den genererade filen Prettier-stabil
  // (ingen drift mellan `gen:tokens` och det committade resultatet). TS-konstanterna
  // behåller sitt kanoniska skiftläge.
  const decls = keys.map((k) => `  ${EVENO_CSS_VAR_NAMES[k]}: ${EVENO_PALETTE[k].toLowerCase()};`)
  const componentDecls = (
    Object.keys(EVENO_COMPONENT_TOKENS) as Array<keyof typeof EVENO_COMPONENT_TOKENS>
  ).map((name) => `  ${name}: ${EVENO_COMPONENT_TOKENS[name]};`)
  return [
    '/* GENERERAD FIL — redigera inte för hand.',
    ' * Källa: packages/ui/src/tokens.ts (EVENO_PALETTE → renderTokensCss()).',
    ' * Regenerera: pnpm --filter @eken/ui gen:tokens',
    ' */',
    ':root {',
    ...decls,
    '',
    '  /* Komponent-variabler — härledda ur paletten ovan, aldrig egen hex. */',
    ...componentDecls,
    '}',
    '',
  ].join('\n')
}
