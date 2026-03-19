import { useState } from 'react'
import { motion } from 'framer-motion'
import { Plus, Filter } from 'lucide-react'
import { PageWrapper } from '@/components/ui/PageWrapper'
import { PageHeader } from '@/components/ui/PageHeader'
import { Button } from '@/components/ui/Button'
import { Modal, ModalFooter } from '@/components/ui/Modal'
import { Input, Select } from '@/components/ui/Input'
import { DataTable } from '@/components/ui/DataTable'
import { InvoiceStatusBadge } from '@/components/ui/Badge'
import { mockInvoices, mockTenants } from '@/lib/mock-data'
import { formatCurrency, formatDate } from '@eken/shared'
import type { Invoice } from '@eken/shared'
import { cn } from '@/lib/cn'

type Tab = 'ALL' | 'DRAFT' | 'SENT' | 'PAID' | 'OVERDUE'
const TABS: { id: Tab; label: string; color?: string }[] = [
  { id: 'ALL', label: 'Alla' },
  { id: 'SENT', label: 'Skickade' },
  { id: 'PAID', label: 'Betalda', color: 'text-emerald-600' },
  { id: 'OVERDUE', label: 'Försenade', color: 'text-red-600' },
  { id: 'DRAFT', label: 'Utkast' },
]

function getTenantName(id: string) {
  const t = mockTenants.find((t) => t.id === id)
  if (!t) return '–'
  return t.type === 'INDIVIDUAL' ? `${t.firstName} ${t.lastName}` : (t.companyName ?? '–')
}

export function InvoicesPage() {
  const [tab, setTab] = useState<Tab>('ALL')
  const [selected, setSelected] = useState<Invoice | null>(null)
  const [showCreate, setShowCreate] = useState(false)

  const filtered = tab === 'ALL' ? mockInvoices : mockInvoices.filter((i) => i.status === tab)
  const totalPaid = mockInvoices.filter((i) => i.status === 'PAID').reduce((s, i) => s + i.total, 0)
  const totalOverdue = mockInvoices
    .filter((i) => i.status === 'OVERDUE')
    .reduce((s, i) => s + i.total, 0)
  const totalDraft = mockInvoices
    .filter((i) => i.status === 'DRAFT')
    .reduce((s, i) => s + i.total, 0)

  return (
    <PageWrapper id="invoices">
      <PageHeader
        title="Fakturor"
        description={`${mockInvoices.length} fakturor totalt`}
        action={
          <div className="flex items-center gap-2">
            <Button size="sm">
              <Filter size={13} />
              Filter
            </Button>
            <Button variant="primary" size="sm" onClick={() => setShowCreate(true)}>
              <Plus size={14} />
              Ny faktura
            </Button>
          </div>
        }
      />

      {/* Summary */}
      <div className="mt-6 grid grid-cols-3 gap-4">
        {[
          {
            label: 'Betalt denna period',
            value: formatCurrency(totalPaid),
            color: 'emerald',
            tag: `${mockInvoices.filter((i) => i.status === 'PAID').length} fakturor`,
          },
          {
            label: 'Försenat belopp',
            value: formatCurrency(totalOverdue),
            color: 'red',
            tag: `${mockInvoices.filter((i) => i.status === 'OVERDUE').length} fakturor`,
          },
          {
            label: 'Obesvarade utkast',
            value: formatCurrency(totalDraft),
            color: 'slate',
            tag: `${mockInvoices.filter((i) => i.status === 'DRAFT').length} fakturor`,
          },
        ].map((s, i) => (
          <motion.div
            key={s.label}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.07 }}
            className="rounded-2xl border border-[#EAEDF0] bg-white p-5"
          >
            <p className="text-[12px] font-medium text-gray-400">{s.label}</p>
            <p
              className={`mt-1 text-[22px] font-semibold text-${s.color}-${s.color === 'slate' ? '700' : '600'}`}
            >
              {s.value}
            </p>
            <p className="mt-1 text-[12px] text-gray-400">{s.tag}</p>
          </motion.div>
        ))}
      </div>

      {/* Tabs */}
      <div className="mt-6 flex w-fit items-center gap-1 rounded-xl bg-gray-100 p-1">
        {TABS.map((t) => {
          const count =
            t.id === 'ALL'
              ? mockInvoices.length
              : mockInvoices.filter((i) => i.status === t.id).length
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                'flex h-8 items-center gap-1.5 rounded-lg px-3 text-[13px] font-medium transition-all',
                tab === t.id
                  ? 'bg-white text-gray-900 shadow-sm'
                  : 'text-gray-500 hover:text-gray-700',
              )}
            >
              {t.label}
              <span
                className={cn(
                  'rounded-full px-1.5 text-[11px] font-semibold',
                  tab === t.id && t.color ? t.color : 'text-gray-400',
                )}
              >
                {count}
              </span>
            </button>
          )
        })}
      </div>

      <div className="mt-4">
        <DataTable
          data={filtered}
          keyExtractor={(i) => i.id}
          onRowClick={setSelected}
          columns={[
            {
              key: 'number',
              header: 'Fakturanr',
              cell: (i) => (
                <span className="font-mono text-[13px] font-medium text-gray-800">
                  {i.invoiceNumber}
                </span>
              ),
            },
            {
              key: 'tenant',
              header: 'Hyresgäst',
              cell: (i) => <span className="text-gray-700">{getTenantName(i.tenantId)}</span>,
            },
            {
              key: 'type',
              header: 'Typ',
              cell: (i) => (
                <span className="text-[12px] text-gray-500">
                  {i.type === 'RENT'
                    ? 'Hyra'
                    : i.type === 'DEPOSIT'
                      ? 'Deposition'
                      : i.type === 'SERVICE'
                        ? 'Tjänst'
                        : i.type}
                </span>
              ),
            },
            {
              key: 'issue',
              header: 'Utfärdat',
              cell: (i) => (
                <span className="text-[12.5px] text-gray-500">{formatDate(i.issueDate)}</span>
              ),
            },
            {
              key: 'due',
              header: 'Förfaller',
              cell: (i) => (
                <span
                  className={`text-[12.5px] font-medium ${i.status === 'OVERDUE' ? 'text-red-600' : 'text-gray-500'}`}
                >
                  {formatDate(i.dueDate)}
                </span>
              ),
            },
            {
              key: 'total',
              header: 'Belopp',
              align: 'right',
              cell: (i) => (
                <span className="font-semibold text-gray-800">{formatCurrency(i.total)}</span>
              ),
            },
            {
              key: 'status',
              header: 'Status',
              cell: (i) => <InvoiceStatusBadge status={i.status} />,
            },
          ]}
        />
      </div>

      {selected && (
        <Modal
          open
          onClose={() => setSelected(null)}
          title={selected.invoiceNumber}
          description={getTenantName(selected.tenantId)}
          size="md"
        >
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              {[
                { label: 'Hyresgäst', value: getTenantName(selected.tenantId) },
                { label: 'Status', value: selected.status },
                { label: 'Utfärdat', value: formatDate(selected.issueDate) },
                { label: 'Förfaller', value: formatDate(selected.dueDate) },
              ].map((i) => (
                <div key={i.label} className="rounded-xl bg-gray-50 p-3">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                    {i.label}
                  </p>
                  <p className="mt-0.5 text-[13px] font-medium text-gray-800">{i.value}</p>
                </div>
              ))}
            </div>
            <div className="overflow-hidden rounded-xl border border-[#EAEDF0]">
              <div className="border-b border-[#EAEDF0] bg-gray-50 px-4 py-2.5">
                <p className="text-[12px] font-semibold text-gray-500">Fakturarader</p>
              </div>
              {selected.lines.map((line) => (
                <div
                  key={line.id}
                  className="flex items-center justify-between border-b border-[#EAEDF0] px-4 py-3 last:border-0"
                >
                  <div>
                    <p className="text-[13px] text-gray-800">{line.description}</p>
                    <p className="text-[12px] text-gray-400">
                      {line.quantity} × {formatCurrency(line.unitPrice)} · Moms {line.vatRate}%
                    </p>
                  </div>
                  <p className="text-[14px] font-semibold text-gray-800">
                    {formatCurrency(line.total)}
                  </p>
                </div>
              ))}
              <div className="flex justify-between bg-gray-50 px-4 py-3">
                <p className="text-[13px] font-semibold text-gray-700">Totalt inkl moms</p>
                <p className="text-[16px] font-bold text-gray-900">
                  {formatCurrency(selected.total)}
                </p>
              </div>
            </div>
            {selected.paidAt && (
              <div className="flex items-center gap-2 rounded-xl border border-emerald-100 bg-emerald-50 p-3">
                <span className="text-[12px] font-medium text-emerald-700">
                  Betald {formatDate(selected.paidAt)}
                </span>
              </div>
            )}
          </div>
        </Modal>
      )}

      <Modal open={showCreate} onClose={() => setShowCreate(false)} title="Ny faktura">
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <Input label="Hyresgäst" placeholder="Välj hyresgäst" />
            </div>
            <Select
              label="Typ"
              options={[
                { value: 'RENT', label: 'Hyra' },
                { value: 'DEPOSIT', label: 'Deposition' },
                { value: 'SERVICE', label: 'Tjänst' },
                { value: 'UTILITY', label: 'Drift' },
                { value: 'OTHER', label: 'Övrigt' },
              ]}
            />
            <Input label="Förfallodatum" type="date" />
            <div className="col-span-2 space-y-2 rounded-xl border p-3">
              <p className="text-[13px] font-medium text-gray-700">Fakturarader</p>
              <Input placeholder="Beskrivning" />
              <div className="flex gap-2">
                <Input placeholder="Antal" type="number" className="w-24" />
                <Input placeholder="À-pris (kr)" type="number" />
                <Select
                  options={[
                    { value: '0', label: '0%' },
                    { value: '6', label: '6%' },
                    { value: '12', label: '12%' },
                    { value: '25', label: '25%' },
                  ]}
                />
              </div>
            </div>
            <Input label="Referens / OCR" placeholder="9153" />
            <Input label="Utfärdandedatum" type="date" />
          </div>
          <ModalFooter>
            <Button onClick={() => setShowCreate(false)}>Avbryt</Button>
            <Button variant="primary" onClick={() => setShowCreate(false)}>
              Skapa faktura
            </Button>
          </ModalFooter>
        </div>
      </Modal>
    </PageWrapper>
  )
}
