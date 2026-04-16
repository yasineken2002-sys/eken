import { useState, useMemo } from 'react'
import { motion } from 'framer-motion'
import {
  Plus,
  Home,
  Building2,
  LayoutGrid,
  Wrench,
  Calendar,
  DoorOpen,
  Ruler,
  Hash,
  AlertCircle,
} from 'lucide-react'
import { PageWrapper } from '@/components/ui/PageWrapper'
import { PageHeader } from '@/components/ui/PageHeader'
import { Button } from '@/components/ui/Button'
import { Modal, ModalFooter } from '@/components/ui/Modal'
import { DataTable } from '@/components/ui/DataTable'
import { StatCard } from '@/components/ui/StatCard'
import { UnitStatusBadge } from '@/components/ui/Badge'
import { EmptyState } from '@/components/ui/EmptyState'
import { UnitForm } from './components/UnitForm'
import { useUnits, useUnit, useCreateUnit, useUpdateUnit, useDeleteUnit } from './hooks/useUnits'
import { formatCurrency, formatDate } from '@eken/shared'
import type { UnitStatus } from '@eken/shared'
import type { UnitWithProperty, UnitDetail, CreateUnitInput } from './api/units.api'
import { cn } from '@/lib/cn'
import { DocumentList } from '@/features/documents/components/DocumentList'

// ─── Types ────────────────────────────────────────────────────────────────────

type FilterTab = 'ALL' | UnitStatus
type DetailTab = 'detaljer' | 'redigera'

const FILTER_TABS: { id: FilterTab; label: string }[] = [
  { id: 'ALL', label: 'Alla' },
  { id: 'VACANT', label: 'Lediga' },
  { id: 'OCCUPIED', label: 'Uthyrda' },
  { id: 'UNDER_RENOVATION', label: 'Underhåll' },
  { id: 'RESERVED', label: 'Reserverade' },
]

// ─── Helpers ──────────────────────────────────────────────────────────────────

const UNIT_TYPE_LABELS: Record<string, string> = {
  APARTMENT: 'Lägenhet',
  OFFICE: 'Kontor',
  RETAIL: 'Butik',
  STORAGE: 'Förråd',
  PARKING: 'Parkering',
  OTHER: 'Övrigt',
}

const container = { hidden: {}, show: { transition: { staggerChildren: 0.05 } } }
const item = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: 0.2 } },
}

function unitToInput(u: UnitDetail): Partial<CreateUnitInput> {
  return {
    propertyId: u.propertyId,
    name: u.name,
    unitNumber: u.unitNumber,
    type: u.type,
    status: u.status,
    area: u.area,
    ...(u.floor != null ? { floor: u.floor } : {}),
    ...(u.rooms != null ? { rooms: u.rooms } : {}),
    monthlyRent: u.monthlyRent,
  }
}

function tenantName(t: UnitDetail['leases'][number]['tenant']): string {
  if (t.type === 'INDIVIDUAL') {
    return [t.firstName, t.lastName].filter(Boolean).join(' ') || '–'
  }
  return t.companyName ?? '–'
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export function UnitsPage() {
  const [filterTab, setFilterTab] = useState<FilterTab>('ALL')
  const [selected, setSelected] = useState<UnitWithProperty | null>(null)
  const [detailTab, setDetailTab] = useState<DetailTab>('detaljer')
  const [showCreate, setShowCreate] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)

  const { data: units = [], isLoading, isError } = useUnits()
  const { data: selectedUnit } = useUnit(selected?.id ?? null)

  const createMutation = useCreateUnit()
  const updateMutation = useUpdateUnit()
  const deleteMutation = useDeleteUnit()

  // Client-side filter
  const filtered = useMemo(() => {
    if (filterTab === 'ALL') return units
    return units.filter((u) => u.status === filterTab)
  }, [units, filterTab])

  // Stats
  const vacantCount = units.filter((u) => u.status === 'VACANT').length
  const occupiedCount = units.filter((u) => u.status === 'OCCUPIED').length
  const renovationCount = units.filter((u) => u.status === 'UNDER_RENOVATION').length

  // ── Handlers ──────────────────────────────────────────────────────────────

  const handleCreate = (dto: CreateUnitInput) => {
    createMutation.mutate(dto, { onSuccess: () => setShowCreate(false) })
  }

  const handleUpdate = (dto: CreateUnitInput) => {
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
      header: 'Objekt',
      cell: (u: UnitWithProperty) => (
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-blue-50">
            <Home size={13} strokeWidth={1.8} className="text-blue-600" />
          </div>
          <div>
            <p className="font-medium text-gray-900">{u.name}</p>
            <p className="text-[11px] text-gray-400">{u.unitNumber}</p>
          </div>
        </div>
      ),
    },
    {
      key: 'property',
      header: 'Fastighet',
      cell: (u: UnitWithProperty) => <span className="text-gray-600">{u.property.name}</span>,
    },
    {
      key: 'type',
      header: 'Typ',
      cell: (u: UnitWithProperty) => (
        <span className="text-[12.5px] text-gray-500">{UNIT_TYPE_LABELS[u.type] ?? u.type}</span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (u: UnitWithProperty) => <UnitStatusBadge status={u.status} />,
    },
    {
      key: 'area',
      header: 'Yta',
      align: 'right' as const,
      cell: (u: UnitWithProperty) => <span className="text-gray-600">{u.area} m²</span>,
    },
    {
      key: 'rent',
      header: 'Hyra/mån',
      align: 'right' as const,
      cell: (u: UnitWithProperty) => (
        <span className="font-semibold text-gray-800">{formatCurrency(Number(u.monthlyRent))}</span>
      ),
    },
  ]

  // ── Render ─────────────────────────────────────────────────────────────────

  if (isError)
    return (
      <PageWrapper id="units-error">
        <EmptyState
          icon={AlertCircle}
          title="Något gick fel"
          description="Kunde inte ladda enheter. Försök ladda om sidan."
        />
      </PageWrapper>
    )

  return (
    <PageWrapper id="units">
      <PageHeader
        title="Objekt"
        description={`${units.length} objekt · ${vacantCount} lediga`}
        action={
          <Button variant="primary" size="sm" onClick={() => setShowCreate(true)}>
            <Plus size={14} strokeWidth={2.2} />
            Nytt objekt
          </Button>
        }
      />

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
            value={units.length}
            icon={LayoutGrid}
            iconColor="#2563EB"
            delay={0}
          />
        </motion.div>
        <motion.div variants={item}>
          <StatCard
            title="Lediga"
            value={vacantCount}
            icon={DoorOpen}
            iconColor="#2563EB"
            delay={0.05}
          />
        </motion.div>
        <motion.div variants={item}>
          <StatCard
            title="Uthyrda"
            value={occupiedCount}
            icon={Home}
            iconColor="#0B84D0"
            delay={0.1}
          />
        </motion.div>
        <motion.div variants={item}>
          <StatCard
            title="Underhåll"
            value={renovationCount}
            icon={Wrench}
            iconColor="#D97706"
            delay={0.15}
          />
        </motion.div>
      </motion.div>

      {/* Filter tabs */}
      <div className="mt-6 flex w-fit items-center gap-1 rounded-xl bg-gray-100/70 p-1">
        {FILTER_TABS.map((f) => {
          const count =
            f.id === 'ALL' ? units.length : units.filter((u) => u.status === f.id).length
          return (
            <button
              key={f.id}
              onClick={() => setFilterTab(f.id)}
              className={cn(
                'flex h-8 items-center gap-1.5 rounded-lg px-3 text-[13px] font-medium transition-all',
                filterTab === f.id
                  ? 'bg-white text-gray-900 shadow-sm'
                  : 'text-gray-500 hover:text-gray-700',
              )}
            >
              {f.label}
              <span className="text-[11px] text-gray-400">{count}</span>
            </button>
          )
        })}
      </div>

      {/* Table */}
      <div className="mt-4">
        {isLoading ? (
          <div className="flex items-center justify-center py-20 text-[13px] text-gray-400">
            Laddar objekt…
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={Home}
            title="Inga objekt"
            description={
              units.length === 0
                ? 'Lägg till ditt första objekt för att komma igång.'
                : 'Inga objekt matchar det aktiva filtret.'
            }
            {...(units.length === 0
              ? {
                  action: (
                    <Button variant="primary" onClick={() => setShowCreate(true)}>
                      <Plus size={14} strokeWidth={2.2} />
                      Skapa objekt
                    </Button>
                  ),
                }
              : {})}
          />
        ) : (
          <DataTable
            columns={columns}
            data={filtered}
            keyExtractor={(u) => u.id}
            onRowClick={(u) => {
              setSelected(u)
              setDetailTab('detaljer')
            }}
          />
        )}
      </div>

      {/* ── Create modal ───────────────────────────────────────────────────── */}
      <Modal open={showCreate} onClose={() => setShowCreate(false)} title="Nytt objekt" size="md">
        <UnitForm
          onSubmit={handleCreate}
          onCancel={() => setShowCreate(false)}
          isSubmitting={createMutation.isPending}
          submitLabel="Skapa objekt"
        />
      </Modal>

      {/* ── Detail modal ───────────────────────────────────────────────────── */}
      <Modal
        open={!!selected}
        onClose={() => setSelected(null)}
        title={selected?.name ?? ''}
        {...(selected ? { description: `${selected.property.name} · ${selected.unitNumber}` } : {})}
        size="lg"
      >
        {selected && (
          <UnitDetailPanel
            selected={selected}
            selectedUnit={selectedUnit ?? null}
            detailTab={detailTab}
            setDetailTab={setDetailTab}
            onUpdate={handleUpdate}
            onDeleteRequest={() => setShowDeleteConfirm(true)}
            isUpdating={updateMutation.isPending}
          />
        )}
      </Modal>

      {/* ── Delete confirm ─────────────────────────────────────────────────── */}
      <Modal
        open={showDeleteConfirm}
        onClose={() => setShowDeleteConfirm(false)}
        title="Ta bort objekt"
        size="sm"
      >
        <p className="text-[13px] text-gray-600">
          Vill du ta bort <span className="font-medium text-gray-900">{selected?.name}</span>?
          Åtgärden kan inte ångras.
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

// ─── Detail Panel ─────────────────────────────────────────────────────────────

interface UnitDetailPanelProps {
  selected: UnitWithProperty
  selectedUnit: UnitDetail | null
  detailTab: DetailTab
  setDetailTab: (t: DetailTab) => void
  onUpdate: (dto: CreateUnitInput) => void
  onDeleteRequest: () => void
  isUpdating: boolean
}

function UnitDetailPanel({
  selected,
  selectedUnit,
  detailTab,
  setDetailTab,
  onUpdate,
  onDeleteRequest,
  isUpdating,
}: UnitDetailPanelProps) {
  const activeLease = selectedUnit?.leases.find((l) => l.status === 'ACTIVE') ?? null

  return (
    <div>
      {/* Tab strip */}
      <div className="mb-5 flex w-fit gap-1 rounded-xl bg-gray-100/70 p-1">
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
          <div className="grid grid-cols-2 gap-3">
            {[
              { icon: Building2, label: 'Fastighet', value: selected.property.name },
              { icon: Hash, label: 'Enhetsnummer', value: selected.unitNumber },
              {
                icon: LayoutGrid,
                label: 'Typ',
                value: UNIT_TYPE_LABELS[selected.type] ?? selected.type,
              },
              {
                icon: Calendar,
                label: 'Skapad',
                value: formatDate(selected.createdAt),
              },
              { icon: Ruler, label: 'Area', value: `${selected.area} m²` },
              {
                icon: Home,
                label: 'Våning',
                value: selected.floor != null ? `Plan ${selected.floor}` : 'Bottenvåning',
              },
              ...(selected.rooms != null
                ? [{ icon: DoorOpen, label: 'Antal rum', value: String(selected.rooms) }]
                : []),
              {
                icon: Hash,
                label: 'Månadshyra',
                value: formatCurrency(Number(selected.monthlyRent)),
              },
            ].map((row) => (
              <div
                key={row.label}
                className="flex items-start gap-2.5 rounded-xl border border-gray-100 p-3"
              >
                <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-gray-50">
                  <row.icon size={12} strokeWidth={1.8} className="text-gray-400" />
                </div>
                <div>
                  <p className="text-[11px] font-medium uppercase tracking-wide text-gray-400">
                    {row.label}
                  </p>
                  <p className="mt-0.5 text-[13px] text-gray-800">{row.value}</p>
                </div>
              </div>
            ))}
          </div>

          {/* Status badge row */}
          <div className="mt-3 flex items-center gap-2">
            <span className="text-[12px] text-gray-400">Status:</span>
            <UnitStatusBadge status={selected.status} />
          </div>

          {/* Active lease */}
          <div className="mt-5">
            <p className="mb-3 text-[13px] font-semibold text-gray-700">Nuvarande kontrakt</p>
            {activeLease ? (
              <div className="rounded-xl border border-gray-100 p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-[14px] font-medium text-gray-900">
                      {tenantName(activeLease.tenant)}
                    </p>
                    <p className="mt-0.5 text-[12px] text-gray-500">{activeLease.tenant.email}</p>
                  </div>
                  <p className="text-[15px] font-semibold text-gray-800">
                    {formatCurrency(Number(activeLease.monthlyRent))}/mån
                  </p>
                </div>
                <div className="mt-3 flex gap-4 text-[12px] text-gray-500">
                  <span>Från {formatDate(activeLease.startDate)}</span>
                  {activeLease.endDate && <span>Till {formatDate(activeLease.endDate)}</span>}
                  {!activeLease.endDate && <span className="text-emerald-600">Tillsvidare</span>}
                </div>
              </div>
            ) : (
              <div className="rounded-xl border border-gray-100 py-8 text-center text-[13px] text-gray-400">
                Ingen aktiv hyresgäst
              </div>
            )}
          </div>

          {/* Documents */}
          <div className="mt-6">
            <DocumentList unitId={selected.id} title="Enhetsdokument" />
          </div>

          {/* Actions */}
          <ModalFooter>
            <Button
              variant="danger"
              size="sm"
              disabled={selected.status === 'OCCUPIED'}
              title={
                selected.status === 'OCCUPIED'
                  ? 'Objekt med aktiv hyresgäst kan inte tas bort'
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
        <UnitForm
          {...(selectedUnit ? { defaultValues: unitToInput(selectedUnit) } : {})}
          onSubmit={onUpdate}
          onCancel={() => setDetailTab('detaljer')}
          isSubmitting={isUpdating}
          submitLabel="Spara ändringar"
        />
      )}
    </div>
  )
}
