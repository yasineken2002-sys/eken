import { useState, useEffect } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { useCreateInspection } from '../hooks/useInspections'
import { useProperties } from '@/features/properties/hooks/useProperties'
import { useUnits } from '@/features/units/hooks/useUnits'
import { useTenants } from '@/features/tenants/hooks/useTenants'
import type { InspectionType } from '../api/inspections.api'

const schema = z.object({
  type: z.string().min(1, 'Välj typ'),
  scheduledDate: z.string().min(1, 'Välj datum'),
  propertyId: z.string().min(1, 'Välj fastighet'),
  unitId: z.string().min(1, 'Välj enhet'),
  tenantId: z.string().optional(),
})

type FormValues = z.infer<typeof schema>

interface Props {
  open: boolean
  onClose: () => void
}

const TYPES: { value: InspectionType; label: string }[] = [
  { value: 'MOVE_IN', label: 'Inflyttningsbesiktning' },
  { value: 'MOVE_OUT', label: 'Utflyttningsbesiktning' },
  { value: 'PERIODIC', label: 'Periodisk kontroll' },
  { value: 'DAMAGE', label: 'Skadebesiktning' },
]

export function CreateInspectionModal({ open, onClose }: Props) {
  const create = useCreateInspection()
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
    await create.mutateAsync({
      type: values.type as InspectionType,
      scheduledDate: values.scheduledDate,
      propertyId: values.propertyId,
      unitId: values.unitId,
      ...(values.tenantId ? { tenantId: values.tenantId } : {}),
    })
    reset()
    setSelectedPropertyId('')
    onClose()
  }

  return (
    <Modal open={open} onClose={onClose} title="Ny besiktning" size="lg">
      <form onSubmit={(e) => void handleSubmit(onSubmit)(e)} className="space-y-4 px-6 pb-6">
        <div>
          <label className="mb-1.5 block text-[13px] font-medium text-gray-700">Typ *</label>
          <select
            {...register('type')}
            className="h-9 w-full rounded-lg border border-[#DDDFE4] px-3 text-[13.5px] text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">Välj typ...</option>
            {TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
          {errors.type && <p className="mt-1 text-[12px] text-red-500">{errors.type.message}</p>}
        </div>

        <div>
          <label className="mb-1.5 block text-[13px] font-medium text-gray-700">Datum *</label>
          <input
            type="date"
            {...register('scheduledDate')}
            className="h-9 w-full rounded-lg border border-[#DDDFE4] px-3 text-[13.5px] text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          {errors.scheduledDate && (
            <p className="mt-1 text-[12px] text-red-500">{errors.scheduledDate.message}</p>
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
            <label className="mb-1.5 block text-[13px] font-medium text-gray-700">Enhet *</label>
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
            {errors.unitId && (
              <p className="mt-1 text-[12px] text-red-500">{errors.unitId.message}</p>
            )}
          </div>
        </div>

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

        <div className="flex justify-end gap-2 border-t border-[#EAEDF0] pt-5">
          <Button variant="secondary" type="button" onClick={onClose}>
            Avbryt
          </Button>
          <Button variant="primary" type="submit" loading={create.isPending}>
            Skapa besiktning
          </Button>
        </div>
      </form>
    </Modal>
  )
}
