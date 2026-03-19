import { useState } from 'react'
import { motion } from 'framer-motion'
import type { Filter } from 'lucide-react'
import { Plus, Home } from 'lucide-react'
import { PageWrapper } from '@/components/ui/PageWrapper'
import { PageHeader } from '@/components/ui/PageHeader'
import { Button } from '@/components/ui/Button'
import { Modal, ModalFooter } from '@/components/ui/Modal'
import { Input, Select } from '@/components/ui/Input'
import { DataTable } from '@/components/ui/DataTable'
import { UnitStatusBadge } from '@/components/ui/Badge'
import { mockUnits, mockProperties } from '@/lib/mock-data'
import { formatCurrency } from '@eken/shared'
import type { Unit } from '@eken/shared'
import { cn } from '@/lib/cn'

type Filter = 'ALL' | 'OCCUPIED' | 'VACANT' | 'UNDER_RENOVATION' | 'RESERVED'
const FILTERS: { id: Filter; label: string }[] = [
  { id: 'ALL', label: 'Alla' },
  { id: 'OCCUPIED', label: 'Uthyrda' },
  { id: 'VACANT', label: 'Lediga' },
  { id: 'UNDER_RENOVATION', label: 'Renovering' },
  { id: 'RESERVED', label: 'Reserverade' },
]

function getPropertyName(id: string) {
  return mockProperties.find((p) => p.id === id)?.name ?? '–'
}

const unitTypeLabel: Record<string, string> = {
  APARTMENT: 'Lägenhet',
  OFFICE: 'Kontor',
  RETAIL: 'Butik/Restaurang',
  STORAGE: 'Förråd',
  PARKING: 'Parkering',
  OTHER: 'Övrigt',
}

export function UnitsPage() {
  const [filter, setFilter] = useState<Filter>('ALL')
  const [selected, setSelected] = useState<Unit | null>(null)
  const [showCreate, setShowCreate] = useState(false)

  const data = filter === 'ALL' ? mockUnits : mockUnits.filter((u) => u.status === filter)
  const totalRent = mockUnits
    .filter((u) => u.status === 'OCCUPIED')
    .reduce((s, u) => s + u.monthlyRent, 0)

  return (
    <PageWrapper id="units">
      <PageHeader
        title="Objekt"
        description={`${mockUnits.length} objekt · ${mockUnits.filter((u) => u.status === 'VACANT').length} lediga`}
        action={
          <Button variant="primary" size="sm" onClick={() => setShowCreate(true)}>
            <Plus size={14} />
            Nytt objekt
          </Button>
        }
      />

      {/* Stats */}
      <div className="mt-6 grid grid-cols-4 gap-4">
        {[
          { label: 'Totala intäkter/mån', value: formatCurrency(totalRent), sub: 'Uthyrda objekt' },
          {
            label: 'Uthyrda',
            value: mockUnits.filter((u) => u.status === 'OCCUPIED').length,
            sub: `av ${mockUnits.length} objekt`,
          },
          {
            label: 'Lediga',
            value: mockUnits.filter((u) => u.status === 'VACANT').length,
            sub: 'objekt',
          },
          {
            label: 'Total yta',
            value: `${mockUnits.reduce((s, u) => s + u.area, 0)} m²`,
            sub: 'Alla objekt',
          },
        ].map((s, i) => (
          <motion.div
            key={s.label}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.07 }}
            className="rounded-2xl border border-[#EAEDF0] bg-white p-4"
          >
            <p className="text-[12px] font-medium text-gray-400">{s.label}</p>
            <p className="mt-1 text-[24px] font-semibold text-gray-900">{s.value}</p>
            <p className="mt-0.5 text-[12px] text-gray-400">{s.sub}</p>
          </motion.div>
        ))}
      </div>

      {/* Filter tabs */}
      <div className="mt-6 flex w-fit items-center gap-1 rounded-xl bg-gray-100 p-1">
        {FILTERS.map((f) => {
          const count =
            f.id === 'ALL' ? mockUnits.length : mockUnits.filter((u) => u.status === f.id).length
          return (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={cn(
                'flex h-8 items-center gap-1.5 rounded-lg px-3 text-[13px] font-medium transition-all',
                filter === f.id
                  ? 'bg-white text-gray-900 shadow-sm'
                  : 'text-gray-500 hover:text-gray-700',
              )}
            >
              {f.label} <span className="text-[11px] text-gray-400">{count}</span>
            </button>
          )
        })}
      </div>

      <div className="mt-4">
        <DataTable
          data={data}
          keyExtractor={(u) => u.id}
          onRowClick={setSelected}
          columns={[
            {
              key: 'name',
              header: 'Objekt',
              cell: (u) => (
                <div className="flex items-center gap-2">
                  <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-blue-50">
                    <Home size={12} className="text-blue-600" />
                  </div>
                  <div>
                    <p className="font-medium text-gray-800">{u.name}</p>
                    <p className="text-[11px] text-gray-400">{u.unitNumber}</p>
                  </div>
                </div>
              ),
            },
            {
              key: 'property',
              header: 'Fastighet',
              cell: (u) => <span className="text-gray-600">{getPropertyName(u.propertyId)}</span>,
            },
            {
              key: 'type',
              header: 'Typ',
              cell: (u) => (
                <span className="text-[12.5px] text-gray-500">
                  {unitTypeLabel[u.type] ?? u.type}
                </span>
              ),
            },
            {
              key: 'area',
              header: 'Yta',
              align: 'right',
              cell: (u) => <span className="text-gray-600">{u.area} m²</span>,
            },
            {
              key: 'floor',
              header: 'Våning',
              align: 'center',
              cell: (u) => (
                <span className="text-gray-500">
                  {u.floor !== undefined ? `Plan ${u.floor}` : 'BV'}
                </span>
              ),
            },
            {
              key: 'rooms',
              header: 'Rum',
              align: 'center',
              cell: (u) => <span className="text-gray-500">{u.rooms ?? '–'}</span>,
            },
            {
              key: 'rent',
              header: 'Hyra/mån',
              align: 'right',
              cell: (u) => (
                <span className="font-semibold text-gray-800">{formatCurrency(u.monthlyRent)}</span>
              ),
            },
            { key: 'status', header: 'Status', cell: (u) => <UnitStatusBadge status={u.status} /> },
          ]}
        />
      </div>

      {selected && (
        <Modal
          open
          onClose={() => setSelected(null)}
          title={selected.name}
          description={`${getPropertyName(selected.propertyId)} · ${selected.unitNumber}`}
          size="sm"
        >
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              {[
                { label: 'Fastighet', value: getPropertyName(selected.propertyId) },
                { label: 'Typ', value: unitTypeLabel[selected.type] ?? selected.type },
                { label: 'Yta', value: `${selected.area} m²` },
                {
                  label: 'Våning',
                  value: selected.floor !== undefined ? `Plan ${selected.floor}` : 'Bottenvåning',
                },
                { label: 'Antal rum', value: selected.rooms ?? '–' },
                { label: 'Hyra/mån', value: formatCurrency(selected.monthlyRent) },
              ].map((i) => (
                <div key={i.label} className="rounded-xl bg-gray-50 p-3">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                    {i.label}
                  </p>
                  <p className="mt-0.5 text-[13px] font-medium text-gray-800">{i.value}</p>
                </div>
              ))}
            </div>
            <div className="flex items-center justify-between pt-1">
              <UnitStatusBadge status={selected.status} />
            </div>
          </div>
        </Modal>
      )}

      <Modal open={showCreate} onClose={() => setShowCreate(false)} title="Nytt objekt">
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <Input label="Namn" placeholder="Lägenhet 5A" />
            </div>
            <Input label="Objektnummer" placeholder="501" />
            <Select
              label="Fastighet"
              options={mockProperties.map((p) => ({ value: p.id, label: p.name }))}
            />
            <Select
              label="Typ"
              options={Object.entries(unitTypeLabel).map(([v, l]) => ({ value: v, label: l }))}
            />
            <Input label="Yta (m²)" type="number" placeholder="72" />
            <Input label="Våning" type="number" placeholder="3" />
            <Input label="Antal rum" type="number" placeholder="3" />
            <div className="col-span-2">
              <Input label="Hyra per månad (kr)" type="number" placeholder="9500" />
            </div>
          </div>
          <ModalFooter>
            <Button onClick={() => setShowCreate(false)}>Avbryt</Button>
            <Button variant="primary" onClick={() => setShowCreate(false)}>
              Spara
            </Button>
          </ModalFooter>
        </div>
      </Modal>
    </PageWrapper>
  )
}
