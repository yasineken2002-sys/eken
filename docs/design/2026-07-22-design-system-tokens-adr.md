# Designsystem: gemensamt `packages/ui` med låst palett

**Datum:** 2026-07-22
**Status:** Beslutad — PR0 (städ & beslut) + PR1 (fundament) byggda. PR2–7 planerade, ej byggda.
**Kontext:** Kartläggning 2026-07-22 (web/admin/portal). Se även minnesnoten `project-design-system-unify`.

---

## Beslut

Web, admin och portal ska ena sig mot ETT delat designfundament, `@eken/ui`, med en
**låst palett** och **Poppins** som typsnitt. Detta dokument låser strukturen och
tokenschemat så att PR1–7 kan byggas mot ett stabilt kontrakt.

### Varför ett nytt paket (inte `@eken/shared`)

`@eken/shared` är typer/schemas/utils/konstanter och ska förbli fritt från CSS/React.
Designtokens, Tailwind-preset, typsnitt och (senare) delade komponenter bor i `@eken/ui`.

### Två stylingsystem — CSS-variabler som gemensamt substrat

Nuläget har **två** system: web+admin kör Tailwind, portalen kör CSS Modules (ingen
Tailwind). Därför byggs `@eken/ui` på **CSS-variabler** (`:root { --ev-* }`) som båda
systemen kan läsa, plus en **Tailwind-preset** som mappar samma variabler in i
web/admins `theme.colors`. Portalen läser variablerna direkt.

## Låst tokenschema (9 semantiska tokens)

| CSS-variabel          | Roll             | Låst målvärde |
| --------------------- | ---------------- | ------------- |
| `--ev-brand`          | Varumärkesprimär | `#1a6b3c`     |
| `--ev-bg`             | Sidbakgrund      | `#F6F4F0`     |
| `--ev-surface`        | Kort/panel       | `#FFFFFF`     |
| `--ev-text`           | Text primär      | `#241F1A`     |
| `--ev-text-muted`     | Text sekundär    | `#5A5248`     |
| `--ev-border`         | Kant/avdelare    | `#ECE7E0`     |
| `--ev-status-success` | Status: lyckat   | `#1a6b3c`     |
| `--ev-status-warning` | Status: varning  | `#B8791A`     |
| `--ev-status-danger`  | Status: fara     | `#C6402F`     |

**Källa till sanning:** `packages/ui/src/tokens.ts` (`EVENO_PALETTE`). `tokens.css`
GENERERAS ur den (`renderTokensCss()` → `pnpm --filter @eken/ui gen:tokens`).

## Låst paketstruktur

```
packages/ui/
├── package.json            # exports: '.' (TS-källa för bundler / CJS för API), './tailwind-preset', './tokens.css', './fonts.css'
├── tsconfig.json           # typecheck (Bundler)
├── tsconfig.cjs.json       # build → dist/cjs (mirrar @eken/shared)
├── scripts/generate-css.mjs
└── src/
    ├── index.ts            # export * tokens + evenoPreset
    ├── tokens.ts           # KÄLLAN: EVENO_BRAND, EVENO_PALETTE, EVENO_CSS_VAR_NAMES, renderTokensCss()
    ├── tailwind-preset.ts  # var(--ev-*) → theme.extend.colors
    ├── css/tokens.css       # GENERERAD
    ├── css/fonts.css        # @font-face Poppins (self-hostad)
    └── fonts/*.woff2        # Poppins 400/500/600/700 (latin + latin-ext), SIL OFL
```

## Reconcile mot `branding.ts`

`packages/shared/src/constants/branding.ts` hade redan `DEFAULT_BRAND_COLOR = '#1a6b3c'`
— **samma värde** som `--ev-brand`. I PR1 blir `@eken/ui` källan: `branding.ts` importerar
`EVENO_BRAND`, så UI-palett och PDF/mejl-varumärke delar en enda konstant. `EVENO_BRAND`
är medvetet en _widening_ literal (ej `as const`) → drop-in-identisk typ med den gamla
konstanten (bryter inte `useState`-initieringar).

## Migreringsordning (PR2–7, ej byggda)

Reskin skjuts upp: **PR2–4 är NEUTRAL token-mappning** (apparnas nuvarande värden binds
till token-namnen, noll visuell ändring). Färgflippen till paletten ovan och Inter→Poppins
är EGNA steg efter PR2–4.

| PR  | Innehåll                                                      |
| --- | ------------------------------------------------------------- |
| PR2 | admin adopterar tokens (minst app först)                      |
| PR3 | web adopterar tokens (störst)                                 |
| PR4 | portal adopterar tokens (CSS Modules)                         |
| PR5 | delad tillgänglig `<Modal>` (WCAG: role/aria/focus-trap)      |
| PR6 | delad `<DataTable>` med keyboard-a11y                         |
| PR7 | lint/stylelint-grind mot rå hex + `-[#..]` utanför `@eken/ui` |
| —   | Färgflipp + Inter→Poppins (efter PR2–4)                       |

## Städning i denna omgång

- `base.css` i repo-roten (0 byte, refererad ingenstans) borttagen (PR0).
