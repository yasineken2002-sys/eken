import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster, toast } from 'sonner'
import { App } from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { extractApiError } from './lib/api'
import './app/globals.css'

// Global safety net: alla muteringar som inte själva sätter meta.handlesOwnError
// får automatiskt en toast med API-felmeddelandet. Stoppar tysta misslyckanden.
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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <App />
        <Toaster position="top-right" richColors closeButton toastOptions={{ duration: 5000 }} />
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
)
