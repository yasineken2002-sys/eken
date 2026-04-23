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
import { MaintenancePage } from './features/maintenance/MaintenancePage'
import { AviseringPage } from './features/avisering/AviseringPage'
import { InspectionsPage } from './features/inspections/InspectionsPage'
import { MaintenancePlanPage } from './features/maintenance-plan/MaintenancePlanPage'
import { TenantPortalPage } from './features/tenant-portal/TenantPortalPage'
import { NotificationsPage } from './features/notifications/NotificationsPage'
import { NewsPage } from './features/news/NewsPage'
import { MessagesPage } from './features/messages/MessagesPage'
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
  | 'maintenance'
  | 'avisering'
  | 'inspections'
  | 'maintenance-plan'
  | 'settings'
  | 'overview'
  | 'notifications'
  | 'news'
  | 'messages'

const PUBLIC_ROUTES: Route[] = ['login', 'register']

// Check if current URL is a tenant portal route
const tenantPortalMatch = window.location.pathname.match(/^\/portal\/(.+)$/)
const INITIAL_TENANT_TOKEN = tenantPortalMatch?.[1] ?? null

export function App() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)

  // Tenant portal — no auth needed
  if (INITIAL_TENANT_TOKEN) {
    return <TenantPortalPage token={INITIAL_TENANT_TOKEN} />
  }

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
    maintenance: <MaintenancePage />,
    avisering: <AviseringPage />,
    inspections: <InspectionsPage />,
    'maintenance-plan': <MaintenancePlanPage />,
    settings: <SettingsPage />,
    overview: <OverviewPage />,
    notifications: <NotificationsPage onNavigate={setRoute} />,
    news: <NewsPage />,
    messages: <MessagesPage />,
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
