import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useCreatePlan } from '../hooks/useMaintenancePlan'
import { useProperties } from '@/features/properties/hooks/useProperties'
import { CATEGORY_LABELS } from './MaintenancePlanBadges'
import type { MaintenancePlanCategory } from '../api/maintenance-plan.api'

const currentYear = new Date().getFullYear()

const schema = z.object({
  title: z.string().min(3, 'Minst 3 tecken'),
  propertyId: z.string().min(1, 'Välj fastighet'),
  category: z.string().min(1, 'Välj kategori'),
  plannedYear: z.coerce.number().min(2020).max(2060),
  estimatedCost: z.coerce.number().min(0, 'Ange kostnad'),
  priority: z.coerce.number().min(1).max(3).optional(),
  interval: z.coerce.number().optional(),
  lastDoneYear: z.coerce.number().optional(),
  description: z.string().optional(),
})

type FormValues = z.infer<typeof schema>

interface Props {
  open: boolean
  onClose: () => void
}

const CATEGORIES = Object.entries(CATEGORY_LABELS) as [MaintenancePlanCategory, string][]

export function CreateMaintenancePlanModal({ open, onClose }: Props) {
  const create = useCreatePlan()
  const { data: properties } = useProperties()

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { plannedYear: currentYear, priority: 2 },
  })

  const onSubmit = async (values: FormValues) => {
    await create.mutateAsync({
      title: values.title,
      propertyId: values.propertyId,
      category: values.category as MaintenancePlanCategory,
      plannedYear: values.plannedYear,
      estimatedCost: values.estimatedCost,
      ...(values.priority ? { priority: values.priority } : {}),
      ...(values.interval ? { interval: values.interval } : {}),
      ...(values.lastDoneYear ? { lastDoneYear: values.lastDoneYear } : {}),
      ...(values.description ? { description: values.description } : {}),
    })
    reset()
    onClose()
  }

  return (
    <Modal open={open} onClose={onClose} title="Lägg till underhållsåtgärd" size="lg">
      <form onSubmit={(e) => void handleSubmit(onSubmit)(e)} className="space-y-4 px-6 pb-6">
        <Input
          label="Titel *"
          placeholder="t.ex. Byte av tak"
          error={errors.title?.message}
          {...register('title')}
        />

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
            <label className="mb-1.5 block text-[13px] font-medium text-gray-700">Kategori *</label>
            <select
              {...register('category')}
              className="h-9 w-full rounded-lg border border-[#DDDFE4] px-3 text-[13.5px] text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">Välj kategori...</option>
              {CATEGORIES.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            {errors.category && (
              <p className="mt-1 text-[12px] text-red-500">{errors.category.message}</p>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Input
            label="Planerat år *"
            type="number"
            error={errors.plannedYear?.message}
            {...register('plannedYear')}
          />
          <Input
            label="Beräknad kostnad (kr) *"
            type="number"
            placeholder="0"
            error={errors.estimatedCost?.message}
            {...register('estimatedCost')}
          />
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div>
            <label className="mb-1.5 block text-[13px] font-medium text-gray-700">Prioritet</label>
            <select
              {...register('priority')}
              className="h-9 w-full rounded-lg border border-[#DDDFE4] px-3 text-[13.5px] text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value={1}>1 – Låg</option>
              <option value={2}>2 – Normal</option>
              <option value={3}>3 – Hög</option>
            </select>
          </div>

          <Input
            label="Intervall (år)"
            type="number"
            placeholder="t.ex. 20"
            {...register('interval')}
          />
          <Input
            label="Senast utfört (år)"
            type="number"
            placeholder="t.ex. 2010"
            {...register('lastDoneYear')}
          />
        </div>

        <div>
          <label className="mb-1.5 block text-[13px] font-medium text-gray-700">
            Beskrivning (valfritt)
          </label>
          <textarea
            {...register('description')}
            rows={2}
            placeholder="Ytterligare detaljer om åtgärden..."
            className="w-full rounded-lg border border-[#DDDFE4] px-3 py-2 text-[13.5px] text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        <div className="flex justify-end gap-2 border-t border-[#EAEDF0] pt-5">
          <Button variant="secondary" type="button" onClick={onClose}>
            Avbryt
          </Button>
          <Button variant="primary" type="submit" loading={create.isPending}>
            Lägg till åtgärd
          </Button>
        </div>
      </form>
    </Modal>
  )
}
