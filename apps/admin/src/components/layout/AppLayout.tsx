import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import {
  LayoutDashboard,
  Building2,
  Receipt,
  AlertTriangle,
  BarChart3,
  Settings,
  LogOut,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { useAuthStore } from '@/stores/auth.store'
import { get } from '@/lib/api'
import { cn } from '@/lib/cn'

type ErrorSummary = {
  total: { CRITICAL: number; ERROR: number; WARNING: number }
  unresolvedCritical: number
}

const navItems = [
  { to: '/', label: 'Översikt', icon: LayoutDashboard, exact: true },
  { to: '/organizations', label: 'Kunder', icon: Building2 },
  { to: '/billing', label: 'Fakturor', icon: Receipt },
  { to: '/errors', label: 'Fel-logg', icon: AlertTriangle, showBadge: true },
  { to: '/stats', label: 'Statistik', icon: BarChart3 },
  { to: '/settings', label: 'Inställningar', icon: Settings },
]

export function AppLayout() {
  const user = useAuthStore((s) => s.user)
  const logout = useAuthStore((s) => s.logout)
  const navigate = useNavigate()
  const [summary, setSummary] = useState<ErrorSummary | null>(null)

  useEffect(() => {
    let cancelled = false
    get<ErrorSummary>('/platform/errors/summary')
      .then((d) => {
        if (!cancelled) setSummary(d)
      })
      .catch(() => undefined)
    const id = setInterval(() => {
      get<ErrorSummary>('/platform/errors/summary')
        .then((d) => {
          if (!cancelled) setSummary(d)
        })
        .catch(() => undefined)
    }, 60_000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [])

  const doLogout = () => {
    logout()
    navigate('/login', { replace: true })
  }

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 flex h-screen w-64 flex-col border-r border-[#EAEDF0] bg-white">
        <div className="px-5 py-5">
          <div className="text-[13px] font-semibold uppercase tracking-wide text-gray-400">
            Eken
          </div>
          <div className="text-[15px] font-semibold text-gray-900">Platform Admin</div>
        </div>
        <nav className="flex-1 space-y-0.5 px-3">
          {navItems.map(({ to, label, icon: Icon, exact, showBadge }) => (
            <NavLink
              key={to}
              to={to}
              end={exact ?? false}
              className={({ isActive }) =>
                cn(
                  'flex items-center justify-between gap-3 rounded-lg px-3 py-2 text-[13.5px] font-medium transition-colors',
                  isActive ? 'bg-gray-100 text-gray-900' : 'text-gray-600 hover:bg-gray-50',
                )
              }
            >
              <span className="flex items-center gap-3">
                <Icon size={16} strokeWidth={1.8} />
                {label}
              </span>
              {showBadge && summary && summary.unresolvedCritical > 0 ? (
                <span className="inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-red-600 px-1.5 text-[11px] font-semibold text-white">
                  {summary.unresolvedCritical}
                </span>
              ) : null}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-[#EAEDF0] px-4 py-4">
          <div className="mb-3 flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-blue-100 text-[13px] font-semibold text-blue-700">
              {user ? `${user.firstName.charAt(0)}${user.lastName.charAt(0)}` : '?'}
            </div>
            <div className="flex-1 overflow-hidden">
              <div className="truncate text-[13px] font-medium text-gray-900">
                {user?.firstName} {user?.lastName}
              </div>
              <div className="truncate text-[11.5px] text-gray-500">{user?.email}</div>
            </div>
          </div>
          <button
            onClick={doLogout}
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-[13px] text-gray-600 hover:bg-gray-50"
          >
            <LogOut size={14} />
            Logga ut
          </button>
        </div>
      </aside>
      <main className="flex-1 bg-[#F7F8FA]">
        <div className="mx-auto max-w-[1280px] px-8 py-8">
          <Outlet />
        </div>
      </main>
    </div>
  )
}
