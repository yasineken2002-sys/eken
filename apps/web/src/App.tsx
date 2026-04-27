import { useState, useEffect } from 'react'
import { AnimatePresence } from 'framer-motion'
import { AppLayout } from './components/layout/AppLayout'
import { LoginPage } from './features/auth/LoginPage'
import { RegisterPage } from './features/auth/RegisterPage'
import { ChangePasswordPage } from './features/auth/ChangePasswordPage'
import { ForgotPasswordPage } from './features/auth/ForgotPasswordPage'
import { ResetPasswordPage } from './features/auth/ResetPasswordPage'
import { AcceptInvitePage } from './features/auth/AcceptInvitePage'
import { DashboardPage } from './features/dashboard/DashboardPage'
import { PropertiesPage } from './features/properties/PropertiesPage'
import { UnitsPage } from './features/units/UnitsPage'
import { TenantsPage } from './features/tenants/TenantsPage'
import { LeasesPage } from './features/leases/LeasesPage'
import { InvoicesPage } from './features/invoices/InvoicesPage'
import { DepositsPage } from './features/deposits/DepositsPage'
import { RentIncreasesPage } from './features/rent-increases/RentIncreasesPage'
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
  | 'change-password'
  | 'forgot-password'
  | 'reset-password'
  | 'accept-invite'
  | 'dashboard'
  | 'properties'
  | 'units'
  | 'tenants'
  | 'leases'
  | 'invoices'
  | 'deposits'
  | 'rent-increases'
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

const PUBLIC_ROUTES: Route[] = [
  'login',
  'register',
  'forgot-password',
  'reset-password',
  'accept-invite',
]

// Check if current URL is a tenant portal route
const tenantPortalMatch = window.location.pathname.match(/^\/portal\/(.+)$/)
const INITIAL_TENANT_TOKEN = tenantPortalMatch?.[1] ?? null

// Detektera reset-password / accept-invite-länkar via path eller query.
// Reset/invite-mailen pekar på /reset-password?token=... resp /accept-invite?token=...
function readInitialAuthRoute(): { route: Route; token: string | null } | null {
  const path = window.location.pathname
  const params = new URLSearchParams(window.location.search)
  const token = params.get('token')
  if (path === '/reset-password' || path === '/auth/reset-password') {
    return { route: 'reset-password', token }
  }
  if (path === '/accept-invite' || path === '/auth/accept-invite') {
    return { route: 'accept-invite', token }
  }
  return null
}
const INITIAL_AUTH_ROUTE = readInitialAuthRoute()

export function App() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)
  const mustChangePassword = useAuthStore((s) => s.user?.mustChangePassword === true)

  // Tenant portal — no auth needed
  if (INITIAL_TENANT_TOKEN) {
    return <TenantPortalPage token={INITIAL_TENANT_TOKEN} />
  }

  const [route, setRoute] = useState<Route>(() => {
    if (INITIAL_AUTH_ROUTE) return INITIAL_AUTH_ROUTE.route
    const auth = useAuthStore.getState()
    if (auth.isAuthenticated) {
      return auth.user?.mustChangePassword ? 'change-password' : 'dashboard'
    }
    return 'login'
  })
  const [authToken] = useState<string | null>(INITIAL_AUTH_ROUTE?.token ?? null)

  // Auth guard: redirect to login when session expires, redirect to dashboard after login
  useEffect(() => {
    if (!isAuthenticated && !PUBLIC_ROUTES.includes(route) && route !== 'change-password') {
      setRoute('login')
    }
    if (isAuthenticated && PUBLIC_ROUTES.includes(route)) {
      setRoute(mustChangePassword ? 'change-password' : 'dashboard')
    }
    // Tvinga password-byte: blockera all annan navigation tills användaren bytt.
    if (isAuthenticated && mustChangePassword && route !== 'change-password' && route !== 'login') {
      setRoute('change-password')
    }
  }, [isAuthenticated, mustChangePassword, route])

  if (route === 'login') return <LoginPage onNavigate={setRoute} />
  if (route === 'register') return <RegisterPage onNavigate={setRoute} />
  if (route === 'forgot-password') return <ForgotPasswordPage onNavigate={setRoute} />
  if (route === 'reset-password')
    return <ResetPasswordPage token={authToken} onNavigate={setRoute} />
  if (route === 'accept-invite') return <AcceptInvitePage token={authToken} onNavigate={setRoute} />
  if (route === 'change-password')
    return <ChangePasswordPage forced={mustChangePassword} onNavigate={setRoute} />

  const page = {
    dashboard: <DashboardPage onNavigate={setRoute} />,
    properties: <PropertiesPage />,
    units: <UnitsPage />,
    tenants: <TenantsPage />,
    leases: <LeasesPage />,
    invoices: <InvoicesPage />,
    deposits: <DepositsPage onNavigate={setRoute} />,
    'rent-increases': <RentIncreasesPage onNavigate={setRoute} />,
    accounting: <AccountingPage />,
    reconciliation: <ReconciliationPage />,
    documents: <DocumentsPage />,
    import: <ImportPage />,
    ai: <AiPage />,
    maintenance: <MaintenancePage />,
    avisering: <AviseringPage />,
    inspections: <InspectionsPage />,
    'maintenance-plan': <MaintenancePlanPage />,
    settings: <SettingsPage onNavigate={setRoute} />,
    overview: <OverviewPage />,
    notifications: <NotificationsPage onNavigate={setRoute} />,
    news: <NewsPage />,
    messages: <MessagesPage />,
    // Auth-flöden hanteras ovan — dessa renderas aldrig inuti AppLayout
    login: null,
    register: null,
    'change-password': null,
    'forgot-password': null,
    'reset-password': null,
    'accept-invite': null,
  }[route]

  return (
    <AppLayout route={route} onNavigate={setRoute}>
      <AnimatePresence mode="wait">{page}</AnimatePresence>
    </AppLayout>
  )
}
