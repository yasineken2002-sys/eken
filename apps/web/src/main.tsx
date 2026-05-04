import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster, toast } from 'sonner'
import { App } from './App'
import { consumeImpersonationHash } from './lib/impersonation'
import { extractApiError } from './lib/api'
import './app/globals.css'

// Global safety net för alla muteringar i hela appen — utan detta blir varje
// 4xx från backend en tyst "ingenting händer"-bugg eftersom ingen feature
// skriver egen onError. Mutationer som hanterar sitt eget fel sätter
// meta.handlesOwnError = true och slipper då dubbel-toast.
const mutationCache = new MutationCache({
  onError: (error, _vars, _ctx, mutation) => {
    if (mutation.meta?.['handlesOwnError']) return
    toast.error(extractApiError(error, 'Något gick fel'))
  },
})

const queryClient = new QueryClient({
  mutationCache,
  defaultOptions: {
    queries: { staleTime: 60_000, retry: 1 },
  },
})

async function bootstrap() {
  // Måste köras INNAN React renderas, annars hinner routing/queries fira
  // mot gammal auth-state innan impersonation-token är sparad.
  await consumeImpersonationHash()

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <App />
        <Toaster position="top-right" richColors closeButton toastOptions={{ duration: 5000 }} />
      </QueryClientProvider>
    </StrictMode>,
  )
}

void bootstrap()
