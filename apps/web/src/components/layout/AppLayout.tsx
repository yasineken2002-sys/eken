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
  Bell,
  ChevronRight,
  Menu,
  Settings,
  HelpCircle,
  LogOut,
  Search,
} from 'lucide-react'
import { cn } from '@/lib/cn'
import type { Route } from '@/App'

interface NavItem {
  id: Route
  label: string
  icon: React.ElementType
  badge?: number
}

const NAV: NavItem[] = [
  { id: 'dashboard', label: 'Översikt', icon: LayoutDashboard },
  { id: 'properties', label: 'Fastigheter', icon: Building2 },
  { id: 'units', label: 'Objekt', icon: Home },
  { id: 'tenants', label: 'Hyresgäster', icon: Users },
  { id: 'leases', label: 'Hyresavtal', icon: FileText },
  { id: 'invoices', label: 'Fakturor', icon: Receipt, badge: 1 },
  { id: 'accounting', label: 'Bokföring', icon: BookOpen },
]

interface Props {
  route: Route
  onNavigate: (r: Route) => void
  children: React.ReactNode
}

export function AppLayout({ route, onNavigate, children }: Props) {
  const [collapsed, setCollapsed] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)

  return (
    <div className="flex h-screen overflow-hidden" style={{ background: '#F3F5F7' }}>
      {/* Mobile overlay */}
      <AnimatePresence>
        {mobileOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-30 lg:hidden"
            style={{ background: 'rgba(0,0,0,0.45)' }}
            onClick={() => setMobileOpen(false)}
          />
        )}
      </AnimatePresence>

      {/* ── SIDEBAR ── */}
      <motion.aside
        animate={{ width: collapsed ? 56 : 220 }}
        transition={{ type: 'spring', stiffness: 320, damping: 32 }}
        className={cn(
          'z-40 flex flex-shrink-0 flex-col overflow-hidden',
          'fixed inset-y-0 left-0 lg:relative',
          mobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0',
          'transition-transform lg:transition-none',
        )}
        style={{ background: '#1A2537' }}
      >
        {/* Logo */}
        <div
          className="flex h-[52px] flex-shrink-0 items-center border-b px-3"
          style={{ borderColor: '#253347' }}
        >
          <div className="flex min-w-0 items-center gap-2.5">
            <div
              className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded"
              style={{ background: 'linear-gradient(135deg, #27A85F 0%, #1A7C45 100%)' }}
            >
              <Building2 size={14} className="text-white" strokeWidth={2} />
            </div>
            <AnimatePresence>
              {!collapsed && (
                <motion.div
                  initial={{ opacity: 0, width: 0 }}
                  animate={{ opacity: 1, width: 'auto' }}
                  exit={{ opacity: 0, width: 0 }}
                  className="overflow-hidden whitespace-nowrap"
                >
                  <span className="text-[15px] font-semibold tracking-tight text-white">Eken</span>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
          {!collapsed && (
            <button
              onClick={() => setCollapsed(true)}
              className="ml-auto hidden h-6 w-6 items-center justify-center rounded transition-colors lg:flex"
              style={{ color: '#5A6A82' }}
              onMouseEnter={(e) => (e.currentTarget.style.color = '#9CAABB')}
              onMouseLeave={(e) => (e.currentTarget.style.color = '#5A6A82')}
            >
              <ChevronRight size={13} className="rotate-180" />
            </button>
          )}
          {collapsed && (
            <button
              onClick={() => setCollapsed(false)}
              className="mx-auto flex h-6 w-6 items-center justify-center rounded transition-colors"
              style={{ color: '#5A6A82' }}
            >
              <ChevronRight size={13} />
            </button>
          )}
        </div>

        {/* Search */}
        <AnimatePresence>
          {!collapsed && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="px-3 pb-1 pt-3"
            >
              <div
                className="group flex h-8 cursor-pointer items-center gap-2 rounded px-2.5 transition-colors"
                style={{ background: '#253347', border: '1px solid #2D3E55' }}
              >
                <Search
                  size={12}
                  style={{ color: '#5A6A82' }}
                  className="flex-shrink-0 transition-colors group-hover:text-[#9CAABB]"
                />
                <span className="flex-1 text-[12.5px]" style={{ color: '#5A6A82' }}>
                  Sök...
                </span>
                <span
                  className="rounded px-1 text-[10px]"
                  style={{ background: '#1A2537', color: '#4A5A70' }}
                >
                  ⌘K
                </span>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Navigation */}
        <nav className="scrollbar-thin mt-1 flex-1 space-y-0.5 overflow-y-auto px-2 py-2">
          {NAV.map((item, i) => {
            const active = route === item.id
            return (
              <motion.button
                key={item.id}
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: i * 0.03 }}
                onClick={() => {
                  onNavigate(item.id)
                  setMobileOpen(false)
                }}
                title={collapsed ? item.label : undefined}
                className={cn(
                  'flex w-full items-center rounded transition-all duration-100',
                  collapsed ? 'h-9 justify-center px-0' : 'h-8 gap-2.5 px-2.5',
                )}
                style={{
                  background: active ? '#253347' : 'transparent',
                  color: active ? '#FFFFFF' : '#8899AE',
                  borderLeft: active ? '2px solid #27A85F' : '2px solid transparent',
                }}
                onMouseEnter={(e) => {
                  if (!active) {
                    e.currentTarget.style.background = '#1E2F45'
                    e.currentTarget.style.color = '#C5D0DC'
                  }
                }}
                onMouseLeave={(e) => {
                  if (!active) {
                    e.currentTarget.style.background = 'transparent'
                    e.currentTarget.style.color = '#8899AE'
                  }
                }}
              >
                <item.icon size={15} strokeWidth={active ? 2.2 : 1.8} className="flex-shrink-0" />
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
                  <span
                    className="flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold"
                    style={{ background: '#E53E3E', color: '#fff' }}
                  >
                    {item.badge}
                  </span>
                )}
              </motion.button>
            )
          })}
        </nav>

        {/* Bottom section */}
        <div
          className="flex-shrink-0 space-y-0.5 border-t px-2 pb-3 pt-2"
          style={{ borderColor: '#253347' }}
        >
          {[
            { icon: HelpCircle, label: 'Hjälp' },
            { icon: Settings, label: 'Inställningar' },
          ].map(({ icon: Icon, label }) => (
            <button
              key={label}
              className={cn(
                'flex w-full items-center rounded transition-colors duration-100',
                collapsed ? 'h-9 justify-center' : 'h-8 gap-2.5 px-2.5',
              )}
              style={{ color: '#5A6A82' }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = '#1E2F45'
                e.currentTarget.style.color = '#9CAABB'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'transparent'
                e.currentTarget.style.color = '#5A6A82'
              }}
            >
              <Icon size={14} strokeWidth={1.7} className="flex-shrink-0" />
              {!collapsed && <span className="text-[12.5px] font-medium">{label}</span>}
            </button>
          ))}

          {/* User */}
          <div
            className={cn(
              'mt-1 flex cursor-pointer items-center rounded transition-colors',
              collapsed ? 'justify-center p-1.5' : 'gap-2.5 px-2.5 py-1.5',
            )}
            style={{ borderTop: '1px solid #253347', marginTop: '6px', paddingTop: '10px' }}
          >
            <div
              className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded text-[11px] font-semibold text-white"
              style={{ background: 'linear-gradient(135deg, #7C3AED, #5B21B6)' }}
            >
              AA
            </div>
            <AnimatePresence>
              {!collapsed && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="min-w-0 flex-1"
                >
                  <p className="truncate text-[12.5px] font-semibold text-white">Anna Andersson</p>
                  <p className="truncate text-[11px]" style={{ color: '#5A6A82' }}>
                    admin@demo.se
                  </p>
                </motion.div>
              )}
            </AnimatePresence>
            {!collapsed && (
              <LogOut
                size={13}
                strokeWidth={1.7}
                style={{ color: '#5A6A82' }}
                className="flex-shrink-0"
              />
            )}
          </div>
        </div>
      </motion.aside>

      {/* ── MAIN ── */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* Topbar */}
        <header
          className="flex h-[52px] flex-shrink-0 items-center gap-3 bg-white px-5"
          style={{ borderBottom: '1px solid #E3E7EC' }}
        >
          <button
            onClick={() => setMobileOpen(true)}
            className="flex h-8 w-8 items-center justify-center rounded text-gray-500 hover:bg-gray-100 lg:hidden"
          >
            <Menu size={16} />
          </button>

          {/* Breadcrumb */}
          <div className="flex items-center gap-1.5 text-[13px]">
            <span style={{ color: '#8A95A3' }}>Eken</span>
            <ChevronRight size={12} style={{ color: '#C5CBD3' }} />
            <span className="font-medium" style={{ color: '#182030' }}>
              {NAV.find((n) => n.id === route)?.label ?? 'Översikt'}
            </span>
          </div>

          <div className="flex-1" />

          {/* Top right actions */}
          <button
            className="relative flex h-8 w-8 items-center justify-center rounded transition-colors hover:bg-gray-100"
            style={{ color: '#6B7684' }}
          >
            <Bell size={16} />
            <span
              className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full"
              style={{ background: '#E53E3E' }}
            />
          </button>

          <div className="h-[18px] w-px" style={{ background: '#E3E7EC' }} />

          <div className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 transition-colors hover:bg-gray-50">
            <div
              className="flex h-6 w-6 items-center justify-center rounded text-[10px] font-bold text-white"
              style={{ background: 'linear-gradient(135deg, #7C3AED, #5B21B6)' }}
            >
              AA
            </div>
            <span className="text-[13px] font-medium" style={{ color: '#182030' }}>
              Anna A.
            </span>
          </div>
        </header>

        {/* Page */}
        <main className="scrollbar-thin flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  )
}
