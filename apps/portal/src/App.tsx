import { Routes, Route, Navigate } from 'react-router-dom'
import { PortalLayout } from '@/components/PortalLayout/PortalLayout'
import { RequireAuth } from '@/components/RequireAuth'
import { DashboardPage } from '@/pages/DashboardPage/DashboardPage'
import { NoticesPage } from '@/pages/NoticesPage/NoticesPage'
import { MaintenancePage } from '@/pages/MaintenancePage/MaintenancePage'
import { NewsPage } from '@/pages/NewsPage/NewsPage'
import { DocumentsPage } from '@/pages/DocumentsPage/DocumentsPage'
import { LoginPage } from '@/pages/LoginPage/LoginPage'
import { VerifyPage } from '@/pages/VerifyPage/VerifyPage'

export function App() {
  return (
    <Routes>
      {/* Publika auth-routes — magic-link-URL:en genereras som /auth/verify?token=... i API:n */}
      <Route path="/login" element={<LoginPage />} />
      <Route path="/auth/verify" element={<VerifyPage />} />

      {/* Skyddade routes — allt innanför kräver aktiv session */}
      <Route
        element={
          <RequireAuth>
            <PortalLayout />
          </RequireAuth>
        }
      >
        <Route index element={<DashboardPage />} />
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/notices" element={<NoticesPage />} />
        <Route path="/maintenance" element={<MaintenancePage />} />
        <Route path="/news" element={<NewsPage />} />
        <Route path="/documents" element={<DocumentsPage />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
