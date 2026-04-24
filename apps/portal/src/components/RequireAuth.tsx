import { Navigate, useLocation } from 'react-router-dom'
import type { ReactNode } from 'react'
import { useSessionStore } from '@/store/session.store'

/**
 * Skyddar alla portal-routes. Om sessionen saknas (ingen tenant har loggat
 * in via magic-link) skickas användaren till /login. Vi bevarar den
 * ursprungliga sökvägen så vi kan bounca tillbaka efter verify.
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const isAuthenticated = useSessionStore((s) => s.isAuthenticated)
  const location = useLocation()

  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />
  }

  return <>{children}</>
}
