import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Input, Select } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { ModalFooter } from '@/components/ui/Modal'
import type { CreatePropertyInput } from '@eken/shared'

const PropertyFormSchema = z.object({
  name: z.string().min(1, 'Namn krävs'),
  propertyDesignation: z.string().min(1, 'Fastighetsbeteckning krävs'),
  type: z.enum(['RESIDENTIAL', 'COMMERCIAL', 'MIXED', 'INDUSTRIAL', 'LAND']),
  street: z.string().min(1, 'Gatuadress krävs'),
  city: z.string().min(1, 'Stad krävs'),
  postalCode: z.string().min(1, 'Postnummer krävs'),
  country: z.string().default('SE'),
  totalArea: z.coerce.number().positive('Area måste vara positiv'),
  yearBuilt: z.coerce
    .number()
    .min(1800)
    .max(2030)
    .optional()
    .or(z.literal(''))
    .transform((v) => (v === '' ? undefined : v === undefined ? undefined : Number(v))),
})

type PropertyFormValues = z.infer<typeof PropertyFormSchema>

const TYPE_OPTIONS = [
  { value: 'RESIDENTIAL', label: 'Bostadsfastighet' },
  { value: 'COMMERCIAL', label: 'Kommersiell' },
  { value: 'MIXED', label: 'Blandfastighet' },
  { value: 'INDUSTRIAL', label: 'Industri' },
  { value: 'LAND', label: 'Mark' },
]

interface Props {
  defaultValues?: Partial<CreatePropertyInput>
  onSubmit: (data: CreatePropertyInput) => void
  onCancel: () => void
  isSubmitting: boolean
  submitLabel?: string
}

function toFormValues(d: Partial<CreatePropertyInput>): Partial<PropertyFormValues> {
  return {
    ...(d.name != null ? { name: d.name } : {}),
    ...(d.propertyDesignation != null ? { propertyDesignation: d.propertyDesignation } : {}),
    ...(d.type != null ? { type: d.type } : {}),
    ...(d.address?.street != null ? { street: d.address.street } : {}),
    ...(d.address?.city != null ? { city: d.address.city } : {}),
    ...(d.address?.postalCode != null ? { postalCode: d.address.postalCode } : {}),
    ...(d.address?.country != null ? { country: d.address.country } : {}),
    ...(d.totalArea != null ? { totalArea: d.totalArea } : {}),
    ...(d.yearBuilt != null ? { yearBuilt: d.yearBuilt } : {}),
  }
}

export function PropertyForm({
  defaultValues,
  onSubmit,
  onCancel,
  isSubmitting,
  submitLabel = 'Spara',
}: Props) {
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<PropertyFormValues>({
    resolver: zodResolver(PropertyFormSchema),
    defaultValues: {
      type: 'RESIDENTIAL',
      country: 'SE',
      ...toFormValues(defaultValues ?? {}),
    },
  })

  const handleFormSubmit = (v: PropertyFormValues) => {
    const dto: CreatePropertyInput = {
      name: v.name,
      propertyDesignation: v.propertyDesignation,
      type: v.type,
      address: {
        street: v.street,
        city: v.city,
        postalCode: v.postalCode,
        country: v.country,
      },
      totalArea: v.totalArea,
      ...(v.yearBuilt != null ? { yearBuilt: v.yearBuilt as number } : {}),
    }
    onSubmit(dto)
  }

  return (
    <form onSubmit={handleSubmit(handleFormSubmit)} className="space-y-4">
      {/* Name + designation row */}
      <div className="grid grid-cols-2 gap-3">
        <Input
          label="Fastighetsnamn"
          placeholder="Ekbacken 1"
          error={errors.name?.message}
          {...register('name')}
        />
        <Input
          label="Fastighetsbeteckning"
          placeholder="Stadsäga 1:1"
          error={errors.propertyDesignation?.message}
          {...register('propertyDesignation')}
        />
      </div>

      {/* Type select */}
      <Select
        label="Typ"
        options={TYPE_OPTIONS}
        error={errors.type?.message}
        {...register('type')}
      />

      {/* Address section */}
      <div>
        <div className="mb-3 flex items-center gap-3">
          <p className="shrink-0 text-[12px] font-semibold uppercase tracking-wide text-gray-400">
            Adress
          </p>
          <div className="h-px flex-1 bg-[#EAEDF0]" />
        </div>
        <div className="space-y-3">
          <Input
            label="Gatuadress"
            placeholder="Storgatan 10"
            error={errors.street?.message}
            {...register('street')}
          />
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Postnummer"
              placeholder="123 45"
              error={errors.postalCode?.message}
              {...register('postalCode')}
            />
            <Input
              label="Stad"
              placeholder="Stockholm"
              error={errors.city?.message}
              {...register('city')}
            />
          </div>
        </div>
      </div>

      {/* Area + year built row */}
      <div className="grid grid-cols-2 gap-3">
        <Input
          label="Total yta (m²)"
          type="number"
          placeholder="1200"
          error={errors.totalArea?.message}
          {...register('totalArea')}
        />
        <Input
          label="Byggår (valfritt)"
          type="number"
          placeholder="1985"
          error={errors.yearBuilt?.message}
          {...register('yearBuilt')}
        />
      </div>

      <ModalFooter>
        <Button type="button" onClick={onCancel} disabled={isSubmitting}>
          Avbryt
        </Button>
        <Button type="submit" variant="primary" loading={isSubmitting}>
          {submitLabel}
        </Button>
      </ModalFooter>
    </form>
  )
}
