import { useState, useMemo, useEffect, useRef } from 'react'
import { motion } from 'framer-motion'
import {
  Users,
  User,
  Building2,
  Mail,
  Phone,
  Hash,
  MapPin,
  Calendar,
  FileText,
  Home,
  FileSignature,
  Info,
} from 'lucide-react'
import { PageWrapper } from '@/components/ui/PageWrapper'
import { PageHeader } from '@/components/ui/PageHeader'
import { Modal } from '@/components/ui/Modal'
import { Input } from '@/components/ui/Input'
import { DataTable } from '@/components/ui/DataTable'
import { Badge, InvoiceStatusBadge, LeaseStatusBadge } from '@/components/ui/Badge'
import { StatCard } from '@/components/ui/StatCard'
import { EmptyState } from '@/components/ui/EmptyState'
import {
  useTenants,
  useTenant,
  useTenantActivationStatus,
  useResendActivation,
} from './hooks/useTenants'
import { formatCurrency, formatDate } from '@eken/shared'
import type { Tenant } from '@eken/shared'
import type { TenantWithCount, TenantDetail, LeaseWithUnit } from './api/tenants.api'
import { cn } from '@/lib/cn'

// ─── Types ────────────────────────────────────────────────────────────────────

type TenantTab = 'ALL' | 'INDIVIDUAL' | 'COMPANY'

const TABS: { id: TenantTab; label: string }[] = [
  { id: 'ALL', label: 'Alla' },
  { id: 'INDIVIDUAL', label: 'Privatpersoner' },
  { id: 'COMPANY', label: 'Företag' },
]

// ─── Helpers ──────────────────────────────────────────────────────────────────

function displayName(t: Pick<Tenant, 'type' | 'firstName' | 'lastName' | 'companyName'>): string {
  if (t.type === 'INDIVIDUAL') {
    return [t.firstName, t.lastName].filter(Boolean).join(' ') || '–'
  }
  return t.companyName ?? '–'
}

function formatUnitLabel(lease: LeaseWithUnit): string {
  return `${lease.unit.property.name} · ${lease.unit.name}`
}

// ─── Animation variants ───────────────────────────────────────────────────────

const container = { hidden: {}, show: { transition: { staggerChildren: 0.05 } } }
const item = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: 0.2 } },
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export function TenantsPage() {
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [tab, setTab] = useState<TenantTab>('ALL')
  const [selected, setSelected] = useState<TenantWithCount | null>(null)

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => setDebouncedSearch(search), 300)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [search])

  const { data: tenants = [], isLoading } = useTenants(debouncedSearch || undefined)
  const { data: selectedTenant } = useTenant(selected?.id ?? null)

  const filtered = useMemo(() => {
    if (tab === 'ALL') return tenants
    return tenants.filter((t) => t.type === tab)
  }, [tenants, tab])

  const individualCount = tenants.filter((t) => t.type === 'INDIVIDUAL').length
  const companyCount = tenants.filter((t) => t.type === 'COMPANY').length
  const withActiveContract = tenants.filter((t) => t.activeLease?.status === 'ACTIVE').length

  // ── Tabellkolumner ────────────────────────────────────────────────────────

  const columns = [
    {
      key: 'name',
      header: 'Hyresgäst',
      cell: (t: TenantWithCount) => (
        <div>
          <p className="font-medium text-gray-900">{displayName(t)}</p>
          <p className="mt-0.5 text-[11.5px] text-gray-400">
            {t.type === 'INDIVIDUAL' ? 'Privatperson' : 'Företag'}
          </p>
        </div>
      ),
    },
    {
      key: 'unit',
      header: 'Bostad',
      cell: (t: TenantWithCount) =>
        t.activeLease ? (
          <div className="flex items-center gap-1.5">
            <Home size={12} className="shrink-0 text-gray-300" />
            <span className="text-[13px] text-gray-700">{formatUnitLabel(t.activeLease)}</span>
          </div>
        ) : (
          <span className="text-[12.5px] italic text-gray-400">Inget aktivt kontrakt</span>
        ),
    },
    {
      key: 'lease',
      header: 'Kontrakt',
      cell: (t: TenantWithCount) =>
        t.activeLease ? <LeaseStatusBadge status={t.activeLease.status} /> : <span>–</span>,
    },
    {
      key: 'rent',
      header: 'Hyra/mån',
      cell: (t: TenantWithCount) =>
        t.activeLease ? (
          <span className="text-gray-700">{formatCurrency(Number(t.activeLease.monthlyRent))}</span>
        ) : (
          <span className="text-gray-400">–</span>
        ),
    },
    {
      key: 'invoices',
      header: 'Fakturor',
      align: 'center' as const,
      cell: (t: TenantWithCount) => <Badge variant="default">{t._count?.invoices ?? 0}</Badge>,
    },
    {
      key: 'portal',
      header: 'Portal',
      cell: (t: TenantWithCount) =>
        t.portalActivated ? (
          <Badge variant="success" dot>
            Aktiverad
          </Badge>
        ) : (
          <Badge variant="ghost" dot>
            Ej aktiverad
          </Badge>
        ),
    },
    {
      key: 'contact',
      header: 'Kontakt',
      cell: (t: TenantWithCount) => <span className="text-gray-500">{t.email}</span>,
    },
  ]

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <PageWrapper id="tenants">
      <PageHeader
        title="Hyresgäster"
        description={`${tenants.length} hyresgäster · läs-bar översikt`}
      />

      {/* Banner som förklarar att skapande sker via Kontrakt-flödet */}
      <div className="mt-6 flex items-start gap-2.5 rounded-xl border border-blue-100 bg-blue-50/60 px-4 py-3 text-[13px] text-blue-900">
        <Info size={14} strokeWidth={1.8} className="mt-0.5 shrink-0 text-blue-500" />
        <p>
          Hyresgäster skapas via <strong>Kontrakt</strong>-fliken när du registrerar ett nytt
          hyresavtal. Den här sidan är en översikt – för att lägga till en ny hyresgäst, gå till
          Kontrakt → Nytt kontrakt.
        </p>
      </div>

      {/* Stats */}
      <motion.div
        variants={container}
        initial="hidden"
        animate="show"
        className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4"
      >
        <motion.div variants={item}>
          <StatCard
            title="Totalt"
            value={tenants.length}
            icon={Users}
            iconColor="#2563EB"
            delay={0}
          />
        </motion.div>
        <motion.div variants={item}>
          <StatCard
            title="Aktiva kontrakt"
            value={withActiveContract}
            icon={FileSignature}
            iconColor="#16A34A"
            delay={0.05}
          />
        </motion.div>
        <motion.div variants={item}>
          <StatCard
            title="Privatpersoner"
            value={individualCount}
            icon={User}
            iconColor="#0B84D0"
            delay={0.1}
          />
        </motion.div>
        <motion.div variants={item}>
          <StatCard
            title="Företag"
            value={companyCount}
            icon={Building2}
            iconColor="#7C3AED"
            delay={0.15}
          />
        </motion.div>
      </motion.div>

      {/* Filter */}
      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-1 rounded-xl bg-gray-100/70 p-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                'h-8 rounded-lg px-3 text-[13px] font-medium transition-all',
                tab === t.id
                  ? 'bg-white text-gray-900 shadow-sm'
                  : 'text-gray-500 hover:text-gray-700',
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="w-64">
          <Input
            name="tenant-search"
            placeholder="Sök på namn eller e-post..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      {/* Tabell */}
      <div className="mt-4">
        {isLoading ? (
          <div className="flex items-center justify-center py-20 text-[13px] text-gray-400">
            Laddar hyresgäster…
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={Users}
            title="Inga hyresgäster"
            description={
              tenants.length === 0
                ? 'Hyresgäster skapas via Kontrakt-fliken när du registrerar ett nytt hyresavtal.'
                : 'Inga hyresgäster matchar det aktiva filtret.'
            }
          />
        ) : (
          <DataTable
            columns={columns}
            data={filtered}
            keyExtractor={(t) => t.id}
            onRowClick={(t) => setSelected(t)}
          />
        )}
      </div>

      {/* Detalj-modal (read-only) */}
      <Modal
        open={!!selected}
        onClose={() => setSelected(null)}
        title={selected ? displayName(selected) : ''}
        size="lg"
      >
        {selected && <DetailPanel selected={selected} selectedTenant={selectedTenant ?? null} />}
      </Modal>
    </PageWrapper>
  )
}

// ─── Detail panel ─────────────────────────────────────────────────────────────

interface DetailPanelProps {
  selected: TenantWithCount
  selectedTenant: TenantDetail | null
}

function DetailPanel({ selected, selectedTenant }: DetailPanelProps) {
  return (
    <div className="space-y-5">
      {/* Portal-aktivering */}
      <PortalActivationCard tenantId={selected.id} />

      {/* Kontaktinfo */}
      <div>
        <p className="mb-3 text-[13px] font-semibold text-gray-700">Kontaktuppgifter</p>
        <div className="grid grid-cols-2 gap-4 rounded-xl border border-gray-100 p-4">
          <InfoRow icon={Mail} label="E-post" value={selected.email} />
          <InfoRow icon={Phone} label="Telefon" value={selected.phone ?? '–'} />
          <InfoRow
            icon={Hash}
            label={selected.type === 'INDIVIDUAL' ? 'Personnummer' : 'Org.nummer'}
            value={
              selected.type === 'INDIVIDUAL'
                ? (selected.personalNumber ?? '–')
                : (selected.orgNumber ?? '–')
            }
          />
          <InfoRow
            icon={MapPin}
            label="Adress"
            value={
              selected.address
                ? `${selected.address.street}, ${selected.address.postalCode} ${selected.address.city}`
                : '–'
            }
          />
          <InfoRow icon={Calendar} label="Skapad" value={formatDate(selected.createdAt)} />
        </div>
      </div>

      {/* Kontrakts-historik */}
      <div>
        <p className="mb-3 text-[13px] font-semibold text-gray-700">Kontrakt</p>
        {selectedTenant?.leases && selectedTenant.leases.length > 0 ? (
          <div className="divide-y divide-gray-100 overflow-hidden rounded-xl border border-gray-100">
            {selectedTenant.leases.map((l) => (
              <div
                key={l.id}
                className="flex items-center justify-between px-4 py-3 hover:bg-gray-50/80"
              >
                <div className="flex items-center gap-2.5">
                  <Home size={13} strokeWidth={1.8} className="text-gray-400" />
                  <div>
                    <p className="text-[13px] font-medium text-gray-800">
                      {l.unit.property.name} · {l.unit.name}
                    </p>
                    <p className="mt-0.5 text-[11.5px] text-gray-400">
                      {formatDate(l.startDate)}
                      {l.endDate ? ` – ${formatDate(l.endDate)}` : ' – tills vidare'}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-3 text-[13px] text-gray-600">
                  <span>{formatCurrency(Number(l.monthlyRent))}/mån</span>
                  <LeaseStatusBadge status={l.status} />
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="rounded-xl border border-gray-100 py-8 text-center text-[13px] text-gray-400">
            Inga kontrakt registrerade
          </div>
        )}
      </div>

      {/* Senaste fakturor */}
      <div>
        <p className="mb-3 text-[13px] font-semibold text-gray-700">Senaste fakturor</p>
        {selectedTenant?.invoices && selectedTenant.invoices.length > 0 ? (
          <div className="divide-y divide-gray-100 overflow-hidden rounded-xl border border-gray-100">
            {selectedTenant.invoices.map((inv) => (
              <div
                key={inv.id}
                className="flex items-center justify-between px-4 py-3 hover:bg-gray-50/80"
              >
                <div className="flex items-center gap-2">
                  <FileText size={13} strokeWidth={1.8} className="text-gray-400" />
                  <span className="text-[13px] font-medium text-gray-800">{inv.invoiceNumber}</span>
                  <InvoiceStatusBadge status={inv.status} />
                </div>
                <div className="flex items-center gap-4 text-[13px] text-gray-500">
                  <span>{formatCurrency(Number(inv.total))}</span>
                  <span>{formatDate(inv.dueDate)}</span>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="rounded-xl border border-gray-100 py-8 text-center text-[13px] text-gray-400">
            Inga fakturor ännu
          </div>
        )}
      </div>
    </div>
  )
}

// ─── InfoRow ──────────────────────────────────────────────────────────────────

function InfoRow({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ElementType
  label: string
  value: string
}) {
  return (
    <div className="flex items-start gap-2.5">
      <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-gray-50">
        <Icon size={12} strokeWidth={1.8} className="text-gray-400" />
      </div>
      <div>
        <p className="text-[11px] font-medium uppercase tracking-wide text-gray-400">{label}</p>
        <p className="mt-0.5 text-[13px] text-gray-800">{value}</p>
      </div>
    </div>
  )
}

// ─── Portal Activation ────────────────────────────────────────────────────────

function PortalActivationCard({ tenantId }: { tenantId: string }) {
  const { data: status, isLoading } = useTenantActivationStatus(tenantId)
  const resend = useResendActivation()
  const [feedback, setFeedback] = useState<'idle' | 'sent' | 'error'>('idle')

  function handleResend() {
    setFeedback('idle')
    resend.mutate(tenantId, {
      onSuccess: () => setFeedback('sent'),
      onError: () => setFeedback('error'),
    })
  }

  return (
    <div>
      <p className="mb-3 text-[13px] font-semibold text-gray-700">Hyresgästportal</p>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-gray-100 p-4">
        <div className="flex flex-col gap-1">
          {isLoading ? (
            <span className="text-[12.5px] text-gray-400">Laddar status…</span>
          ) : status?.portalActivated ? (
            <>
              <Badge variant="success" dot>
                Portal aktiverad
              </Badge>
              {status.portalActivatedAt && (
                <span className="text-[11.5px] text-gray-400">
                  Aktiverad {formatDate(status.portalActivatedAt)}
                </span>
              )}
            </>
          ) : (
            <>
              <Badge variant="ghost" dot>
                Ej aktiverad
              </Badge>
              {status?.hasPendingActivationLink ? (
                <span className="text-[11.5px] text-gray-400">
                  Aktiveringslänk skickad
                  {status.activationTokenExpiresAt
                    ? ` · går ut ${formatDate(status.activationTokenExpiresAt)}`
                    : ''}
                </span>
              ) : (
                <span className="text-[11.5px] text-gray-400">
                  Hyresgästen har inte aktiverat sitt konto än.
                </span>
              )}
            </>
          )}
        </div>

        {!status?.portalActivated && (
          <div className="flex flex-col items-end gap-1">
            <button
              type="button"
              onClick={handleResend}
              disabled={resend.isPending}
              className={cn(
                'h-9 rounded-lg border border-[#DDDFE4] bg-white px-4 text-[13.5px] font-medium text-gray-700 shadow-sm transition-all',
                'hover:bg-gray-50 active:scale-[0.97]',
                resend.isPending && 'cursor-not-allowed opacity-60',
              )}
            >
              {resend.isPending ? 'Skickar…' : 'Skicka aktiveringslänk igen'}
            </button>
            {feedback === 'sent' && (
              <span className="text-[11.5px] text-emerald-600">Mejl skickat</span>
            )}
            {feedback === 'error' && (
              <span className="text-[11.5px] text-red-600">Det gick inte att skicka mejlet</span>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
