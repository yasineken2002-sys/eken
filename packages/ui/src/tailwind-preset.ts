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
