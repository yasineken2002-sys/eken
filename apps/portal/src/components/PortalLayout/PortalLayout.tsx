import { useEffect, useState } from 'react'
import { Link, Outlet, NavLink, useLocation } from 'react-router-dom'
import { TenantAiChat, TenantAiFab } from '@/features/ai/TenantAiChat'
import {
  EvBell,
  EvHome,
  EvReceipt,
  EvWrench,
  EvMail,
  EvMenu,
  EvArrowLeft,
} from '@/components/ui/EvenoIcons'
import { useSessionStore } from '@/store/session.store'
import styles from './PortalLayout.module.css'

function PortalFooter() {
  const year = new Date().getFullYear()
  return (
    <footer className={styles.footer}>
      <p className={styles.footerCopy}>© {year} Eveno AB</p>
      <div className={styles.footerLinks}>
        <Link to="/legal/villkor">Användarvillkor</Link>
        <Link to="/legal/integritet">Integritetspolicy</Link>
        <Link to="/legal/cookies">Cookies</Link>
      </div>
    </footer>
  )
}

interface RouteMeta {
  title: string
  showTopHeader: boolean
}

const ROUTE_META: Record<string, RouteMeta> = {
  '/': { title: '', showTopHeader: true },
  '/dashboard': { title: '', showTopHeader: true },
  '/notices': { title: 'Mina avier', showTopHeader: false },
  '/maintenance': { title: 'Felanmälan', showTopHeader: false },
  '/news': { title: 'Nyheter', showTopHeader: false },
  '/documents': { title: 'Dokument', showTopHeader: false },
  '/installningar': { title: 'Konto', showTopHeader: false },
}

function getMeta(pathname: string): RouteMeta {
  return ROUTE_META[pathname] ?? { title: '', showTopHeader: false }
}

function getInitials(
  tenant: { type: string; firstName?: string; lastName?: string; companyName?: string } | null,
): string {
  if (!tenant) return 'EV'
  if (tenant.type === 'COMPANY' && tenant.companyName) {
    const parts = tenant.companyName.trim().split(/\s+/)
    return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || 'EV'
  }
  const a = tenant.firstName?.[0] ?? ''
  const b = tenant.lastName?.[0] ?? ''
  return (a + b).toUpperCase() || 'EV'
}

function TopHeader() {
  const tenant = useSessionStore((s) => s.tenant)
  return (
    <header className="ev-top-header">
      <div className="ev-top-header-inner">
        <div className="ev-brand">
          <div className="ev-brand-mark" aria-hidden="true">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path
                d="M4 13.5V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v8.5"
                stroke="#fff"
                strokeWidth="1.4"
                strokeLinecap="round"
              />
              <circle cx="9.6" cy="9" r="0.7" fill="#fff" />
            </svg>
          </div>
          <div className="ev-brand-wordmark">eveno</div>
        </div>
        <div className="ev-header-actions">
          <NavLink to="/news" className="ev-icon-btn" aria-label="Notiser">
            <EvBell size={18} />
            <span className="ev-notif-dot"></span>
          </NavLink>
          <Link to="/installningar" className="ev-avatar" title={tenant?.firstName ?? 'Konto'}>
            {getInitials(tenant)}
          </Link>
        </div>
      </div>
    </header>
  )
}

function SubHeader({ title }: { title: string }) {
  // History-aware back: go back to Hem from any subview
  return (
    <div className="ev-sub-header">
      <Link to="/" className="ev-icon-btn" aria-label="Tillbaka">
        <EvArrowLeft size={20} />
      </Link>
      <div className="ev-sub-header-title">{title}</div>
      <div style={{ width: 36 }} />
    </div>
  )
}

const NAV_ITEMS: { to: string; label: string; Icon: typeof EvHome; end: boolean }[] = [
  { to: '/', label: 'Hem', Icon: EvHome, end: true },
  { to: '/notices', label: 'Avier', Icon: EvReceipt, end: false },
  { to: '/maintenance', label: 'Ärenden', Icon: EvWrench, end: false },
  { to: '/news', label: 'Nyheter', Icon: EvMail, end: false },
  { to: '/installningar', label: 'Mer', Icon: EvMenu, end: false },
]

export function PortalLayout() {
  const location = useLocation()
  const [aiOpen, setAiOpen] = useState(false)
  const [initialMessage, setInitialMessage] = useState<string | undefined>()

  useEffect(() => {
    const handler = (e: Event) => {
      const ce = e as CustomEvent<{ message?: string }>
      setInitialMessage(ce.detail?.message ?? undefined)
      setAiOpen(true)
    }
    window.addEventListener('eveno-portal-ask-ai', handler)
    return () => window.removeEventListener('eveno-portal-ask-ai', handler)
  }, [])

  useEffect(() => {
    setAiOpen(false)
  }, [location.pathname])

  const meta = getMeta(location.pathname)

  return (
    <div className="ev-app" data-screen-label={`portal${location.pathname}`}>
      {meta.showTopHeader ? <TopHeader /> : <SubHeader title={meta.title} />}

      <main className={styles.main}>
        <Outlet />
        <PortalFooter />
      </main>

      <TenantAiFab onClick={() => setAiOpen(true)} hidden={aiOpen} />

      <TenantAiChat
        open={aiOpen}
        onClose={() => {
          setAiOpen(false)
          setInitialMessage(undefined)
        }}
        initialMessage={initialMessage}
      />

      <nav className="ev-bottom-nav" aria-label="Navigering">
        {NAV_ITEMS.map((item) => {
          const Icon = item.Icon
          return (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => `ev-nav-item${isActive ? 'active' : ''}`}
            >
              {({ isActive }) => (
                <>
                  <Icon size={20} stroke={isActive ? 2.1 : 1.8} />
                  <span>{item.label}</span>
                </>
              )}
            </NavLink>
          )
        })}
      </nav>
    </div>
  )
}
