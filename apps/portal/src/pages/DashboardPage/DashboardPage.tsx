import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { fetchDashboard, fetchNews } from '@/api/portal.api'
import { Spinner } from '@/components/ui/Spinner'
import { ErrorCard } from '@/components/ui/ErrorCard'
import {
  EvDownload,
  EvWrench,
  EvMail,
  EvFileText,
  EvSparkles,
  EvDroplet,
} from '@/components/ui/EvenoIcons'

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
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(new Date(dateStr))
    .replace(/\//g, '-')
}

function formatMonth(dateStr: string): string {
  return new Intl.DateTimeFormat('sv-SE', { month: 'long' }).format(new Date(dateStr))
}

function daysBetween(target: Date, now: Date): number {
  const ms = target.getTime() - now.getTime()
  return Math.round(ms / (1000 * 60 * 60 * 24))
}

export function DashboardPage() {
  const navigate = useNavigate()
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['portal', 'dashboard'],
    queryFn: fetchDashboard,
  })

  const newsQuery = useQuery({
    queryKey: ['portal', 'news'],
    queryFn: fetchNews,
  })

  if (isLoading) {
    return (
      <div className="ev-page ev-view-enter">
        <Spinner size="lg" label="Laddar din portal..." />
      </div>
    )
  }

  if (isError || !data) {
    return (
      <div className="ev-page ev-view-enter">
        <ErrorCard isUnderConstruction onRetry={() => void refetch()} />
      </div>
    )
  }

  const { tenant, activeLease, overdueInvoices, upcomingInvoice, openMaintenanceTickets } = data

  const firstName =
    tenant.type === 'COMPANY'
      ? (tenant.companyName ?? 'Hyresgäst')
      : (tenant.firstName ?? 'Hyresgäst')

  const propertyAddress = activeLease ? activeLease.property.street : ''
  const unitName = activeLease?.unit.name ?? ''

  const hero = upcomingInvoice
  const heroDue = hero ? new Date(hero.dueDate) : null
  const now = new Date()
  const isOverdue = hero && heroDue && (hero.status === 'OVERDUE' || heroDue < now)
  const daysOff = heroDue ? Math.abs(daysBetween(heroDue, now)) : 0

  const latestNews = newsQuery.data?.[0]

  return (
    <div className="ev-page ev-view-enter">
      <div className="ev-page-greet">Hej {firstName} 👋</div>
      <h1 className="ev-page-h1">
        {propertyAddress || 'Välkommen tillbaka'}
        {unitName && (
          <>
            ,<br />
            {unitName}
          </>
        )}
      </h1>

      {/* Invoice hero card */}
      {hero && (
        <div className={`${isOverdue ? 'ev-card-priority' : 'ev-card'} ev-invoice-hero`}>
          <div className="ev-invoice-hero-head">
            <span className="ev-invoice-hero-label">Hyra för {formatMonth(hero.issueDate)}</span>
            {isOverdue ? (
              <span className="ev-badge danger">
                <span className="ev-badge-dot"></span>
                Förfallen
              </span>
            ) : (
              <span className="ev-badge info">
                <span className="ev-badge-dot"></span>
                Att betala
              </span>
            )}
          </div>
          <div>
            <div className="ev-invoice-hero-amount">{formatCurrencySv(hero.total)}</div>
            <div className="ev-invoice-hero-due">
              {isOverdue ? (
                <>
                  Förföll {formatDateShort(hero.dueDate)} ·{' '}
                  <strong>
                    {daysOff} {daysOff === 1 ? 'dag' : 'dagar'} sen
                  </strong>
                </>
              ) : (
                <>
                  Förfaller {formatDateShort(hero.dueDate)}
                  {heroDue && (
                    <>
                      {' '}
                      ·{' '}
                      <strong className="upcoming">
                        om {daysOff} {daysOff === 1 ? 'dag' : 'dagar'}
                      </strong>
                    </>
                  )}
                </>
              )}
            </div>
          </div>
          <button
            type="button"
            className="ev-btn ev-btn-primary ev-btn-full"
            onClick={() => navigate('/notices')}
          >
            <EvDownload size={15} stroke={2} />
            Ladda ner avi
          </button>
        </div>
      )}

      {/* KPI mini cards */}
      <div className="ev-kpi-row">
        <div className="ev-kpi-mini">
          <div className="ev-kpi-mini-head">
            <div className="ev-kpi-mini-icon">
              <EvFileText size={13} />
            </div>
            <div className="ev-kpi-mini-label">Kontrakt</div>
          </div>
          <div className="ev-kpi-mini-value">
            {activeLease ? (activeLease.endDate ? 'Tidsbestämt' : 'Tillsvidare') : 'Inget aktivt'}
          </div>
          <div className="ev-kpi-mini-sub">
            {activeLease ? `sedan ${formatDateShort(activeLease.startDate).slice(0, 7)}` : ''}
          </div>
        </div>

        <div className="ev-kpi-mini">
          <div className="ev-kpi-mini-head">
            <div className={`ev-kpi-mini-icon ${openMaintenanceTickets > 0 ? 'warning' : ''}`}>
              <EvWrench size={13} />
            </div>
            <div className="ev-kpi-mini-label">Mina ärenden</div>
          </div>
          <div className="ev-kpi-mini-value">
            {openMaintenanceTickets > 0
              ? `${openMaintenanceTickets} ${openMaintenanceTickets === 1 ? 'öppet' : 'öppna'}`
              : 'Inga öppna'}
          </div>
          <div className={`ev-kpi-mini-sub ${openMaintenanceTickets > 0 ? 'warning' : ''}`}>
            {openMaintenanceTickets > 0 ? 'Pågående' : 'Allt OK'}
          </div>
        </div>
      </div>

      {/* Latest news */}
      {latestNews && (
        <>
          <div className="ev-section-title">
            <span>Nyhet från ägaren</span>
            <button type="button" className="ev-link" onClick={() => navigate('/news')}>
              Visa alla
            </button>
          </div>
          <button type="button" className="ev-list-card" onClick={() => navigate('/news')}>
            <div className="ev-list-card-icon info">
              <EvMail size={16} />
            </div>
            <div className="ev-list-card-body">
              <div className="ev-list-card-title">{latestNews.title}</div>
              <div className="ev-list-card-text">
                {latestNews.body.length > 120
                  ? `${latestNews.body.slice(0, 120)}…`
                  : latestNews.body}
              </div>
              <div className="ev-list-card-meta">
                {formatDateShort(latestNews.publishedAt)}
                {latestNews.authorName ? ` · ${latestNews.authorName}` : ''}
              </div>
            </div>
          </button>
        </>
      )}

      {/* Overdue/maintenance promo */}
      {openMaintenanceTickets > 0 && (
        <>
          <div className="ev-section-title">
            <span>Pågående ärenden</span>
            <button type="button" className="ev-link" onClick={() => navigate('/maintenance')}>
              Visa alla
            </button>
          </div>
          <button type="button" className="ev-list-card" onClick={() => navigate('/maintenance')}>
            <div className="ev-list-card-icon warning">
              <EvDroplet size={16} />
            </div>
            <div className="ev-list-card-body">
              <div className="ev-list-card-title">
                {openMaintenanceTickets === 1
                  ? 'Du har 1 öppet ärende'
                  : `Du har ${openMaintenanceTickets} öppna ärenden`}
                <span className="ev-badge warning">
                  <span className="ev-badge-dot"></span>
                  Pågående
                </span>
              </div>
              <div className="ev-list-card-meta">Tryck för att se status och uppdateringar</div>
            </div>
          </button>
        </>
      )}

      {/* Overdue invoice quick-link */}
      {overdueInvoices > 0 && !isOverdue && (
        <>
          <div className="ev-section-title">
            <span>Att åtgärda</span>
          </div>
          <button type="button" className="ev-list-card" onClick={() => navigate('/notices')}>
            <div className="ev-list-card-icon danger">
              <EvDownload size={16} />
            </div>
            <div className="ev-list-card-body">
              <div className="ev-list-card-title">
                {overdueInvoices === 1 ? '1 förfallen avi' : `${overdueInvoices} förfallna avier`}
                <span className="ev-badge danger">
                  <span className="ev-badge-dot"></span>
                  Förfallen
                </span>
              </div>
              <div className="ev-list-card-meta">Öppna avier för att betala</div>
            </div>
          </button>
        </>
      )}

      {/* Quick actions */}
      <div className="ev-section-title">
        <span>Snabbåtgärder</span>
      </div>
      <div className="ev-quick-grid">
        <button type="button" className="ev-quick-tile" onClick={() => navigate('/maintenance')}>
          <div className="ev-quick-tile-icon">
            <EvWrench size={16} />
          </div>
          <div className="ev-quick-tile-label">Felanmäl</div>
        </button>

        <button type="button" className="ev-quick-tile" onClick={() => navigate('/news')}>
          <div className="ev-quick-tile-icon">
            <EvMail size={16} />
          </div>
          <div className="ev-quick-tile-label">Meddelanden</div>
        </button>

        <button type="button" className="ev-quick-tile" onClick={() => navigate('/documents')}>
          <div className="ev-quick-tile-icon">
            <EvFileText size={16} />
          </div>
          <div className="ev-quick-tile-label">Dokument</div>
        </button>

        <button
          type="button"
          className="ev-quick-tile ai"
          onClick={() => {
            window.dispatchEvent(new CustomEvent('eveno-portal-ask-ai'))
          }}
        >
          <div className="ev-quick-tile-icon">
            <EvSparkles size={16} />
          </div>
          <div className="ev-quick-tile-label">AI-hjälp</div>
        </button>
      </div>
    </div>
  )
}
