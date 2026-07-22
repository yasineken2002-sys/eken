import type { Config } from 'tailwindcss'
import { fontFamily } from 'tailwindcss/defaultTheme'
import { evenoPreset } from '@eken/ui/tailwind-preset'

export default {
  // @eken/ui-preseten mappar var(--ev-*) → theme.colors (brand/canvas/ink/line/…).
  // PR2: neutral adoption — utilities som bg-canvas/border-line/text-ink pekar på
  // CSS-variabler som globals.css binder till admins NUVARANDE värden (ingen reskin).
  presets: [evenoPreset],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter var', ...fontFamily.sans],
      },
    },
  },
  plugins: [],
} satisfies Config
