import { useState } from 'react'
import { motion } from 'framer-motion'
import { Plus, Calendar, Home, User } from 'lucide-react'
import { PageWrapper } from '@/components/ui/PageWrapper'
import { PageHeader } from '@/components/ui/PageHeader'
import { Button } from '@/components/ui/Button'
import { Modal, ModalFooter } from '@/components/ui/Modal'
import { Input } from '@/components/ui/Input'
import { DataTable } from '@/components/ui/DataTable'
import { LeaseStatusBadge } from '@/components/ui/Badge'
import { mockLeases, mockTenants, mockUnits, mockProperties } from '@/lib/mock-data'
import { formatCurrency, formatDate } from '@eken/shared'
import type { Lease } from '@eken/shared'

function getTenantName(id: string) {
  const t = mockTenants.find((t) => t.id === id)
  if (!t) return '–'
  return t.type === 'INDIVIDUAL' ? `${t.firstName} ${t.lastName}` : (t.companyName ?? '–')
}
function getUnitName(id: string) {
  const u = mockUnits.find((u) => u.id === id)
  if (!u) return '–'
  const p = mockProperties.find((p) => p.id === u.propertyId)
  return `${p?.name ?? ''} · ${u.name}`
}

export function LeasesPage() {
  const [selected, setSelected] = useState<Lease | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const active = mockLeases.filter((l) => l.status === 'ACTIVE').length

  return (
    <PageWrapper id="leases">
      <PageHeader
        title="Hyresavtal"
        description={`${mockLeases.length} avtal · ${active} aktiva`}
        action={
          <Button variant="primary" size="sm" onClick={() => setShowCreate(true)}>
            <Plus size={14} />
            Nytt avtal
          </Button>
        }
      />

      {/* Summary cards */}
      <div className="mt-6 grid grid-cols-3 gap-4">
        {[
          { label: 'Aktiva avtal', value: active, color: 'emerald' },
          {
            label: 'Tidsbegränsade',
            value: mockLeases.filter((l) => l.endDate).length,
            color: 'amber',
          },
          {
            label: 'Tillsvidare',
            value: mockLeases.filter((l) => !l.endDate).length,
            color: 'blue',
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
            <p className="mt-1 text-[28px] font-semibold text-gray-900">{s.value}</p>
          </motion.div>
        ))}
      </div>

      <div className="mt-6">
        <DataTable
          data={mockLeases}
          keyExtractor={(l) => l.id}
          onRowClick={setSelected}
          columns={[
            {
              key: 'tenant',
              header: 'Hyresgäst',
              cell: (l) => (
                <div className="flex items-center gap-2">
                  <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-violet-100">
                    <User size={12} className="text-violet-600" />
                  </div>
                  <span className="font-medium text-gray-800">{getTenantName(l.tenantId)}</span>
                </div>
              ),
            },
            {
              key: 'unit',
              header: 'Objekt',
              cell: (l) => (
                <div className="flex items-center gap-1.5 text-gray-600">
                  <Home size={12} className="text-gray-300" />
                  {getUnitName(l.unitId)}
                </div>
              ),
            },
            {
              key: 'period',
              header: 'Period',
              cell: (l) => (
                <div className="flex items-center gap-1.5 text-[12.5px] text-gray-600">
                  <Calendar size={11} className="text-gray-300" />
                  {formatDate(l.startDate)} → {l.endDate ? formatDate(l.endDate) : 'Tillsvidare'}
                </div>
              ),
            },
            {
              key: 'rent',
              header: 'Hyra/mån',
              align: 'right',
              cell: (l) => (
                <span className="font-semibold text-gray-800">{formatCurrency(l.monthlyRent)}</span>
              ),
            },
            {
              key: 'deposit',
              header: 'Deposition',
              align: 'right',
              cell: (l) => <span className="text-gray-500">{formatCurrency(l.depositAmount)}</span>,
            },
            {
              key: 'status',
              header: 'Status',
              cell: (l) => <LeaseStatusBadge status={l.status} />,
            },
          ]}
        />
      </div>

      {selected && (
        <Modal
          open
          onClose={() => setSelected(null)}
          title="Hyresavtal"
          description={getTenantName(selected.tenantId)}
          size="md"
        >
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              {[
                { label: 'Hyresgäst', value: getTenantName(selected.tenantId) },
                { label: 'Objekt', value: getUnitName(selected.unitId) },
                { label: 'Startdatum', value: formatDate(selected.startDate) },
                {
                  label: 'Slutdatum',
                  value: selected.endDate ? formatDate(selected.endDate) : 'Tillsvidare',
                },
                { label: 'Hyra/mån', value: formatCurrency(selected.monthlyRent) },
                { label: 'Deposition', value: formatCurrency(selected.depositAmount) },
                { label: 'Uppsägningstid', value: `${selected.noticePeriodMonths} månader` },
                { label: 'Indexklausul', value: selected.indexClause ? 'Ja' : 'Nej' },
              ].map((i) => (
                <div key={i.label} className="rounded-xl bg-gray-50 p-3">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                    {i.label}
                  </p>
                  <p className="mt-0.5 text-[13px] font-medium text-gray-800">{i.value}</p>
                </div>
              ))}
            </div>
            <div className="flex items-center justify-between">
              <LeaseStatusBadge status={selected.status} />
              {selected.signedAt && (
                <p className="text-[12px] text-gray-400">
                  Signerat {formatDate(selected.signedAt)}
                </p>
              )}
            </div>
          </div>
        </Modal>
      )}

      <Modal open={showCreate} onClose={() => setShowCreate(false)} title="Nytt hyresavtal">
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <Input label="Hyresgäst" placeholder="Välj hyresgäst" />
            </div>
            <div className="col-span-2">
              <Input label="Objekt" placeholder="Välj objekt" />
            </div>
            <Input label="Startdatum" type="date" />
            <Input label="Slutdatum (lämna tomt = tillsvidare)" type="date" />
            <Input label="Hyra per månad (kr)" type="number" placeholder="9200" />
            <Input label="Deposition (kr)" type="number" placeholder="27600" />
            <Input label="Uppsägningstid (månader)" type="number" placeholder="3" />
          </div>
          <ModalFooter>
            <Button onClick={() => setShowCreate(false)}>Avbryt</Button>
            <Button variant="primary" onClick={() => setShowCreate(false)}>
              Skapa avtal
            </Button>
          </ModalFooter>
        </div>
      </Modal>
    </PageWrapper>
  )
}
