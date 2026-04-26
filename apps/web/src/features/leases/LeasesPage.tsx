import { useState, useMemo } from 'react'
import { motion } from 'framer-motion'
import { Plus, FileX, FileText, Home, User, Download } from 'lucide-react'
import { PageWrapper } from '@/components/ui/PageWrapper'
import { PageHeader } from '@/components/ui/PageHeader'
import { Button } from '@/components/ui/Button'
import { Modal, ModalFooter } from '@/components/ui/Modal'
import { DataTable } from '@/components/ui/DataTable'
import { LeaseStatusBadge } from '@/components/ui/Badge'
import { StatCard } from '@/components/ui/StatCard'
import { EmptyState } from '@/components/ui/EmptyState'
import { LeaseForm } from './components/LeaseForm'
import {
  useLeases,
  useLease,
  useCreateLeaseWithTenant,
  useUpdateLease,
  useTransitionLeaseStatus,
  useDeleteLease,
} from './hooks/useLeases'
import { formatCurrency, formatDate } from '@eken/shared'
import type { LeaseStatus, Tenant } from '@eken/shared'
import type { LeaseDetail, CreateLeaseWithTenantInput } from './api/leases.api'
import { cn } from '@/lib/cn'
import { DocumentList } from '@/features/documents/components/DocumentList'
import { generateLeaseContract, downloadLeaseContract } from './api/leases.api'

// ─── Types ────────────────────────────────────────────────────────────────────

type LeaseTab = 'ALL' | LeaseStatus
type DetailTab = 'detaljer' | 'redigera'

const TABS: { id: LeaseTab; label: string }[] = [
  { id: 'ALL', label: 'Alla' },
  { id: 'ACTIVE', label: 'Aktiva' },
  { id: 'DRAFT', label: 'Väntande' },
  { id: 'EXPIRED', label: 'Utgångna' },
  { id: 'TERMINATED', label: 'Avslutade' },
]

// ─── Helpers ──────────────────────────────────────────────────────────────────

function tenantName(t: Tenant): string {
  if (t.type === 'INDIVIDUAL') {
    return [t.firstName, t.lastName].filter(Boolean).join(' ') || '–'
  }
  return t.companyName ?? '–'
}

function leaseToInput(l: LeaseDetail): Partial<CreateLeaseWithTenantInput> {
  return {
    existingTenantId: l.tenantId,
    unitId: l.unitId,
    startDate: l.startDate.slice(0, 10),
    ...(l.endDate != null ? { endDate: l.endDate.slice(0, 10) } : {}),
    monthlyRent: Number(l.monthlyRent),
    depositAmount: Number(l.depositAmount),
  }
}

// ─── Animation variants ───────────────────────────────────────────────────────

const container = { hidden: {}, show: { transition: { staggerChildren: 0.05 } } }
const item = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: 0.2 } },
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export function LeasesPage() {
  const [tab, setTab] = useState<LeaseTab>('ALL')
  const [selected, setSelected] = useState<LeaseDetail | null>(null)
  const [detailTab, setDetailTab] = useState<DetailTab>('detaljer')
  const [showCreate, setShowCreate] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)

  const { data: leases = [], isLoading, isError } = useLeases()
  const { data: selectedLease } = useLease(selected?.id ?? null)

  const createMutation = useCreateLeaseWithTenant()
  const updateMutation = useUpdateLease()
  const transitionMutation = useTransitionLeaseStatus()
  const deleteMutation = useDeleteLease()

  // Client-side tab filter
  const filtered = useMemo(() => {
    if (tab === 'ALL') return leases
    return leases.filter((l) => l.status === tab)
  }, [leases, tab])

  const activeCount = leases.filter((l) => l.status === 'ACTIVE').length
  const draftCount = leases.filter((l) => l.status === 'DRAFT').length

  // ── Handlers ──────────────────────────────────────────────────────────────

  const handleCreate = (dto: CreateLeaseWithTenantInput) => {
    createMutation.mutate(dto, { onSuccess: () => setShowCreate(false) })
  }

  const handleUpdate = (dto: CreateLeaseWithTenantInput) => {
    if (!selected) return
    updateMutation.mutate(
      {
        id: selected.id,
        unitId: dto.unitId,
        startDate: dto.startDate,
        ...(dto.endDate ? { endDate: dto.endDate } : {}),
        monthlyRent: dto.monthlyRent,
        ...(dto.depositAmount != null ? { depositAmount: dto.depositAmount } : {}),
      },
      { onSuccess: () => setDetailTab('detaljer') },
    )
  }

  const handleTransition = (status: string) => {
    if (!selected) return
    transitionMutation.mutate(
      { id: selected.id, status },
      {
        onSuccess: (updated) => {
          setSelected(updated)
        },
      },
    )
  }

  const handleDelete = () => {
    if (!selected) return
    const id = selected.id
    setSelected(null)
    setShowDeleteConfirm(false)
    deleteMutation.mutate(id)
  }

  // ── Table columns ──────────────────────────────────────────────────────────

  const columns = [
    {
      key: 'tenant',
      header: 'Hyresgäst',
      cell: (l: LeaseDetail) => (
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-violet-100">
            <User size={12} className="text-violet-600" />
          </div>
          <span className="font-medium text-gray-900">{tenantName(l.tenant)}</span>
        </div>
      ),
    },
    {
      key: 'unit',
      header: 'Enhet',
      cell: (l: LeaseDetail) => (
        <div className="flex items-center gap-1.5">
          <Home size={12} className="text-gray-300" />
          <div>
            <p className="text-[13px] font-medium text-gray-800">{l.unit.name}</p>
            <p className="text-[11px] text-gray-400">{l.unit.property.name}</p>
          </div>
        </div>
      ),
    },
    {
      key: 'rent',
      header: 'Månadshyra',
      align: 'right' as const,
      cell: (l: LeaseDetail) => (
        <span className="font-semibold text-gray-800">{formatCurrency(Number(l.monthlyRent))}</span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (l: LeaseDetail) => <LeaseStatusBadge status={l.status} />,
    },
    {
      key: 'startDate',
      header: 'Startdatum',
      cell: (l: LeaseDetail) => <span className="text-gray-500">{formatDate(l.startDate)}</span>,
    },
  ]

  // ── Render ─────────────────────────────────────────────────────────────────

  if (isError) {
    return (
      <PageWrapper id="leases">
        <EmptyState
          icon={FileX}
          title="Något gick fel"
          description="Kunde inte ladda kontrakt. Försök igen."
        />
      </PageWrapper>
    )
  }

  return (
    <PageWrapper id="leases">
      <PageHeader
        title="Hyresavtal"
        description={`${leases.length} kontrakt`}
        action={
          <Button variant="primary" size="sm" onClick={() => setShowCreate(true)}>
            <Plus size={14} strokeWidth={2.2} />
            Nytt kontrakt
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
            value={leases.length}
            icon={FileText}
            iconColor="#2563EB"
            delay={0}
          />
        </motion.div>
        <motion.div variants={item}>
          <StatCard
            title="Aktiva"
            value={activeCount}
            icon={FileText}
            iconColor="#0B84D0"
            delay={0.05}
          />
        </motion.div>
        <motion.div variants={item}>
          <StatCard
            title="Väntande"
            value={draftCount}
            icon={FileText}
            iconColor="#F59E0B"
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
            Laddar kontrakt…
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={FileText}
            title="Inga kontrakt"
            description={
              leases.length === 0
                ? 'Skapa ditt första hyresavtal för att komma igång.'
                : 'Inga kontrakt matchar det aktiva filtret.'
            }
            {...(leases.length === 0
              ? {
                  action: (
                    <Button variant="primary" onClick={() => setShowCreate(true)}>
                      <Plus size={14} strokeWidth={2.2} />
                      Nytt kontrakt
                    </Button>
                  ),
                }
              : {})}
          />
        ) : (
          <DataTable
            columns={columns}
            data={filtered}
            keyExtractor={(l) => l.id}
            onRowClick={(l) => {
              setSelected(l)
              setDetailTab('detaljer')
            }}
          />
        )}
      </div>

      {/* ── Create modal ───────────────────────────────────────────────────── */}
      <Modal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        title="Nytt hyresavtal"
        size="lg"
      >
        <LeaseForm
          onSubmit={handleCreate}
          onCancel={() => setShowCreate(false)}
          isSubmitting={createMutation.isPending}
          submitLabel="Skapa kontrakt"
        />
      </Modal>

      {/* ── Detail modal ───────────────────────────────────────────────────── */}
      <Modal
        open={!!selected}
        onClose={() => setSelected(null)}
        title={selected ? `Avtal – ${tenantName(selected.tenant)}` : ''}
        size="lg"
      >
        {selected && (
          <LeaseDetailPanel
            selected={selected}
            selectedLease={selectedLease ?? null}
            detailTab={detailTab}
            setDetailTab={setDetailTab}
            onUpdate={handleUpdate}
            onTransition={handleTransition}
            onDeleteRequest={() => setShowDeleteConfirm(true)}
            isUpdating={updateMutation.isPending}
            isTransitioning={transitionMutation.isPending}
          />
        )}
      </Modal>

      {/* ── Delete confirm modal ───────────────────────────────────────────── */}
      <Modal
        open={showDeleteConfirm}
        onClose={() => setShowDeleteConfirm(false)}
        title="Ta bort kontrakt"
        size="sm"
      >
        <p className="text-[13px] text-gray-600">
          Vill du ta bort kontraktet för{' '}
          <span className="font-medium text-gray-900">
            {selected ? tenantName(selected.tenant) : ''}
          </span>
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

// ─── Detail panel ─────────────────────────────────────────────────────────────

interface DetailPanelProps {
  selected: LeaseDetail
  selectedLease: LeaseDetail | null
  detailTab: DetailTab
  setDetailTab: (t: DetailTab) => void
  onUpdate: (dto: CreateLeaseWithTenantInput) => void
  onTransition: (status: string) => void
  onDeleteRequest: () => void
  isUpdating: boolean
  isTransitioning: boolean
}

function LeaseDetailPanel({
  selected,
  selectedLease,
  detailTab,
  setDetailTab,
  onUpdate,
  onTransition,
  onDeleteRequest,
  isUpdating,
  isTransitioning,
}: DetailPanelProps) {
  const status = selected.status
  const [isGeneratingContract, setIsGeneratingContract] = useState(false)
  const [contractGenerated, setContractGenerated] = useState(false)

  const handleGenerateContract = async () => {
    setIsGeneratingContract(true)
    try {
      await generateLeaseContract(selected.id)
      setContractGenerated(true)
    } finally {
      setIsGeneratingContract(false)
    }
  }

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
          <div className="grid grid-cols-2 gap-3 rounded-xl border border-gray-100 p-4">
            {[
              { label: 'Hyresgäst', value: tenantName(selected.tenant) },
              { label: 'Enhet', value: selected.unit.name },
              { label: 'Fastighet', value: selected.unit.property.name },
              { label: 'Startdatum', value: formatDate(selected.startDate) },
              { label: 'Slutdatum', value: selected.endDate ? formatDate(selected.endDate) : '–' },
              { label: 'Månadshyra', value: formatCurrency(Number(selected.monthlyRent)) },
              { label: 'Deposition', value: formatCurrency(Number(selected.depositAmount)) },
              { label: 'Skapad', value: formatDate(selected.createdAt) },
            ].map((row) => (
              <div key={row.label} className="rounded-xl bg-gray-50 p-3">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                  {row.label}
                </p>
                <p className="mt-0.5 text-[13px] font-medium text-gray-800">{row.value}</p>
              </div>
            ))}
          </div>

          {/* Status */}
          <div className="mt-4 flex items-center gap-2">
            <p className="text-[12px] font-semibold uppercase tracking-wide text-gray-400">
              Status
            </p>
            <LeaseStatusBadge status={selected.status} />
          </div>

          {/* Generate contract */}
          <div className="mt-6 flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              size="sm"
              loading={isGeneratingContract}
              onClick={() => {
                setContractGenerated(false)
                void handleGenerateContract()
              }}
            >
              <FileText size={13} strokeWidth={1.8} />
              Generera hyreskontrakt
            </Button>
            {contractGenerated && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void downloadLeaseContract(selected.id)}
              >
                <Download size={13} strokeWidth={1.8} />
                Ladda ned direkt
              </Button>
            )}
          </div>
          {contractGenerated && (
            <p className="mt-1.5 text-[12px] text-emerald-600">
              Kontraktet är sparat under Dokument.
            </p>
          )}

          {/* Documents */}
          <div className="mt-6">
            <DocumentList leaseId={selected.id} title="Kontraktsdokument" />
          </div>

          {/* Action buttons */}
          <ModalFooter>
            {status === 'DRAFT' && (
              <>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={onDeleteRequest}
                  disabled={isTransitioning}
                >
                  Ta bort
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  loading={isTransitioning}
                  onClick={() => onTransition('TERMINATED')}
                >
                  Avsluta
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  loading={isTransitioning}
                  onClick={() => onTransition('ACTIVE')}
                >
                  Aktivera
                </Button>
              </>
            )}
            {status === 'ACTIVE' && (
              <>
                <Button
                  variant="secondary"
                  size="sm"
                  loading={isTransitioning}
                  onClick={() => onTransition('TERMINATED')}
                >
                  Avsluta
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  loading={isTransitioning}
                  onClick={() => onTransition('EXPIRED')}
                >
                  Markera utgången
                </Button>
              </>
            )}
            {(status === 'EXPIRED' || status === 'TERMINATED') && (
              <p className="text-[13px] text-gray-400">Inga tillgängliga åtgärder</p>
            )}
            <Button variant="secondary" size="sm" onClick={() => setDetailTab('redigera')}>
              Redigera
            </Button>
          </ModalFooter>
        </div>
      ) : (
        <LeaseForm
          {...(selectedLease ? { defaultValues: leaseToInput(selectedLease) } : {})}
          initialPropertyId={selected.unit.property.id}
          onSubmit={onUpdate}
          onCancel={() => setDetailTab('detaljer')}
          isSubmitting={isUpdating}
          submitLabel="Spara ändringar"
        />
      )}
    </div>
  )
}
