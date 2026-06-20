import { useEffect, useRef } from 'react'
import { useForm, Controller } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { Input, Select } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { ModalFooter } from '@/components/ui/Modal'
import { CreateMeterSchema, type CreateMeterInput, type MeterType } from '@eken/shared'
import { useUnits } from '@/features/units/hooks/useUnits'

interface MeterFormProps {
  onSubmit: (data: CreateMeterInput) => void
  onCancel: () => void
  isSubmitting?: boolean
}

// Mätartyper med svenska etiketter + förvald mätenhet. Enheten är fri text
// (källagnostisk) men förifylls efter typ så hyresvärden slipper gissa.
const METER_TYPES: { value: MeterType; label: string; unit: string }[] = [
  { value: 'ELECTRICITY', label: 'El', unit: 'kWh' },
  { value: 'WATER_COLD', label: 'Kallvatten', unit: 'm³' },
  { value: 'WATER_HOT', label: 'Varmvatten', unit: 'm³' },
  { value: 'HEATING', label: 'Värme', unit: 'kWh' },
]

const today = new Date().toISOString().split('T')[0]!

export function MeterForm({ onSubmit, onCancel, isSubmitting = false }: MeterFormProps) {
  const { data: units = [], isLoading: unitsLoading } = useUnits()

  const {
    register,
    control,
    handleSubmit,
    watch,
    setValue,
    formState: { errors },
  } = useForm<CreateMeterInput>({
    resolver: zodResolver(CreateMeterSchema),
    defaultValues: {
      unitId: '',
      type: 'ELECTRICITY',
      unitOfMeasure: 'kWh',
      serialNumber: '',
      provider: '',
      externalId: '',
      installedAt: today,
    },
  })

  // Förifyll mätenheten efter vald typ — men respektera om hyresvärden själv
  // ändrat den (typiskt MWh för värme i större fastigheter).
  const type = watch('type')
  const unitTouched = useRef(false)
  useEffect(() => {
    if (unitTouched.current) return
    const preset = METER_TYPES.find((t) => t.value === type)?.unit
    if (preset) setValue('unitOfMeasure', preset)
  }, [type, setValue])

  const unitOptions = units.map((u) => ({
    value: u.id,
    label: `${u.property.name} · ${u.unitNumber}`,
  }))

  // Töm valfria tomsträngsfält till undefined innan post (exactOptionalProperty
  // + backend @IsDateString avvisar tom installedAt).
  function handleClean(data: CreateMeterInput) {
    const clean: CreateMeterInput = {
      unitId: data.unitId,
      type: data.type,
      unitOfMeasure: data.unitOfMeasure.trim(),
      ...(data.serialNumber?.trim() ? { serialNumber: data.serialNumber.trim() } : {}),
      ...(data.provider?.trim() ? { provider: data.provider.trim() } : {}),
      ...(data.externalId?.trim() ? { externalId: data.externalId.trim() } : {}),
      ...(data.installedAt ? { installedAt: data.installedAt } : {}),
    }
    onSubmit(clean)
  }

  return (
    <form onSubmit={handleSubmit(handleClean)} className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        {/* Enhet — mätaren sitter på väggen i en lägenhet/lokal */}
        <div className="col-span-2">
          <Controller
            control={control}
            name="unitId"
            render={({ field }) => (
              <Select
                label="Enhet"
                options={
                  unitsLoading
                    ? [{ value: '', label: 'Laddar enheter…' }]
                    : unitOptions.length === 0
                      ? [{ value: '', label: 'Inga enheter upplagda' }]
                      : [{ value: '', label: 'Välj enhet…' }, ...unitOptions]
                }
                disabled={unitsLoading || unitOptions.length === 0}
                error={errors.unitId?.message}
                {...field}
                value={field.value ?? ''}
              />
            )}
          />
        </div>

        {/* Mätartyp */}
        <Select
          label="Mätartyp"
          options={METER_TYPES.map((t) => ({ value: t.value, label: t.label }))}
          error={errors.type?.message}
          {...register('type')}
        />

        {/* Mätenhet (fri text, förifylls efter typ) */}
        <Input
          label="Mätenhet"
          placeholder="kWh, m³, MWh…"
          error={errors.unitOfMeasure?.message}
          {...register('unitOfMeasure', {
            onChange: () => {
              unitTouched.current = true
            },
          })}
        />

        {/* Serienummer (valfritt) */}
        <Input
          label="Serienummer (valfritt)"
          placeholder="T.ex. fabrikatets serienr"
          error={errors.serialNumber?.message}
          {...register('serialNumber')}
        />

        {/* Installationsdatum (valfritt) */}
        <Input
          label="Installerad (valfritt)"
          type="date"
          error={errors.installedAt?.message}
          {...register('installedAt')}
        />

        {/* Leverantör + externt id — källagnostik för framtida API (Etapp 2) */}
        <Input
          label="Leverantör (valfritt)"
          placeholder="T.ex. Loggamera"
          error={errors.provider?.message}
          {...register('provider')}
        />
        <Input
          label="Externt id (valfritt)"
          placeholder="Mätar-id hos datakällan"
          error={errors.externalId?.message}
          {...register('externalId')}
        />
      </div>

      <div className="rounded-lg border border-blue-100 bg-blue-50/60 px-3 py-2 text-[12px] text-blue-700">
        Mätaren kopplas till enheten. Avläsningar och debitering hanteras i kommande steg — det här
        lägger bara upp själva mätaren.
      </div>

      <ModalFooter>
        <Button type="button" onClick={onCancel} disabled={isSubmitting}>
          Avbryt
        </Button>
        <Button type="submit" variant="primary" disabled={isSubmitting}>
          {isSubmitting ? 'Sparar…' : 'Lägg till mätare'}
        </Button>
      </ModalFooter>
    </form>
  )
}
