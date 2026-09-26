import { useForm, Controller } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Input, Select } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { ModalFooter } from '@/components/ui/Modal'
import { useProperties } from '@/features/properties/hooks/useProperties'
import { frivilligSkattskyldighetPaverkarSatsen } from '@eken/shared'
import type { CreateUnitInput } from '../api/units.api'

// ─── Schema ───────────────────────────────────────────────────────────────────

const UnitFormSchema = z.object({
  propertyId: z.string().uuid('Välj en fastighet'),
  name: z.string().min(1, 'Namn krävs'),
  unitNumber: z.string().min(1, 'Enhetsnummer krävs'),
  type: z.enum(['APARTMENT', 'OFFICE', 'RETAIL', 'STORAGE', 'PARKING', 'OTHER']),
  status: z.enum(['VACANT', 'OCCUPIED', 'UNDER_RENOVATION', 'RESERVED']),
  area: z.number({ invalid_type_error: 'Area krävs' }).positive('Area måste vara positiv'),
  floor: z.number().optional(),
  rooms: z.number().positive().optional(),
  monthlyRent: z.number({ invalid_type_error: 'Hyra krävs' }).min(0),
  voluntaryTaxLiability: z.boolean(),
})

type UnitFormValues = z.infer<typeof UnitFormSchema>

// ─── Options ──────────────────────────────────────────────────────────────────

const TYPE_OPTIONS = [
  { value: 'APARTMENT', label: 'Lägenhet' },
  { value: 'OFFICE', label: 'Kontor' },
  { value: 'RETAIL', label: 'Butik' },
  { value: 'STORAGE', label: 'Förråd' },
  { value: 'PARKING', label: 'Parkering' },
  { value: 'OTHER', label: 'Övrigt' },
]

const STATUS_OPTIONS = [
  { value: 'VACANT', label: 'Ledig' },
  { value: 'OCCUPIED', label: 'Uthyrd' },
  { value: 'UNDER_RENOVATION', label: 'Underhåll' },
  { value: 'RESERVED', label: 'Reserverad' },
]

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  defaultValues?: Partial<CreateUnitInput>
  onSubmit: (data: CreateUnitInput) => void
  onCancel: () => void
  isSubmitting: boolean
  submitLabel?: string
  propertyId?: string
}

// ─── Component ────────────────────────────────────────────────────────────────

export function UnitForm({
  defaultValues,
  onSubmit,
  onCancel,
  isSubmitting,
  submitLabel = 'Spara',
  propertyId,
}: Props) {
  const { data: properties = [], isLoading: propertiesLoading } = useProperties()

  const {
    register,
    handleSubmit,
    control,
    watch,
    formState: { errors },
  } = useForm<UnitFormValues>({
    resolver: zodResolver(UnitFormSchema),
    defaultValues: {
      propertyId: propertyId ?? defaultValues?.propertyId ?? '',
      name: defaultValues?.name ?? '',
      unitNumber: defaultValues?.unitNumber ?? '',
      type: defaultValues?.type ?? 'APARTMENT',
      status: defaultValues?.status ?? 'VACANT',
      ...(defaultValues?.area != null ? { area: defaultValues.area } : {}),
      ...(defaultValues?.floor != null ? { floor: defaultValues.floor } : {}),
      ...(defaultValues?.rooms != null ? { rooms: defaultValues.rooms } : {}),
      monthlyRent: defaultValues?.monthlyRent ?? 0,
      voluntaryTaxLiability: defaultValues?.voluntaryTaxLiability ?? false,
    },
  })

  // I2 — reglaget visas bara där frivillig skattskyldighet påverkar momsregelns
  // sats (härlett ur `vatRateForRent`, ingen egen typlista). För övriga typer
  // skickas ett uttryckligt false, så en lokal som byter typ till bostad inte
  // bär med sig en flagga servern avvisar.
  const valdTyp = watch('type')
  const visaFrivillig = frivilligSkattskyldighetPaverkarSatsen(valdTyp)

  const handleFormSubmit = (values: UnitFormValues) => {
    onSubmit({
      propertyId: values.propertyId,
      name: values.name,
      unitNumber: values.unitNumber,
      type: values.type,
      status: values.status,
      area: values.area,
      ...(values.floor != null ? { floor: values.floor } : {}),
      ...(values.rooms != null ? { rooms: values.rooms } : {}),
      monthlyRent: values.monthlyRent,
      voluntaryTaxLiability: frivilligSkattskyldighetPaverkarSatsen(values.type)
        ? values.voluntaryTaxLiability
        : false,
    })
  }

  const propertyOptions = propertiesLoading
    ? [{ value: '', label: 'Laddar fastigheter…' }]
    : [
        { value: '', label: 'Välj fastighet…' },
        ...properties.map((p) => ({ value: p.id, label: p.name })),
      ]

  return (
    <form onSubmit={handleSubmit(handleFormSubmit)} className="space-y-4">
      {/* Fastighet */}
      <Controller
        control={control}
        name="propertyId"
        render={({ field }) => (
          <Select
            label="Fastighet"
            options={propertyOptions}
            disabled={!!propertyId || propertiesLoading}
            error={errors.propertyId?.message}
            {...field}
          />
        )}
      />

      {/* Väljaren är låst när fastigheten är given av sammanhanget. Vid
          redigering är den det alltid: servern avvisar ett ÄNDRAT propertyId,
          eftersom att flytta ett objekt mellan fastigheter inte är en stödd
          operation. Utan den här raden erbjuder gränssnittet ett val som bara
          kan sluta i ett fel. */}
      {propertyId && (
        <p className="-mt-2 text-[12px] text-gray-400">Fastigheten kan inte ändras här.</p>
      )}

      {/* Namn + Enhetsnummer */}
      <div className="grid grid-cols-2 gap-3">
        <Input
          label="Enhetsnamn"
          placeholder="Lägenhet 3A"
          error={errors.name?.message}
          {...register('name')}
        />
        <Input
          label="Enhetsnummer"
          placeholder="301"
          error={errors.unitNumber?.message}
          {...register('unitNumber')}
        />
      </div>

      {/* Typ + Status */}
      <div className="grid grid-cols-2 gap-3">
        <Controller
          control={control}
          name="type"
          render={({ field }) => (
            <Select label="Typ" options={TYPE_OPTIONS} error={errors.type?.message} {...field} />
          )}
        />
        <Controller
          control={control}
          name="status"
          render={({ field }) => (
            <Select
              label="Status"
              options={STATUS_OPTIONS}
              error={errors.status?.message}
              {...field}
            />
          )}
        />
      </div>

      {/* Area + Våning */}
      <div className="grid grid-cols-2 gap-3">
        <Input
          label="Area (m²)"
          type="number"
          step="0.01"
          placeholder="72"
          error={errors.area?.message}
          {...register('area', { valueAsNumber: true })}
        />
        <Input
          label="Våning (valfritt)"
          type="number"
          placeholder="3"
          error={errors.floor?.message}
          {...register('floor', {
            setValueAs: (v: string) => (v === '' ? undefined : Number(v)),
          })}
        />
      </div>

      {/* Rum + Hyra */}
      <div className="grid grid-cols-2 gap-3">
        <Input
          label="Antal rum (valfritt)"
          type="number"
          placeholder="3"
          error={errors.rooms?.message}
          {...register('rooms', {
            setValueAs: (v: string) => (v === '' ? undefined : Number(v)),
          })}
        />
        <Input
          label="Månadshyra (kr)"
          type="number"
          placeholder="9 500"
          error={errors.monthlyRent?.message}
          {...register('monthlyRent', { valueAsNumber: true })}
        />
      </div>

      {visaFrivillig && (
        <label className="border-line flex cursor-pointer items-start gap-2.5 rounded-lg border bg-white px-3.5 py-2.5">
          <input
            type="checkbox"
            {...register('voluntaryTaxLiability')}
            className="mt-0.5 h-3.5 w-3.5 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
          />
          <span className="text-[13px] text-gray-800">
            Objektet är frivilligt skattskyldigt för moms
            <span className="mt-0.5 block text-[11.5px] text-gray-500">
              Markera bara om frivillig skattskyldighet gäller för uthyrningen. Nya fakturor och
              avier för objektet får då moms. Redan skapade dokument ändras inte.
            </span>
          </span>
        </label>
      )}

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
