// ─────────────────────────────────────────────────────────────────────────────
// Tailwind-preset — mappar Evenos CSS-variabler in i theme.colors (PR1)
// ─────────────────────────────────────────────────────────────────────────────
//
// Konsumeras av web/admin: `presets: [evenoPreset]` i respektive tailwind.config.
// (portalen kör inte Tailwind — den läser CSS-variablerna direkt ur tokens.css.)
//
// Färgnycklarna nedan är Tailwind-utility-namn (→ `bg-brand`, `text-ink`,
// `text-ink-muted`, `border-line`, `bg-canvas`, `bg-success` osv). Värdena pekar
// på `var(--ev-*)` så att hela paletten byts på ETT ställe (tokens.css) utan att
// någon utility-klass behöver röras.
//
// PR1: ingen app extendar denna preset ännu. Inkoppling sker i PR2–4.
//
// OBS: värdena är hex-strängar bakom `var()`, så Tailwinds alfa-modifierare
// (t.ex. `bg-brand/50`) fungerar INTE ännu. Kanal-baserade variabler kan införas
// i en senare PR om opacitetsvarianter behövs.

/**
 * Minimal preset-form. Vi undviker medvetet ett `import type { Config }` från
 * `tailwindcss` här — detta leaf-paket ska inte dra in Tailwind som beroende.
 * Konsumentens egen config har den fulla typen.
 */
export interface EvenoTailwindPreset {
  theme: {
    extend: {
      colors: Record<string, string | Record<string, string>>
    }
  }
}

/**
 * HÄRLEDDA SKALOR som Tailwind-färgobjekt (F1). Peka en befintlig Tailwind-familj
 * på en av dessa i appens egen config — `colors: { gray: evenoScales.neutral }` —
 * så går appens alla `text-gray-500`/`bg-gray-50` genom `var(--ev-neutral-*)`
 * UTAN att en enda klass skrivs om.
 *
 * Medvetet UTANFÖR `evenoPreset`: preseten delas av web och admin, och en app i
 * taget ska flippas (F1 admin → F2 web). Låg preseten på dem skulle web bytt färg
 * samtidigt som admin. Opt-in per app är hela poängen.
 */
const scaleSteps = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900] as const

/**
 * Ett skalsteg som Tailwind-färgvärde — KANALFORM.
 *
 * `bg-gray-50/60` (delade DataTable-headern) måste kunna få en alfa. En hex bakom
 * `var()` går inte att dela upp: Tailwind ser en ogenomskinlig sträng och släpper
 * modifieraren tyst, så headern blir opak. Kanalvariabeln (`90 82 72`) plus
 * `<alpha-value>` ger exakt samma rgba() som Tailwind emitterar idag — mätt
 * byte-identiskt, till skillnad från color-mix() som avvek ±1 i kompositeringen.
 */
const scaleVars = (scale: string): Record<string, string> =>
  Object.fromEntries(
    scaleSteps.map((step) => [String(step), `rgb(var(--ev-${scale}-${step}-ch) / <alpha-value>)`]),
  )

export const evenoScales = {
  neutral: scaleVars('neutral'),
  success: scaleVars('success'),
  warning: scaleVars('warning'),
  danger: scaleVars('danger'),
}

export const evenoPreset: EvenoTailwindPreset = {
  theme: {
    extend: {
      colors: {
        brand: 'var(--ev-brand)',
        surface: 'var(--ev-surface)',
        canvas: 'var(--ev-bg)',
        ink: {
          DEFAULT: 'var(--ev-text)',
          muted: 'var(--ev-text-muted)',
        },
        line: 'var(--ev-border)',
        success: 'var(--ev-status-success)',
        warning: 'var(--ev-status-warning)',
        danger: 'var(--ev-status-danger)',
      },
    },
  },
}

export default evenoPreset
