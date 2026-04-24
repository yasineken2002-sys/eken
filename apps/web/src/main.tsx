import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { App } from './App'
import { ImpersonationBanner } from './components/ImpersonationBanner'
import { consumeImpersonationHash } from './lib/impersonation'
import './app/globals.css'

const queryClient = new QueryClient({
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
        <ImpersonationBanner />
        <App />
      </QueryClientProvider>
    </StrictMode>,
  )
}

void bootstrap()
