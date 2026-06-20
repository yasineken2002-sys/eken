import { useState } from 'react'
import { motion } from 'framer-motion'
import { Plus, Gauge, Lock, Pencil, Coins, Activity, FileText, BookCheck } from 'lucide-react'
import { PageWrapper } from '@/components/ui/PageWrapper'
import { PageHeader } from '@/components/ui/PageHeader'
import { Button } from '@/components/ui/Button'
import { Modal, ModalFooter } from '@/components/ui/Modal'
import { Input, Select } from '@/components/ui/Input'
import { DataTable } from '@/components/ui/DataTable'
import { EmptyState } from '@/components/ui/EmptyState'
import { MeterForm } from './components/MeterForm'
import { TariffForm } from './components/TariffForm'
import { ReadingForm } from './components/ReadingForm'
import { useMeters, useCreateMeter, useUpdateMeter } from './hooks/useMeterQueries'
import { useTariffs, useCreateTariff } from './hooks/useTariffQueries'
import { useReadings, useCreateReading } from './hooks/useReadingQueries'
import { useCharges, useCharge, useConfirmCharge } from './hooks/useChargeQueries'
import { useUnits } from '@/features/units/hooks/useUnits'
import { useProperties } from '@/features/properties/hooks/useProperties'
import { useCanWrite } from '@/hooks/useCanWrite'
import { formatDate, formatCurrency } from '@eken/shared'
import type {
  Meter,
  MeterType,
  MeterStatus,
  CreateMeterInput,
  UpdateMeterInput,
  ConsumptionTariff,
  TariffScope,
  CreateTariffInput,
  ReadingType,
  CreateReadingInput,
  ConsumptionChargeStatus,
  ConsumptionBillingMode,
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

const SCOPE_LABELS: Record<TariffScope, string> = {
  ORGANIZATION: 'Hela organisationen',
  PROPERTY: 'Per fastighet',
  UNIT: 'Per enhet',
}

// Prisenhet per mätartyp (el/värme i kWh, vatten i m³).
const PRICE_UNIT: Record<MeterType, string> = {
  ELECTRICITY: 'kWh',
  WATER_COLD: 'm³',
  WATER_HOT: 'm³',
  HEATING: 'kWh',
}

// Pris kan komma som Decimal-sträng från API:t — coercera vid visning.
function formatPricePerUnit(value: number | string, meterType: MeterType): string {
  const n = Number(value)
  const formatted = Number.isFinite(n)
    ? n.toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 4 })
    : '–'
  return `${formatted} kr/${PRICE_UNIT[meterType]}`
}

const READING_TYPE_LABELS: Record<ReadingType, string> = {
  CUMULATIVE: 'Mätarställning',
  PERIOD_VOLUME: 'Periodförbrukning',
}

// ─── Förbrukningsposter (charges) ─────────────────────────────────────────────

const CHARGE_STATUS: Record<ConsumptionChargeStatus, { label: string; cls: string }> = {
  DRAFT: { label: 'Utkast', cls: 'bg-amber-50 text-amber-700' },
  CONFIRMED: { label: 'Bokförd', cls: 'bg-blue-50 text-blue-700' },
  ATTACHED: { label: 'Kopplad', cls: 'bg-emerald-50 text-emerald-700' },
  CANCELLED: { label: 'Annullerad', cls: 'bg-gray-100 text-gray-500' },
}

function ChargeStatusBadge({ status }: { status: ConsumptionChargeStatus }) {
  const s = CHARGE_STATUS[status]
  return (
    <span className={cn('rounded-full px-2.5 py-0.5 text-[12px] font-medium', s.cls)}>
      {s.label}
    </span>
  )
}

const DELIVERY_LABELS: Record<ConsumptionBillingMode, string> = {
  RENT_NOTICE_LINE: 'Rad på hyresavi',
  SEPARATE_INVOICE: 'Separat faktura',
  NONE: 'Ingen debitering',
}

// Belopp kommer som Decimal-sträng → coercera ENBART vid visning, räkna ALDRIG om.
function chargeAmount(value: number | string): string {
  return formatCurrency(Number(value))
}

const CHARGE_FILTERS: { id: 'ALL' | ConsumptionChargeStatus; label: string }[] = [
  { id: 'ALL', label: 'Alla' },
  { id: 'DRAFT', label: 'Utkast' },
  { id: 'CONFIRMED', label: 'Bokförda' },
  { id: 'ATTACHED', label: 'Kopplade' },
  { id: 'CANCELLED', label: 'Annullerade' },
]

// ─── Flikar ───────────────────────────────────────────────────────────────────
// Endast "Mätare" är aktiv i denna PR. Tariffer/Avläsningar/Charges byggs i
// 1.3/1.4/1.5 — de visas som låsta platshållare så strukturen är på plats och
// routern/navet inte behöver röras igen.

type TabId = 'meters' | 'tariffs' | 'readings' | 'charges'
const TABS: { id: TabId; label: string; ready: boolean }[] = [
  { id: 'meters', label: 'Mätare', ready: true },
  { id: 'tariffs', label: 'Tariffer', ready: true },
  { id: 'readings', label: 'Avläsningar', ready: true },
  { id: 'charges', label: 'Förbrukningsposter', ready: true },
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
  const [showCreateTariff, setShowCreateTariff] = useState(false)
  const [showCreateReading, setShowCreateReading] = useState(false)
  const [selected, setSelected] = useState<Meter | null>(null)
  const [editing, setEditing] = useState(false)
  // Avläsningsfilter (1.1-filtret: unit + period mot avläsningens slutdatum).
  const [readingUnitFilter, setReadingUnitFilter] = useState('')
  const [readingFrom, setReadingFrom] = useState('')
  const [readingTo, setReadingTo] = useState('')
  // Förbrukningsposter: statusfilter + öppen detalj.
  const [chargeFilter, setChargeFilter] = useState<'ALL' | ConsumptionChargeStatus>('ALL')
  const [selectedChargeId, setSelectedChargeId] = useState<string | null>(null)

  const { data: meters = [], isLoading } = useMeters()
  const { data: tariffs = [], isLoading: tariffsLoading } = useTariffs()
  const { data: units = [] } = useUnits()
  const { data: properties = [] } = useProperties()
  const readingFilters = {
    ...(readingUnitFilter ? { unitId: readingUnitFilter } : {}),
    ...(readingFrom ? { periodStart: readingFrom } : {}),
    ...(readingTo ? { periodEnd: readingTo } : {}),
  }
  const { data: readings = [], isLoading: readingsLoading } = useReadings(readingFilters)
  const { data: charges = [], isLoading: chargesLoading } = useCharges(
    chargeFilter === 'ALL' ? undefined : { status: chargeFilter },
  )
  // Detaljen hämtas separat så confirm-invalidering (['charge', id]) driver en
  // refetch och modalen aldrig visar inaktuell status.
  const { data: selectedCharge } = useCharge(selectedChargeId)
  const createMutation = useCreateMeter()
  const updateMutation = useUpdateMeter()
  const createTariffMutation = useCreateTariff()
  const createReadingMutation = useCreateReading()
  const confirmChargeMutation = useConfirmCharge()

  function unitLabel(unitId: string): string {
    const u = units.find((u) => u.id === unitId)
    return u ? `${u.property.name} · ${u.unitNumber}` : '–'
  }

  // Etikett för en avläsnings mätare (typ + enhet).
  function meterLabel(meterId: string): string {
    const m = meters.find((m) => m.id === meterId)
    if (!m) return '–'
    return `${METER_TYPE_LABELS[m.type]} · ${unitLabel(m.unitId)}`
  }

  // Scope-målets namn för en tariff (ORG → fast text, PROPERTY/UNIT → upplöses).
  function tariffScopeTarget(t: ConsumptionTariff): string {
    if (t.scope === 'PROPERTY') {
      return properties.find((p) => p.id === t.propertyId)?.name ?? 'Okänd fastighet'
    }
    if (t.scope === 'UNIT') {
      return t.unitId ? unitLabel(t.unitId) : 'Okänd enhet'
    }
    return SCOPE_LABELS.ORGANIZATION
  }

  // KPI — räknas från hämtad data.
  const activeCount = meters.filter((m) => m.status === 'ACTIVE').length
  const inactiveCount = meters.filter((m) => m.status !== 'ACTIVE').length
  // Gällande tariff = validTo null. Övriga är historik (stängda prisperioder).
  const currentTariffs = tariffs.filter((t) => t.validTo === null).length
  const historicTariffs = tariffs.length - currentTariffs
  // Avläsnings-KPI.
  const metersRead = new Set(readings.map((r) => r.meterId)).size
  const latestReading = readings.reduce<string | null>(
    (max, r) => (max === null || r.readingDate > max ? r.readingDate : max),
    null,
  )
  // Charge-KPI: DRAFT = att bekräfta, CONFIRMED/ATTACHED = bokförda. (Räknas på
  // den filtrerade listan endast om filtret är ALL — annars visas filtrets antal.)
  const draftCharges = charges.filter((c) => c.status === 'DRAFT').length
  const bookedCharges = charges.filter(
    (c) => c.status === 'CONFIRMED' || c.status === 'ATTACHED',
  ).length

  function handleCreate(data: CreateMeterInput) {
    createMutation.mutate(data, { onSuccess: () => setShowCreate(false) })
  }

  function handleCreateTariff(data: CreateTariffInput) {
    createTariffMutation.mutate(data, { onSuccess: () => setShowCreateTariff(false) })
  }

  function handleCreateReading(data: CreateReadingInput) {
    createReadingMutation.mutate(data, { onSuccess: () => setShowCreateReading(false) })
  }

  // Namn på charge:ns hyresgäst (från nästlad tenant).
  function chargeTenantName(t: {
    firstName: string | null
    lastName: string | null
    companyName: string | null
  }): string {
    if (t.companyName) return t.companyName
    const name = `${t.firstName ?? ''} ${t.lastName ?? ''}`.trim()
    return name || '–'
  }

  // Bekräfta + bokför en DRAFT-charge. Anropar den befintliga endpointen som
  // skapar verifikatet — frontend bygger ingen bokföringslogik.
  function handleConfirmCharge() {
    if (!selectedCharge) return
    confirmChargeMutation.mutate(selectedCharge.id)
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
          canWrite && tab === 'meters' ? (
            <Button variant="primary" size="sm" onClick={() => setShowCreate(true)}>
              <Plus size={14} />
              Ny mätare
            </Button>
          ) : canWrite && tab === 'tariffs' ? (
            <Button variant="primary" size="sm" onClick={() => setShowCreateTariff(true)}>
              <Plus size={14} />
              Ny tariff
            </Button>
          ) : canWrite && tab === 'readings' ? (
            <Button variant="primary" size="sm" onClick={() => setShowCreateReading(true)}>
              <Plus size={14} />
              Ny avläsning
            </Button>
          ) : undefined
        }
      />

      {/* KPI-kort (per aktiv flik) */}
      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        {(tab === 'tariffs'
          ? [
              { label: 'Tariffer totalt', value: tariffs.length, tag: 'inkl. historik' },
              { label: 'Gällande nu', value: currentTariffs, tag: 'aktiva prisperioder' },
              { label: 'Historiska', value: historicTariffs, tag: 'stängda prisperioder' },
            ]
          : tab === 'readings'
            ? [
                { label: 'Avläsningar', value: readings.length, tag: 'i nuvarande filter' },
                { label: 'Mätare avlästa', value: metersRead, tag: 'distinkta mätare' },
                {
                  label: 'Senaste avläsning',
                  value: latestReading ? formatDate(latestReading) : '–',
                  tag: 'senaste avläsningsdatum',
                },
              ]
            : tab === 'charges'
              ? [
                  { label: 'Poster', value: charges.length, tag: 'i nuvarande filter' },
                  { label: 'Att bekräfta', value: draftCharges, tag: 'utkast (ej bokförda)' },
                  { label: 'Bokförda', value: bookedCharges, tag: 'verifikat skapat' },
                ]
              : [
                  { label: 'Mätare totalt', value: meters.length, tag: 'el · vatten · värme' },
                  { label: 'I drift', value: activeCount, tag: 'aktiva mätare' },
                  { label: 'Ur bruk / demonterade', value: inactiveCount, tag: 'historik bevaras' },
                ]
        ).map((s, i) => (
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
      ) : tab === 'tariffs' ? (
        <div className="mt-4">
          {!tariffsLoading && tariffs.length === 0 ? (
            <EmptyState
              icon={Coins}
              title="Inga tariffer ännu"
              description="Lägg upp pris per förbrukningsenhet (kr/kWh, kr/m³) per organisation, fastighet eller enhet. Avläsningarna räknar mot den tariff som gällde under mätperioden."
              action={
                canWrite ? (
                  <Button variant="primary" size="sm" onClick={() => setShowCreateTariff(true)}>
                    <Plus size={14} />
                    Ny tariff
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <DataTable
              data={tariffsLoading ? [] : tariffs}
              keyExtractor={(t) => t.id}
              columns={[
                {
                  key: 'meterType',
                  header: 'Typ',
                  cell: (t) => (
                    <span className="font-medium text-gray-800">
                      {METER_TYPE_LABELS[t.meterType]}
                    </span>
                  ),
                },
                {
                  key: 'scope',
                  header: 'Omfattning',
                  cell: (t) => (
                    <div className="flex flex-col">
                      <span className="text-gray-700">{tariffScopeTarget(t)}</span>
                      <span className="text-[11px] text-gray-400">{SCOPE_LABELS[t.scope]}</span>
                    </div>
                  ),
                },
                {
                  key: 'price',
                  header: 'Pris',
                  align: 'right',
                  cell: (t) => (
                    <span className="font-semibold text-gray-800">
                      {formatPricePerUnit(t.pricePerUnit, t.meterType)}
                    </span>
                  ),
                },
                {
                  key: 'validFrom',
                  header: 'Giltig fr.o.m.',
                  cell: (t) => (
                    <span className="text-[12.5px] text-gray-500">{formatDate(t.validFrom)}</span>
                  ),
                },
                {
                  key: 'validTo',
                  header: 'Status',
                  cell: (t) =>
                    t.validTo === null ? (
                      <span className="rounded-full bg-emerald-50 px-2.5 py-0.5 text-[12px] font-medium text-emerald-700">
                        Gäller nu
                      </span>
                    ) : (
                      <span className="text-[12.5px] text-gray-400">
                        t.o.m. {formatDate(t.validTo)}
                      </span>
                    ),
                },
              ]}
            />
          )}
        </div>
      ) : tab === 'readings' ? (
        <div className="mt-4 space-y-4">
          {/* Filter: enhet + period (mot avläsningens slutdatum, 1.1-filtret) */}
          <div className="flex flex-wrap items-end gap-3 rounded-2xl border border-[#EAEDF0] bg-white p-3">
            <div className="w-56">
              <Select
                label="Enhet"
                value={readingUnitFilter}
                onChange={(e) => setReadingUnitFilter(e.target.value)}
                options={[
                  { value: '', label: 'Alla enheter' },
                  ...units.map((u) => ({
                    value: u.id,
                    label: `${u.property.name} · ${u.unitNumber}`,
                  })),
                ]}
              />
            </div>
            <Input
              label="Period fr.o.m."
              type="date"
              value={readingFrom}
              onChange={(e) => setReadingFrom(e.target.value)}
            />
            <Input
              label="Period t.o.m."
              type="date"
              value={readingTo}
              onChange={(e) => setReadingTo(e.target.value)}
            />
            {(readingUnitFilter || readingFrom || readingTo) && (
              <Button
                size="sm"
                onClick={() => {
                  setReadingUnitFilter('')
                  setReadingFrom('')
                  setReadingTo('')
                }}
              >
                Rensa filter
              </Button>
            )}
          </div>

          {!readingsLoading && readings.length === 0 ? (
            <EmptyState
              icon={Activity}
              title="Inga avläsningar"
              description="Registrera mätaravläsningar (manuellt) per period. Förbrukningen beräknas mot tariffen som gällde under perioden."
              action={
                canWrite ? (
                  <Button variant="primary" size="sm" onClick={() => setShowCreateReading(true)}>
                    <Plus size={14} />
                    Ny avläsning
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <DataTable
              data={readingsLoading ? [] : readings}
              keyExtractor={(r) => r.id}
              columns={[
                {
                  key: 'meter',
                  header: 'Mätare',
                  cell: (r) => <span className="text-gray-700">{meterLabel(r.meterId)}</span>,
                },
                {
                  key: 'value',
                  header: 'Värde',
                  align: 'right',
                  cell: (r) => (
                    <span className="font-semibold text-gray-800">
                      {Number(r.value).toLocaleString('sv-SE', { maximumFractionDigits: 3 })}
                    </span>
                  ),
                },
                {
                  key: 'type',
                  header: 'Avläsningssätt',
                  cell: (r) => (
                    <span className="text-[12.5px] text-gray-500">
                      {READING_TYPE_LABELS[r.readingType]}
                    </span>
                  ),
                },
                {
                  key: 'readingDate',
                  header: 'Avläst',
                  cell: (r) => (
                    <span className="text-[12.5px] text-gray-500">{formatDate(r.readingDate)}</span>
                  ),
                },
                {
                  key: 'period',
                  header: 'Period',
                  cell: (r) => (
                    <span className="text-[12.5px] text-gray-500">
                      {formatDate(r.periodStart)} – {formatDate(r.periodEnd)}
                    </span>
                  ),
                },
                {
                  key: 'source',
                  header: 'Källa',
                  cell: (r) => (
                    <span className="rounded-full bg-gray-100 px-2.5 py-0.5 text-[11px] font-medium text-gray-600">
                      {r.source === 'MANUAL' ? 'Manuell' : r.source}
                    </span>
                  ),
                },
              ]}
            />
          )}
        </div>
      ) : (
        /* Förbrukningsposter (charges) */
        <div className="mt-4 space-y-4">
          {/* Statusfilter */}
          <div className="flex w-fit items-center gap-1 rounded-xl bg-gray-100/70 p-1">
            {CHARGE_FILTERS.map((f) => (
              <button
                key={f.id}
                onClick={() => setChargeFilter(f.id)}
                className={cn(
                  'flex h-8 items-center rounded-lg px-3 text-[13px] font-medium transition-all',
                  chargeFilter === f.id
                    ? 'bg-white text-gray-900 shadow-sm'
                    : 'text-gray-500 hover:text-gray-700',
                )}
              >
                {f.label}
              </button>
            ))}
          </div>

          {!chargesLoading && charges.length === 0 ? (
            <EmptyState
              icon={FileText}
              title="Inga förbrukningsposter"
              description="Förbrukningsposter skapas automatiskt när en avläsning ger debiterbar förbrukning (aktivt avtal + tariff). Bekräfta dem här för att bokföra."
            />
          ) : (
            <DataTable
              data={chargesLoading ? [] : charges}
              keyExtractor={(c) => c.id}
              onRowClick={(c) => setSelectedChargeId(c.id)}
              columns={[
                {
                  key: 'type',
                  header: 'Typ',
                  cell: (c) => (
                    <span className="font-medium text-gray-800">
                      {METER_TYPE_LABELS[c.meterType]}
                    </span>
                  ),
                },
                {
                  key: 'tenant',
                  header: 'Hyresgäst',
                  cell: (c) => <span className="text-gray-700">{chargeTenantName(c.tenant)}</span>,
                },
                {
                  key: 'period',
                  header: 'Period',
                  cell: (c) => (
                    <span className="text-[12.5px] text-gray-500">
                      {formatDate(c.periodStart)} – {formatDate(c.periodEnd)}
                    </span>
                  ),
                },
                {
                  key: 'amount',
                  header: 'Belopp',
                  align: 'right',
                  cell: (c) => (
                    <span className="font-semibold text-gray-800">
                      {chargeAmount(c.totalAmount)}
                    </span>
                  ),
                },
                {
                  key: 'delivery',
                  header: 'Leveranssätt',
                  cell: (c) => (
                    <span className="text-[12px] text-gray-500">
                      {DELIVERY_LABELS[c.deliveryMode]}
                    </span>
                  ),
                },
                {
                  key: 'status',
                  header: 'Status',
                  cell: (c) => <ChargeStatusBadge status={c.status} />,
                },
              ]}
            />
          )}
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

      {/* Skapa tariff */}
      <Modal
        open={showCreateTariff}
        onClose={() => setShowCreateTariff(false)}
        title="Ny tariff"
        description="Pris per förbrukningsenhet. En ny tariff stänger föregående prisperiod automatiskt."
        size="lg"
      >
        <TariffForm
          onSubmit={handleCreateTariff}
          onCancel={() => setShowCreateTariff(false)}
          isSubmitting={createTariffMutation.isPending}
        />
      </Modal>

      {/* Registrera avläsning */}
      <Modal
        open={showCreateReading}
        onClose={() => setShowCreateReading(false)}
        title="Ny avläsning"
        description="Manuell mätaravläsning. Förbrukningen beräknas mot gällande tariff."
        size="lg"
      >
        <ReadingForm
          onSubmit={handleCreateReading}
          onCancel={() => setShowCreateReading(false)}
          isSubmitting={createReadingMutation.isPending}
        />
      </Modal>

      {/* Förbrukningspost — detalj + bekräfta/bokför */}
      {selectedChargeId && (
        <Modal
          open
          onClose={() => setSelectedChargeId(null)}
          title={selectedCharge ? METER_TYPE_LABELS[selectedCharge.meterType] : 'Förbrukningspost'}
          description={
            selectedCharge
              ? `${chargeTenantName(selectedCharge.tenant)} · ${formatDate(selectedCharge.periodStart)} – ${formatDate(selectedCharge.periodEnd)}`
              : ''
          }
          size="lg"
        >
          {!selectedCharge ? (
            <p className="py-8 text-center text-[13px] text-gray-400">Laddar…</p>
          ) : (
            <div className="space-y-4">
              {/* Metadata */}
              <div className="grid grid-cols-2 gap-3">
                {[
                  { label: 'Status', value: <ChargeStatusBadge status={selectedCharge.status} /> },
                  { label: 'Hyresgäst', value: chargeTenantName(selectedCharge.tenant) },
                  { label: 'Mätartyp', value: METER_TYPE_LABELS[selectedCharge.meterType] },
                  {
                    label: 'Förbrukning',
                    value: `${Number(selectedCharge.quantity).toLocaleString('sv-SE', { maximumFractionDigits: 3 })} ${PRICE_UNIT[selectedCharge.meterType]}`,
                  },
                  {
                    label: 'Pris/enhet',
                    value: formatPricePerUnit(
                      selectedCharge.pricePerUnit,
                      selectedCharge.meterType,
                    ),
                  },
                  { label: 'Leveranssätt', value: DELIVERY_LABELS[selectedCharge.deliveryMode] },
                ].map((i) => (
                  <div key={i.label} className="rounded-xl bg-gray-50 p-3">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                      {i.label}
                    </p>
                    <div className="mt-0.5 text-[13px] font-medium text-gray-800">{i.value}</div>
                  </div>
                ))}
              </div>

              {/* Beloppsruta — läses DIREKT från verifikatet, räknas aldrig om */}
              <div className="overflow-hidden rounded-xl border border-[#EAEDF0]">
                <div className="border-b border-[#EAEDF0] bg-gray-50 px-4 py-2.5">
                  <p className="text-[12px] font-semibold text-gray-500">
                    Belopp (från verifikatet)
                  </p>
                </div>
                <div className="divide-y divide-[#EAEDF0]">
                  <div className="flex justify-between px-4 py-2.5 text-[13px]">
                    <span className="text-gray-500">Netto</span>
                    <span className="font-medium text-gray-800">
                      {chargeAmount(selectedCharge.netAmount)}
                    </span>
                  </div>
                  <div className="flex justify-between px-4 py-2.5 text-[13px]">
                    <span className="text-gray-500">
                      Moms{' '}
                      {selectedCharge.vatStatus === 'EXEMPT'
                        ? '(momsfri)'
                        : `(${selectedCharge.vatRate}%)`}
                    </span>
                    <span className="font-medium text-gray-800">
                      {chargeAmount(selectedCharge.vatAmount)}
                    </span>
                  </div>
                  <div className="flex justify-between bg-gray-50 px-4 py-3">
                    <span className="text-[13px] font-semibold text-gray-700">Att betala</span>
                    <span className="text-[16px] font-bold text-gray-900">
                      {chargeAmount(selectedCharge.totalAmount)}
                    </span>
                  </div>
                </div>
              </div>

              {/* Leveranssätt SEPARATE_INVOICE — statisk info, INGEN faktura-knapp */}
              {selectedCharge.deliveryMode === 'SEPARATE_INVOICE' && (
                <div className="rounded-xl border border-blue-100 bg-blue-50/60 p-3 text-[12px] text-blue-700">
                  Leveranssätt: separat faktura. Fakturan genereras i ett kommande steg när den
                  juridiska granskningen är klar — ingen faktura skapas härifrån.
                </div>
              )}

              {/* Bekräfta + bokför — endast DRAFT, bokföringsåtgärd */}
              {selectedCharge.status === 'DRAFT' && canWrite && (
                <div className="rounded-xl border border-amber-200 bg-amber-50 p-3.5">
                  <p className="text-[13px] font-semibold text-amber-800">
                    Att bekräfta innebär att bokföra
                  </p>
                  <p className="mt-1 text-[12px] text-amber-700">
                    Ett periodiserat verifikat skapas (kundfordran 1510 + intäkt, samt moms vid
                    momspliktig post). Åtgärden kan inte ångras härifrån.
                  </p>
                  <div className="mt-3 flex justify-end">
                    <Button
                      variant="primary"
                      size="sm"
                      loading={confirmChargeMutation.isPending}
                      onClick={handleConfirmCharge}
                    >
                      <BookCheck size={14} strokeWidth={1.9} />
                      Bekräfta och bokför
                    </Button>
                  </div>
                </div>
              )}

              {selectedCharge.status !== 'DRAFT' && (
                <div className="flex items-center gap-2 rounded-xl border border-[#EAEDF0] bg-gray-50 p-3 text-[12px] text-gray-500">
                  <BookCheck size={14} strokeWidth={1.9} className="text-emerald-600" />
                  Posten är bokförd (verifikat skapat).
                </div>
              )}
            </div>
          )}
        </Modal>
      )}

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
