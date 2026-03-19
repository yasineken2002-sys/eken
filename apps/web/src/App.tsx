import { useState } from 'react'
import { AnimatePresence } from 'framer-motion'
import { AppLayout } from './components/layout/AppLayout'
import { DashboardPage } from './features/dashboard/DashboardPage'
import { PropertiesPage } from './features/properties/PropertiesPage'
import { UnitsPage } from './features/units/UnitsPage'
import { TenantsPage } from './features/tenants/TenantsPage'
import { LeasesPage } from './features/leases/LeasesPage'
import { InvoicesPage } from './features/invoices/InvoicesPage'
import { AccountingPage } from './features/accounting/AccountingPage'

export type Route =
  | 'dashboard'
  | 'properties'
  | 'units'
  | 'tenants'
  | 'leases'
  | 'invoices'
  | 'accounting'

export function App() {
  const [route, setRoute] = useState<Route>('dashboard')

  const page = {
    dashboard: <DashboardPage />,
    properties: <PropertiesPage />,
    units: <UnitsPage />,
    tenants: <TenantsPage />,
    leases: <LeasesPage />,
    invoices: <InvoicesPage />,
    accounting: <AccountingPage />,
  }[route]

  return (
    <AppLayout route={route} onNavigate={setRoute}>
      <AnimatePresence mode="wait">{page}</AnimatePresence>
    </AppLayout>
  )
}
