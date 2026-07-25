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
  /** Fältkant (input/select/textarea). Default: den vanliga kanten. */
  '--ev-input-border': 'var(--ev-border)',
} as const satisfies Record<`--ev-${string}`, string>

// ─────────────────────────────────────────────────────────────────────────────
// HÄRLEDDA SKALOR (F1) — gråskala och statustinter
// ─────────────────────────────────────────────────────────────────────────────
//
// Problemet skalorna löser: apparna använder Tailwinds `gray-*`, `emerald-*`,
// `amber-*` och `red-*` i hundratals klasser. De är osynliga för färggrinden
// (ingen rå hex) men lika kalla som de hex-värden grinden fångar — tas de inte
// med byter flippen kanvas och kant till varmt medan gråskalan står kvar blå.
//
// Regeln från komponent-variablerna gäller skärpt här: skalorna får INTE
// innehålla en enda egen hex. Varje steg är antingen ett palettvärde rakt av
// eller en beräknad blandning mellan två palettvärden. Paletten förblir enda
// källan; ändras `EVENO_PALETTE` följer skalorna med.

/** sRGB-blandning mellan två hex-värden. `t` = 0 ger `from`, 1 ger `to`. Pure. */
export function mixHex(from: string, to: string, t: number): string {
  const parse = (hex: string): [number, number, number] => {
    const h = hex.replace('#', '')
    const full =
      h.length === 3
        ? h
            .split('')
            .map((c) => c + c)
            .join('')
        : h
    return [
      Number.parseInt(full.slice(0, 2), 16),
      Number.parseInt(full.slice(2, 4), 16),
      Number.parseInt(full.slice(4, 6), 16),
    ]
  }
  const [r1, g1, b1] = parse(from)
  const [r2, g2, b2] = parse(to)
  const ch = (a: number, b: number) =>
    Math.round(a + (b - a) * t)
      .toString(16)
      .padStart(2, '0')
  return `#${ch(r1, r2)}${ch(g1, g2)}${ch(b1, b2)}`
}

const P = EVENO_PALETTE

/**
 * Neutralskalan. Ankrad i paletten: 100 = bakgrunden, 200 = kanten,
 * 500 = dämpad text, 900 = primär text. Mellanstegen är blandningar. Skalan blir
 * varm av sig själv eftersom ändpunkterna är varma — ingen ton väljs för hand.
 */
export const EVENO_NEUTRAL_SCALE = {
  50: mixHex(P.surface, P.bg, 0.5),
  100: P.bg,
  200: P.border,
  300: mixHex(P.border, P.textMuted, 0.25),
  400: mixHex(P.border, P.textMuted, 0.55),
  500: P.textMuted,
  600: mixHex(P.textMuted, P.text, 0.35),
  700: mixHex(P.textMuted, P.text, 0.6),
  800: mixHex(P.textMuted, P.text, 0.8),
  900: P.text,
} as const

/** Hex → HSL. Behövs för tinterna: se `statusScale`. Pure. */
function hexToHsl(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16) / 255) as [
    number,
    number,
    number,
  ]
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  const d = max - min
  if (d === 0) return [0, 0, l]
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  const hue =
    (max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4) / 6
  return [hue * 360, s, l]
}

/** HSL → hex. Pure. */
function hslToHex(hDeg: number, s: number, l: number): string {
  const h = ((((hDeg % 360) + 360) % 360) / 360) as number
  const f = (p: number, q: number, t: number) => {
    let x = t
    if (x < 0) x += 1
    if (x > 1) x -= 1
    if (x < 1 / 6) return p + (q - p) * 6 * x
    if (x < 1 / 2) return q
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6
    return p
  }
  let r: number
  let g: number
  let b: number
  if (s === 0) {
    r = l
    g = l
    b = l
  } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s
    const p = 2 * l - q
    r = f(p, q, h + 1 / 3)
    g = f(p, q, h)
    b = f(p, q, h - 1 / 3)
  }
  const ch = (v: number) =>
    Math.round(v * 255)
      .toString(16)
      .padStart(2, '0')
  return `#${ch(r)}${ch(g)}${ch(b)}`
}

/**
 * Statusskala ur EN låst statusfärg.
 *
 * De LJUSA stegen (50–400) kan inte blandas fram i sRGB: att blanda in en mörk,
 * mättad färg i bakgrunden ger en grumlig, mörknad tint (#1a6b3c 10% i bakgrunden
 * blev #e0e6de — grå, inte grön). Stegen behåller därför statusfärgens NYANS,
 * sänker mättnaden lite och höjer ljusheten till en fast trappa; först därefter
 * blandas 12 % bakgrund in så tinten hamnar i samma varma familj som kanvasen.
 *
 * De MÖRKA stegen (600–900) blandas mot primärtexten — det är text på tint, och
 * den ska dras mot bläcket, inte mot svart.
 *
 * 500 = den låsta färgen själv, orörd.
 */
const LIGHT_STEPS: Record<number, [lightness: number, saturationFactor: number]> = {
  50: [0.955, 0.55],
  100: [0.915, 0.62],
  200: [0.845, 0.68],
  300: [0.75, 0.7],
  400: [0.615, 0.78],
}

const statusScale = (color: string) => {
  const [hue, sat] = hexToHsl(color)
  const tint = (step: number) => {
    const [lightness, satFactor] = LIGHT_STEPS[step] as [number, number]
    return mixHex(hslToHex(hue, sat * satFactor, lightness), P.bg, 0.12)
  }
  return {
    50: tint(50),
    100: tint(100),
    200: tint(200),
    300: tint(300),
    400: tint(400),
    500: color,
    600: mixHex(color, P.text, 0.25),
    700: mixHex(color, P.text, 0.45),
    800: mixHex(color, P.text, 0.65),
    900: mixHex(color, P.text, 0.8),
  } as const
}

export const EVENO_STATUS_SCALES = {
  success: statusScale(P.statusSuccess),
  warning: statusScale(P.statusWarning),
  danger: statusScale(P.statusDanger),
} as const

/** Alla härledda skalor → CSS-variabelnamn. `--ev-neutral-500`, `--ev-success-50`, … */
export const EVENO_SCALES = {
  neutral: EVENO_NEUTRAL_SCALE,
  success: EVENO_STATUS_SCALES.success,
  warning: EVENO_STATUS_SCALES.warning,
  danger: EVENO_STATUS_SCALES.danger,
} as const

export type EvenoScaleName = keyof typeof EVENO_SCALES
export type EvenoScaleStep = keyof typeof EVENO_NEUTRAL_SCALE

/** `--ev-neutral-500` osv. Delas av tokens.css (värden) och preseten (var-referenser). */
export const scaleVarName = (scale: EvenoScaleName, step: number | string) =>
  `--ev-${scale}-${step}`

/**
 * Kanalformen: `--ev-neutral-500-ch: 90 82 72`. Finns för Tailwinds alfa-
 * modifierare — `bg-gray-50/60` måste kunna bli `rgb(<kanaler> / 0.6)`. En hex
 * bakom `var()` går inte att dela upp, och `color-mix()` ger en ±1-avvikelse mot
 * dagens rgba()-kompositering (mätt, subperceptuell men inte noll). Kanalformen
 * ger BYTE-identisk rendering, vilket är vad ett neutralt steg ska ge.
 *
 * Hex-formen finns kvar parallellt: portalen kör CSS Modules och läser
 * variablerna rakt av (`color: var(--ev-neutral-500)`), där är kanaler oanvändbara.
 */
export const scaleChannelVarName = (scale: EvenoScaleName, step: number | string) =>
  `--ev-${scale}-${step}-ch`

/** '#5a5248' → '90 82 72'. Pure. */
export function hexToChannels(hex: string): string {
  const h = hex.replace('#', '')
  return [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16)).join(' ')
}

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
  const scaleBlocks = (Object.keys(EVENO_SCALES) as EvenoScaleName[]).flatMap((scale) => [
    '',
    `  /* ${scale} — härledd skala, se EVENO_SCALES i tokens.ts */`,
    ...Object.entries(EVENO_SCALES[scale]).flatMap(([step, value]) => [
      `  ${scaleVarName(scale, step)}: ${value.toLowerCase()};`,
      `  ${scaleChannelVarName(scale, step)}: ${hexToChannels(value)};`,
    ]),
  ])
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
    ...scaleBlocks,
    '}',
    '',
  ].join('\n')
}
