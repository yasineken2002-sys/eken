import { useState } from 'react'
import { motion } from 'framer-motion'
import { Plus, Mail, Phone, Building2 } from 'lucide-react'
import { PageWrapper } from '@/components/ui/PageWrapper'
import { PageHeader } from '@/components/ui/PageHeader'
import { Button } from '@/components/ui/Button'
import { Modal, ModalFooter } from '@/components/ui/Modal'
import { Input } from '@/components/ui/Input'
import { Badge } from '@/components/ui/Badge'
import { mockTenants, mockLeases } from '@/lib/mock-data'
import type { Tenant } from '@eken/shared'

const stagger = { hidden: {}, show: { transition: { staggerChildren: 0.05 } } }
const item = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: 0.2 } },
}

function TenantCard({ tenant, onClick }: { tenant: Tenant; onClick: () => void }) {
  const lease = mockLeases.find((l) => l.tenantId === tenant.id && l.status === 'ACTIVE')
  const name =
    tenant.type === 'INDIVIDUAL'
      ? `${tenant.firstName} ${tenant.lastName}`
      : (tenant.companyName ?? '')
  const initials =
    tenant.type === 'INDIVIDUAL'
      ? `${tenant.firstName?.[0] ?? ''}${tenant.lastName?.[0] ?? ''}`
      : (tenant.companyName?.[0] ?? '')
  const colors = [
    'from-violet-400 to-violet-600',
    'from-blue-400 to-blue-600',
    'from-emerald-400 to-emerald-600',
    'from-rose-400 to-rose-600',
    'from-amber-400 to-amber-600',
  ]
  const color = colors[tenant.id.charCodeAt(1) % colors.length] ?? colors[0]
  return (
    <motion.div
      variants={item}
      onClick={onClick}
      whileHover={{ y: -1 }}
      className="cursor-pointer rounded-2xl border border-[#EAEDF0] bg-white p-4 transition-all hover:shadow-sm"
    >
      <div className="flex items-start gap-3">
        <div
          className={`h-10 w-10 rounded-xl bg-gradient-to-br ${color} flex flex-shrink-0 items-center justify-center`}
        >
          <span className="text-[13px] font-semibold text-white">{initials}</span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="truncate text-[14px] font-semibold text-gray-900">{name}</p>
            <Badge variant={tenant.type === 'COMPANY' ? 'info' : 'default'}>
              {tenant.type === 'COMPANY' ? 'Företag' : 'Privat'}
            </Badge>
          </div>
          {tenant.type === 'COMPANY' && (
            <p className="mt-0.5 text-[12px] text-gray-400">{tenant.contactPerson}</p>
          )}
          {tenant.personalNumber && (
            <p className="mt-0.5 text-[12px] text-gray-400">{tenant.personalNumber}</p>
          )}
          {tenant.orgNumber && (
            <p className="mt-0.5 text-[12px] text-gray-400">{tenant.orgNumber}</p>
          )}
        </div>
      </div>
      <div className="mt-3 space-y-1.5">
        <div className="flex items-center gap-2 text-[12.5px] text-gray-500">
          <Mail size={11} className="text-gray-300" />
          {tenant.email}
        </div>
        {tenant.phone && (
          <div className="flex items-center gap-2 text-[12.5px] text-gray-500">
            <Phone size={11} className="text-gray-300" />
            {tenant.phone}
          </div>
        )}
      </div>
      <div className="mt-3 flex items-center gap-2 border-t border-[#EAEDF0] pt-3">
        {lease ? (
          <>
            <Building2 size={11} className="text-emerald-500" />
            <span className="text-[12px] font-medium text-emerald-700">Aktivt hyresavtal</span>
          </>
        ) : (
          <>
            <span className="text-[12px] text-gray-400">Inget aktivt avtal</span>
          </>
        )}
      </div>
    </motion.div>
  )
}

function TenantDetail({ tenant, onClose }: { tenant: Tenant; onClose: () => void }) {
  const name =
    tenant.type === 'INDIVIDUAL'
      ? `${tenant.firstName} ${tenant.lastName}`
      : (tenant.companyName ?? '')
  const leases = mockLeases.filter((l) => l.tenantId === tenant.id)
  return (
    <Modal open onClose={onClose} title={name} description={tenant.email} size="md">
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          {[
            { label: 'Typ', value: tenant.type === 'COMPANY' ? 'Företag' : 'Privatperson' },
            { label: 'E-post', value: tenant.email },
            { label: 'Telefon', value: tenant.phone ?? '–' },
            {
              label: tenant.type === 'COMPANY' ? 'Org.nr' : 'Personnummer',
              value: tenant.orgNumber ?? tenant.personalNumber ?? '–',
            },
          ].map((i) => (
            <div key={i.label} className="rounded-xl bg-gray-50 p-3">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                {i.label}
              </p>
              <p className="mt-0.5 text-[13px] font-medium text-gray-800">{i.value}</p>
            </div>
          ))}
        </div>
        {leases.length > 0 && (
          <div>
            <h3 className="mb-2 text-[13px] font-semibold text-gray-700">Hyresavtal</h3>
            {leases.map((l) => (
              <div
                key={l.id}
                className="mb-2 flex items-center justify-between rounded-xl border border-[#EAEDF0] p-3"
              >
                <div>
                  <p className="text-[13px] font-medium text-gray-800">Avtal #{l.id}</p>
                  <p className="text-[12px] text-gray-400">
                    Startade {l.startDate}
                    {l.endDate ? ` → ${l.endDate}` : ' (tillsvidare)'}
                  </p>
                </div>
                <p className="text-[13px] font-semibold text-gray-700">
                  {l.monthlyRent.toLocaleString('sv-SE')} kr/mån
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  )
}

export function TenantsPage() {
  const [selected, setSelected] = useState<Tenant | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [type, setType] = useState<'INDIVIDUAL' | 'COMPANY'>('INDIVIDUAL')
  return (
    <PageWrapper id="tenants">
      <PageHeader
        title="Hyresgäster"
        description={`${mockTenants.length} hyresgäster registrerade`}
        action={
          <Button variant="primary" size="sm" onClick={() => setShowCreate(true)}>
            <Plus size={14} />
            Ny hyresgäst
          </Button>
        }
      />
      <motion.div
        variants={stagger}
        initial="hidden"
        animate="show"
        className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3"
      >
        {mockTenants.map((t) => (
          <TenantCard key={t.id} tenant={t} onClick={() => setSelected(t)} />
        ))}
      </motion.div>
      {selected && <TenantDetail tenant={selected} onClose={() => setSelected(null)} />}
      <Modal open={showCreate} onClose={() => setShowCreate(false)} title="Ny hyresgäst">
        <div className="space-y-4">
          <div className="flex overflow-hidden rounded-xl border border-[#EAEDF0]">
            {(['INDIVIDUAL', 'COMPANY'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setType(t)}
                className={`flex-1 py-2 text-[13px] font-medium transition-colors ${type === t ? 'bg-blue-600 text-white' : 'text-gray-500 hover:bg-gray-50'}`}
              >
                {t === 'INDIVIDUAL' ? 'Privatperson' : 'Företag'}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-3">
            {type === 'INDIVIDUAL' ? (
              <>
                <Input label="Förnamn" placeholder="Anna" />
                <Input label="Efternamn" placeholder="Lindqvist" />
                <div className="col-span-2">
                  <Input label="Personnummer" placeholder="19880315-4521" />
                </div>
              </>
            ) : (
              <>
                <div className="col-span-2">
                  <Input label="Företagsnamn" placeholder="Techstart AB" />
                </div>
                <div className="col-span-2">
                  <Input label="Organisationsnummer" placeholder="556789-1234" />
                </div>
                <div className="col-span-2">
                  <Input label="Kontaktperson" placeholder="Maria Holm" />
                </div>
              </>
            )}
            <div className="col-span-2">
              <Input label="E-postadress" type="email" placeholder="kontakt@foretag.se" />
            </div>
            <div className="col-span-2">
              <Input label="Telefon" placeholder="070-123 45 67" />
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
