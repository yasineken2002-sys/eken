import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react-swc'
import { resolve } from 'path'

// Separat config för Vitest. Återanvänder samma alias som vite.config.ts så
// importer som `@/components/...` fungerar i testerna.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@eken/shared': resolve(__dirname, '../../packages/shared/src/index.ts'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    // Datumprovet ändrar TZ lokalt och verifierar verklig Intl/Date-rendering.
    // En egen process behövs: worker_threads byter inte Nodes tidszon via env.
    poolMatchGlobs: [['**/NoticesPage.test.tsx', 'forks']],
  },
})
