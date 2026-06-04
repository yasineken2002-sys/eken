// URL-baserad routing för Eveno-webben (FIX 4).
//
// Ersätter den tidigare useState<Route>-routningen. URL:en speglar appens
// tillstånd: F5 behåller sidan, bakåt/framåt fungerar, bokmärken och delbara
// länkar fungerar.
//
// Sidkomponenterna navigerar själva via TanStack Routers useNavigate/<Link>.

import { useEffect } from 'react'
import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  redirect,
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
import { TerminationsPage } from '../features/terminations/TerminationsPage'
import { AccountingPage } from '../features/accounting/AccountingPage'
import { ReportsPage } from '../features/reports/ReportsPage'
import { SettingsPage } from '../features/settings/SettingsPage'
import { OverviewPage } from '../features/overview/OverviewPage'
import { ReconciliationPage } from '../features/reconciliation/ReconciliationPage'
import { DocumentsPage } from '../features/documents/DocumentsPage'
import { ImportPage } from '../features/import/ImportPage'
import { ContractBatchUploadPage } from '../features/contract-batch/ContractBatchUploadPage'
import { ContractBatchReviewPage } from '../features/contract-batch/ContractBatchReviewPage'
import { AiPage } from '../features/ai/AiPage'
import { MaintenancePage } from '../features/maintenance/MaintenancePage'
import { AviseringPage } from '../features/avisering/AviseringPage'
import { CollectionsPage } from '../features/collections/CollectionsPage'
import { InspectionsPage } from '../features/inspections/InspectionsPage'
import { MaintenancePlanPage } from '../features/maintenance-plan/MaintenancePlanPage'
import { NotificationsPage } from '../features/notifications/NotificationsPage'
import { NewsPage } from '../features/news/NewsPage'
import { MessagesPage } from '../features/messages/MessagesPage'
import { useAuthStore } from '../stores/auth.store'

// ── Auth-hjälpare ────────────────────────────────────────────────────────────

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

// ── Auth-flöden ──────────────────────────────────────────────────────────────

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  beforeLoad: redirectIfAuthenticated,
  component: function LoginRoute() {
    return (
      <>
        <LoginPage />
        <CookieBanner />
      </>
    )
  },
})

const registerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/register',
  beforeLoad: redirectIfAuthenticated,
  component: function RegisterRoute() {
    return (
      <>
        <RegisterPage />
        <CookieBanner />
      </>
    )
  },
})

const forgotPasswordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/forgot-password',
  beforeLoad: redirectIfAuthenticated,
  component: ForgotPasswordPage,
})

const resetPasswordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/reset-password',
  validateSearch: (search: Record<string, unknown>): { token?: string } =>
    typeof search['token'] === 'string' ? { token: search['token'] } : {},
  beforeLoad: redirectIfAuthenticated,
  component: function ResetPasswordRoute() {
    const { token } = resetPasswordRoute.useSearch()
    return <ResetPasswordPage token={token ?? null} />
  },
})

const acceptInviteRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/accept-invite',
  validateSearch: (search: Record<string, unknown>): { token?: string } =>
    typeof search['token'] === 'string' ? { token: search['token'] } : {},
  beforeLoad: redirectIfAuthenticated,
  component: function AcceptInviteRoute() {
    const { token } = acceptInviteRoute.useSearch()
    return <AcceptInvitePage token={token ?? null} />
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
    const forced = useAuthStore((s) => s.user?.mustChangePassword === true)
    return <ChangePasswordPage forced={forced} />
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

  return (
    <AppLayout>
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

// Generisk över path-literalen så TanStack registrerar varje route med sin
// exakta URL — annars degraderas <Link to>/navigate-typningen till `string`.
function appPage<TPath extends string>(path: TPath, component: () => JSX.Element) {
  return createRoute({ getParentRoute: () => appRoute, path, component })
}

const dashboardRoute = appPage('/', DashboardPage)
const propertiesRoute = appPage('/properties', PropertiesPage)
const unitsRoute = appPage('/units', UnitsPage)
const tenantsRoute = appPage('/tenants', TenantsPage)
const customersRoute = appPage('/customers', CustomersPage)
const leasesRoute = appPage('/leases', LeasesPage)
const invoicesRoute = appPage('/invoices', InvoicesPage)
const depositsRoute = appPage('/deposits', DepositsPage)
const rentIncreasesRoute = appPage('/rent-increases', RentIncreasesPage)
const terminationsRoute = appPage('/terminations', TerminationsPage)
const accountingRoute = appPage('/accounting', AccountingPage)
const reportsRoute = appPage('/reports', ReportsPage)
const reconciliationRoute = appPage('/reconciliation', ReconciliationPage)
const collectionsRoute = appPage('/collections', CollectionsPage)
const documentsRoute = appPage('/documents', DocumentsPage)
const importRoute = appPage('/import', ImportPage)
const contractBatchUploadRoute = appPage('/import/contract-batches', ContractBatchUploadPage)
const contractBatchReviewRoute = appPage(
  '/import/contract-batches/$batchId',
  ContractBatchReviewPage,
)
const aiRoute = appPage('/ai', AiPage)
const maintenanceRoute = appPage('/maintenance', MaintenancePage)
const aviseringRoute = appPage('/avisering', AviseringPage)
const inspectionsRoute = appPage('/inspections', InspectionsPage)
const maintenancePlanRoute = appPage('/maintenance-plan', MaintenancePlanPage)
const settingsRoute = appPage('/settings', SettingsPage)
const overviewRoute = appPage('/overview', OverviewPage)
const notificationsRoute = appPage('/notifications', NotificationsPage)
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
    terminationsRoute,
    accountingRoute,
    reportsRoute,
    reconciliationRoute,
    collectionsRoute,
    documentsRoute,
    importRoute,
    contractBatchUploadRoute,
    contractBatchReviewRoute,
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
