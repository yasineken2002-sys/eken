import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  LayoutDashboard,
  Building2,
  Home,
  Users,
  FileText,
  Receipt,
  BookOpen,
  ChevronRight,
  Menu,
  Settings,
  LogOut,
  LayoutGrid,
  ArrowLeftRight,
  FolderOpen,
  Upload,
  Sparkles,
  Wrench,
  ClipboardCheck,
  CalendarRange,
  Newspaper,
  MessageSquare,
  CreditCard,
} from 'lucide-react'
import { cn } from '@/lib/cn'
import { useAuthStore } from '@/stores/auth.store'
import { logoutApi } from '@/features/auth/api/auth.api'
import { NotificationBell } from '@/features/notifications/components/NotificationBell'
import { ImpersonationBanner } from '@/components/ImpersonationBanner'
import type { Route } from '@/App'

interface NavItem {
  id: Route
  label: string
  icon: React.ElementType
  badge?: number
  readOnly?: boolean
}

const NAV_PRIMARY: NavItem[] = [
  { id: 'dashboard', label: 'Översikt', icon: LayoutDashboard },
  { id: 'ai', label: 'AI-assistent', icon: Sparkles },
]

const NAV_PORTFOLIO: NavItem[] = [
  { id: 'properties', label: 'Fastigheter', icon: Building2 },
  { id: 'units', label: 'Objekt', icon: Home },
  { id: 'tenants', label: 'Hyresgäster', icon: Users, readOnly: true },
  { id: 'leases', label: 'Hyresavtal', icon: FileText },
]

const NAV_FINANCE: NavItem[] = [
  { id: 'invoices', label: 'Fakturor', icon: Receipt },
  { id: 'avisering', label: 'Hyresavier', icon: Receipt },
  { id: 'deposits', label: 'Depositioner', icon: CreditCard },
  { id: 'accounting', label: 'Bokföring', icon: BookOpen },
  { id: 'reconciliation', label: 'Bankavstämning', icon: ArrowLeftRight },
]

const NAV_TOOLS: NavItem[] = [
  { id: 'inspections', label: 'Besiktningar', icon: ClipboardCheck },
  { id: 'maintenance', label: 'Underhåll', icon: Wrench },
  { id: 'maintenance-plan', label: 'Underhållsplan', icon: CalendarRange },
  { id: 'documents', label: 'Dokument', icon: FolderOpen },
  { id: 'import', label: 'Importera', icon: Upload },
  { id: 'news', label: 'Nyheter', icon: Newspaper },
  { id: 'messages', label: 'Meddelanden', icon: MessageSquare },
  { id: 'overview', label: 'Plattformsöversikt', icon: LayoutGrid },
]

interface NavGroupProps {
  label?: string
  items: NavItem[]
  route: Route
  collapsed: boolean
  onNavigate: (r: Route) => void
  onMobileClose: () => void
}

function NavGroup({ label, items, route, collapsed, onNavigate, onMobileClose }: NavGroupProps) {
  return (
    <div className="space-y-0.5">
      {label && !collapsed && (
        <p className="mb-1 mt-4 px-3 text-[10px] font-semibold uppercase tracking-widest text-white/20 first:mt-2">
          {label}
        </p>
      )}
      {label && collapsed && <div className="mx-auto mt-3 h-px w-6 bg-white/10" />}
      {items.map((item) => {
        const active = route === item.id
        return (
          <button
            key={item.id}
            onClick={() => {
              onNavigate(item.id)
              onMobileClose()
            }}
            title={collapsed ? item.label : undefined}
            className={cn(
              'group flex w-full items-center rounded-xl transition-all duration-150',
              collapsed ? 'h-10 justify-center px-0' : 'h-9 gap-3 px-3',
              active
                ? 'bg-white/10 text-white'
                : 'hover:bg-white/6 text-white/45 hover:text-white/80',
            )}
          >
            <item.icon
              size={15}
              strokeWidth={active ? 2.2 : 1.8}
              className={cn('flex-shrink-0 transition-colors', active ? 'text-white' : '')}
            />
            <AnimatePresence>
              {!collapsed && (
                <motion.span
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="flex-1 overflow-hidden whitespace-nowrap text-left text-[13px] font-medium"
                >
                  {item.label}
                </motion.span>
              )}
            </AnimatePresence>
            {!collapsed && item.badge !== undefined && (
              <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
                {item.badge}
              </span>
            )}
            {!collapsed && item.readOnly && (
              <span
                title="Läs-bar översikt – skapas via Kontrakt"
                className="rounded-md border border-white/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-white/40"
              >
                Läs
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

interface Props {
  route: Route
  onNavigate: (r: Route) => void
  children: React.ReactNode
}

export function AppLayout({ route, onNavigate, children }: Props) {
  const [collapsed, setCollapsed] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const user = useAuthStore((s) => s.user)
  const clearAuth = useAuthStore((s) => s.clearAuth)

  const handleLogout = async () => {
    try {
      await logoutApi()
    } catch {
      /* clear regardless */
    }
    clearAuth()
    onNavigate('login')
  }

  const displayName = user ? `${user.firstName} ${user.lastName}` : ''
  const initials = user ? `${user.firstName[0] ?? ''}${user.lastName[0] ?? ''}`.toUpperCase() : '?'
  const shortName = user ? `${user.firstName} ${user.lastName[0]}.` : ''
  const currentLabel =
    [...NAV_PRIMARY, ...NAV_PORTFOLIO, ...NAV_FINANCE, ...NAV_TOOLS].find((n) => n.id === route)
      ?.label ?? 'Översikt'

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-[#F7F8FC]">
      <ImpersonationBanner />
      <div className="flex min-h-0 flex-1">
        {/* Mobile overlay */}
        <AnimatePresence>
          {mobileOpen && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-30 bg-black/50 backdrop-blur-sm lg:hidden"
              onClick={() => setMobileOpen(false)}
            />
          )}
        </AnimatePresence>

        {/* ── SIDEBAR ── */}
        <motion.aside
          animate={{ width: collapsed ? 60 : 228 }}
          transition={{ type: 'spring', stiffness: 340, damping: 34 }}
          className={cn(
            'z-40 flex flex-shrink-0 flex-col overflow-hidden',
            'fixed inset-y-0 left-0 lg:relative',
            mobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0',
            'transition-transform lg:transition-none',
          )}
          style={{ background: '#0F1117' }}
        >
          {/* Logo */}
          <div
            className="flex h-14 flex-shrink-0 items-center px-3.5"
            style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}
          >
            <div className="flex min-w-0 items-center gap-2.5">
              <div
                className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg"
                style={{ background: 'linear-gradient(135deg, #3B82F6 0%, #2563EB 100%)' }}
              >
                <Building2 size={13} className="text-white" strokeWidth={2.2} />
              </div>
              <AnimatePresence>
                {!collapsed && (
                  <motion.div
                    initial={{ opacity: 0, width: 0 }}
                    animate={{ opacity: 1, width: 'auto' }}
                    exit={{ opacity: 0, width: 0 }}
                    className="overflow-hidden whitespace-nowrap"
                  >
                    <span className="text-[15px] font-bold tracking-tight text-white">Eken</span>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
            {!collapsed && (
              <button
                onClick={() => setCollapsed(true)}
                className="hover:bg-white/8 ml-auto hidden h-6 w-6 items-center justify-center rounded-lg text-white/25 transition-colors hover:text-white/60 lg:flex"
              >
                <ChevronRight size={13} className="rotate-180" />
              </button>
            )}
            {collapsed && (
              <button
                onClick={() => setCollapsed(false)}
                className="hover:bg-white/8 mx-auto flex h-6 w-6 items-center justify-center rounded-lg text-white/25 transition-colors hover:text-white/60"
              >
                <ChevronRight size={13} />
              </button>
            )}
          </div>

          {/* Navigation */}
          <nav className="scrollbar-thin flex-1 overflow-y-auto px-2.5 py-3">
            <NavGroup
              items={NAV_PRIMARY}
              route={route}
              collapsed={collapsed}
              onNavigate={onNavigate}
              onMobileClose={() => setMobileOpen(false)}
            />
            <NavGroup
              label="Portfölj"
              items={NAV_PORTFOLIO}
              route={route}
              collapsed={collapsed}
              onNavigate={onNavigate}
              onMobileClose={() => setMobileOpen(false)}
            />
            <NavGroup
              label="Ekonomi"
              items={NAV_FINANCE}
              route={route}
              collapsed={collapsed}
              onNavigate={onNavigate}
              onMobileClose={() => setMobileOpen(false)}
            />
            <NavGroup
              label="Verktyg"
              items={NAV_TOOLS}
              route={route}
              collapsed={collapsed}
              onNavigate={onNavigate}
              onMobileClose={() => setMobileOpen(false)}
            />
          </nav>

          {/* Bottom section */}
          <div
            className="flex-shrink-0 px-2.5 pb-4 pt-2"
            style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}
          >
            <button
              onClick={() => {
                onNavigate('settings')
                setMobileOpen(false)
              }}
              className={cn(
                'hover:bg-white/6 flex w-full items-center rounded-xl text-white/40 transition-colors hover:text-white/70',
                collapsed ? 'h-9 justify-center' : 'h-9 gap-3 px-3',
              )}
            >
              <Settings size={14} strokeWidth={1.8} className="flex-shrink-0" />
              {!collapsed && <span className="text-[13px] font-medium">Inställningar</span>}
            </button>

            {/* User */}
            <div
              className={cn(
                'mt-2 flex items-center rounded-xl',
                collapsed ? 'justify-center p-2' : 'gap-2.5 px-2.5 py-2',
              )}
              style={{
                borderTop: '1px solid rgba(255,255,255,0.06)',
                paddingTop: '10px',
                marginTop: '10px',
              }}
            >
              <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-violet-500 to-violet-700 text-[11px] font-bold text-white">
                {initials}
              </div>
              <AnimatePresence>
                {!collapsed && (
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="min-w-0 flex-1"
                  >
                    <p className="truncate text-[12.5px] font-semibold text-white/90">
                      {displayName}
                    </p>
                    <p className="truncate text-[11px] text-white/35">{user?.email ?? ''}</p>
                  </motion.div>
                )}
              </AnimatePresence>
              {!collapsed && (
                <button
                  onClick={handleLogout}
                  title="Logga ut"
                  className="hover:bg-white/8 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-lg text-white/30 transition-colors hover:text-red-400"
                >
                  <LogOut size={13} strokeWidth={1.8} />
                </button>
              )}
            </div>
          </div>
        </motion.aside>

        {/* ── MAIN ── */}
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {/* Topbar */}
          <header className="flex h-14 flex-shrink-0 items-center gap-3 border-b border-gray-100 bg-white/80 px-6 backdrop-blur-sm">
            <button
              onClick={() => setMobileOpen(true)}
              className="flex h-8 w-8 items-center justify-center rounded-xl text-gray-500 transition-colors hover:bg-gray-100 lg:hidden"
            >
              <Menu size={15} strokeWidth={1.8} />
            </button>

            {/* Breadcrumb */}
            <div className="flex items-center gap-1.5">
              <span className="text-[13px] text-gray-400">Eken</span>
              <ChevronRight size={11} strokeWidth={2} className="text-gray-300" />
              <span className="text-[13px] font-semibold text-gray-800">{currentLabel}</span>
            </div>

            <div className="flex-1" />

            {/* Notifications */}
            <NotificationBell onNavigate={onNavigate} />

            <div className="h-5 w-px bg-gray-100" />

            {/* User chip */}
            <div className="flex cursor-pointer items-center gap-2 rounded-xl px-2.5 py-1.5 transition-colors hover:bg-gray-50">
              <div className="flex h-6 w-6 items-center justify-center rounded-full bg-gradient-to-br from-violet-500 to-violet-700 text-[10px] font-bold text-white">
                {initials}
              </div>
              <span className="text-[13px] font-medium text-gray-700">{shortName}</span>
            </div>
          </header>

          {/* Page */}
          <main className="scrollbar-thin flex-1 overflow-y-auto">{children}</main>
        </div>
      </div>
    </div>
  )
}
