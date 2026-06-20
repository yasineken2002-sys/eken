import { useState } from 'react'
import { motion } from 'framer-motion'
import { Plus, Gauge, Lock, Pencil } from 'lucide-react'
import { PageWrapper } from '@/components/ui/PageWrapper'
import { PageHeader } from '@/components/ui/PageHeader'
import { Button } from '@/components/ui/Button'
import { Modal, ModalFooter } from '@/components/ui/Modal'
import { Input, Select } from '@/components/ui/Input'
import { DataTable } from '@/components/ui/DataTable'
import { EmptyState } from '@/components/ui/EmptyState'
import { MeterForm } from './components/MeterForm'
import { useMeters, useCreateMeter, useUpdateMeter } from './hooks/useMeterQueries'
import { useUnits } from '@/features/units/hooks/useUnits'
import { useCanWrite } from '@/hooks/useCanWrite'
import { formatDate } from '@eken/shared'
import type {
  Meter,
  MeterType,
  MeterStatus,
  CreateMeterInput,
  UpdateMeterInput,
} from '@eken/shared'
import { cn } from '@/lib/cn'

// ─── Etiketter ────────────────────────────────────────────────────────────────

const METER_TYPE_LABELS: Record<MeterType, string> = {
  ELECTRICITY: 'El',
  WATER_COLD: 'Kallvatten',
  WATER_HOT: 'Varmvatten',
  HEATING: 'Värme',
}

const METER_STATUS: Record<MeterStatus, { label: string; cls: string }> = {
  ACTIVE: { label: 'I drift', cls: 'bg-emerald-50 text-emerald-700' },
  INACTIVE: { label: 'Ur bruk', cls: 'bg-amber-50 text-amber-700' },
  REMOVED: { label: 'Demonterad', cls: 'bg-gray-100 text-gray-500' },
}

function MeterStatusBadge({ status }: { status: MeterStatus }) {
  const s = METER_STATUS[status]
  return (
    <span className={cn('rounded-full px-2.5 py-0.5 text-[12px] font-medium', s.cls)}>
      {s.label}
    </span>
  )
}

// ─── Flikar ───────────────────────────────────────────────────────────────────
// Endast "Mätare" är aktiv i denna PR. Tariffer/Avläsningar/Charges byggs i
// 1.3/1.4/1.5 — de visas som låsta platshållare så strukturen är på plats och
// routern/navet inte behöver röras igen.

type TabId = 'meters' | 'tariffs' | 'readings' | 'charges'
const TABS: { id: TabId; label: string; ready: boolean }[] = [
  { id: 'meters', label: 'Mätare', ready: true },
  { id: 'tariffs', label: 'Tariffer', ready: false },
  { id: 'readings', label: 'Avläsningar', ready: false },
  { id: 'charges', label: 'Förbrukningsposter', ready: false },
]

// ─── Inline-redigering av befintlig mätare (status + källagnostiska fält) ──────
// Enhet och mätartyp är identitet/räkenskapsbärande och ändras inte här.

function MeterEditForm({
  meter,
  onSave,
  onCancel,
  isSaving,
}: {
  meter: Meter
  onSave: (dto: UpdateMeterInput) => void
  onCancel: () => void
  isSaving: boolean
}) {
  const [status, setStatus] = useState<MeterStatus>(meter.status)
  const [serialNumber, setSerialNumber] = useState(meter.serialNumber ?? '')
  const [provider, setProvider] = useState(meter.provider ?? '')
  const [externalId, setExternalId] = useState(meter.externalId ?? '')

  function submit() {
    onSave({
      status,
      serialNumber: serialNumber.trim(),
      provider: provider.trim(),
      externalId: externalId.trim(),
    })
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <Select
          label="Status"
          value={status}
          onChange={(e) => setStatus(e.target.value as MeterStatus)}
          options={[
            { value: 'ACTIVE', label: 'I drift' },
            { value: 'INACTIVE', label: 'Ur bruk' },
            { value: 'REMOVED', label: 'Demonterad' },
          ]}
        />
        <Input
          label="Serienummer"
          value={serialNumber}
          onChange={(e) => setSerialNumber(e.target.value)}
        />
        <Input label="Leverantör" value={provider} onChange={(e) => setProvider(e.target.value)} />
        <Input
          label="Externt id"
          value={externalId}
          onChange={(e) => setExternalId(e.target.value)}
        />
      </div>
      <ModalFooter>
        <Button type="button" onClick={onCancel} disabled={isSaving}>
          Avbryt
        </Button>
        <Button type="button" variant="primary" onClick={submit} disabled={isSaving}>
          {isSaving ? 'Sparar…' : 'Spara ändringar'}
        </Button>
      </ModalFooter>
    </div>
  )
}

// ─── Huvudkomponent ───────────────────────────────────────────────────────────

export function ConsumptionPage() {
  const canWrite = useCanWrite()
  const [tab, setTab] = useState<TabId>('meters')
  const [showCreate, setShowCreate] = useState(false)
  const [selected, setSelected] = useState<Meter | null>(null)
  const [editing, setEditing] = useState(false)

  const { data: meters = [], isLoading } = useMeters()
  const { data: units = [] } = useUnits()
  const createMutation = useCreateMeter()
  const updateMutation = useUpdateMeter()

  function unitLabel(unitId: string): string {
    const u = units.find((u) => u.id === unitId)
    return u ? `${u.property.name} · ${u.unitNumber}` : '–'
  }

  // KPI — räknas från hämtad data.
  const activeCount = meters.filter((m) => m.status === 'ACTIVE').length
  const inactiveCount = meters.filter((m) => m.status !== 'ACTIVE').length

  function handleCreate(data: CreateMeterInput) {
    createMutation.mutate(data, { onSuccess: () => setShowCreate(false) })
  }

  function handleUpdate(dto: UpdateMeterInput) {
    if (!selected) return
    updateMutation.mutate(
      { id: selected.id, ...dto },
      {
        onSuccess: (updated) => {
          setSelected(updated)
          setEditing(false)
        },
      },
    )
  }

  return (
    <PageWrapper id="consumption">
      <PageHeader
        title="Förbrukning"
        description="Individuell mätning och debitering (IMD) — el, vatten och värme"
        action={
          canWrite &&
          tab === 'meters' && (
            <Button variant="primary" size="sm" onClick={() => setShowCreate(true)}>
              <Plus size={14} />
              Ny mätare
            </Button>
          )
        }
      />

      {/* KPI-kort */}
      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        {[
          { label: 'Mätare totalt', value: meters.length, tag: 'el · vatten · värme' },
          { label: 'I drift', value: activeCount, tag: 'aktiva mätare' },
          { label: 'Ur bruk / demonterade', value: inactiveCount, tag: 'historik bevaras' },
        ].map((s, i) => (
          <motion.div
            key={s.label}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.07 }}
            className="rounded-2xl border border-[#EAEDF0] bg-white p-5"
          >
            <p className="text-[12px] font-medium text-gray-400">{s.label}</p>
            <p className="mt-1 text-[26px] font-semibold tracking-tight text-gray-900">{s.value}</p>
            <p className="mt-1 text-[12px] text-gray-400">{s.tag}</p>
          </motion.div>
        ))}
      </div>

      {/* Flikar */}
      <div className="mt-6 flex w-fit items-center gap-1 rounded-xl bg-gray-100/70 p-1">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => t.ready && setTab(t.id)}
            disabled={!t.ready}
            title={t.ready ? undefined : 'Byggs i ett kommande steg'}
            className={cn(
              'flex h-8 items-center gap-1.5 rounded-lg px-3 text-[13px] font-medium transition-all',
              tab === t.id
                ? 'bg-white text-gray-900 shadow-sm'
                : t.ready
                  ? 'text-gray-500 hover:text-gray-700'
                  : 'cursor-not-allowed text-gray-300',
            )}
          >
            {!t.ready && <Lock size={11} strokeWidth={2} />}
            {t.label}
          </button>
        ))}
      </div>

      {/* Innehåll per flik */}
      {tab === 'meters' ? (
        <div className="mt-4">
          {!isLoading && meters.length === 0 ? (
            <EmptyState
              icon={Gauge}
              title="Inga mätare ännu"
              description="Lägg upp el-, vatten- och värmemätare per enhet för att kunna registrera avläsningar och debitera förbrukning."
              action={
                canWrite ? (
                  <Button variant="primary" size="sm" onClick={() => setShowCreate(true)}>
                    <Plus size={14} />
                    Ny mätare
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <DataTable
              data={isLoading ? [] : meters}
              keyExtractor={(m) => m.id}
              onRowClick={(m) => {
                setSelected(m)
                setEditing(false)
              }}
              columns={[
                {
                  key: 'type',
                  header: 'Typ',
                  cell: (m) => (
                    <span className="font-medium text-gray-800">{METER_TYPE_LABELS[m.type]}</span>
                  ),
                },
                {
                  key: 'unit',
                  header: 'Enhet',
                  cell: (m) => <span className="text-gray-700">{unitLabel(m.unitId)}</span>,
                },
                {
                  key: 'unitOfMeasure',
                  header: 'Mätenhet',
                  cell: (m) => (
                    <span className="text-[12.5px] text-gray-500">{m.unitOfMeasure}</span>
                  ),
                },
                {
                  key: 'serial',
                  header: 'Serienr',
                  cell: (m) => (
                    <span className="font-mono text-[12.5px] text-gray-500">
                      {m.serialNumber ?? '–'}
                    </span>
                  ),
                },
                {
                  key: 'installedAt',
                  header: 'Installerad',
                  cell: (m) => (
                    <span className="text-[12.5px] text-gray-500">
                      {m.installedAt ? formatDate(m.installedAt) : '–'}
                    </span>
                  ),
                },
                {
                  key: 'status',
                  header: 'Status',
                  cell: (m) => <MeterStatusBadge status={m.status} />,
                },
              ]}
            />
          )}
        </div>
      ) : (
        <div className="mt-4">
          <EmptyState
            icon={Lock}
            title={`${TABS.find((t) => t.id === tab)?.label} byggs i ett kommande steg`}
            description="Förbrukningsgrunden (mätare) läggs upp först. Tariffer, avläsningar och förbrukningsposter aktiveras i tur och ordning."
          />
        </div>
      )}

      {/* Skapa mätare */}
      <Modal open={showCreate} onClose={() => setShowCreate(false)} title="Ny mätare" size="lg">
        <MeterForm
          onSubmit={handleCreate}
          onCancel={() => setShowCreate(false)}
          isSubmitting={createMutation.isPending}
        />
      </Modal>

      {/* Detalj / redigera */}
      {selected && (
        <Modal
          open
          onClose={() => {
            setSelected(null)
            setEditing(false)
          }}
          title={METER_TYPE_LABELS[selected.type]}
          description={unitLabel(selected.unitId)}
          size="lg"
        >
          {editing ? (
            <MeterEditForm
              meter={selected}
              onSave={handleUpdate}
              onCancel={() => setEditing(false)}
              isSaving={updateMutation.isPending}
            />
          ) : (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                {[
                  { label: 'Status', value: <MeterStatusBadge status={selected.status} /> },
                  { label: 'Enhet', value: unitLabel(selected.unitId) },
                  { label: 'Mätartyp', value: METER_TYPE_LABELS[selected.type] },
                  { label: 'Mätenhet', value: selected.unitOfMeasure },
                  { label: 'Serienummer', value: selected.serialNumber ?? '–' },
                  {
                    label: 'Installerad',
                    value: selected.installedAt ? formatDate(selected.installedAt) : '–',
                  },
                  { label: 'Leverantör', value: selected.provider ?? '–' },
                  { label: 'Externt id', value: selected.externalId ?? '–' },
                ].map((i) => (
                  <div key={i.label} className="rounded-xl bg-gray-50 p-3">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                      {i.label}
                    </p>
                    <div className="mt-0.5 text-[13px] font-medium text-gray-800">{i.value}</div>
                  </div>
                ))}
              </div>

              {canWrite && (
                <div className="flex items-center gap-2 border-t border-[#EAEDF0] pt-4">
                  <Button size="sm" onClick={() => setEditing(true)}>
                    <Pencil size={13} strokeWidth={1.8} />
                    Redigera
                  </Button>
                </div>
              )}
            </div>
          )}
        </Modal>
      )}
    </PageWrapper>
  )
}
