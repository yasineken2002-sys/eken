import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'
import { resolve } from 'path'

/**
 * Eken – Vite dev server configuration
 *
 * Transformer: SWC (Rust-based) via @vitejs/plugin-react-swc
 * → Signifikant snabbare HMR och cold starts vs Babel
 * → Samma hastighetsfilosofi som Turbopack, rätt verktyg för Vite-stacken
 */
export default defineConfig(({ mode }) => ({
  plugins: [
    react({
      // SWC-konfiguration: dekoratorer + class properties
      tsDecorators: true,
    }),
  ],

  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@eken/shared': resolve(__dirname, '../../packages/shared/src/index.ts'),
    },
  },

  // ── Dev server ──────────────────────────────────────────────────────────────
  server: {
    port: 5173,
    strictPort: true, // Misslyckas snabbt om porten är upptagen – ingen tyst fallback
    host: true, // Exponera på 0.0.0.0 (funkar i Codespaces / Docker)
    allowedHosts: true, // Tillåt Codespaces-domäner
    cors: true,
    hmr: {
      overlay: true, // Visa fel direkt i browsern
    },
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
    // Värm upp kritiska moduler vid serverstart → snabbare första rendering
    warmup: {
      clientFiles: [
        './src/main.tsx',
        './src/App.tsx',
        './src/components/layout/AppLayout.tsx',
        './src/components/ui/Button.tsx',
        './src/components/ui/Modal.tsx',
      ],
    },
  },

  // ── Dependency pre-bundling ──────────────────────────────────────────────────
  optimizeDeps: {
    // Inkludera tunga deps explicit → undviker re-bundling under dev
    include: [
      'react',
      'react-dom',
      'react-dom/client',
      'react/jsx-runtime',
      'framer-motion',
      '@tanstack/react-router',
      '@tanstack/react-query',
      '@tanstack/react-query-devtools',
      'zustand',
      'axios',
      'lucide-react',
      'zod',
      'clsx',
      'tailwind-merge',
      'class-variance-authority',
      'date-fns',
      'react-hook-form',
      '@hookform/resolvers/zod',
      '@radix-ui/react-dialog',
      '@radix-ui/react-dropdown-menu',
      '@radix-ui/react-select',
      '@radix-ui/react-tooltip',
      '@radix-ui/react-toast',
    ],
  },

  // ── esbuild (används för non-SWC transforms, t.ex. JSON) ────────────────────
  esbuild: {
    target: 'es2022',
    legalComments: 'none', // Renare output
  },

  // ── Build (prod) ─────────────────────────────────────────────────────────────
  build: {
    target: 'es2022',
    sourcemap: mode === 'development',
    rollupOptions: {
      output: {
        // Manuell chunk-splitting för optimal cache-utnyttjning
        manualChunks: {
          'vendor-react': ['react', 'react-dom', 'react/jsx-runtime'],
          'vendor-router': ['@tanstack/react-router', '@tanstack/react-query'],
          'vendor-ui': [
            'framer-motion',
            'lucide-react',
            '@radix-ui/react-dialog',
            '@radix-ui/react-dropdown-menu',
            '@radix-ui/react-select',
            '@radix-ui/react-tooltip',
            '@radix-ui/react-toast',
          ],
          'vendor-forms': ['react-hook-form', '@hookform/resolvers', 'zod'],
          'vendor-utils': [
            'axios',
            'zustand',
            'date-fns',
            'clsx',
            'tailwind-merge',
            'class-variance-authority',
          ],
        },
      },
    },
    // Varna om chunks > 500 kB
    chunkSizeWarningLimit: 500,
  },

  // ── CSS ──────────────────────────────────────────────────────────────────────
  css: {
    devSourcemap: true,
  },
}))
