import { useState, useEffect } from 'react'
import { AnimatePresence } from 'framer-motion'
import { AppLayout } from './components/layout/AppLayout'
import { LoginPage } from './features/auth/LoginPage'
import { RegisterPage } from './features/auth/RegisterPage'
import { DashboardPage } from './features/dashboard/DashboardPage'
import { PropertiesPage } from './features/properties/PropertiesPage'
import { UnitsPage } from './features/units/UnitsPage'
import { TenantsPage } from './features/tenants/TenantsPage'
import { LeasesPage } from './features/leases/LeasesPage'
import { InvoicesPage } from './features/invoices/InvoicesPage'
import { AccountingPage } from './features/accounting/AccountingPage'
import { SettingsPage } from './features/settings/SettingsPage'
import { OverviewPage } from './features/overview/OverviewPage'
import { ReconciliationPage } from './features/reconciliation/ReconciliationPage'
import { DocumentsPage } from './features/documents/DocumentsPage'
import { ImportPage } from './features/import/ImportPage'
import { AiPage } from './features/ai/AiPage'
import { useAuthStore } from './stores/auth.store'

export type Route =
  | 'login'
  | 'register'
  | 'dashboard'
  | 'properties'
  | 'units'
  | 'tenants'
  | 'leases'
  | 'invoices'
  | 'accounting'
  | 'reconciliation'
  | 'documents'
  | 'import'
  | 'ai'
  | 'settings'
  | 'overview'

const PUBLIC_ROUTES: Route[] = ['login', 'register']

export function App() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)

  const [route, setRoute] = useState<Route>(() =>
    useAuthStore.getState().isAuthenticated ? 'dashboard' : 'login',
  )

  // Auth guard: redirect to login when session expires, redirect to dashboard after login
  useEffect(() => {
    if (!isAuthenticated && !PUBLIC_ROUTES.includes(route)) {
      setRoute('login')
    }
    if (isAuthenticated && PUBLIC_ROUTES.includes(route)) {
      setRoute('dashboard')
    }
  }, [isAuthenticated, route])

  if (route === 'login') return <LoginPage onNavigate={setRoute} />
  if (route === 'register') return <RegisterPage onNavigate={setRoute} />

  const page = {
    dashboard: <DashboardPage onNavigate={setRoute} />,
    properties: <PropertiesPage />,
    units: <UnitsPage />,
    tenants: <TenantsPage />,
    leases: <LeasesPage />,
    invoices: <InvoicesPage />,
    accounting: <AccountingPage />,
    reconciliation: <ReconciliationPage />,
    documents: <DocumentsPage />,
    import: <ImportPage />,
    ai: <AiPage />,
    settings: <SettingsPage />,
    overview: <OverviewPage />,
    // login/register handled above — these never render inside AppLayout
    login: null,
    register: null,
  }[route]

  return (
    <AppLayout route={route} onNavigate={setRoute}>
      <AnimatePresence mode="wait">{page}</AnimatePresence>
    </AppLayout>
  )
}
