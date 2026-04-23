import { Navigate, Outlet } from 'react-router-dom'
import { useSessionStore } from '@/store/session.store'

export function ProtectedRoute() {
  const isAuthenticated = useSessionStore((s) => s.isAuthenticated)
  return isAuthenticated ? <Outlet /> : <Navigate to="/login" replace />
}
