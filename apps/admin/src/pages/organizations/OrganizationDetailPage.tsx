import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { LogIn, Pause, Play, Trash2, Plus } from 'lucide-react'
import { PageHeader } from '@/components/ui/PageHeader'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { OrgStatusBadge, PlanBadge, InvoiceStatusBadge } from '@/components/ui/Badge'
import { Modal } from '@/components/ui/Modal'
import { Input, Label, Select, Textarea } from '@/components/ui/Input'
import { get, post, del } from '@/lib/api'
import { formatCurrency, formatDate, formatDateTime } from '@/lib/format'

interface OrgDetail {
  id: string
  name: string
  orgNumber: string | null
  vatNumber: string | null
  email: string
  phone: string | null
  address: { street: string; city: string; postalCode: string; country: string }
  plan: 'TRIAL' | 'BASIC' | 'STANDARD' | 'PREMIUM'
  status: 'ACTIVE' | 'SUSPENDED' | 'CANCELLED'
  trialEndsAt: string | null
  monthlyFee: number
  billingEmail: string | null
  suspendedAt: string | null
  cancellationReason: string | null
  createdAt: string
  counts: {
    properties: number
    tenants: number
    users: number
    invoices: number
    platformInvoices: number
  }
  users: {
    id: string
    email: string
    firstName: string
    lastName: string
    role: string
    isActive: boolean
    lastLoginAt: string | null
    createdAt: string
  }[]
}

type Tab = 'overview' | 'properties' | 'invoices' | 'errors' | 'users'

export function OrganizationDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [tab, setTab] = useState<Tab>('overview')
  const [impersonateOpen, setImpersonateOpen] = useState(false)
  const [suspendOpen, setSuspendOpen] = useState(false)
  const [cancelOpen, setCancelOpen] = useState(false)

  const { data: org } = useQuery({
    queryKey: ['platform', 'org', id],
    queryFn: () => get<OrgDetail>(`/platform/organizations/${id}`),
    enabled: !!id,
  })

  const suspend = useMutation({
    mutationFn: (reason: string) => post(`/platform/organizations/${id}/suspend`, { reason }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['platform', 'org', id] }),
  })
  const unsuspend = useMutation({
    mutationFn: () => post(`/platform/organizations/${id}/unsuspend`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['platform', 'org', id] }),
  })
  const cancel = useMutation({
    mutationFn: (reason: string) =>
      del(`/platform/organizations/${id}?reason=${encodeURIComponent(reason)}`),
    onSuccess: () => navigate('/organizations'),
  })

  if (!org) {
    return <div className="text-[13px] text-gray-500">Laddar…</div>
  }

  return (
    <>
      <PageHeader
        title={org.name}
        description={`${org.orgNumber ?? '—'} · ${org.address.street}, ${org.address.postalCode} ${org.address.city}`}
        action={
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setImpersonateOpen(true)}>
              <LogIn size={14} /> Logga in som kund
            </Button>
            {org.status === 'ACTIVE' ? (
              <Button variant="secondary" onClick={() => setSuspendOpen(true)}>
                <Pause size={14} /> Suspendera
              </Button>
            ) : org.status === 'SUSPENDED' ? (
              <Button onClick={() => unsuspend.mutate()}>
                <Play size={14} /> Återaktivera
              </Button>
            ) : null}
            {org.status !== 'CANCELLED' ? (
              <Button variant="danger" onClick={() => setCancelOpen(true)}>
                <Trash2 size={14} /> Avsluta
              </Button>
            ) : null}
          </div>
        }
      />

      <div className="mt-4 flex items-center gap-3">
        <OrgStatusBadge status={org.status} />
        <PlanBadge plan={org.plan} />
        {org.trialEndsAt ? (
          <span className="text-[12px] text-gray-500">
            Trial slutar {formatDate(org.trialEndsAt)}
          </span>
        ) : null}
      </div>

      <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-4">
        <Card className="p-4">
          <div className="text-[12px] uppercase tracking-wide text-gray-500">Fastigheter</div>
          <div className="mt-1 text-[20px] font-semibold">{org.counts.properties}</div>
        </Card>
        <Card className="p-4">
          <div className="text-[12px] uppercase tracking-wide text-gray-500">Hyresgäster</div>
          <div className="mt-1 text-[20px] font-semibold">{org.counts.tenants}</div>
        </Card>
        <Card className="p-4">
          <div className="text-[12px] uppercase tracking-wide text-gray-500">Månadsavgift</div>
          <div className="mt-1 text-[20px] font-semibold">{formatCurrency(org.monthlyFee)}</div>
        </Card>
        <Card className="p-4">
          <div className="text-[12px] uppercase tracking-wide text-gray-500">
            Fakturor (plattf.)
          </div>
          <div className="mt-1 text-[20px] font-semibold">{org.counts.platformInvoices}</div>
        </Card>
      </div>

      <div className="mt-6 flex w-fit gap-1 rounded-xl bg-gray-100 p-1">
        {(
          [
            ['overview', 'Översikt'],
            ['properties', 'Fastigheter'],
            ['invoices', 'Plattformsfakturor'],
            ['errors', 'Fel'],
            ['users', 'Användare'],
          ] as [Tab, string][]
        ).map(([k, label]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={`h-8 rounded-lg px-3 text-[13px] font-medium ${tab === k ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="mt-4">
        {tab === 'overview' ? <OverviewTab org={org} /> : null}
        {tab === 'users' ? <UsersTab org={org} /> : null}
        {tab === 'properties' ? <PropertiesTab orgId={org.id} /> : null}
        {tab === 'invoices' ? <InvoicesTab orgId={org.id} /> : null}
        {tab === 'errors' ? <ErrorsTab orgId={org.id} /> : null}
      </div>

      <ImpersonateModal
        open={impersonateOpen}
        onClose={() => setImpersonateOpen(false)}
        org={org}
      />
      <SuspendModal
        open={suspendOpen}
        onClose={() => setSuspendOpen(false)}
        onSubmit={(reason) => {
          suspend.mutate(reason)
          setSuspendOpen(false)
        }}
      />
      <CancelModal
        open={cancelOpen}
        onClose={() => setCancelOpen(false)}
        onSubmit={(reason) => {
          cancel.mutate(reason)
          setCancelOpen(false)
        }}
      />
    </>
  )
}

function OverviewTab({ org }: { org: OrgDetail }) {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <h3 className="text-[14px] font-semibold">Kontakt</h3>
        </CardHeader>
        <CardBody className="space-y-2 text-[13.5px]">
          <Row label="E-post" value={org.email} />
          <Row label="Telefon" value={org.phone ?? '—'} />
          <Row label="Faktura-mail" value={org.billingEmail ?? '—'} />
          <Row
            label="Adress"
            value={`${org.address.street}, ${org.address.postalCode} ${org.address.city}`}
          />
        </CardBody>
      </Card>
      <Card>
        <CardHeader>
          <h3 className="text-[14px] font-semibold">Abonnemang</h3>
        </CardHeader>
        <CardBody className="space-y-2 text-[13.5px]">
          <Row label="Plan" value={<PlanBadge plan={org.plan} />} />
          <Row label="Status" value={<OrgStatusBadge status={org.status} />} />
          <Row label="Trial slut" value={org.trialEndsAt ? formatDate(org.trialEndsAt) : '—'} />
          <Row label="Månadsavgift" value={formatCurrency(org.monthlyFee)} />
          {org.cancellationReason ? <Row label="Anledning" value={org.cancellationReason} /> : null}
        </CardBody>
      </Card>
    </div>
  )
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-gray-500">{label}</span>
      <span className="text-right text-gray-900">{value}</span>
    </div>
  )
}

function UsersTab({ org }: { org: OrgDetail }) {
  return (
    <Card className="overflow-hidden">
      <table className="w-full">
        <thead>
          <tr className="border-b border-[#EAEDF0]">
            <th className="px-5 py-3 text-left text-[12px] font-semibold uppercase tracking-wide text-gray-400">
              Namn
            </th>
            <th className="px-5 py-3 text-left text-[12px] font-semibold uppercase tracking-wide text-gray-400">
              E-post
            </th>
            <th className="px-5 py-3 text-left text-[12px] font-semibold uppercase tracking-wide text-gray-400">
              Roll
            </th>
            <th className="px-5 py-3 text-left text-[12px] font-semibold uppercase tracking-wide text-gray-400">
              Senast inloggad
            </th>
          </tr>
        </thead>
        <tbody>
          {org.users.map((u) => (
            <tr key={u.id} className="border-b border-[#EAEDF0] last:border-0">
              <td className="px-5 py-3 text-[13.5px]">
                {u.firstName} {u.lastName}
              </td>
              <td className="px-5 py-3 text-[13.5px] text-gray-600">{u.email}</td>
              <td className="px-5 py-3 text-[13px]">{u.role}</td>
              <td className="px-5 py-3 text-[13px] text-gray-600">
                {u.lastLoginAt ? formatDateTime(u.lastLoginAt) : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  )
}

interface Property {
  id: string
  name: string
  propertyDesignation: string
  type: string
  address: { street: string; city: string }
  totalArea: number
}

function PropertiesTab({ orgId }: { orgId: string }) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const { data: list } = useQuery({
    queryKey: ['platform', 'org', orgId, 'properties'],
    queryFn: () => get<Property[]>(`/platform/organizations/${orgId}/properties`),
  })
  return (
    <>
      <div className="mb-3 flex justify-end">
        <Button onClick={() => setOpen(true)}>
          <Plus size={14} /> Skapa fastighet
        </Button>
      </div>
      <Card className="overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-[#EAEDF0]">
              <th className="px-5 py-3 text-left text-[12px] font-semibold uppercase tracking-wide text-gray-400">
                Namn
              </th>
              <th className="px-5 py-3 text-left text-[12px] font-semibold uppercase tracking-wide text-gray-400">
                Beteckning
              </th>
              <th className="px-5 py-3 text-left text-[12px] font-semibold uppercase tracking-wide text-gray-400">
                Typ
              </th>
              <th className="px-5 py-3 text-left text-[12px] font-semibold uppercase tracking-wide text-gray-400">
                Ort
              </th>
              <th className="px-5 py-3 text-right text-[12px] font-semibold uppercase tracking-wide text-gray-400">
                Area
              </th>
            </tr>
          </thead>
          <tbody>
            {(list ?? []).map((p) => (
              <tr key={p.id} className="border-b border-[#EAEDF0] last:border-0">
                <td className="px-5 py-3 text-[13.5px]">{p.name}</td>
                <td className="px-5 py-3 text-[13px] text-gray-600">{p.propertyDesignation}</td>
                <td className="px-5 py-3 text-[13px]">{p.type}</td>
                <td className="px-5 py-3 text-[13px] text-gray-600">{p.address.city}</td>
                <td className="px-5 py-3 text-right text-[13px]">{p.totalArea} m²</td>
              </tr>
            ))}
            {list && list.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-5 py-10 text-center text-[13px] text-gray-500">
                  Inga fastigheter.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </Card>
      <CreatePropertyModal
        open={open}
        onClose={() => setOpen(false)}
        orgId={orgId}
        onCreated={() => {
          setOpen(false)
          qc.invalidateQueries({ queryKey: ['platform', 'org', orgId, 'properties'] })
          qc.invalidateQueries({ queryKey: ['platform', 'org', orgId] })
        }}
      />
    </>
  )
}

function CreatePropertyModal({
  open,
  onClose,
  orgId,
  onCreated,
}: {
  open: boolean
  onClose: () => void
  orgId: string
  onCreated: () => void
}) {
  const [form, setForm] = useState({
    name: '',
    propertyDesignation: '',
    type: 'RESIDENTIAL',
    street: '',
    city: '',
    postalCode: '',
    totalArea: 0,
    yearBuilt: '',
  })
  const mutation = useMutation({
    mutationFn: () =>
      post(`/platform/organizations/${orgId}/properties`, {
        name: form.name,
        propertyDesignation: form.propertyDesignation,
        type: form.type,
        address: {
          street: form.street,
          city: form.city,
          postalCode: form.postalCode,
          country: 'SE',
        },
        totalArea: Number(form.totalArea),
        ...(form.yearBuilt ? { yearBuilt: Number(form.yearBuilt) } : {}),
      }),
    onSuccess: onCreated,
  })
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Ny fastighet"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Avbryt
          </Button>
          <Button onClick={() => mutation.mutate()} loading={mutation.isPending}>
            Skapa
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <Label>Namn</Label>
          <Input
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Fastighetsbeteckning</Label>
            <Input
              value={form.propertyDesignation}
              onChange={(e) => setForm((f) => ({ ...f, propertyDesignation: e.target.value }))}
            />
          </div>
          <div>
            <Label>Typ</Label>
            <Select
              value={form.type}
              onChange={(e) => setForm((f) => ({ ...f, type: e.target.value }))}
            >
              <option value="RESIDENTIAL">Bostäder</option>
              <option value="COMMERCIAL">Kommersiellt</option>
              <option value="MIXED">Blandat</option>
              <option value="INDUSTRIAL">Industri</option>
              <option value="LAND">Mark</option>
            </Select>
          </div>
        </div>
        <div>
          <Label>Adress</Label>
          <Input
            value={form.street}
            onChange={(e) => setForm((f) => ({ ...f, street: e.target.value }))}
          />
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <Label>Postnr</Label>
            <Input
              value={form.postalCode}
              onChange={(e) => setForm((f) => ({ ...f, postalCode: e.target.value }))}
            />
          </div>
          <div>
            <Label>Ort</Label>
            <Input
              value={form.city}
              onChange={(e) => setForm((f) => ({ ...f, city: e.target.value }))}
            />
          </div>
          <div>
            <Label>Byggår</Label>
            <Input
              value={form.yearBuilt}
              onChange={(e) => setForm((f) => ({ ...f, yearBuilt: e.target.value }))}
            />
          </div>
        </div>
        <div>
          <Label>Area (m²)</Label>
          <Input
            type="number"
            value={form.totalArea}
            onChange={(e) => setForm((f) => ({ ...f, totalArea: Number(e.target.value) }))}
          />
        </div>
      </div>
    </Modal>
  )
}

interface PlatformInvoice {
  id: string
  invoiceNumber: string
  amount: number
  status: 'PENDING' | 'PAID' | 'OVERDUE' | 'VOID'
  description: string | null
  dueDate: string
  createdAt: string
}

function InvoicesTab({ orgId }: { orgId: string }) {
  const { data } = useQuery({
    queryKey: ['platform', 'org', orgId, 'invoices'],
    queryFn: () =>
      get<{ items: PlatformInvoice[] }>('/platform/invoices', { organizationId: orgId }),
  })
  return (
    <Card className="overflow-hidden">
      <table className="w-full">
        <thead>
          <tr className="border-b border-[#EAEDF0]">
            <th className="px-5 py-3 text-left text-[12px] font-semibold uppercase tracking-wide text-gray-400">
              Nummer
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
          </tr>
        </thead>
        <tbody>
          {(data?.items ?? []).map((i) => (
            <tr key={i.id} className="border-b border-[#EAEDF0] last:border-0">
              <td className="px-5 py-3 font-mono text-[13px]">{i.invoiceNumber}</td>
              <td className="px-5 py-3 text-[13px] text-gray-600">{i.description ?? '—'}</td>
              <td className="px-5 py-3 text-right text-[13.5px] font-medium">
                {formatCurrency(i.amount)}
              </td>
              <td className="px-5 py-3">
                <InvoiceStatusBadge status={i.status} />
              </td>
              <td className="px-5 py-3 text-[13px] text-gray-600">{formatDate(i.dueDate)}</td>
            </tr>
          ))}
          {data && data.items.length === 0 ? (
            <tr>
              <td colSpan={5} className="px-5 py-10 text-center text-[13px] text-gray-500">
                Inga fakturor.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </Card>
  )
}

interface ErrorLogItem {
  id: string
  severity: 'CRITICAL' | 'ERROR' | 'WARNING'
  source: string
  message: string
  resolved: boolean
  createdAt: string
}

function ErrorsTab({ orgId }: { orgId: string }) {
  const { data } = useQuery({
    queryKey: ['platform', 'org', orgId, 'errors'],
    queryFn: () =>
      get<{ items: ErrorLogItem[] }>('/platform/errors', { organizationId: orgId, pageSize: 50 }),
  })
  return (
    <Card>
      <CardBody>
        {!data ? (
          <div className="text-[13px] text-gray-500">Laddar…</div>
        ) : data.items.length === 0 ? (
          <div className="py-6 text-center text-[13px] text-gray-500">Inga fel registrerade.</div>
        ) : (
          <ul className="divide-y divide-[#EAEDF0]">
            {data.items.map((e) => (
              <li key={e.id} className="py-3 first:pt-0 last:pb-0">
                <div className="flex items-center gap-2 text-[13px]">
                  <span className="text-gray-500">{formatDateTime(e.createdAt)}</span>
                  <span className="text-gray-400">·</span>
                  <span>{e.source}</span>
                </div>
                <div className="mt-1 text-[13.5px] text-gray-900">{e.message}</div>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  )
}

function ImpersonateModal({
  open,
  onClose,
  org,
}: {
  open: boolean
  onClose: () => void
  org: OrgDetail
}) {
  const [userId, setUserId] = useState('')
  const [reason, setReason] = useState('')
  const mutation = useMutation({
    mutationFn: () =>
      post<{ accessToken: string; logId: string; expiresInSeconds: number }>(
        '/platform/impersonate',
        {
          organizationId: org.id,
          ...(userId ? { userId } : {}),
          ...(reason ? { reason } : {}),
        },
      ),
    onSuccess: (data) => {
      const webUrl =
        (import.meta.env.VITE_WEB_URL as string | undefined) ??
        window.location.origin.replace(/:\d+$/, ':5173')
      window.open(
        `${webUrl}/#impersonate=${data.accessToken}&logId=${data.logId}`,
        '_blank',
        'noopener',
      )
      onClose()
    },
  })
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Logga in som ${org.name}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Avbryt
          </Button>
          <Button onClick={() => mutation.mutate()} loading={mutation.isPending}>
            Skapa impersonation
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-[13px] text-gray-700">
        <p>
          Genererar en JWT som loggar in dig som en användare i <strong>{org.name}</strong>.
          Sessionen loggas juridiskt i ImpersonationLog och går ut efter 1 timme.
        </p>
        <div>
          <Label>Välj användare</Label>
          <Select value={userId} onChange={(e) => setUserId(e.target.value)}>
            <option value="">Automatisk (OWNER/ADMIN först)</option>
            {org.users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.firstName} {u.lastName} · {u.role} · {u.email}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label>Anledning (valfri)</Label>
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Support-ärende #123"
          />
        </div>
      </div>
    </Modal>
  )
}

function SuspendModal({
  open,
  onClose,
  onSubmit,
}: {
  open: boolean
  onClose: () => void
  onSubmit: (reason: string) => void
}) {
  const [reason, setReason] = useState('')
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Suspendera kund"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Avbryt
          </Button>
          <Button variant="danger" onClick={() => onSubmit(reason)}>
            Suspendera
          </Button>
        </>
      }
    >
      <Label>Anledning</Label>
      <Textarea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Obetald faktura…"
      />
    </Modal>
  )
}

function CancelModal({
  open,
  onClose,
  onSubmit,
}: {
  open: boolean
  onClose: () => void
  onSubmit: (reason: string) => void
}) {
  const [reason, setReason] = useState('')
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Avsluta kund"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Avbryt
          </Button>
          <Button variant="danger" onClick={() => onSubmit(reason)}>
            Avsluta
          </Button>
        </>
      }
    >
      <Label>Anledning</Label>
      <Textarea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Kundens beslut…"
      />
    </Modal>
  )
}
