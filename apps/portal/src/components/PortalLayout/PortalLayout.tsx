import { useEffect, useState } from 'react'
import { Outlet, NavLink, useLocation } from 'react-router-dom'
import { TenantAiChat, TenantAiFab } from '@/features/ai/TenantAiChat'
import styles from './PortalLayout.module.css'

function HemIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
      <path
        d="M11 3 L19 9 L19 19 L3 19 L3 9 Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <rect x="8" y="13" width="6" height="6" rx="1" fill="currentColor" opacity="0.8" />
      <path d="M1 9 L11 2 L21 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

function AvierIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
      <rect x="3" y="4" width="16" height="15" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <line x1="3" y1="8" x2="19" y2="8" stroke="currentColor" strokeWidth="1" />
      <line x1="7" y1="12" x2="15" y2="12" stroke="currentColor" strokeWidth="1" opacity="0.6" />
      <line x1="7" y1="15" x2="12" y2="15" stroke="currentColor" strokeWidth="1" opacity="0.4" />
    </svg>
  )
}

function FelanmalanIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
      <circle cx="11" cy="8" r="3.5" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M4 20 Q4 14 11 14 Q18 14 18 20"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <line
        x1="16"
        y1="4"
        x2="19"
        y2="4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <line
        x1="17.5"
        y1="2.5"
        x2="17.5"
        y2="5.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  )
}

function NyheterIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
      <rect x="4" y="3" width="14" height="16" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <line x1="7" y1="8" x2="15" y2="8" stroke="currentColor" strokeWidth="1" opacity="0.6" />
      <line x1="7" y1="11" x2="15" y2="11" stroke="currentColor" strokeWidth="1" opacity="0.4" />
      <line x1="7" y1="14" x2="11" y2="14" stroke="currentColor" strokeWidth="1" opacity="0.3" />
    </svg>
  )
}

function DokumentIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
      <rect x="5" y="3" width="12" height="16" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <line x1="8" y1="8" x2="14" y2="8" stroke="currentColor" strokeWidth="1" opacity="0.6" />
      <line x1="8" y1="11" x2="14" y2="11" stroke="currentColor" strokeWidth="1" opacity="0.4" />
    </svg>
  )
}

function InstallningarIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
      <circle cx="11" cy="11" r="3" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M11 3v2M11 17v2M3 11h2M17 11h2M5.5 5.5l1.4 1.4M15.1 15.1l1.4 1.4M5.5 16.5l1.4-1.4M15.1 6.9l1.4-1.4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  )
}

const NAV_ITEMS: { to: string; label: string; icon: React.ReactNode; end: boolean }[] = [
  { to: '/', label: 'Hem', icon: <HemIcon />, end: true },
  { to: '/notices', label: 'Avier', icon: <AvierIcon />, end: false },
  { to: '/maintenance', label: 'Felanmälan', icon: <FelanmalanIcon />, end: false },
  { to: '/news', label: 'Nyheter', icon: <NyheterIcon />, end: false },
  { to: '/documents', label: 'Dokument', icon: <DokumentIcon />, end: false },
  { to: '/installningar', label: 'Konto', icon: <InstallningarIcon />, end: false },
]

export function PortalLayout() {
  const location = useLocation()
  const [aiOpen, setAiOpen] = useState(false)
  const [initialMessage, setInitialMessage] = useState<string | undefined>()

  // Lyssna på custom event från Dashboard-chips: ask-ai → öppna chatten med
  // en förifylld fråga.
  useEffect(() => {
    const handler = (e: Event) => {
      const ce = e as CustomEvent<{ message?: string }>
      setInitialMessage(ce.detail?.message ?? undefined)
      setAiOpen(true)
    }
    window.addEventListener('eveno-portal-ask-ai', handler)
    return () => window.removeEventListener('eveno-portal-ask-ai', handler)
  }, [])

  // Stäng AI när användaren navigerar bort (förbättrar UX på mobil)
  useEffect(() => {
    setAiOpen(false)
  }, [location.pathname])

  return (
    <div className={styles.shell}>
      <main className={styles.main}>
        <Outlet />
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

      <nav className={styles.tabBar} aria-label="Navigering">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) =>
              `${styles.tabItem} ${isActive ? styles.tabItemActive : ''}`
            }
          >
            <span className={styles.tabIcon}>{item.icon}</span>
            <span className={styles.tabLabel}>{item.label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  )
}
