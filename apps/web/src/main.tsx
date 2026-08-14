import './instrument'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { Toaster, toast } from 'sonner'
import { router } from './app/router'
import { ErrorBoundary } from './components/ErrorBoundary'
import { consumeImpersonationHash } from './lib/impersonation'
import { extractApiError, isForbidden } from './lib/api'
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

// Motsvarigheten för LÄSNINGAR, och av exakt samma skäl som mutationCache ovan.
// Utan den blir ett 403 på en query en tyst tomhet: `const { data = [] } =
// useQuery(...)` gör ett fel oskiljbart från "inga rader", och sidan renderar
// sitt vanliga tomma tillstånd. Användaren får då ett falskt sakpåstående om
// organisationens data i stället för ett nekande (#442).
//
// BARA 403 toastas här. Ett 500 är redan synligt som ett trasigt läge och
// hanteras av respektive vy; ett 401 fångas av interceptorn i lib/api (refresh
// eller utloggning) och blir aldrig ett stabilt lästillstånd. Att toasta allt
// hade gett dubbla meddelanden på varje sida som redan visar sitt eget felläge.
//
// Toasten säger VARFÖR skärmen är tom. Att skärmen inte längre PÅSTÅR tomhet
// bärs av `isError`-grenarna i vyerna — se PermissionDeniedState. Båda behövs:
// den här ensam förklarar en lögn i stället för att ta bort den.
const queryCache = new QueryCache({
  onError: (error, query) => {
    if (!isForbidden(error)) return
    if (query.meta?.['handlesOwnError']) return
    toast.error(extractApiError(error, 'Du har inte behörighet att se den här informationen'))
  },
})

const queryClient = new QueryClient({
  mutationCache,
  queryCache,
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
      <ErrorBoundary>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
          <Toaster position="top-right" richColors closeButton toastOptions={{ duration: 5000 }} />
        </QueryClientProvider>
      </ErrorBoundary>
    </StrictMode>,
  )
}

void bootstrap()
