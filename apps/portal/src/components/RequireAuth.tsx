import { Navigate, useLocation } from 'react-router-dom'
import { useEffect, type ReactNode } from 'react'
import { useSessionStore } from '@/store/session.store'

/**
 * Skyddar alla portal-routes. Om sessionen saknas eller har gått ut
 * skickas användaren till /login. Vi kontrollerar `expiresAt` på varje
 * navigation så vi kan logga ut proaktivt istället för att vänta på
 * första 401:an från API:t. Vi bevarar den ursprungliga sökvägen så
 * vi kan bounca tillbaka efter verify.
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const isAuthenticated = useSessionStore((s) => s.isAuthenticated)
  const checkAndClearIfExpired = useSessionStore((s) => s.checkAndClearIfExpired)
  const location = useLocation()

  useEffect(() => {
    checkAndClearIfExpired()
  }, [location.pathname, checkAndClearIfExpired])

  if (!isAuthenticated || checkAndClearIfExpired()) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />
  }

  return <>{children}</>
}
