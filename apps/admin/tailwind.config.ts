import type { Config } from 'tailwindcss'
import { fontFamily } from 'tailwindcss/defaultTheme'
import { evenoPreset, evenoScales } from '@eken/ui/tailwind-preset'

export default {
  // @eken/ui-preseten mappar var(--ev-*) → theme.colors (brand/canvas/ink/line/…).
  // PR2: neutral adoption — utilities som bg-canvas/border-line/text-ink pekar på
  // CSS-variabler som globals.css binder till admins NUVARANDE värden (ingen reskin).
  presets: [evenoPreset],
  // Inkluderar @eken/ui/src så Tailwind genererar klasserna som den delade
  // <Modal> (och kommande komponenter) använder — annars blir de ostylade.
  content: ['./index.html', './src/**/*.{ts,tsx}', '../../packages/ui/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      // F1 commit 1: admins gråskala och statusfamiljer går genom @eken/ui:s
      // härledda skalor i stället för Tailwinds egna. Ingen klass skrivs om —
      // `text-gray-500` slår nu upp var(--ev-neutral-500). Värdet är pinnat till
      // dagens exakta Tailwind-hex i globals.css, så steget är pixelneutralt;
      // flippen (commit 2) tar bort pinnarna och skalorna blir varma.
      // Blå familjen lämnas MEDVETET orörd — den är varumärkesbytet i F5.
      colors: {
        gray: evenoScales.neutral,
        emerald: evenoScales.success,
        amber: evenoScales.warning,
        red: evenoScales.danger,
        // Fältkant (input/select/textarea) — ersätter border-[#DDDFE4].
        input: 'var(--ev-input-border)',
      },
      fontFamily: {
        sans: ['Inter var', ...fontFamily.sans],
      },
    },
  },
  plugins: [],
} satisfies Config
