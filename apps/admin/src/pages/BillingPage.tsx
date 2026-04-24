import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { PageHeader } from '@/components/ui/PageHeader'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Input, Label, Select } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { InvoiceStatusBadge } from '@/components/ui/Badge'
import { get, post, patch } from '@/lib/api'
import { formatCurrency, formatDate } from '@/lib/format'

interface Invoice {
  id: string
  invoiceNumber: string
  amount: number
  status: 'PENDING' | 'PAID' | 'OVERDUE' | 'VOID'
  description: string | null
  dueDate: string
  organization: { id: string; name: string; email: string }
}

interface Org {
  id: string
  name: string
}

export function BillingPage() {
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<'' | Invoice['status']>('')
  const qc = useQueryClient()

  const { data } = useQuery({
    queryKey: ['platform', 'invoices', status],
    queryFn: () =>
      get<{ items: Invoice[] }>(
        '/platform/invoices',
        status ? { status, pageSize: 200 } : { pageSize: 200 },
      ),
  })

  const updateStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: Invoice['status'] }) =>
      patch(`/platform/invoices/${id}/status`, { status }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['platform', 'invoices'] }),
  })

  return (
    <>
      <PageHeader
        title="Plattformsfakturor"
        description="Fakturor som Eken skickar till kunder"
        action={
          <Button onClick={() => setOpen(true)}>
            <Plus size={14} /> Skicka faktura
          </Button>
        }
      />

      <div className="mt-6">
        <Select
          value={status}
          onChange={(e) => setStatus(e.target.value as Invoice['status'] | '')}
          className="w-48"
        >
          <option value="">Alla statusar</option>
          <option value="PENDING">Väntar</option>
          <option value="PAID">Betald</option>
          <option value="OVERDUE">Förfallen</option>
          <option value="VOID">Makulerad</option>
        </Select>
      </div>

      <Card className="mt-4 overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-[#EAEDF0]">
              <th className="px-5 py-3 text-left text-[12px] font-semibold uppercase tracking-wide text-gray-400">
                Nummer
              </th>
              <th className="px-5 py-3 text-left text-[12px] font-semibold uppercase tracking-wide text-gray-400">
                Kund
              </th>
              <th className="px-5 py-3 text-left text-[12px] font-semibold uppercase tracking-wide text-gray-400">
                Beskrivning
              </th>
              <th className="px-5 py-3 text-right text-[12px] font-semibold uppercase tracking-wide text-gray-400">
                Belopp
              </th>
              <th className="px-5 py-3 text-left text-[12px] font-semibold uppercase tracking-wide text-gray-400">
                Status
              </th>
              <th className="px-5 py-3 text-left text-[12px] font-semibold uppercase tracking-wide text-gray-400">
                Förfaller
              </th>
              <th className="px-5 py-3 text-right text-[12px] font-semibold uppercase tracking-wide text-gray-400"></th>
            </tr>
          </thead>
          <tbody>
            {(data?.items ?? []).map((i) => (
              <tr key={i.id} className="border-b border-[#EAEDF0] last:border-0">
                <td className="px-5 py-3 font-mono text-[13px]">{i.invoiceNumber}</td>
                <td className="px-5 py-3 text-[13.5px]">{i.organization.name}</td>
                <td className="px-5 py-3 text-[13px] text-gray-600">{i.description ?? '—'}</td>
                <td className="px-5 py-3 text-right text-[13.5px] font-medium">
                  {formatCurrency(i.amount)}
                </td>
                <td className="px-5 py-3">
                  <InvoiceStatusBadge status={i.status} />
                </td>
                <td className="px-5 py-3 text-[13px] text-gray-600">{formatDate(i.dueDate)}</td>
                <td className="px-5 py-3 text-right">
                  {i.status === 'PENDING' || i.status === 'OVERDUE' ? (
                    <div className="flex justify-end gap-2">
                      <Button
                        size="sm"
                        onClick={() => updateStatus.mutate({ id: i.id, status: 'PAID' })}
                      >
                        Markera betald
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => updateStatus.mutate({ id: i.id, status: 'VOID' })}
                      >
                        Makulera
                      </Button>
                    </div>
                  ) : null}
                </td>
              </tr>
            ))}
            {data && data.items.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-5 py-10 text-center text-[13px] text-gray-500">
                  Inga fakturor.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </Card>

      <CreateInvoiceModal
        open={open}
        onClose={() => setOpen(false)}
        onCreated={() => {
          setOpen(false)
          qc.invalidateQueries({ queryKey: ['platform', 'invoices'] })
        }}
      />
    </>
  )
}

function CreateInvoiceModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean
  onClose: () => void
  onCreated: () => void
}) {
  const [form, setForm] = useState({
    organizationId: '',
    amount: 0,
    description: '',
    dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
  })
  const { data: orgs } = useQuery({
    queryKey: ['platform', 'organizations', 'minimal'],
    queryFn: () => get<{ items: Org[] }>('/platform/organizations', { pageSize: 500 }),
    enabled: open,
  })
  const mutation = useMutation({
    mutationFn: () =>
      post('/platform/invoices', {
        organizationId: form.organizationId,
        amount: Number(form.amount),
        dueDate: new Date(form.dueDate).toISOString(),
        description: form.description || undefined,
      }),
    onSuccess: onCreated,
  })
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Skicka plattformsfaktura"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Avbryt
          </Button>
          <Button
            onClick={() => mutation.mutate()}
            loading={mutation.isPending}
            disabled={!form.organizationId}
          >
            Skapa
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <Label>Kund</Label>
          <Select
            value={form.organizationId}
            onChange={(e) => setForm((f) => ({ ...f, organizationId: e.target.value }))}
          >
            <option value="">Välj kund…</option>
            {orgs?.items.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Belopp (SEK)</Label>
            <Input
              type="number"
              value={form.amount}
              onChange={(e) => setForm((f) => ({ ...f, amount: Number(e.target.value) }))}
            />
          </div>
          <div>
            <Label>Förfaller</Label>
            <Input
              type="date"
              value={form.dueDate}
              onChange={(e) => setForm((f) => ({ ...f, dueDate: e.target.value }))}
            />
          </div>
        </div>
        <div>
          <Label>Beskrivning</Label>
          <Input
            value={form.description}
            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            placeholder="Månadsavgift maj"
          />
        </div>
      </div>
    </Modal>
  )
}
