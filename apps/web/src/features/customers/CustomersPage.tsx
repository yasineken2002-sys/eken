import { useState, useMemo, useEffect, useRef } from 'react'
import { Plus, Search, Users, User, Building2, Mail, Phone, FileText } from 'lucide-react'
import { PageWrapper } from '@/components/ui/PageWrapper'
import { PageHeader } from '@/components/ui/PageHeader'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { DataTable } from '@/components/ui/DataTable'
import { Badge } from '@/components/ui/Badge'
import { StatCard } from '@/components/ui/StatCard'
import { EmptyState } from '@/components/ui/EmptyState'
import { cn } from '@/lib/cn'
import {
  useCustomers,
  useCreateCustomer,
  useUpdateCustomer,
  useDeleteCustomer,
} from './hooks/useCustomers'
import type { CustomerWithCount, CustomerType } from './api/customers.api'
import { CustomerForm } from './components/CustomerForm'

type Tab = 'ALL' | 'INDIVIDUAL' | 'COMPANY' | 'ARCHIVED'

const TABS: { id: Tab; label: string }[] = [
  { id: 'ALL', label: 'Aktiva' },
  { id: 'INDIVIDUAL', label: 'Privatpersoner' },
  { id: 'COMPANY', label: 'Företag' },
  { id: 'ARCHIVED', label: 'Arkiverade' },
]

function displayName(c: CustomerWithCount): string {
  if (c.type === 'INDIVIDUAL') {
    return [c.firstName, c.lastName].filter(Boolean).join(' ') || '–'
  }
  return c.companyName ?? '–'
}

export function CustomersPage() {
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [tab, setTab] = useState<Tab>('ALL')
  const [showCreate, setShowCreate] = useState(false)
  const [selected, setSelected] = useState<CustomerWithCount | null>(null)

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => setDebouncedSearch(search), 300)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [search])

  const filters = useMemo(() => {
    const f: { search?: string; type?: CustomerType; isActive?: boolean } = {}
    if (debouncedSearch) f.search = debouncedSearch
    if (tab === 'INDIVIDUAL' || tab === 'COMPANY') f.type = tab
    if (tab === 'ARCHIVED') f.isActive = false
    else f.isActive = true
    return f
  }, [debouncedSearch, tab])

  const { data: customers = [], isLoading } = useCustomers(filters)

  const createMutation = useCreateCustomer()
  const updateMutation = useUpdateCustomer()
  const deleteMutation = useDeleteCustomer()

  // Statistik (oberoende av filter — räknar alla aktiva för översikten)
  const { data: allActive = [] } = useCustomers({ isActive: true })
  const individualCount = allActive.filter((c) => c.type === 'INDIVIDUAL').length
  const companyCount = allActive.filter((c) => c.type === 'COMPANY').length
  const totalInvoices = allActive.reduce((s, c) => s + c._count.invoices, 0)

  const columns = [
    {
      key: 'name',
      header: 'Kund',
      cell: (c: CustomerWithCount) => (
        <div>
          <p className="font-medium text-gray-900">{displayName(c)}</p>
          {c.type === 'COMPANY' && c.contactPerson && (
            <p className="mt-0.5 text-[11.5px] text-gray-400">Kontakt: {c.contactPerson}</p>
          )}
        </div>
      ),
    },
    {
      key: 'type',
      header: 'Typ',
      cell: (c: CustomerWithCount) => (
        <Badge variant={c.type === 'COMPANY' ? 'info' : 'default'}>
          {c.type === 'COMPANY' ? 'Företag' : 'Privat'}
        </Badge>
      ),
    },
    {
      key: 'contact',
      header: 'Kontakt',
      cell: (c: CustomerWithCount) => (
        <div className="space-y-0.5">
          {c.email && (
            <div className="flex items-center gap-1.5 text-[12.5px] text-gray-600">
              <Mail size={11} strokeWidth={1.8} className="text-gray-400" />
              {c.email}
            </div>
          )}
          {c.phone && (
            <div className="flex items-center gap-1.5 text-[12.5px] text-gray-500">
              <Phone size={11} strokeWidth={1.8} className="text-gray-400" />
              {c.phone}
            </div>
          )}
        </div>
      ),
    },
    {
      key: 'orgNumber',
      header: 'Org/personnummer',
      cell: (c: CustomerWithCount) => (
        <span className="text-[13px] text-gray-600">{c.orgNumber ?? c.personalNumber ?? '–'}</span>
      ),
    },
    {
      key: 'invoices',
      header: 'Fakturor',
      align: 'right' as const,
      cell: (c: CustomerWithCount) => (
        <div className="flex items-center justify-end gap-1.5 text-[13px] text-gray-700">
          <FileText size={12} strokeWidth={1.8} className="text-gray-400" />
          {c._count.invoices}
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (c: CustomerWithCount) =>
        c.isActive ? (
          <Badge variant="success">Aktiv</Badge>
        ) : (
          <Badge variant="default">Arkiverad</Badge>
        ),
    },
  ]

  return (
    <PageWrapper id="customers">
      <PageHeader
        title="Kunder"
        description="Externa kunder för fakturering vid sidan av hyresgäster"
        action={
          <Button variant="primary" size="sm" onClick={() => setShowCreate(true)}>
            <Plus size={14} />
            Ny kund
          </Button>
        }
      />

      {/* Statistikkort */}
      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard title="Privatpersoner" value={individualCount} icon={User} iconColor="#2563EB" />
        <StatCard title="Företag" value={companyCount} icon={Building2} iconColor="#059669" />
        <StatCard
          title="Fakturor totalt"
          value={totalInvoices}
          icon={FileText}
          iconColor="#7C3AED"
        />
      </div>

      {/* Sök + flikar */}
      <div className="mt-6 flex items-center justify-between gap-3">
        <div className="relative w-72">
          <Search
            size={13}
            strokeWidth={1.8}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
          />
          <Input
            placeholder="Sök på namn, e-post, orgnr…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8"
          />
        </div>

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

      {/* Innehåll */}
      <div className="mt-4">
        {isLoading ? (
          <div className="space-y-2">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-14 animate-pulse rounded-2xl bg-gray-100" />
            ))}
          </div>
        ) : customers.length === 0 ? (
          <EmptyState
            icon={Users}
            title="Inga kunder hittades"
            description={
              debouncedSearch
                ? 'Justera söktermen eller filtret.'
                : 'Lägg till din första externa kund för att börja fakturera.'
            }
            action={
              !debouncedSearch ? (
                <Button variant="primary" size="sm" onClick={() => setShowCreate(true)}>
                  <Plus size={14} />
                  Ny kund
                </Button>
              ) : undefined
            }
          />
        ) : (
          <DataTable
            columns={columns}
            data={customers}
            keyExtractor={(c) => c.id}
            onRowClick={(c) => setSelected(c)}
          />
        )}
      </div>

      {/* Skapa-modal */}
      <Modal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        title="Ny kund"
        description="Lägg till en extern kund som inte är hyresgäst"
        size="md"
      >
        <CustomerForm
          onSubmit={(data) =>
            createMutation.mutate(data, {
              onSuccess: () => setShowCreate(false),
            })
          }
          onCancel={() => setShowCreate(false)}
          isSubmitting={createMutation.isPending}
        />
      </Modal>

      {/* Detaljvy / redigera */}
      {selected && (
        <Modal
          open={!!selected}
          onClose={() => setSelected(null)}
          title={displayName(selected)}
          description={
            selected.type === 'COMPANY'
              ? `Företag · ${selected.orgNumber ?? 'Inget orgnr'}`
              : 'Privatperson'
          }
          size="md"
        >
          <CustomerForm
            defaultValues={selected}
            submitLabel="Spara ändringar"
            onSubmit={(data) =>
              updateMutation.mutate(
                { id: selected.id, ...data },
                { onSuccess: () => setSelected(null) },
              )
            }
            onCancel={() => setSelected(null)}
            isSubmitting={updateMutation.isPending}
          />

          <div className="mt-5 flex justify-between border-t border-gray-100 pt-4">
            {selected.isActive ? (
              <Button
                size="sm"
                onClick={() => {
                  if (
                    window.confirm(
                      `Arkivera ${displayName(selected)}? Befintliga fakturor behålls.`,
                    )
                  ) {
                    deleteMutation.mutate(selected.id, {
                      onSuccess: () => setSelected(null),
                    })
                  }
                }}
              >
                Arkivera kund
              </Button>
            ) : (
              <Button
                size="sm"
                onClick={() =>
                  updateMutation.mutate(
                    { id: selected.id, isActive: true },
                    { onSuccess: () => setSelected(null) },
                  )
                }
              >
                Återaktivera
              </Button>
            )}
            <span className="text-[12px] text-gray-400">
              {selected._count.invoices} fakturor · skapad{' '}
              {new Date(selected.createdAt).toLocaleDateString('sv-SE')}
            </span>
          </div>
        </Modal>
      )}
    </PageWrapper>
  )
}
