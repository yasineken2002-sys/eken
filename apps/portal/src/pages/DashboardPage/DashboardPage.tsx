import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { fetchDashboard } from '@/api/portal.api'
import { StatusBadge } from '@/components/ui/StatusBadge'
import { Spinner } from '@/components/ui/Spinner'
import { ErrorCard } from '@/components/ui/ErrorCard'
import styles from './DashboardPage.module.css'

function getGreeting(): string {
  const hour = new Date().getHours()
  if (hour < 10) return 'God morgon'
  if (hour < 18) return 'God eftermiddag'
  return 'God kväll'
}

function formatDateSv(): string {
  return new Intl.DateTimeFormat('sv-SE', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(new Date())
}

function formatCurrencySv(amount: number): string {
  return new Intl.NumberFormat('sv-SE', {
    style: 'currency',
    currency: 'SEK',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount)
}

function formatDateShort(dateStr: string): string {
  return new Intl.DateTimeFormat('sv-SE', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(dateStr))
}

function formatMonthYear(dateStr: string): string {
  return new Intl.DateTimeFormat('sv-SE', {
    month: 'long',
    year: 'numeric',
  }).format(new Date(dateStr))
}

// ── SVG icons for quick-action cards ──────────────────

function AvierSvg() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
      <rect x="3" y="4" width="16" height="15" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <line x1="3" y1="8" x2="19" y2="8" stroke="currentColor" strokeWidth="1" />
      <line x1="7" y1="12" x2="15" y2="12" stroke="currentColor" strokeWidth="1" opacity="0.7" />
      <line x1="7" y1="15" x2="12" y2="15" stroke="currentColor" strokeWidth="1" opacity="0.5" />
    </svg>
  )
}

function NyheterSvg() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
      <rect x="4" y="3" width="14" height="16" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <line x1="7" y1="8" x2="15" y2="8" stroke="currentColor" strokeWidth="1" opacity="0.7" />
      <line x1="7" y1="11" x2="15" y2="11" stroke="currentColor" strokeWidth="1" opacity="0.5" />
      <line x1="7" y1="14" x2="11" y2="14" stroke="currentColor" strokeWidth="1" opacity="0.4" />
    </svg>
  )
}

function FelanmalanSvg() {
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

function DokumentSvg() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
      <rect x="5" y="3" width="12" height="16" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <line x1="8" y1="8" x2="14" y2="8" stroke="currentColor" strokeWidth="1" opacity="0.7" />
      <line x1="8" y1="11" x2="14" y2="11" stroke="currentColor" strokeWidth="1" opacity="0.5" />
    </svg>
  )
}

export function DashboardPage() {
  const navigate = useNavigate()
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['portal', 'dashboard'],
    queryFn: fetchDashboard,
  })

  if (isLoading) {
    return <Spinner size="lg" label="Laddar din portal..." />
  }

  if (isError || !data) {
    return <ErrorCard isUnderConstruction onRetry={() => void refetch()} />
  }

  const { tenant, activeLease, overdueInvoices, upcomingInvoice, openMaintenanceTickets } = data

  const firstName =
    tenant.type === 'COMPANY'
      ? (tenant.companyName ?? 'Hyresgäst')
      : (tenant.firstName ?? 'Hyresgäst')

  return (
    <div className={styles.page}>
      {/* ── Green gradient header with houses ── */}
      <div className={styles.header}>
        <div className={styles.headerText}>
          <p className={styles.greeting}>
            {getGreeting()}, {firstName}! 👋
          </p>
          <p className={styles.date}>{formatDateSv()}</p>
        </div>

        {/* SVG house silhouettes */}
        <svg
          style={{ position: 'absolute', bottom: 0, left: 0, width: '100%' }}
          height="120"
          viewBox="0 0 380 120"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <rect x="0" y="90" width="380" height="30" fill="#f0f4f0" />
          <path
            d="M0,100 Q95,88 190,95 Q285,102 380,90 L380,120 L0,120Z"
            fill="#e8f0e8"
            opacity="0.8"
          />
          <rect x="55" y="48" width="38" height="42" rx="3" fill="#164022" opacity="0.7" />
          <polygon points="55,48 93,48 74,26" fill="#1c5530" opacity="0.8" />
          <rect x="63" y="62" width="9" height="28" rx="1" fill="#0f2c17" opacity="0.9" />
          <rect x="76" y="56" width="11" height="9" rx="1" fill="#ffffff18" />
          <ellipse cx="74" cy="92" rx="20" ry="7" fill="#2d6e3e" opacity="0.6" />
          <rect x="138" y="38" width="52" height="52" rx="3" fill="#164022" opacity="0.7" />
          <polygon points="138,38 190,38 164,14" fill="#1c5530" opacity="0.8" />
          <rect x="148" y="54" width="11" height="36" rx="1" fill="#0f2c17" opacity="0.9" />
          <rect x="163" y="50" width="13" height="11" rx="1" fill="#ffffff18" />
          <ellipse cx="164" cy="88" rx="26" ry="8" fill="#2d6e3e" opacity="0.6" />
          <rect x="238" y="44" width="42" height="46" rx="3" fill="#164022" opacity="0.7" />
          <polygon points="238,44 280,44 259,22" fill="#1c5530" opacity="0.8" />
          <rect x="246" y="58" width="9" height="32" rx="1" fill="#0f2c17" opacity="0.9" />
          <rect x="259" y="54" width="12" height="10" rx="1" fill="#ffffff18" />
          <ellipse cx="259" cy="88" rx="22" ry="7" fill="#2d6e3e" opacity="0.6" />
          <rect x="300" y="56" width="30" height="34" rx="3" fill="#164022" opacity="0.6" />
          <polygon points="300,56 330,56 315,38" fill="#1c5530" opacity="0.7" />
        </svg>
      </div>

      {/* ── Content ── */}
      <div className={styles.content}>
        {/* Overdue alert */}
        {overdueInvoices > 0 && (
          <div className={styles.alertCard}>
            <span className={styles.alertText}>
              ⚠️ {overdueInvoices} förfallen{overdueInvoices > 1 ? 'a' : ''} avi
              {overdueInvoices > 1 ? 'er' : ''}
            </span>
            <button className={styles.alertBtn} onClick={() => navigate('/notices')}>
              Visa
            </button>
          </div>
        )}

        {/* Lease card */}
        {activeLease ? (
          <div className={styles.leaseCard}>
            <div className={styles.leaseTop}>
              <div>
                <p className={styles.leaseRent}>{formatCurrencySv(activeLease.monthlyRent)}</p>
                <p className={styles.leaseRentLabel}>per månad</p>
              </div>
              <StatusBadge type="lease" status={activeLease.status} />
            </div>
            <div className={styles.leaseMeta}>
              <div className={styles.leaseMetaBox}>
                <p className={styles.leaseMetaLabel}>Adress</p>
                <p className={styles.leaseMetaValue}>
                  {activeLease.property.street}, {activeLease.property.city}
                </p>
              </div>
              <div className={styles.leaseMetaBox}>
                <p className={styles.leaseMetaLabel}>
                  {upcomingInvoice ? 'Nästa förfallodatum' : 'Startdatum'}
                </p>
                <p className={styles.leaseMetaValue}>
                  {upcomingInvoice
                    ? formatDateShort(upcomingInvoice.dueDate)
                    : formatDateShort(activeLease.startDate)}
                </p>
              </div>
            </div>
          </div>
        ) : (
          <div className={styles.noLeaseCard}>
            <p>Du har inget aktivt hyresavtal.</p>
          </div>
        )}

        {/* 2×2 Quick action grid */}
        <div className={styles.actionGrid}>
          <button className={styles.actionCard} onClick={() => navigate('/notices')}>
            <div className={styles.actionIcon} style={{ background: '#e8f0fd', color: '#3b82f6' }}>
              <AvierSvg />
            </div>
            <p className={styles.actionTitle}>Avier</p>
            <p className={styles.actionSub}>
              {overdueInvoices > 0 ? `${overdueInvoices} obetalda` : 'Inga förfallna'}
            </p>
          </button>

          <button className={styles.actionCard} onClick={() => navigate('/news')}>
            <div className={styles.actionIcon} style={{ background: '#fef3e2', color: '#f59e0b' }}>
              <NyheterSvg />
            </div>
            <p className={styles.actionTitle}>Nyheter</p>
            <p className={styles.actionSub}>Från hyresvärden</p>
          </button>

          <button className={styles.actionCard} onClick={() => navigate('/maintenance')}>
            <div className={styles.actionIcon} style={{ background: '#fce8e8', color: '#ef4444' }}>
              <FelanmalanSvg />
            </div>
            <p className={styles.actionTitle}>Felanmälan</p>
            <p className={styles.actionSub}>
              {openMaintenanceTickets > 0 ? `${openMaintenanceTickets} öppna` : 'Rapportera fel'}
            </p>
          </button>

          <button className={styles.actionCard} onClick={() => navigate('/documents')}>
            <div className={styles.actionIcon} style={{ background: '#f0eaff', color: '#8b5cf6' }}>
              <DokumentSvg />
            </div>
            <p className={styles.actionTitle}>Dokument</p>
            <p className={styles.actionSub}>Avtal &amp; filer</p>
          </button>
        </div>

        {/* Latest notice card */}
        {upcomingInvoice && (
          <div className={styles.noticeCard}>
            <div className={styles.noticeHeader}>
              <p className={styles.noticeHeaderTitle}>Senaste avi</p>
              <button className={styles.noticeHeaderLink} onClick={() => navigate('/notices')}>
                Visa alla →
              </button>
            </div>
            <div className={styles.noticeRow}>
              <div>
                <p className={styles.noticeMonth}>{formatMonthYear(upcomingInvoice.issueDate)}</p>
                <p className={styles.noticeDue}>
                  Förfaller {formatDateShort(upcomingInvoice.dueDate)}
                </p>
              </div>
              <div className={styles.noticeRight}>
                <p className={styles.noticeAmount}>{formatCurrencySv(upcomingInvoice.total)}</p>
                <StatusBadge type="invoice" status={upcomingInvoice.status} />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
