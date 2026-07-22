# @eken/ui

Evenos delade **designfundament** — den enda källan till sanning för palett, design­tokens och (kommande) delade UI-komponenter. Konsumeras av `web`, `admin`, `portal` och (för brandfärgen) `@eken/shared`.

> **Status: PR1 (fundament).** Ingen app är kopplad ännu. Att paketet finns ändrar inte hur en enda vy, PDF eller ett enda mejl ser ut. Inkoppling sker i PR2–7.

## Innehåll

| Fil                      | Roll                                                                                                                         |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `src/tokens.ts`          | **Källan.** TS-konstanter: `EVENO_BRAND`, `EVENO_PALETTE` (9 semantiska tokens), `EVENO_CSS_VAR_NAMES`, `renderTokensCss()`. |
| `src/css/tokens.css`     | **Genererad** ur `tokens.ts` (`:root { --ev-* }`). Redigera aldrig för hand.                                                 |
| `src/tailwind-preset.ts` | Tailwind-preset som mappar `var(--ev-*)` → `theme.extend.colors`. För web/admin.                                             |
| `src/css/fonts.css`      | `@font-face` för self-hostad Poppins (400/500/600/700, `latin` + `latin-ext`).                                               |
| `src/fonts/*.woff2`      | Poppins-binärer (SIL OFL 1.1). Inga CDN-anrop.                                                                               |

## Den låsta paletten

9 tokens (mål — tas i bruk vid färgflippen efter PR2–4):

```
--ev-brand           #1a6b3c
--ev-bg              #F6F4F0
--ev-surface         #FFFFFF
--ev-text            #241F1A
--ev-text-muted      #5A5248
--ev-border          #ECE7E0
--ev-status-success  #1a6b3c
--ev-status-warning  #B8791A
--ev-status-danger   #C6402F
```

## Regenerera tokens.css

`tokens.css` genereras ur `tokens.ts`. Efter ändring av `EVENO_PALETTE`:

```bash
pnpm --filter @eken/ui gen:tokens   # bygger + skriver om src/css/tokens.css
```

Committa den genererade filen.

## Konsumtion (senare PR:er — inte aktivt nu)

```ts
// web/admin — tailwind.config
import { evenoPreset } from '@eken/ui/tailwind-preset'
export default { presets: [evenoPreset] /* ... */ }
```

```ts
// valfri app — CSS-variabler + typsnitt
import '@eken/ui/tokens.css'
import '@eken/ui/fonts.css'
```

```ts
// @eken/shared/branding.ts — brandfärgen, en sanning
import { EVENO_BRAND } from '@eken/ui'
```

## Resolution

`exports` ger bundler-konsumenter (Vite: `web`/`admin`/`portal`) **TS-källan** direkt
(`import`-villkoret → `src/`), medan API:et via `@eken/shared` får den kompilerade
**CJS**-utdatan (`require`-villkoret → `dist/cjs/`). Därför bygger `apps/api/Dockerfile`
`@eken/ui` innan `@eken/shared`.
