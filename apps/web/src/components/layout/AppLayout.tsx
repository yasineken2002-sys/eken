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
  TrendingUp,
  Gavel,
  Search,
} from 'lucide-react'
import { cn } from '@/lib/cn'
import { useAuthStore } from '@/stores/auth.store'
import { logoutApi } from '@/features/auth/api/auth.api'
import { NotificationBell } from '@/features/notifications/components/NotificationBell'
import { ImpersonationBanner } from '@/components/ImpersonationBanner'
import { ViewerBanner } from '@/components/ViewerBanner'
import type { Route } from '@/App'

interface NavItem {
  id: Route
  label: string
  icon: React.ElementType
  badge?: number
  badgeTone?: 'default' | 'danger'
  readOnly?: boolean
}

const NAV_PRIMARY: NavItem[] = [{ id: 'dashboard', label: 'Översikt', icon: LayoutDashboard }]

const NAV_PORTFOLIO: NavItem[] = [
  { id: 'properties', label: 'Fastigheter', icon: Building2 },
  { id: 'units', label: 'Objekt', icon: Home },
  { id: 'tenants', label: 'Hyresgäster', icon: Users, readOnly: true },
  { id: 'customers', label: 'Kunder', icon: Users },
  { id: 'leases', label: 'Hyresavtal', icon: FileText },
  { id: 'maintenance', label: 'Felanmälningar', icon: Wrench },
]

const NAV_FINANCE: NavItem[] = [
  { id: 'invoices', label: 'Fakturor', icon: Receipt },
  { id: 'avisering', label: 'Hyresavier', icon: Receipt },
  { id: 'deposits', label: 'Depositioner', icon: CreditCard },
  { id: 'rent-increases', label: 'Hyreshöjningar', icon: TrendingUp },
  { id: 'accounting', label: 'Bokföring', icon: BookOpen },
  { id: 'reconciliation', label: 'Bankavstämning', icon: ArrowLeftRight },
  { id: 'collections', label: 'Inkasso', icon: Gavel },
]

const NAV_TOOLS: NavItem[] = [
  { id: 'ai', label: 'AI-assistent', icon: Sparkles },
  { id: 'inspections', label: 'Besiktningar', icon: ClipboardCheck },
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
  onNavigate: (r: Route) => void
  onMobileClose: () => void
}

function NavGroup({ label, items, route, onNavigate, onMobileClose }: NavGroupProps) {
  return (
    <div className="flex flex-col gap-0.5">
      {label && <p className="ev-sb-group-title">{label}</p>}
      {items.map((item) => {
        const active = route === item.id
        const isAi = item.id === 'ai'
        return (
          <button
            key={item.id}
            onClick={() => {
              onNavigate(item.id)
              onMobileClose()
            }}
            className={cn('ev-sb-item', active && 'active')}
          >
            <span className="ev-sb-item-icon">
              <item.icon size={16} strokeWidth={active ? 2.2 : 1.8} />
            </span>
            <span className="flex-1 truncate">{item.label}</span>
            {item.badge !== undefined && (
              <span className={cn('ev-sb-badge', item.badgeTone === 'danger' && 'danger')}>
                {item.badge}
              </span>
            )}
            {item.readOnly && (
              <span
                title="Läs-bar översikt – skapas via Kontrakt"
                className="rounded-md border border-[rgba(15,31,71,0.14)] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-[#9098a9]"
              >
                Läs
              </span>
            )}
            {isAi && !active && (
              <span
                className="ml-1 h-1.5 w-1.5 rounded-full"
                style={{ background: 'var(--ev-color-primary-accent)' }}
              />
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
  const [mobileOpen, setMobileOpen] = useState(false)
  const user = useAuthStore((s) => s.user)
  const org = useAuthStore((s) => s.organization)
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

  return (
    <div
      className="flex h-screen flex-col overflow-hidden"
      style={{ background: 'var(--ev-color-bg)' }}
    >
      <ImpersonationBanner />
      <ViewerBanner />
      <div className="flex min-h-0 flex-1">
        {/* Mobile overlay */}
        <AnimatePresence>
          {mobileOpen && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-30 lg:hidden"
              style={{ background: 'rgba(15, 31, 71, 0.4)', backdropFilter: 'blur(2px)' }}
              onClick={() => setMobileOpen(false)}
            />
          )}
        </AnimatePresence>

        {/* ── SIDEBAR ── */}
        <aside
          className={cn(
            'z-40 flex w-[240px] flex-shrink-0 flex-col overflow-hidden',
            'fixed inset-y-0 left-0 lg:relative',
            mobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0',
            'transition-transform lg:transition-none',
          )}
          style={{
            background: 'var(--ev-color-surface)',
            borderRight: '0.5px solid var(--ev-color-border)',
          }}
        >
          {/* Brand */}
          <div
            className="flex h-16 flex-shrink-0 items-center gap-2.5 px-5"
            style={{ borderBottom: '0.5px solid var(--ev-color-border)' }}
          >
            <div
              className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg"
              style={{ background: 'var(--ev-gradient-ai)' }}
            >
              <Building2 size={13} className="text-white" strokeWidth={2.2} />
            </div>
            <span
              className="text-[17px] font-semibold tracking-tight"
              style={{ color: 'var(--ev-color-primary)' }}
            >
              Eveno
            </span>
          </div>

          {/* Navigation */}
          <nav className="scrollbar-thin flex flex-1 flex-col gap-3.5 overflow-y-auto px-3 py-3.5">
            <NavGroup
              items={NAV_PRIMARY}
              route={route}
              onNavigate={onNavigate}
              onMobileClose={() => setMobileOpen(false)}
            />
            <NavGroup
              label="Förvaltning"
              items={NAV_PORTFOLIO}
              route={route}
              onNavigate={onNavigate}
              onMobileClose={() => setMobileOpen(false)}
            />
            <NavGroup
              label="Ekonomi"
              items={NAV_FINANCE}
              route={route}
              onNavigate={onNavigate}
              onMobileClose={() => setMobileOpen(false)}
            />
            <NavGroup
              label="Verktyg"
              items={NAV_TOOLS}
              route={route}
              onNavigate={onNavigate}
              onMobileClose={() => setMobileOpen(false)}
            />
          </nav>

          {/* Footer */}
          <div
            className="flex flex-shrink-0 flex-col gap-2 px-3 pb-4 pt-2"
            style={{ borderTop: '0.5px solid var(--ev-color-border)' }}
          >
            <button
              onClick={() => {
                onNavigate('settings')
                setMobileOpen(false)
              }}
              className={cn('ev-sb-item', route === 'settings' && 'active')}
            >
              <span className="ev-sb-item-icon">
                <Settings size={16} strokeWidth={route === 'settings' ? 2.2 : 1.8} />
              </span>
              <span className="flex-1">Inställningar</span>
            </button>

            <div className="mt-1 flex items-center gap-2.5 px-2 pt-2">
              <div
                className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-[11px] font-semibold text-white"
                style={{ background: 'var(--ev-color-primary)' }}
              >
                {initials}
              </div>
              <div className="min-w-0 flex-1 leading-tight">
                <p
                  className="truncate text-[12.5px] font-medium"
                  style={{ color: 'var(--ev-color-fg-1)' }}
                >
                  {displayName}
                </p>
                <p className="truncate text-[11px]" style={{ color: 'var(--ev-color-fg-3)' }}>
                  {org?.name ?? user?.email ?? ''}
                </p>
              </div>
              <button
                onClick={handleLogout}
                title="Logga ut"
                className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg text-[#9098a9] transition-colors hover:bg-[var(--ev-color-subtle)] hover:text-[var(--ev-color-danger)]"
              >
                <LogOut size={13} strokeWidth={1.8} />
              </button>
            </div>
          </div>
        </aside>

        {/* ── MAIN ── */}
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {/* Topbar */}
          <header
            className="flex h-16 flex-shrink-0 items-center gap-3 px-6"
            style={{
              background: 'rgba(255, 255, 255, 0.92)',
              backdropFilter: 'blur(12px) saturate(140%)',
              borderBottom: '0.5px solid var(--ev-color-border)',
            }}
          >
            <button
              onClick={() => setMobileOpen(true)}
              className="flex h-9 w-9 items-center justify-center rounded-xl text-[var(--ev-color-fg-2)] transition-colors hover:bg-[var(--ev-color-subtle)] lg:hidden"
            >
              <Menu size={16} strokeWidth={1.8} />
            </button>

            {/* Search */}
            <div
              className="flex h-[38px] max-w-[460px] flex-1 items-center gap-2.5 rounded-[10px] px-3"
              style={{
                background: 'var(--ev-color-subtle)',
                border: '0.5px solid var(--ev-color-border)',
              }}
            >
              <Search size={15} strokeWidth={1.8} style={{ color: 'var(--ev-color-fg-3)' }} />
              <input
                type="text"
                placeholder="Sök efter hyresgäst, fastighet, faktura…"
                aria-label="Sök"
                className="flex-1 border-0 bg-transparent text-[13.5px] outline-none"
                style={{ color: 'var(--ev-color-fg-1)' }}
              />
              <kbd
                className="rounded-md px-1.5 py-0.5 font-mono text-[11px]"
                style={{
                  color: 'var(--ev-color-fg-3)',
                  background: 'var(--ev-color-surface)',
                  border: '0.5px solid var(--ev-color-border-strong)',
                }}
              >
                ⌘K
              </kbd>
            </div>

            <div className="ml-auto flex items-center gap-1.5">
              <NotificationBell onNavigate={onNavigate} />

              <div
                className="mx-1 h-6 w-px"
                style={{ background: 'var(--ev-color-border-strong)' }}
              />

              <button
                onClick={() => onNavigate('settings')}
                className="flex cursor-pointer items-center gap-2.5 rounded-full py-1 pl-1 pr-3 transition-colors hover:bg-[var(--ev-color-subtle)]"
              >
                <div
                  className="flex h-[30px] w-[30px] items-center justify-center rounded-full text-[11px] font-semibold text-white"
                  style={{ background: 'var(--ev-color-primary)' }}
                >
                  {initials}
                </div>
                <div className="flex flex-col text-left leading-tight">
                  <span
                    className="text-[12.5px] font-medium"
                    style={{ color: 'var(--ev-color-fg-1)' }}
                  >
                    {displayName}
                  </span>
                  <span className="text-[11px]" style={{ color: 'var(--ev-color-fg-3)' }}>
                    Förvaltare
                  </span>
                </div>
              </button>
            </div>
          </header>

          {/* Page */}
          <main className="scrollbar-thin flex-1 overflow-y-auto">
            {children}
            <AppFooter onNavigate={onNavigate} />
          </main>
        </div>
      </div>
    </div>
  )
}

function AppFooter({ onNavigate }: { onNavigate: (r: Route) => void }) {
  const year = new Date().getFullYear()
  return (
    <footer
      className="px-7 py-4"
      style={{
        background: 'rgba(255, 255, 255, 0.6)',
        borderTop: '0.5px solid var(--ev-color-border)',
      }}
    >
      <div className="flex flex-col items-center justify-between gap-2 text-[12px] sm:flex-row">
        <p style={{ color: 'var(--ev-color-fg-2)' }}>© {year} Eveno AB</p>
        <div className="flex flex-wrap items-center gap-4">
          {(
            [
              ['legal-villkor', 'Användarvillkor'],
              ['legal-integritet', 'Integritetspolicy'],
              ['legal-cookies', 'Cookies'],
            ] as const
          ).map(([r, label]) => (
            <button
              key={r}
              type="button"
              onClick={() => onNavigate(r)}
              className="transition-colors"
              style={{ color: 'var(--ev-color-fg-2)' }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
    </footer>
  )
}
