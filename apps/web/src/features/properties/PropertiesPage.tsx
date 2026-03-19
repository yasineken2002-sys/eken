import { useState } from 'react'
import { motion } from 'framer-motion'
import { Plus, Building2, MapPin, Ruler, Calendar, Home } from 'lucide-react'
import { PageWrapper } from '@/components/ui/PageWrapper'
import { PageHeader } from '@/components/ui/PageHeader'
import { Button } from '@/components/ui/Button'
import { Modal, ModalFooter } from '@/components/ui/Modal'
import { Input, Select } from '@/components/ui/Input'
import { PropertyTypeBadge } from '@/components/ui/Badge'
import { mockProperties, mockUnits } from '@/lib/mock-data'
import type { Property } from '@eken/shared'

const container = { hidden: {}, show: { transition: { staggerChildren: 0.07 } } }
const card = {
  hidden: { opacity: 0, y: 14 },
  show: { opacity: 1, y: 0, transition: { duration: 0.25 } },
}

function PropertyCard({ property, onClick }: { property: Property; onClick: () => void }) {
  const units = mockUnits.filter((u) => u.propertyId === property.id)
  const occupied = units.filter((u) => u.status === 'OCCUPIED').length
  const pct = units.length ? Math.round((occupied / units.length) * 100) : 0
  return (
    <motion.div
      variants={card}
      onClick={onClick}
      whileHover={{ y: -2, boxShadow: '0 8px 24px rgba(0,0,0,0.08)' }}
      className="cursor-pointer overflow-hidden rounded-2xl border border-[#EAEDF0] bg-white transition-shadow"
    >
      <div className="relative flex h-28 items-center justify-center bg-gradient-to-br from-slate-100 to-blue-50">
        <Building2 size={40} strokeWidth={1} className="text-blue-200" />
        <div className="absolute right-3 top-3">
          <PropertyTypeBadge type={property.type} />
        </div>
        <div className="absolute bottom-0 left-0 right-0 h-1 bg-gray-100">
          <motion.div
            initial={{ width: 0 }}
            animate={{ width: `${pct}%` }}
            transition={{ delay: 0.3, duration: 0.6 }}
            className={`h-full ${pct > 80 ? 'bg-emerald-400' : pct > 50 ? 'bg-amber-400' : 'bg-red-400'}`}
          />
        </div>
      </div>
      <div className="p-4">
        <h3 className="text-[15px] font-semibold text-gray-900">{property.name}</h3>
        <p className="mt-0.5 text-[12px] text-gray-400">{property.propertyDesignation}</p>
        <div className="mt-3 space-y-1.5">
          <div className="flex items-center gap-2 text-[12.5px] text-gray-500">
            <MapPin size={12} className="text-gray-300" />
            {property.address.street}, {property.address.city}
          </div>
          <div className="flex items-center gap-2 text-[12.5px] text-gray-500">
            <Ruler size={12} className="text-gray-300" />
            {property.totalArea} m²
          </div>
          {property.yearBuilt && (
            <div className="flex items-center gap-2 text-[12.5px] text-gray-500">
              <Calendar size={12} className="text-gray-300" />
              Byggd {property.yearBuilt}
            </div>
          )}
        </div>
        <div className="mt-4 flex items-center justify-between border-t border-[#EAEDF0] pt-4">
          <div className="flex items-center gap-1.5 text-[12.5px] text-gray-500">
            <Home size={12} className="text-gray-300" />
            {occupied}/{units.length} uthyrda
          </div>
          <span
            className={`text-[12px] font-semibold ${pct > 80 ? 'text-emerald-600' : pct > 50 ? 'text-amber-600' : 'text-red-600'}`}
          >
            {pct}%
          </span>
        </div>
      </div>
    </motion.div>
  )
}

function DetailModal({ property, onClose }: { property: Property; onClose: () => void }) {
  const units = mockUnits.filter((u) => u.propertyId === property.id)
  return (
    <Modal
      open
      onClose={onClose}
      title={property.name}
      description={property.propertyDesignation}
      size="lg"
    >
      <div className="space-y-5">
        <div className="grid grid-cols-2 gap-3">
          {[
            {
              label: 'Adress',
              value: `${property.address.street}, ${property.address.postalCode} ${property.address.city}`,
            },
            { label: 'Typ', value: property.type },
            { label: 'Yta', value: `${property.totalArea} m²` },
            { label: 'Byggår', value: property.yearBuilt ?? '–' },
          ].map((i) => (
            <div key={i.label} className="rounded-xl bg-gray-50 p-3">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                {i.label}
              </p>
              <p className="mt-0.5 text-[13.5px] font-medium text-gray-800">{i.value}</p>
            </div>
          ))}
        </div>
        <div>
          <h3 className="mb-3 text-[13px] font-semibold text-gray-700">Objekt ({units.length})</h3>
          <div className="space-y-2">
            {units.map((u) => (
              <div
                key={u.id}
                className="flex items-center gap-3 rounded-xl border border-[#EAEDF0] p-3 transition-colors hover:bg-gray-50"
              >
                <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-[#EAEDF0] bg-gray-50 text-[12px] font-semibold text-gray-600">
                  {u.floor ?? 'BV'}
                </div>
                <div className="flex-1">
                  <p className="text-[13px] font-medium text-gray-800">{u.name}</p>
                  <p className="text-[12px] text-gray-400">
                    {u.area} m²{u.rooms ? ` · ${u.rooms} rum` : ''}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-[13px] font-semibold text-gray-700">
                    {u.monthlyRent.toLocaleString('sv-SE')} kr
                  </p>
                  <span
                    className={`text-[11px] font-medium ${u.status === 'OCCUPIED' ? 'text-emerald-600' : u.status === 'VACANT' ? 'text-amber-600' : 'text-blue-600'}`}
                  >
                    {u.status === 'OCCUPIED'
                      ? 'Uthyrd'
                      : u.status === 'VACANT'
                        ? 'Ledig'
                        : u.status === 'UNDER_RENOVATION'
                          ? 'Renovering'
                          : 'Reserverad'}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  )
}

export function PropertiesPage() {
  const [selected, setSelected] = useState<Property | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  return (
    <PageWrapper id="properties">
      <PageHeader
        title="Fastigheter"
        description={`${mockProperties.length} fastigheter · ${mockUnits.length} objekt totalt`}
        action={
          <Button variant="primary" size="sm" onClick={() => setShowCreate(true)}>
            <Plus size={14} />
            Ny fastighet
          </Button>
        }
      />
      <motion.div
        variants={container}
        initial="hidden"
        animate="show"
        className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3"
      >
        {mockProperties.map((p) => (
          <PropertyCard key={p.id} property={p} onClick={() => setSelected(p)} />
        ))}
        <motion.div
          variants={card}
          onClick={() => setShowCreate(true)}
          whileHover={{ y: -2 }}
          className="group flex cursor-pointer flex-col items-center justify-center rounded-2xl border border-dashed border-[#DDDFE4] bg-white py-16 transition-colors hover:border-blue-300 hover:bg-blue-50/30"
        >
          <div className="flex h-10 w-10 items-center justify-center rounded-full border-2 border-dashed border-gray-200 transition-colors group-hover:border-blue-300">
            <Plus size={18} className="text-gray-300 transition-colors group-hover:text-blue-400" />
          </div>
          <p className="mt-3 text-[13px] font-medium text-gray-400 transition-colors group-hover:text-blue-500">
            Lägg till fastighet
          </p>
        </motion.div>
      </motion.div>
      {selected && <DetailModal property={selected} onClose={() => setSelected(null)} />}
      <Modal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        title="Ny fastighet"
        description="Fyll i uppgifterna för den nya fastigheten"
      >
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <Input label="Fastighetsnamn" placeholder="t.ex. Storgatan 10" />
            </div>
            <div className="col-span-2">
              <Input label="Fastighetsbeteckning" placeholder="t.ex. Stockholm Centrum 1:1" />
            </div>
            <Select
              label="Typ"
              options={[
                { value: 'RESIDENTIAL', label: 'Bostäder' },
                { value: 'COMMERCIAL', label: 'Kommersiell' },
                { value: 'MIXED', label: 'Blandat' },
              ]}
            />
            <Input label="Total yta (m²)" type="number" placeholder="1200" />
            <div className="col-span-2">
              <Input label="Gatuadress" placeholder="Storgatan 10" />
            </div>
            <Input label="Postnummer" placeholder="111 22" />
            <Input label="Ort" placeholder="Stockholm" />
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
