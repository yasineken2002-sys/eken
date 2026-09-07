import { useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { Hammer, Mail, Phone, Plus } from 'lucide-react'
import type { CreateContractorInput, MaintenanceCategoryValue } from '@eken/shared'
import { MAINTENANCE_CATEGORIES, MAINTENANCE_CATEGORY_ETIKETT } from '@eken/shared'

import { PageWrapper } from '@/components/ui/PageWrapper'
import { PageHeader } from '@/components/ui/PageHeader'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { DataTable } from '@/components/ui/DataTable'
import { EmptyState } from '@/components/ui/EmptyState'
import { StatCard } from '@/components/ui/StatCard'
import { cn } from '@/lib/cn'

import { useContractors, useCreateContractor, useUpdateContractor } from './hooks/useContractors'
import { ContractorForm } from './components/ContractorForm'
import type { Contractor } from './api/contractors.api'

type Flik = 'AKTIVA' | 'INAKTIVA' | 'ALLA'

const FLIKAR: { id: Flik; label: string }[] = [
  { id: 'AKTIVA', label: 'Aktiva' },
  { id: 'INAKTIVA', label: 'Inaktiva' },
  { id: 'ALLA', label: 'Alla' },
]

const container = { hidden: {}, show: { transition: { staggerChildren: 0.05 } } }
const item = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: 0.2 } },
}

export function ContractorsPage() {
  const [flik, setFlik] = useState<Flik>('AKTIVA')
  const [kategori, setKategori] = useState<MaintenanceCategoryValue | ''>('')
  const [skapaOppen, setSkapaOppen] = useState(false)
  const [redigerar, setRedigerar] = useState<Contractor | null>(null)

  const { data: hantverkare = [], isLoading, isError } = useContractors()
  const skapa = useCreateContractor()
  const uppdatera = useUpdateContractor()

  const synliga = useMemo(() => {
    return hantverkare.filter((h) => {
      if (flik === 'AKTIVA' && !h.isActive) return false
      if (flik === 'INAKTIVA' && h.isActive) return false
      if (kategori && !h.categories.includes(kategori)) return false
      return true
    })
  }, [hantverkare, flik, kategori])

  const antalAktiva = hantverkare.filter((h) => h.isActive).length
  const utanEpost = hantverkare.filter((h) => h.isActive && !h.email).length

  const spara = (input: CreateContractorInput) => {
    if (redigerar) {
      uppdatera.mutate({ id: redigerar.id, input }, { onSuccess: () => setRedigerar(null) })
    } else {
      skapa.mutate(input, { onSuccess: () => setSkapaOppen(false) })
    }
  }

  return (
    <PageWrapper id="contractors">
      <PageHeader
        title="Hantverkare"
        description="Registret över dem du anlitar — styr vilka som föreslås när ett ärende ska tilldelas"
        action={
          <Button variant="primary" onClick={() => setSkapaOppen(true)}>
            <Plus className="h-4 w-4" strokeWidth={1.8} />
            Lägg till hantverkare
          </Button>
        }
      />

      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard title="Aktiva hantverkare" value={antalAktiva} icon={Hammer} />
        <StatCard title="Totalt i registret" value={hantverkare.length} />
        {/* Utan e-post går ingen arbetsorder att skicka (PR 2) — ett åtgärdbart
            tillstånd, inte en statistikpost. */}
        <StatCard title="Aktiva utan e-post" value={utanEpost} icon={Mail} />
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <div className="flex w-fit gap-1 rounded-xl bg-gray-100 p-1">
          {FLIKAR.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setFlik(f.id)}
              className={cn(
                'h-8 rounded-lg px-3 text-[13px] font-medium transition-all duration-150',
                flik === f.id
                  ? 'bg-white text-gray-900 shadow-sm'
                  : 'text-gray-500 hover:text-gray-700',
              )}
            >
              {f.label}
            </button>
          ))}
        </div>

        <select
          value={kategori}
          onChange={(e) => setKategori(e.target.value as MaintenanceCategoryValue | '')}
          aria-label="Filtrera på yrkeskategori"
          className="h-9 rounded-xl border border-gray-200 bg-white px-3 text-[13.5px] text-gray-900 hover:border-gray-300 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/15"
        >
          <option value="">Alla kategorier</option>
          {MAINTENANCE_CATEGORIES.map((k) => (
            <option key={k} value={k}>
              {MAINTENANCE_CATEGORY_ETIKETT[k]}
            </option>
          ))}
        </select>
      </div>

      <div className="mt-4">
        {isError ? (
          <EmptyState
            icon={Hammer}
            title="Registret kunde inte hämtas"
            description="Försök igen om en stund."
          />
        ) : !isLoading && synliga.length === 0 ? (
          <EmptyState
            icon={Hammer}
            title={hantverkare.length === 0 ? 'Inga hantverkare' : 'Inga träffar'}
            description={
              hantverkare.length === 0
                ? 'Lägg till dem du anlitar, så kan de tilldelas felanmälningar.'
                : 'Ingen hantverkare matchar filtret. Prova en annan kategori.'
            }
            {...(hantverkare.length === 0
              ? {
                  action: (
                    <Button variant="primary" onClick={() => setSkapaOppen(true)}>
                      Lägg till hantverkare
                    </Button>
                  ),
                }
              : {})}
          />
        ) : (
          <motion.div variants={container} initial="hidden" animate="show">
            <DataTable
              data={synliga}
              keyExtractor={(h) => h.id}
              onRowClick={(h) => setRedigerar(h)}
              rowLabel={(h) => `Redigera ${h.name}`}
              columns={[
                {
                  key: 'namn',
                  header: 'Namn',
                  cell: (h) => (
                    <motion.div variants={item} className="font-medium text-gray-900">
                      {h.name}
                      {h.contactPerson ? (
                        <span className="block text-[12px] text-gray-400">{h.contactPerson}</span>
                      ) : null}
                    </motion.div>
                  ),
                },
                {
                  key: 'kategorier',
                  header: 'Kategorier',
                  cell: (h) =>
                    h.categories.length ? (
                      <div className="flex flex-wrap gap-1">
                        {h.categories.map((k) => (
                          <Badge key={k} variant="default">
                            {MAINTENANCE_CATEGORY_ETIKETT[k]}
                          </Badge>
                        ))}
                      </div>
                    ) : (
                      <span className="text-[12px] text-gray-400">Ingen angiven</span>
                    ),
                },
                {
                  key: 'kontakt',
                  header: 'Kontakt',
                  cell: (h) => (
                    <div className="space-y-0.5 text-[12px] text-gray-500">
                      {h.email ? (
                        <span className="flex items-center gap-1.5">
                          <Mail className="h-3 w-3" strokeWidth={1.8} />
                          {h.email}
                        </span>
                      ) : (
                        <span className="text-amber-700">Saknar e-post</span>
                      )}
                      {h.phone ? (
                        <span className="flex items-center gap-1.5">
                          <Phone className="h-3 w-3" strokeWidth={1.8} />
                          {h.phone}
                        </span>
                      ) : null}
                    </div>
                  ),
                },
                {
                  key: 'status',
                  header: 'Status',
                  cell: (h) =>
                    h.isActive ? (
                      <Badge variant="success" dot>
                        Aktiv
                      </Badge>
                    ) : (
                      <Badge variant="default">Inaktiv</Badge>
                    ),
                },
              ]}
            />
          </motion.div>
        )}
      </div>

      <Modal
        open={skapaOppen}
        onClose={() => setSkapaOppen(false)}
        title="Lägg till hantverkare"
        description="Bara namnet krävs. Resten kan fyllas i senare."
      >
        <ContractorForm
          sparar={skapa.isPending}
          onSubmit={spara}
          onCancel={() => setSkapaOppen(false)}
        />
      </Modal>

      <Modal
        open={redigerar !== null}
        onClose={() => setRedigerar(null)}
        title={redigerar?.name ?? 'Hantverkare'}
        description="Ändra uppgifter eller avaktivera."
      >
        {redigerar ? (
          <div className="space-y-4">
            <ContractorForm
              initial={{
                name: redigerar.name,
                ...(redigerar.contactPerson ? { contactPerson: redigerar.contactPerson } : {}),
                ...(redigerar.email ? { email: redigerar.email } : {}),
                ...(redigerar.phone ? { phone: redigerar.phone } : {}),
                ...(redigerar.orgNumber ? { orgNumber: redigerar.orgNumber } : {}),
                ...(redigerar.notes ? { notes: redigerar.notes } : {}),
                categories: redigerar.categories,
              }}
              sparar={uppdatera.isPending}
              onSubmit={spara}
              onCancel={() => setRedigerar(null)}
            />
            <div className="border-line border-t pt-4">
              {/* AVAKTIVERA, inte radera. Raden ska finnas kvar så att gamla
                  ärenden kan visa vem som utförde arbetet — se docblocket på
                  ContractorsService.remove för skillnaden mot GDPR-radering. */}
              <Button
                variant={redigerar.isActive ? 'secondary' : 'primary'}
                disabled={uppdatera.isPending}
                onClick={() =>
                  uppdatera.mutate(
                    { id: redigerar.id, input: { isActive: !redigerar.isActive } },
                    { onSuccess: () => setRedigerar(null) },
                  )
                }
              >
                {redigerar.isActive ? 'Avaktivera' : 'Aktivera igen'}
              </Button>
              <p className="mt-2 text-[12px] text-gray-400">
                En avaktiverad hantverkare kan inte tilldelas nya ärenden, men syns kvar på de
                ärenden hen redan har.
              </p>
            </div>
          </div>
        ) : null}
      </Modal>
    </PageWrapper>
  )
}
