import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { useAuthStore } from '@/stores/auth.store'
import { AppLayout } from '@/components/layout/AppLayout'
import { LoginPage } from '@/pages/LoginPage'
import { DashboardPage } from '@/pages/DashboardPage'
import { OrganizationsPage } from '@/pages/organizations/OrganizationsPage'
import { OrganizationDetailPage } from '@/pages/organizations/OrganizationDetailPage'
import { NewOrganizationPage } from '@/pages/organizations/NewOrganizationPage'
import { BillingPage } from '@/pages/BillingPage'
import { ErrorsPage } from '@/pages/ErrorsPage'
import { StatsPage } from '@/pages/StatsPage'
import { SettingsPage } from '@/pages/SettingsPage'

function ProtectedShell() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)
  if (!isAuthenticated) return <Navigate to="/login" replace />
  return <AppLayout />
}

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route element={<ProtectedShell />}>
          <Route index element={<DashboardPage />} />
          <Route path="/organizations" element={<OrganizationsPage />} />
          <Route path="/organizations/new" element={<NewOrganizationPage />} />
          <Route path="/organizations/:id" element={<OrganizationDetailPage />} />
          <Route path="/billing" element={<BillingPage />} />
          <Route path="/errors" element={<ErrorsPage />} />
          <Route path="/stats" element={<StatsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
