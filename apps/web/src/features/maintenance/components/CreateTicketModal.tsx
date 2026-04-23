import { useState, useEffect } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { useCreateTicket } from '../hooks/useMaintenance'
import { useProperties } from '@/features/properties/hooks/useProperties'
import { useUnits } from '@/features/units/hooks/useUnits'
import { useTenants } from '@/features/tenants/hooks/useTenants'
import type { MaintenanceCategory, MaintenancePriority } from '../api/maintenance.api'

const schema = z.object({
  title: z.string().min(3, 'Minst 3 tecken'),
  description: z.string().min(10, 'Minst 10 tecken'),
  propertyId: z.string().min(1, 'Välj en fastighet'),
  unitId: z.string().optional(),
  tenantId: z.string().optional(),
  category: z.string().optional(),
  priority: z.string().optional(),
  scheduledDate: z.string().optional(),
  estimatedCost: z.string().optional(),
})

type FormValues = z.infer<typeof schema>

interface Props {
  open: boolean
  onClose: () => void
}

const CATEGORIES: { value: MaintenanceCategory; label: string }[] = [
  { value: 'PLUMBING', label: 'VVS' },
  { value: 'ELECTRICAL', label: 'El' },
  { value: 'HEATING', label: 'Värme' },
  { value: 'APPLIANCES', label: 'Vitvaror' },
  { value: 'WINDOWS_DOORS', label: 'Fönster/Dörrar' },
  { value: 'LOCKS', label: 'Lås' },
  { value: 'FACADE', label: 'Fasad' },
  { value: 'ROOF', label: 'Tak' },
  { value: 'COMMON_AREAS', label: 'Gemensamma utrymmen' },
  { value: 'CLEANING', label: 'Städning' },
  { value: 'OTHER', label: 'Övrigt' },
]

const PRIORITIES: { value: MaintenancePriority; label: string }[] = [
  { value: 'LOW', label: 'Låg' },
  { value: 'NORMAL', label: 'Normal' },
  { value: 'HIGH', label: 'Hög' },
  { value: 'URGENT', label: 'Akut' },
]

export function CreateTicketModal({ open, onClose }: Props) {
  const createTicket = useCreateTicket()
  const { data: properties } = useProperties()
  const [selectedPropertyId, setSelectedPropertyId] = useState('')
  const { data: units } = useUnits(selectedPropertyId || undefined)
  const { data: tenants } = useTenants()

  const {
    register,
    handleSubmit,
    reset,
    watch,
    formState: { errors },
  } = useForm<FormValues>({ resolver: zodResolver(schema) })

  const propertyId = watch('propertyId')

  useEffect(() => {
    setSelectedPropertyId(propertyId ?? '')
  }, [propertyId])

  const onSubmit = async (values: FormValues) => {
    await createTicket.mutateAsync({
      title: values.title,
      description: values.description,
      propertyId: values.propertyId,
      ...(values.unitId ? { unitId: values.unitId } : {}),
      ...(values.tenantId ? { tenantId: values.tenantId } : {}),
      ...(values.category ? { category: values.category as MaintenanceCategory } : {}),
      ...(values.priority ? { priority: values.priority as MaintenancePriority } : {}),
      ...(values.scheduledDate ? { scheduledDate: values.scheduledDate } : {}),
      ...(values.estimatedCost ? { estimatedCost: parseFloat(values.estimatedCost) } : {}),
    })
    reset()
    onClose()
  }

  return (
    <Modal open={open} onClose={onClose} title="Ny felanmälan" size="lg">
      <form onSubmit={(e) => void handleSubmit(onSubmit)(e)} className="space-y-4 px-6 pb-6">
        <Input
          label="Rubrik *"
          placeholder="Beskriv problemet kortfattat..."
          error={errors.title?.message}
          {...register('title')}
        />

        <div>
          <label className="mb-1.5 block text-[13px] font-medium text-gray-700">
            Beskrivning *
          </label>
          <textarea
            {...register('description')}
            rows={3}
            placeholder="Beskriv felet i detalj..."
            className="w-full rounded-lg border border-[#DDDFE4] px-3 py-2 text-[13.5px] text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          {errors.description && (
            <p className="mt-1 text-[12px] text-red-500">{errors.description.message}</p>
          )}
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className="mb-1.5 block text-[13px] font-medium text-gray-700">
              Fastighet *
            </label>
            <select
              {...register('propertyId')}
              className="h-9 w-full rounded-lg border border-[#DDDFE4] px-3 text-[13.5px] text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">Välj fastighet...</option>
              {properties?.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            {errors.propertyId && (
              <p className="mt-1 text-[12px] text-red-500">{errors.propertyId.message}</p>
            )}
          </div>

          <div>
            <label className="mb-1.5 block text-[13px] font-medium text-gray-700">
              Enhet (valfritt)
            </label>
            <select
              {...register('unitId')}
              disabled={!selectedPropertyId}
              className="h-9 w-full rounded-lg border border-[#DDDFE4] px-3 text-[13.5px] text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <option value="">Välj enhet...</option>
              {units?.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name} ({u.unitNumber})
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className="mb-1.5 block text-[13px] font-medium text-gray-700">
              Hyresgäst (valfritt)
            </label>
            <select
              {...register('tenantId')}
              className="h-9 w-full rounded-lg border border-[#DDDFE4] px-3 text-[13.5px] text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">Välj hyresgäst...</option>
              {tenants?.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.type === 'INDIVIDUAL'
                    ? `${t.firstName ?? ''} ${t.lastName ?? ''}`.trim()
                    : t.companyName}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="mb-1.5 block text-[13px] font-medium text-gray-700">Kategori</label>
            <select
              {...register('category')}
              className="h-9 w-full rounded-lg border border-[#DDDFE4] px-3 text-[13.5px] text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">Välj kategori...</option>
              {CATEGORIES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div>
            <label className="mb-1.5 block text-[13px] font-medium text-gray-700">Prioritet</label>
            <select
              {...register('priority')}
              className="h-9 w-full rounded-lg border border-[#DDDFE4] px-3 text-[13.5px] text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {PRIORITIES.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="mb-1.5 block text-[13px] font-medium text-gray-700">
              Schemalagt datum
            </label>
            <input
              type="date"
              {...register('scheduledDate')}
              className="h-9 w-full rounded-lg border border-[#DDDFE4] px-3 text-[13.5px] text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <Input
            label="Beräknad kostnad (kr)"
            type="number"
            placeholder="0"
            {...register('estimatedCost')}
          />
        </div>

        <div className="flex justify-end gap-2 border-t border-[#EAEDF0] pt-5">
          <Button variant="secondary" type="button" onClick={onClose}>
            Avbryt
          </Button>
          <Button variant="primary" type="submit" loading={createTicket.isPending}>
            Skapa ärende
          </Button>
        </div>
      </form>
    </Modal>
  )
}
