// URL-baserad routing för Eveno-webben (FIX 4, Etapp 1).
//
// Ersätter den tidigare useState<Route>-routningen i App.tsx. URL:en speglar
// nu appens tillstånd: F5 behåller sidan, bakåt/framåt fungerar, bokmärken och
// delbara länkar fungerar.
//
// Etapp 1 behåller sidkomponenternas befintliga `onNavigate`-API via en adapter
// (se `useOnNavigate`). Etapp 2 konverterar konsumenterna till <Link>/useNavigate
// och tar bort adaptern.

import { useEffect } from 'react'
import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  redirect,
  useLocation,
  useNavigate,
} from '@tanstack/react-router'
import { AnimatePresence } from 'framer-motion'
import { CURRENT_TERMS_VERSION } from '@eken/shared'

import { RootLayout } from '../components/layout/RootLayout'
import { AppLayout } from '../components/layout/AppLayout'
import { CookieBanner } from '../components/CookieBanner'
import { TermsReacceptanceModal } from '../features/legal/TermsReacceptanceModal'
import { PrivacyPage } from '../features/legal/PrivacyPage'
import { TermsPage } from '../features/legal/TermsPage'
import { CookiesPage } from '../features/legal/CookiesPage'
import { LoginPage } from '../features/auth/LoginPage'
import { RegisterPage } from '../features/auth/RegisterPage'
import { ChangePasswordPage } from '../features/auth/ChangePasswordPage'
import { ForgotPasswordPage } from '../features/auth/ForgotPasswordPage'
import { ResetPasswordPage } from '../features/auth/ResetPasswordPage'
import { AcceptInvitePage } from '../features/auth/AcceptInvitePage'
import { DashboardPage } from '../features/dashboard/DashboardPage'
import { PropertiesPage } from '../features/properties/PropertiesPage'
import { UnitsPage } from '../features/units/UnitsPage'
import { TenantsPage } from '../features/tenants/TenantsPage'
import { CustomersPage } from '../features/customers/CustomersPage'
import { LeasesPage } from '../features/leases/LeasesPage'
import { InvoicesPage } from '../features/invoices/InvoicesPage'
import { DepositsPage } from '../features/deposits/DepositsPage'
import { RentIncreasesPage } from '../features/rent-increases/RentIncreasesPage'
import { AccountingPage } from '../features/accounting/AccountingPage'
import { SettingsPage } from '../features/settings/SettingsPage'
import { OverviewPage } from '../features/overview/OverviewPage'
import { ReconciliationPage } from '../features/reconciliation/ReconciliationPage'
import { DocumentsPage } from '../features/documents/DocumentsPage'
import { ImportPage } from '../features/import/ImportPage'
import { AiPage } from '../features/ai/AiPage'
import { MaintenancePage } from '../features/maintenance/MaintenancePage'
import { AviseringPage } from '../features/avisering/AviseringPage'
import { CollectionsPage } from '../features/collections/CollectionsPage'
import { InspectionsPage } from '../features/inspections/InspectionsPage'
import { MaintenancePlanPage } from '../features/maintenance-plan/MaintenancePlanPage'
import { TenantPortalPage } from '../features/tenant-portal/TenantPortalPage'
import { NotificationsPage } from '../features/notifications/NotificationsPage'
import { NewsPage } from '../features/news/NewsPage'
import { MessagesPage } from '../features/messages/MessagesPage'
import { useAuthStore } from '../stores/auth.store'
import type { Route } from '../App'

// ── Route ↔ URL-mappning ─────────────────────────────────────────────────────

const ROUTE_TO_PATH: Record<Route, string> = {
  login: '/login',
  register: '/register',
  'change-password': '/change-password',
  'forgot-password': '/forgot-password',
  'reset-password': '/reset-password',
  'accept-invite': '/accept-invite',
  privacy: '/legal/integritet',
  'legal-villkor': '/legal/villkor',
  'legal-integritet': '/legal/integritet',
  'legal-cookies': '/legal/cookies',
  dashboard: '/',
  properties: '/properties',
  units: '/units',
  tenants: '/tenants',
  customers: '/customers',
  leases: '/leases',
  invoices: '/invoices',
  deposits: '/deposits',
  'rent-increases': '/rent-increases',
  accounting: '/accounting',
  reconciliation: '/reconciliation',
  collections: '/collections',
  documents: '/documents',
  import: '/import',
  ai: '/ai',
  maintenance: '/maintenance',
  avisering: '/avisering',
  inspections: '/inspections',
  'maintenance-plan': '/maintenance-plan',
  settings: '/settings',
  overview: '/overview',
  notifications: '/notifications',
  news: '/news',
  messages: '/messages',
}

// Omvänd mappning för AppLayout (aktiv nav-markering + brödsmula). Endast
// app-routes — AppLayout renderas aldrig på publika/auth-sidor.
const PATH_TO_ROUTE: Record<string, Route> = {
  '/': 'dashboard',
  '/properties': 'properties',
  '/units': 'units',
  '/tenants': 'tenants',
  '/customers': 'customers',
  '/leases': 'leases',
  '/invoices': 'invoices',
  '/deposits': 'deposits',
  '/rent-increases': 'rent-increases',
  '/accounting': 'accounting',
  '/reconciliation': 'reconciliation',
  '/collections': 'collections',
  '/documents': 'documents',
  '/import': 'import',
  '/ai': 'ai',
  '/maintenance': 'maintenance',
  '/avisering': 'avisering',
  '/inspections': 'inspections',
  '/maintenance-plan': 'maintenance-plan',
  '/settings': 'settings',
  '/overview': 'overview',
  '/notifications': 'notifications',
  '/news': 'news',
  '/messages': 'messages',
}

// Adapter: låter sidkomponenter behålla sitt `onNavigate(route)`-API men driver
// riktig URL-navigering. Tas bort i Etapp 2 när konsumenter använder <Link>.
function useOnNavigate(): (route: Route) => void {
  const navigate = useNavigate()
  return (route: Route) => {
    void navigate({ to: ROUTE_TO_PATH[route] ?? '/' })
  }
}

function authSnapshot(): { isAuthenticated: boolean; mustChangePassword: boolean } {
  const state = useAuthStore.getState()
  return {
    isAuthenticated: state.isAuthenticated,
    mustChangePassword: state.user?.mustChangePassword === true,
  }
}

// Auth-flödessidor (login/register/...) — en redan inloggad användare som
// hamnar här skickas vidare, precis som den gamla App.tsx-logiken gjorde.
function redirectIfAuthenticated(): void {
  const { isAuthenticated, mustChangePassword } = authSnapshot()
  if (isAuthenticated) {
    throw redirect({ to: mustChangePassword ? '/change-password' : '/' })
  }
}

// ── Rot ──────────────────────────────────────────────────────────────────────

const rootRoute = createRootRoute({ component: RootLayout })

// ── Hyresgästportal — helt utanför app-skalet, ingen auth ───────────────────

const portalRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/portal/$token',
  component: function PortalRoute() {
    const { token } = portalRoute.useParams()
    return <TenantPortalPage token={token} />
  },
})

// ── Auth-flöden ──────────────────────────────────────────────────────────────

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  beforeLoad: redirectIfAuthenticated,
  component: function LoginRoute() {
    const onNavigate = useOnNavigate()
    return (
      <>
        <LoginPage onNavigate={onNavigate} />
        <CookieBanner onNavigate={onNavigate} />
      </>
    )
  },
})

const registerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/register',
  beforeLoad: redirectIfAuthenticated,
  component: function RegisterRoute() {
    const onNavigate = useOnNavigate()
    return (
      <>
        <RegisterPage onNavigate={onNavigate} />
        <CookieBanner onNavigate={onNavigate} />
      </>
    )
  },
})

const forgotPasswordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/forgot-password',
  beforeLoad: redirectIfAuthenticated,
  component: function ForgotPasswordRoute() {
    const onNavigate = useOnNavigate()
    return <ForgotPasswordPage onNavigate={onNavigate} />
  },
})

const resetPasswordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/reset-password',
  validateSearch: (search: Record<string, unknown>): { token?: string } =>
    typeof search['token'] === 'string' ? { token: search['token'] } : {},
  beforeLoad: redirectIfAuthenticated,
  component: function ResetPasswordRoute() {
    const onNavigate = useOnNavigate()
    const { token } = resetPasswordRoute.useSearch()
    return <ResetPasswordPage token={token ?? null} onNavigate={onNavigate} />
  },
})

const acceptInviteRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/accept-invite',
  validateSearch: (search: Record<string, unknown>): { token?: string } =>
    typeof search['token'] === 'string' ? { token: search['token'] } : {},
  beforeLoad: redirectIfAuthenticated,
  component: function AcceptInviteRoute() {
    const onNavigate = useOnNavigate()
    const { token } = acceptInviteRoute.useSearch()
    return <AcceptInvitePage token={token ?? null} onNavigate={onNavigate} />
  },
})

// change-password är nåbar för inloggade (även icke-tvingade, via Inställningar).
const changePasswordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/change-password',
  beforeLoad: () => {
    if (!authSnapshot().isAuthenticated) throw redirect({ to: '/login' })
  },
  component: function ChangePasswordRoute() {
    const onNavigate = useOnNavigate()
    const forced = useAuthStore((s) => s.user?.mustChangePassword === true)
    return <ChangePasswordPage forced={forced} onNavigate={onNavigate} />
  },
})

// ── Juridiska sidor — publika, läsbara även för inloggade ────────────────────

function useLegalBack(): () => void {
  const navigate = useNavigate()
  return () => {
    void navigate({ to: authSnapshot().isAuthenticated ? '/' : '/login' })
  }
}

const legalTermsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/legal/villkor',
  component: function LegalTermsRoute() {
    return <TermsPage onBack={useLegalBack()} />
  },
})

const legalPrivacyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/legal/integritet',
  component: function LegalPrivacyRoute() {
    return <PrivacyPage onBack={useLegalBack()} />
  },
})

const legalCookiesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/legal/cookies',
  component: function LegalCookiesRoute() {
    return <CookiesPage onBack={useLegalBack()} />
  },
})

// Legacy-alias så att gamla mejl-länkar fortsätter fungera.
function aliasRoute(path: string, to: string) {
  return createRoute({
    getParentRoute: () => rootRoute,
    path,
    beforeLoad: () => {
      throw redirect({ to })
    },
    component: () => null,
  })
}

const privacyAliasRoute = aliasRoute('/privacy', '/legal/integritet')
const integritetAliasRoute = aliasRoute('/integritet', '/legal/integritet')
const integritetspolicyAliasRoute = aliasRoute('/integritetspolicy', '/legal/integritet')

const resetPasswordAliasRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/auth/reset-password',
  validateSearch: (search: Record<string, unknown>): { token?: string } =>
    typeof search['token'] === 'string' ? { token: search['token'] } : {},
  beforeLoad: ({ search }) => {
    throw redirect({ to: '/reset-password', search })
  },
  component: () => null,
})

const acceptInviteAliasRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/auth/accept-invite',
  validateSearch: (search: Record<string, unknown>): { token?: string } =>
    typeof search['token'] === 'string' ? { token: search['token'] } : {},
  beforeLoad: ({ search }) => {
    throw redirect({ to: '/accept-invite', search })
  },
  component: () => null,
})

// ── App-skalet (AppLayout + auth-guard) ──────────────────────────────────────

function AppShell() {
  const navigate = useNavigate()
  const location = useLocation()
  const onNavigate = useOnNavigate()
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)
  const mustChangePassword = useAuthStore((s) => s.user?.mustChangePassword === true)
  const orgTermsVersion = useAuthStore((s) => s.organization?.termsVersion ?? null)
  const needsTermsReacceptance =
    isAuthenticated && !mustChangePassword && orgTermsVersion !== CURRENT_TERMS_VERSION

  // Sessionsutgång mitt i en session: när auth-store nollas (t.ex. 401 →
  // clearAuth) ska användaren tillbaka till login. beforeLoad-guarden täcker
  // sidladdningar; denna effekt täcker utgång medan appen redan är öppen.
  useEffect(() => {
    if (!isAuthenticated) void navigate({ to: '/login' })
  }, [isAuthenticated, navigate])

  const route: Route = PATH_TO_ROUTE[location.pathname] ?? 'dashboard'

  return (
    <AppLayout route={route} onNavigate={onNavigate}>
      {needsTermsReacceptance && <TermsReacceptanceModal onAccepted={() => {}} />}
      <AnimatePresence mode="wait">
        <Outlet />
      </AnimatePresence>
    </AppLayout>
  )
}

const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'app',
  beforeLoad: () => {
    const { isAuthenticated, mustChangePassword } = authSnapshot()
    if (!isAuthenticated) throw redirect({ to: '/login' })
    if (mustChangePassword) throw redirect({ to: '/change-password' })
  },
  component: AppShell,
})

// ── App-sidor ────────────────────────────────────────────────────────────────

function appPage(path: string, component: () => JSX.Element) {
  return createRoute({ getParentRoute: () => appRoute, path, component })
}

const dashboardRoute = appPage('/', function DashboardRoute() {
  return <DashboardPage onNavigate={useOnNavigate()} />
})
const depositsRoute = appPage('/deposits', function DepositsRoute() {
  return <DepositsPage onNavigate={useOnNavigate()} />
})
const rentIncreasesRoute = appPage('/rent-increases', function RentIncreasesRoute() {
  return <RentIncreasesPage onNavigate={useOnNavigate()} />
})
const settingsRoute = appPage('/settings', function SettingsRoute() {
  return <SettingsPage onNavigate={useOnNavigate()} />
})
const notificationsRoute = appPage('/notifications', function NotificationsRoute() {
  return <NotificationsPage onNavigate={useOnNavigate()} />
})

const propertiesRoute = appPage('/properties', PropertiesPage)
const unitsRoute = appPage('/units', UnitsPage)
const tenantsRoute = appPage('/tenants', TenantsPage)
const customersRoute = appPage('/customers', CustomersPage)
const leasesRoute = appPage('/leases', LeasesPage)
const invoicesRoute = appPage('/invoices', InvoicesPage)
const accountingRoute = appPage('/accounting', AccountingPage)
const reconciliationRoute = appPage('/reconciliation', ReconciliationPage)
const collectionsRoute = appPage('/collections', CollectionsPage)
const documentsRoute = appPage('/documents', DocumentsPage)
const importRoute = appPage('/import', ImportPage)
const aiRoute = appPage('/ai', AiPage)
const maintenanceRoute = appPage('/maintenance', MaintenancePage)
const aviseringRoute = appPage('/avisering', AviseringPage)
const inspectionsRoute = appPage('/inspections', InspectionsPage)
const maintenancePlanRoute = appPage('/maintenance-plan', MaintenancePlanPage)
const overviewRoute = appPage('/overview', OverviewPage)
const newsRoute = appPage('/news', NewsPage)
const messagesRoute = appPage('/messages', MessagesPage)

// Okänd URL → dashboard (motsvarar gamla fallbacken).
const catchAllRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '$',
  beforeLoad: () => {
    throw redirect({ to: '/' })
  },
  component: () => null,
})

// ── Routerträd ───────────────────────────────────────────────────────────────

const routeTree = rootRoute.addChildren([
  portalRoute,
  loginRoute,
  registerRoute,
  forgotPasswordRoute,
  resetPasswordRoute,
  acceptInviteRoute,
  changePasswordRoute,
  legalTermsRoute,
  legalPrivacyRoute,
  legalCookiesRoute,
  privacyAliasRoute,
  integritetAliasRoute,
  integritetspolicyAliasRoute,
  resetPasswordAliasRoute,
  acceptInviteAliasRoute,
  appRoute.addChildren([
    dashboardRoute,
    propertiesRoute,
    unitsRoute,
    tenantsRoute,
    customersRoute,
    leasesRoute,
    invoicesRoute,
    depositsRoute,
    rentIncreasesRoute,
    accountingRoute,
    reconciliationRoute,
    collectionsRoute,
    documentsRoute,
    importRoute,
    aiRoute,
    maintenanceRoute,
    aviseringRoute,
    inspectionsRoute,
    maintenancePlanRoute,
    settingsRoute,
    overviewRoute,
    notificationsRoute,
    newsRoute,
    messagesRoute,
  ]),
  catchAllRoute,
])

export const router = createRouter({ routeTree })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
