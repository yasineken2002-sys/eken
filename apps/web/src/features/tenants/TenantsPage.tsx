import { useState, useMemo, useEffect, useRef } from 'react'
import { motion } from 'framer-motion'
import {
  Plus,
  Users,
  User,
  Building2,
  Mail,
  Phone,
  Hash,
  MapPin,
  Calendar,
  FileText,
} from 'lucide-react'
import { PageWrapper } from '@/components/ui/PageWrapper'
import { PageHeader } from '@/components/ui/PageHeader'
import { Button } from '@/components/ui/Button'
import { Modal, ModalFooter } from '@/components/ui/Modal'
import { Input } from '@/components/ui/Input'
import { DataTable } from '@/components/ui/DataTable'
import { Badge, InvoiceStatusBadge } from '@/components/ui/Badge'
import { StatCard } from '@/components/ui/StatCard'
import { EmptyState } from '@/components/ui/EmptyState'
import { TenantForm } from './components/TenantForm'
import {
  useTenants,
  useTenant,
  useCreateTenant,
  useUpdateTenant,
  useDeleteTenant,
} from './hooks/useTenants'
import { formatCurrency, formatDate } from '@eken/shared'
import type { CreateTenantInput, Tenant } from '@eken/shared'
import type { TenantWithCount, TenantDetail } from './api/tenants.api'
import { cn } from '@/lib/cn'

// ─── Types ────────────────────────────────────────────────────────────────────

type TenantTab = 'ALL' | 'INDIVIDUAL' | 'COMPANY'
type DetailTab = 'detaljer' | 'redigera'

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

// Convert Tenant shape → CreateTenantInput for pre-filling TenantForm
function tenantToInput(t: TenantDetail): Partial<CreateTenantInput> {
  return {
    type: t.type,
    ...(t.firstName != null ? { firstName: t.firstName } : {}),
    ...(t.lastName != null ? { lastName: t.lastName } : {}),
    ...(t.companyName != null ? { companyName: t.companyName } : {}),
    email: t.email,
    ...(t.phone != null ? { phone: t.phone } : {}),
    ...(t.personalNumber != null ? { personalNumber: t.personalNumber } : {}),
    ...(t.orgNumber != null ? { orgNumber: t.orgNumber } : {}),
    ...(t.address != null ? { address: t.address } : {}),
  }
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
  const [detailTab, setDetailTab] = useState<DetailTab>('detaljer')
  const [showCreate, setShowCreate] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)

  // Debounce search → server-side query
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

  const createMutation = useCreateTenant()
  const updateMutation = useUpdateTenant()
  const deleteMutation = useDeleteTenant()

  // Client-side tab filter (search is already server-side)
  const filtered = useMemo(() => {
    if (tab === 'ALL') return tenants
    return tenants.filter((t) => t.type === tab)
  }, [tenants, tab])

  const individualCount = tenants.filter((t) => t.type === 'INDIVIDUAL').length
  const companyCount = tenants.filter((t) => t.type === 'COMPANY').length

  // ── Handlers ──────────────────────────────────────────────────────────────

  const handleCreate = (dto: CreateTenantInput) => {
    createMutation.mutate(dto, { onSuccess: () => setShowCreate(false) })
  }

  const handleUpdate = (dto: CreateTenantInput) => {
    if (!selected) return
    updateMutation.mutate(
      { id: selected.id, ...dto },
      { onSuccess: () => setDetailTab('detaljer') },
    )
  }

  const handleDelete = () => {
    if (!selected) return
    deleteMutation.mutate(selected.id, {
      onSuccess: () => {
        setSelected(null)
        setShowDeleteConfirm(false)
      },
    })
  }

  // ── Table columns ──────────────────────────────────────────────────────────

  const columns = [
    {
      key: 'name',
      header: 'Namn',
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
      key: 'email',
      header: 'E-post',
      cell: (t: TenantWithCount) => <span className="text-gray-600">{t.email}</span>,
    },
    {
      key: 'phone',
      header: 'Telefon',
      cell: (t: TenantWithCount) => <span className="text-gray-500">{t.phone ?? '–'}</span>,
    },
    {
      key: 'invoices',
      header: 'Fakturor',
      align: 'center' as const,
      cell: (t: TenantWithCount) => <Badge variant="default">{t._count?.invoices ?? 0}</Badge>,
    },
    {
      key: 'createdAt',
      header: 'Skapad',
      cell: (t: TenantWithCount) => (
        <span className="text-gray-500">{formatDate(t.createdAt)}</span>
      ),
    },
  ]

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <PageWrapper id="tenants">
      {/* Header */}
      <PageHeader
        title="Hyresgäster"
        description={`${tenants.length} hyresgäster`}
        action={
          <Button variant="primary" size="sm" onClick={() => setShowCreate(true)}>
            <Plus size={14} strokeWidth={2.2} />
            Ny hyresgäst
          </Button>
        }
      />

      {/* Stats */}
      <motion.div
        variants={container}
        initial="hidden"
        animate="show"
        className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3"
      >
        <motion.div variants={item}>
          <StatCard
            title="Totalt"
            value={tenants.length}
            icon={Users}
            iconColor="#218F52"
            delay={0}
          />
        </motion.div>
        <motion.div variants={item}>
          <StatCard
            title="Privatpersoner"
            value={individualCount}
            icon={User}
            iconColor="#0B84D0"
            delay={0.05}
          />
        </motion.div>
        <motion.div variants={item}>
          <StatCard
            title="Företag"
            value={companyCount}
            icon={Building2}
            iconColor="#7C3AED"
            delay={0.1}
          />
        </motion.div>
      </motion.div>

      {/* Search + filter tabs */}
      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-1 rounded-xl bg-gray-100 p-1">
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
            placeholder="Sök på namn eller e-post..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      {/* Table */}
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
                ? 'Lägg till din första hyresgäst för att komma igång.'
                : 'Inga hyresgäster matchar det aktiva filtret.'
            }
            {...(tenants.length === 0
              ? {
                  action: (
                    <Button variant="primary" onClick={() => setShowCreate(true)}>
                      <Plus size={14} strokeWidth={2.2} />
                      Skapa hyresgäst
                    </Button>
                  ),
                }
              : {})}
          />
        ) : (
          <DataTable
            columns={columns}
            data={filtered}
            keyExtractor={(t) => t.id}
            onRowClick={(t) => {
              setSelected(t)
              setDetailTab('detaljer')
            }}
          />
        )}
      </div>

      {/* ── Create modal ───────────────────────────────────────────────────── */}
      <Modal open={showCreate} onClose={() => setShowCreate(false)} title="Ny hyresgäst" size="md">
        <TenantForm
          onSubmit={handleCreate}
          onCancel={() => setShowCreate(false)}
          isSubmitting={createMutation.isPending}
          submitLabel="Skapa hyresgäst"
        />
      </Modal>

      {/* ── Detail modal ───────────────────────────────────────────────────── */}
      <Modal
        open={!!selected}
        onClose={() => setSelected(null)}
        title={selected ? displayName(selected) : ''}
        size="lg"
      >
        {selected && (
          <DetailPanel
            selected={selected}
            selectedTenant={selectedTenant ?? null}
            detailTab={detailTab}
            setDetailTab={setDetailTab}
            onUpdate={handleUpdate}
            onDeleteRequest={() => setShowDeleteConfirm(true)}
            isUpdating={updateMutation.isPending}
          />
        )}
      </Modal>

      {/* ── Delete confirm modal ───────────────────────────────────────────── */}
      <Modal
        open={showDeleteConfirm}
        onClose={() => setShowDeleteConfirm(false)}
        title="Ta bort hyresgäst"
        size="sm"
      >
        <p className="text-[13px] text-gray-600">
          Vill du ta bort{' '}
          <span className="font-medium text-gray-900">{selected ? displayName(selected) : ''}</span>
          ? Åtgärden kan inte ångras.
        </p>
        <ModalFooter>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setShowDeleteConfirm(false)}
            disabled={deleteMutation.isPending}
          >
            Avbryt
          </Button>
          <Button
            variant="danger"
            size="sm"
            loading={deleteMutation.isPending}
            onClick={handleDelete}
          >
            Ta bort
          </Button>
        </ModalFooter>
      </Modal>
    </PageWrapper>
  )
}

// ─── Detail panel (extracted to keep TenantsPage readable) ────────────────────

interface DetailPanelProps {
  selected: TenantWithCount
  selectedTenant: TenantDetail | null
  detailTab: DetailTab
  setDetailTab: (t: DetailTab) => void
  onUpdate: (dto: CreateTenantInput) => void
  onDeleteRequest: () => void
  isUpdating: boolean
}

function DetailPanel({
  selected,
  selectedTenant,
  detailTab,
  setDetailTab,
  onUpdate,
  onDeleteRequest,
  isUpdating,
}: DetailPanelProps) {
  return (
    <div>
      {/* Tab strip */}
      <div className="mb-5 flex w-fit gap-1 rounded-xl bg-gray-100 p-1">
        {(['detaljer', 'redigera'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setDetailTab(t)}
            className={cn(
              'h-8 rounded-lg px-3 text-[13px] font-medium transition-all',
              detailTab === t
                ? 'bg-white text-gray-900 shadow-sm'
                : 'text-gray-500 hover:text-gray-700',
            )}
          >
            {t === 'detaljer' ? 'Detaljer' : 'Redigera'}
          </button>
        ))}
      </div>

      {detailTab === 'detaljer' ? (
        <div>
          {/* Info grid */}
          <div className="grid grid-cols-2 gap-4 rounded-xl border border-[#EAEDF0] p-4">
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

          {/* Recent invoices */}
          <div className="mt-5">
            <p className="mb-3 text-[13px] font-semibold text-gray-700">Senaste fakturor</p>
            {selectedTenant?.invoices && selectedTenant.invoices.length > 0 ? (
              <div className="divide-y divide-[#EAEDF0] overflow-hidden rounded-xl border border-[#EAEDF0]">
                {selectedTenant.invoices.map((inv) => (
                  <div
                    key={inv.id}
                    className="flex items-center justify-between px-4 py-3 hover:bg-gray-50/80"
                  >
                    <div className="flex items-center gap-2">
                      <FileText size={13} strokeWidth={1.8} className="text-gray-400" />
                      <span className="text-[13px] font-medium text-gray-800">
                        {inv.invoiceNumber}
                      </span>
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
              <div className="rounded-xl border border-[#EAEDF0] py-8 text-center text-[13px] text-gray-400">
                Inga fakturor ännu
              </div>
            )}
          </div>

          {/* Actions */}
          <ModalFooter>
            <Button
              variant="danger"
              size="sm"
              disabled={(selected._count?.invoices ?? 0) > 0}
              title={
                (selected._count?.invoices ?? 0) > 0
                  ? 'Hyresgästen har aktiva fakturor och kan inte tas bort'
                  : undefined
              }
              onClick={onDeleteRequest}
            >
              Ta bort
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setDetailTab('redigera')}>
              Redigera
            </Button>
          </ModalFooter>
        </div>
      ) : (
        <TenantForm
          {...(selectedTenant ? { defaultValues: tenantToInput(selectedTenant) } : {})}
          onSubmit={onUpdate}
          onCancel={() => setDetailTab('detaljer')}
          isSubmitting={isUpdating}
          submitLabel="Spara ändringar"
        />
      )}
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
