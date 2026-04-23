import { Routes, Route, Navigate } from 'react-router-dom'
import { PortalLayout } from '@/components/PortalLayout/PortalLayout'
import { DashboardPage } from '@/pages/DashboardPage/DashboardPage'
import { NoticesPage } from '@/pages/NoticesPage/NoticesPage'
import { MaintenancePage } from '@/pages/MaintenancePage/MaintenancePage'
import { NewsPage } from '@/pages/NewsPage/NewsPage'
import { DocumentsPage } from '@/pages/DocumentsPage/DocumentsPage'

export function App() {
  return (
    <Routes>
      <Route element={<PortalLayout />}>
        <Route index element={<DashboardPage />} />
        <Route path="/notices" element={<NoticesPage />} />
        <Route path="/maintenance" element={<MaintenancePage />} />
        <Route path="/news" element={<NewsPage />} />
        <Route path="/documents" element={<DocumentsPage />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
