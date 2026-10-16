import { useEffect, useState, type ReactNode } from 'react'
import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { toast } from 'sonner'
import { extractApiError } from '@/api/portal.api'
import { SessionChangedError } from '@/lib/session-guard'
import { isSessionCurrent, startSessionSync, useSessionStore } from '@/store/session.store'

function SessionScope({ children, generation }: { children: ReactNode; generation: number }) {
  const [client] = useState(
    () =>
      new QueryClient({
        mutationCache: new MutationCache({
          onError: (error, _vars, _ctx, mutation) => {
            if (
              !isSessionCurrent(generation) ||
              error instanceof SessionChangedError ||
              mutation.meta?.['handlesOwnError']
            )
              return
            toast.error(extractApiError(error, 'Något gick fel'))
          },
        }),
        defaultOptions: {
          queries: {
            staleTime: 60_000,
            retry: (count, error) =>
              isSessionCurrent(generation) && !(error instanceof SessionChangedError) && count < 1,
          },
        },
      }),
  )
  useEffect(
    () => () => {
      void client.cancelQueries()
      client.clear()
      toast.dismiss()
    },
    [client],
  )
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

export function SessionBoundary({ children }: { children: ReactNode }) {
  const generation = useSessionStore((state) => state.sessionGeneration)
  useEffect(startSessionSync, [])
  return (
    <SessionScope key={generation} generation={generation}>
      {children}
    </SessionScope>
  )
}
