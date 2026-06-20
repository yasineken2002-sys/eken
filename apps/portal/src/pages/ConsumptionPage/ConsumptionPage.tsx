import { useQuery } from '@tanstack/react-query'
import { fetchConsumption } from '@/api/portal.api'
import { Spinner } from '@/components/ui/Spinner'
import { ErrorCard } from '@/components/ui/ErrorCard'
import type { PortalConsumptionCharge } from '@/types/portal.types'
import styles from './ConsumptionPage.module.css'

const METER: Record<
  PortalConsumptionCharge['meterType'],
  { label: string; unit: string; bg: string; color: string }
> = {
  ELECTRICITY: { label: 'El', unit: 'kWh', bg: '#fff4e0', color: '#d97706' },
  WATER_COLD: { label: 'Kallvatten', unit: 'm³', bg: '#e0f2fe', color: '#0284c7' },
  WATER_HOT: { label: 'Varmvatten', unit: 'm³', bg: '#fce8e8', color: '#dc2626' },
  HEATING: { label: 'Värme', unit: 'kWh', bg: '#fdeede', color: '#ea580c' },
}

// Mjuk "hög förbrukning"-tröskel: en period som är mer än så här många gånger
// hyresgästens snitt för samma mätartyp markeras rött. Ren visuell hjälp.
const HIGH_FACTOR = 1.3

function formatPeriod(startStr: string, endStr: string): string {
  const start = new Date(startStr)
  const end = new Date(endStr)
  const opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' }
  const fmt = new Intl.DateTimeFormat('sv-SE', opts)
  return `${fmt.format(start)} – ${fmt.format(end)} ${end.getFullYear()}`
}

function formatSek(amount: number): string {
  return new Intl.NumberFormat('sv-SE', {
    style: 'currency',
    currency: 'SEK',
    maximumFractionDigits: 0,
  }).format(amount)
}

function formatQty(value: number): string {
  return value.toLocaleString('sv-SE', { maximumFractionDigits: 3 })
}

function ChargeCard({ charge, high }: { charge: PortalConsumptionCharge; high: boolean }) {
  const meter = METER[charge.meterType]
  return (
    <div className={styles.card}>
      <div className={styles.cardLeft}>
        <div className={styles.icon} style={{ background: meter.bg, color: meter.color }}>
          <span className={styles.iconDot} style={{ background: meter.color }} />
        </div>
        <div className={styles.info}>
          <p className={styles.title}>{meter.label}</p>
          <p className={styles.period}>{formatPeriod(charge.periodStart, charge.periodEnd)}</p>
        </div>
      </div>
      <div className={styles.cardRight}>
        <p className={high ? styles.qtyHigh : styles.qty}>
          {formatQty(charge.quantity)} {meter.unit}
          {high && <span className={styles.highTag}>Hög</span>}
        </p>
        <p className={styles.amount}>{formatSek(charge.totalAmount)}</p>
      </div>
    </div>
  )
}

export function ConsumptionPage() {
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['portal', 'consumption'],
    queryFn: fetchConsumption,
  })

  if (isLoading) return <Spinner size="md" label="Laddar förbrukning..." />
  if (isError || !data) {
    return <ErrorCard onRetry={() => void refetch()} />
  }

  // Snitt per mätartyp för den mjuka "hög"-markeringen.
  const byType = new Map<string, number[]>()
  for (const c of data) {
    const arr = byType.get(c.meterType) ?? []
    arr.push(c.quantity)
    byType.set(c.meterType, arr)
  }
  function isHigh(c: PortalConsumptionCharge): boolean {
    const arr = byType.get(c.meterType) ?? []
    if (arr.length < 2) return false
    const avg = arr.reduce((s, q) => s + q, 0) / arr.length
    return avg > 0 && c.quantity > HIGH_FACTOR * avg
  }

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h1 className={styles.pageTitle}>Min förbrukning</h1>
        <p className={styles.subtitle}>El, vatten och värme per period</p>
      </div>

      {data.length === 0 ? (
        <div className={styles.empty}>
          <div className={styles.emptyIconWrap}>
            <svg width="32" height="32" viewBox="0 0 22 22" fill="none">
              <path
                d="M11 2v7M11 9l-4 7h8l-4-7z"
                stroke="#aaa"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <p className={styles.emptyText}>Ingen förbrukning registrerad ännu</p>
        </div>
      ) : (
        <div className={styles.list}>
          {data.map((c) => (
            <ChargeCard key={c.id} charge={c} high={isHigh(c)} />
          ))}
        </div>
      )}
    </div>
  )
}
