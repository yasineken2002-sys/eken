import { useState, useMemo } from 'react'
import { motion } from 'framer-motion'
import { Plus, Building2, Home, Layers, MapPin, Calendar, Trash2, AlertCircle } from 'lucide-react'
import { PageWrapper } from '@/components/ui/PageWrapper'
import { PageHeader } from '@/components/ui/PageHeader'
import { Button } from '@/components/ui/Button'
import { Modal, ModalFooter } from '@/components/ui/Modal'
import { DataTable } from '@/components/ui/DataTable'
import { Badge, UnitStatusBadge, PropertyTypeBadge } from '@/components/ui/Badge'
import { StatCard } from '@/components/ui/StatCard'
import { EmptyState } from '@/components/ui/EmptyState'
import { PropertyForm } from './components/PropertyForm'
import {
  useProperties,
  useProperty,
  useCreateProperty,
  useUpdateProperty,
  useDeleteProperty,
} from './hooks/useProperties'
import { formatCurrency, formatDate } from '@eken/shared'
import type { CreatePropertyInput } from '@eken/shared'
import type { PropertyWithCount, PropertyDetail } from './api/properties.api'
import { cn } from '@/lib/cn'
import { DocumentList } from '@/features/documents/components/DocumentList'

// ─── Types ────────────────────────────────────────────────────────────────────

type PropertyTab = 'ALL' | 'RESIDENTIAL' | 'COMMERCIAL' | 'INDUSTRIAL' | 'LAND'
type DetailTab = 'detaljer' | 'redigera'

const TABS: { id: PropertyTab; label: string }[] = [
  { id: 'ALL', label: 'Alla' },
  { id: 'RESIDENTIAL', label: 'Bostäder' },
  { id: 'COMMERCIAL', label: 'Kommersiella' },
  { id: 'INDUSTRIAL', label: 'Industri' },
  { id: 'LAND', label: 'Mark' },
]

const PROPERTY_TYPE_LABELS: Record<string, string> = {
  RESIDENTIAL: 'Bostadsfastighet',
  COMMERCIAL: 'Kommersiell',
  MIXED: 'Blandfastighet',
  INDUSTRIAL: 'Industri',
  LAND: 'Mark',
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function propertyToInput(p: PropertyWithCount): Partial<CreatePropertyInput> {
  return {
    name: p.name,
    propertyDesignation: p.propertyDesignation,
    type: p.type,
    address: p.address,
    totalArea: p.totalArea,
    ...(p.yearBuilt != null ? { yearBuilt: p.yearBuilt } : {}),
  }
}

// ─── Animation variants ───────────────────────────────────────────────────────

const container = { hidden: {}, show: { transition: { staggerChildren: 0.05 } } }
const item = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: 0.2 } },
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export function PropertiesPage() {
  const [tab, setTab] = useState<PropertyTab>('ALL')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detailTab, setDetailTab] = useState<DetailTab>('detaljer')
  const [showCreate, setShowCreate] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)

  const { data: properties = [], isLoading, isError } = useProperties()
  const { data: selectedProperty } = useProperty(selectedId)

  const createMutation = useCreateProperty()
  const updateMutation = useUpdateProperty()
  const deleteMutation = useDeleteProperty()

  // ── Derived stats ────────────────────────────────────────────────────────

  const totalUnits = useMemo(
    () => properties.reduce((sum, p) => sum + p._count.units, 0),
    [properties],
  )
  const residentialCount = useMemo(
    () => properties.filter((p) => p.type === 'RESIDENTIAL').length,
    [properties],
  )

  // ── Client-side tab filter ───────────────────────────────────────────────

  const filtered = useMemo(() => {
    if (tab === 'ALL') return properties
    return properties.filter((p) => p.type === tab)
  }, [properties, tab])

  // ── Handlers ────────────────────────────────────────────────────────────

  const handleRowClick = (p: PropertyWithCount) => {
    setSelectedId(p.id)
    setDetailTab('detaljer')
  }

  const handleCreate = (dto: CreatePropertyInput) => {
    createMutation.mutate(dto, { onSuccess: () => setShowCreate(false) })
  }

  const handleUpdate = (dto: CreatePropertyInput) => {
    if (!selectedId) return
    updateMutation.mutate({ id: selectedId, ...dto }, { onSuccess: () => setDetailTab('detaljer') })
  }

  const handleDelete = () => {
    if (!selectedId) return
    deleteMutation.mutate(selectedId, {
      onSuccess: () => {
        setSelectedId(null)
        setShowDeleteConfirm(false)
      },
    })
  }

  const selectedSummary = properties.find((p) => p.id === selectedId)

  // ── Table columns ────────────────────────────────────────────────────────

  const columns = [
    {
      key: 'name',
      header: 'Namn',
      cell: (p: PropertyWithCount) => (
        <div>
          <p className="font-medium text-gray-900">{p.name}</p>
          <p className="mt-0.5 text-[11.5px] text-gray-400">{p.propertyDesignation}</p>
        </div>
      ),
    },
    {
      key: 'type',
      header: 'Typ',
      cell: (p: PropertyWithCount) => <PropertyTypeBadge type={p.type} />,
    },
    {
      key: 'address',
      header: 'Adress',
      cell: (p: PropertyWithCount) => (
        <span className="text-gray-600">
          {p.address.street}, {p.address.postalCode} {p.address.city}
        </span>
      ),
    },
    {
      key: 'units',
      header: 'Enheter',
      align: 'center' as const,
      cell: (p: PropertyWithCount) => <Badge variant="default">{p._count.units}</Badge>,
    },
    {
      key: 'area',
      header: 'Yta',
      cell: (p: PropertyWithCount) => (
        <span className="text-gray-500">{p.totalArea.toLocaleString('sv-SE')} m²</span>
      ),
    },
  ]

  // ── Render ───────────────────────────────────────────────────────────────

  if (isError)
    return (
      <PageWrapper id="properties-error">
        <EmptyState
          icon={AlertCircle}
          title="Något gick fel"
          description="Kunde inte ladda fastigheter. Försök ladda om sidan."
        />
      </PageWrapper>
    )

  return (
    <PageWrapper id="properties">
      {/* Header */}
      <PageHeader
        title="Fastigheter"
        description={`${properties.length} fastigheter`}
        action={
          <Button variant="primary" size="sm" onClick={() => setShowCreate(true)}>
            <Plus size={14} strokeWidth={2.2} />
            Ny fastighet
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
            title="Totalt fastigheter"
            value={properties.length}
            icon={Building2}
            iconColor="#2563EB"
            delay={0}
          />
        </motion.div>
        <motion.div variants={item}>
          <StatCard
            title="Totalt enheter"
            value={totalUnits}
            icon={Layers}
            iconColor="#0B84D0"
            delay={0.05}
          />
        </motion.div>
        <motion.div variants={item}>
          <StatCard
            title="Bostadsfastigheter"
            value={residentialCount}
            icon={Home}
            iconColor="#2563EB"
            delay={0.1}
          />
        </motion.div>
      </motion.div>

      {/* Filter tabs */}
      <div className="mt-6">
        <div className="flex w-fit gap-1 rounded-xl bg-gray-100/70 p-1">
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
      </div>

      {/* Table */}
      <div className="mt-4">
        {isLoading ? (
          <div className="flex items-center justify-center py-20 text-[13px] text-gray-400">
            Laddar fastigheter…
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={Building2}
            title="Inga fastigheter"
            description={
              properties.length === 0
                ? 'Lägg till din första fastighet för att komma igång.'
                : 'Inga fastigheter matchar det aktiva filtret.'
            }
            {...(properties.length === 0
              ? {
                  action: (
                    <Button variant="primary" onClick={() => setShowCreate(true)}>
                      <Plus size={14} strokeWidth={2.2} />
                      Skapa fastighet
                    </Button>
                  ),
                }
              : {})}
          />
        ) : (
          <DataTable
            columns={columns}
            data={filtered}
            keyExtractor={(p) => p.id}
            onRowClick={handleRowClick}
          />
        )}
      </div>

      {/* ── Create modal ─────────────────────────────────────────────────────── */}
      <Modal open={showCreate} onClose={() => setShowCreate(false)} title="Ny fastighet" size="md">
        <PropertyForm
          onSubmit={handleCreate}
          onCancel={() => setShowCreate(false)}
          isSubmitting={createMutation.isPending}
          submitLabel="Skapa fastighet"
        />
      </Modal>

      {/* ── Detail modal ──────────────────────────────────────────────────────── */}
      <Modal
        open={!!selectedId}
        onClose={() => setSelectedId(null)}
        title={selectedSummary?.name ?? ''}
        {...(selectedSummary ? { description: PROPERTY_TYPE_LABELS[selectedSummary.type] } : {})}
        size="lg"
      >
        {selectedId && (
          <DetailPanel
            detailTab={detailTab}
            setDetailTab={setDetailTab}
            selectedProperty={selectedProperty ?? null}
            onUpdate={handleUpdate}
            onDeleteRequest={() => setShowDeleteConfirm(true)}
            isUpdating={updateMutation.isPending}
          />
        )}
      </Modal>

      {/* ── Delete confirm modal ──────────────────────────────────────────────── */}
      <Modal
        open={showDeleteConfirm}
        onClose={() => setShowDeleteConfirm(false)}
        title="Ta bort fastighet"
        size="sm"
      >
        <p className="text-[13px] text-gray-600">
          Vill du ta bort{' '}
          <span className="font-medium text-gray-900">{selectedSummary?.name ?? ''}</span>? Åtgärden
          kan inte ångras. Fastigheten måste sakna aktiva kontrakt.
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

interface DetailPanelProps {
  detailTab: DetailTab
  setDetailTab: (t: DetailTab) => void
  selectedProperty: PropertyDetail | null
  onUpdate: (dto: CreatePropertyInput) => void
  onDeleteRequest: () => void
  isUpdating: boolean
}

function DetailPanel({
  detailTab,
  setDetailTab,
  selectedProperty,
  onUpdate,
  onDeleteRequest,
  isUpdating,
}: DetailPanelProps) {
  return (
    <div>
      {/* Tabs */}
      <div className="mb-5 flex w-fit gap-1 rounded-xl bg-gray-100/70 p-1">
        {(['detaljer', 'redigera'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setDetailTab(t)}
            className={cn(
              'h-8 rounded-lg px-3 text-[13px] font-medium capitalize transition-all',
              detailTab === t
                ? 'bg-white text-gray-900 shadow-sm'
                : 'text-gray-500 hover:text-gray-700',
            )}
          >
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {detailTab === 'detaljer' && (
        <DetaljerTab property={selectedProperty} onDeleteRequest={onDeleteRequest} />
      )}

      {detailTab === 'redigera' && selectedProperty && (
        <PropertyForm
          defaultValues={propertyToInput(selectedProperty)}
          onSubmit={onUpdate}
          onCancel={() => setDetailTab('detaljer')}
          isSubmitting={isUpdating}
          submitLabel="Spara ändringar"
        />
      )}
    </div>
  )
}

// ─── Detaljer Tab ─────────────────────────────────────────────────────────────

interface DetaljerTabProps {
  property: PropertyDetail | null
  onDeleteRequest: () => void
}

function DetaljerTab({ property, onDeleteRequest }: DetaljerTabProps) {
  if (!property) {
    return (
      <div className="flex items-center justify-center py-12 text-[13px] text-gray-400">
        Laddar…
      </div>
    )
  }

  const infoRows: { label: string; value: React.ReactNode }[] = [
    { label: 'Fastighetsbeteckning', value: property.propertyDesignation },
    { label: 'Typ', value: <PropertyTypeBadge type={property.type} /> },
    {
      label: 'Adress',
      value: (
        <span>
          {property.address.street}
          <br />
          {property.address.postalCode} {property.address.city}
        </span>
      ),
    },
    { label: 'Total yta', value: `${property.totalArea.toLocaleString('sv-SE')} m²` },
    { label: 'Byggår', value: property.yearBuilt?.toString() ?? '–' },
    { label: 'Skapad', value: formatDate(property.createdAt) },
  ]

  return (
    <div className="space-y-6">
      {/* Info grid */}
      <div className="grid grid-cols-2 gap-x-6 gap-y-4">
        {infoRows.map((row) => (
          <div key={row.label}>
            <p className="text-[11.5px] font-semibold uppercase tracking-wide text-gray-400">
              {row.label}
            </p>
            <div className="mt-1 text-[13.5px] font-medium text-gray-900">{row.value}</div>
          </div>
        ))}
      </div>

      {/* Units section */}
      <div>
        <div className="mb-3 flex items-center gap-3">
          <p className="shrink-0 text-[12px] font-semibold uppercase tracking-wide text-gray-400">
            Enheter
          </p>
          <div className="h-px flex-1 bg-[#EAEDF0]" />
          <span className="text-[12px] text-gray-400">{property.units.length}</span>
        </div>

        {property.units.length === 0 ? (
          <EmptyState
            icon={Layers}
            title="Inga enheter registrerade"
            description="Lägg till enheter via enhetsregistret."
          />
        ) : (
          <div className="space-y-2">
            {property.units.map((unit) => (
              <div
                key={unit.id}
                className="flex items-center justify-between rounded-lg border border-gray-100 bg-gray-50/60 px-3 py-2.5"
              >
                <div className="flex items-center gap-2.5">
                  <MapPin size={12} strokeWidth={1.8} className="text-gray-400" />
                  <div>
                    <span className="text-[13px] font-medium text-gray-900">{unit.unitNumber}</span>
                    {unit.name && (
                      <span className="ml-1.5 text-[12px] text-gray-500">{unit.name}</span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <UnitStatusBadge status={unit.status} />
                  <span className="text-[13px] font-medium text-gray-700">
                    {formatCurrency(Number(unit.monthlyRent))}/mån
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Documents */}
      <DocumentList propertyId={property.id} title="Fastighetsdokument" />

      {/* Footer actions */}
      <div className="flex items-center justify-between border-t border-gray-100 pt-4">
        <Button variant="danger" size="sm" onClick={onDeleteRequest}>
          <Trash2 size={13} strokeWidth={1.8} />
          Ta bort fastighet
        </Button>
        <div className="flex items-center gap-1.5 text-[11.5px] text-gray-400">
          <Calendar size={11} strokeWidth={1.8} />
          Uppdaterad {formatDate(property.updatedAt)}
        </div>
      </div>
    </div>
  )
}
