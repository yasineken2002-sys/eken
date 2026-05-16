import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        eveno: {
          'deep-space': '#0A0E1F',
          navy: '#0F1F47',
          electric: '#5B7FE0',
          mint: '#ADE0C5',
          cream: '#FAF4E8',
          'soft-glow': '#FFF9F0',
        },
      },
      fontFamily: {
        sans: ['var(--font-inter)', 'system-ui', 'sans-serif'],
      },
      backgroundImage: {
        'cosmic-gradient': 'linear-gradient(135deg, #0A0E1F 0%, #0F1F47 50%, #1E3A8A 100%)',
      },
      animation: {
        'pulse-slow': 'pulse 3s ease-in-out infinite',
        twinkle: 'twinkle 4s ease-in-out infinite',
      },
      keyframes: {
        twinkle: {
          '0%, 100%': { opacity: '0.3' },
          '50%': { opacity: '1' },
        },
      },
    },
  },
  plugins: [],
}
export default config
