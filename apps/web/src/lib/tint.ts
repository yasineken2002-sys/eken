/**
 * Genomskinlig tint av en godtycklig färg — utan strängkonkatenering.
 *
 * BAKGRUND (PR3-regressionen, löst i F2): mönstret `${color}14` la på alfa genom
 * att klistra två hex-siffror sist i strängen. Det fungerar bara om `color` är
 * exakt sex hexsiffror — så fort värdet blev en token (`var(--ev-brand)14`) blev
 * det ogiltig CSS och tinten föll bort helt. Färgen kunde alltså inte tokeniseras
 * så länge tinten räknades ut med strängar.
 *
 * `tint()` tar i stället alfan som ett tal och låter CSS göra blandningen:
 * - hex in → `rgba()` med samma alfa som förut, bit för bit identiskt med
 *   `${hex}14` (0x14/255 = 0.0784…). Det gör bytet färgneutralt.
 * - allt annat (`var(--ev-brand)`, `rgb(...)`, färgnamn) → `color-mix()`, som kan
 *   blanda värden webbläsaren först löser upp vid renderingen.
 *
 * Därmed kan anropen peka på tokens utan att tinten går sönder.
 */
export function tint(color: string, alpha: number): string {
  const hex = color.trim()
  const match = /^#([0-9a-f]{6})$/i.exec(hex)
  if (match) {
    const value = match[1] as string
    const r = Number.parseInt(value.slice(0, 2), 16)
    const g = Number.parseInt(value.slice(2, 4), 16)
    const b = Number.parseInt(value.slice(4, 6), 16)
    // Ingen färg här: kanalerna kommer från anroparens värde, och tokeniseringen
    // sker hos anroparen — som numera KAN skicka var(--ev-*) tack vare funktionen.
    // design-tokens-allow: rgba-konstruktör, inte ett färgvärde
    return `rgba(${r}, ${g}, ${b}, ${alpha})`
  }
  return `color-mix(in srgb, ${color} ${alpha * 100}%, transparent)`
}

/** Alfanivåerna som fanns som hex-suffix före F2. Behålls exakta. */
export const TINT = {
  /** `${color}08` */
  faint: 0x08 / 255,
  /** `${color}14` */
  soft: 0x14 / 255,
  /** `${color}18` */
  medium: 0x18 / 255,
} as const
