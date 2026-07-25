import type { Config } from 'tailwindcss'
import { fontFamily } from 'tailwindcss/defaultTheme'
import animate from 'tailwindcss-animate'
import typography from '@tailwindcss/typography'
import { evenoPreset, evenoScales } from '@eken/ui/tailwind-preset'

export default {
  // @eken/ui-preseten mappar var(--ev-*) → theme.colors (brand/canvas/ink/line/…).
  // PR3: neutral adoption — utilities (bg-canvas/border-line/…) pekar på CSS-variabler
  // som globals.css binder till webs NUVARANDE värden (ingen reskin). Preset-nycklarna
  // krockar inte med webs egna (border/background/primary/…) → ren merge.
  presets: [evenoPreset],
  darkMode: ['class'],
  // Inkluderar @eken/ui/src så Tailwind genererar klasserna som den delade
  // <Modal> (och kommande komponenter) använder — annars blir de ostylade.
  content: ['./index.html', './src/**/*.{ts,tsx}', '../../packages/ui/src/**/*.{ts,tsx}'],
  theme: {
    container: {
      center: true,
      padding: '2rem',
      screens: { '2xl': '1400px' },
    },
    extend: {
      colors: {
        // F2 commit 1: webs gråskala och statusfamiljer går genom @eken/ui:s
        // härledda skalor i stället för Tailwinds egna. Ingen klass skrivs om —
        // `text-gray-500` slår nu upp var(--ev-neutral-500), pinnad till dagens
        // exakta Tailwind-hex i globals.css. Flippen (commit 2) tar bort pinnarna.
        // Blå familjen lämnas MEDVETET orörd — den är varumärkesbytet i F5.
        gray: evenoScales.neutral,
        emerald: evenoScales.success,
        amber: evenoScales.warning,
        red: evenoScales.danger,
        border: 'hsl(var(--border))',
        // `input` pekade på webs shadcn-HSL men användes inte på en enda plats
        // (0 träffar på border-input/bg-input/ring-input). Den pekas om till
        // fältkant-tokenen, samma nyckel som admin fick i F1, och tar över de 62
        // hårdkodade border-[#DDDFE4].
        input: 'var(--ev-input-border)',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      fontFamily: {
        sans: ['Inter var', ...fontFamily.sans],
      },
    },
  },
  plugins: [animate, typography],
} satisfies Config
