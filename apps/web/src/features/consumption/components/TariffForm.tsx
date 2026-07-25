import { useEffect } from 'react'
import { useForm, Controller } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { Input, Select } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { ModalFooter } from '@/components/ui/Modal'
import { CreateTariffSchema, type CreateTariffInput, type MeterType } from '@eken/shared'
import { useProperties } from '@/features/properties/hooks/useProperties'
import { useUnits } from '@/features/units/hooks/useUnits'

interface TariffFormProps {
  onSubmit: (data: CreateTariffInput) => void
  onCancel: () => void
  isSubmitting?: boolean
}

// Mätartyper + prisenhet (för pris-suffix kr/kWh resp. kr/m³).
const METER_TYPES: { value: MeterType; label: string; unit: string }[] = [
  { value: 'ELECTRICITY', label: 'El', unit: 'kWh' },
  { value: 'WATER_COLD', label: 'Kallvatten', unit: 'm³' },
  { value: 'WATER_HOT', label: 'Varmvatten', unit: 'm³' },
  { value: 'HEATING', label: 'Värme', unit: 'kWh' },
]

const SCOPE_OPTIONS = [
  { value: 'ORGANIZATION', label: 'Hela organisationen' },
  { value: 'PROPERTY', label: 'Per fastighet' },
  { value: 'UNIT', label: 'Per enhet' },
]

const today = new Date().toISOString().split('T')[0]!

export function TariffForm({ onSubmit, onCancel, isSubmitting = false }: TariffFormProps) {
  const { data: properties = [], isLoading: propsLoading } = useProperties()
  const { data: units = [], isLoading: unitsLoading } = useUnits()

  const {
    register,
    control,
    handleSubmit,
    watch,
    setValue,
    formState: { errors },
  } = useForm<CreateTariffInput>({
    resolver: zodResolver(CreateTariffSchema),
    defaultValues: {
      scope: 'ORGANIZATION',
      meterType: 'ELECTRICITY',
      pricePerUnit: 0,
      validFrom: today,
    },
  })

  const scope = watch('scope')
  const meterType = watch('meterType')
  const priceUnit = METER_TYPES.find((t) => t.value === meterType)?.unit ?? 'enhet'

  // Rensa motstående scope-mål när omfattningen byts (Zod-refine kräver rätt mål
  // satt, och ett gammalt id ska inte ligga kvar dolt).
  useEffect(() => {
    if (scope !== 'PROPERTY') setValue('propertyId', undefined)
    if (scope !== 'UNIT') setValue('unitId', undefined)
  }, [scope, setValue])

  const propertyOptions = properties.map((p) => ({ value: p.id, label: p.name }))
  const unitOptions = units.map((u) => ({
    value: u.id,
    label: `${u.property.name} · ${u.unitNumber}`,
  }))

  // Töm valfri fast avgift innan post (skicka inte 0/NaN i onödan).
  function handleClean(data: CreateTariffInput) {
    const clean: CreateTariffInput = {
      scope: data.scope,
      meterType: data.meterType,
      pricePerUnit: data.pricePerUnit,
      validFrom: data.validFrom,
      ...(data.scope === 'PROPERTY' && data.propertyId ? { propertyId: data.propertyId } : {}),
      ...(data.scope === 'UNIT' && data.unitId ? { unitId: data.unitId } : {}),
      ...(typeof data.fixedMonthlyFee === 'number' && data.fixedMonthlyFee > 0
        ? { fixedMonthlyFee: data.fixedMonthlyFee }
        : {}),
      ...(data.calculationBasis?.trim() ? { calculationBasis: data.calculationBasis.trim() } : {}),
    }
    onSubmit(clean)
  }

  return (
    <form onSubmit={handleSubmit(handleClean)} className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        {/* Mätartyp */}
        <Select
          label="Mätartyp"
          options={METER_TYPES.map((t) => ({ value: t.value, label: t.label }))}
          error={errors.meterType?.message}
          {...register('meterType')}
        />

        {/* Omfattning (scope) */}
        <Select
          label="Omfattning"
          options={SCOPE_OPTIONS}
          error={errors.scope?.message}
          {...register('scope')}
        />

        {/* Scope-mål: fastighet */}
        {scope === 'PROPERTY' && (
          <div className="col-span-2">
            <Controller
              control={control}
              name="propertyId"
              render={({ field }) => (
                <Select
                  label="Fastighet"
                  options={
                    propsLoading
                      ? [{ value: '', label: 'Laddar fastigheter…' }]
                      : propertyOptions.length === 0
                        ? [{ value: '', label: 'Inga fastigheter upplagda' }]
                        : [{ value: '', label: 'Välj fastighet…' }, ...propertyOptions]
                  }
                  disabled={propsLoading || propertyOptions.length === 0}
                  error={errors.propertyId?.message}
                  {...field}
                  value={field.value ?? ''}
                />
              )}
            />
          </div>
        )}

        {/* Scope-mål: enhet */}
        {scope === 'UNIT' && (
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
        )}

        {/* Pris per förbrukningsenhet */}
        <Input
          label={`Pris (kr/${priceUnit})`}
          type="number"
          step="0.0001"
          min="0"
          error={errors.pricePerUnit?.message}
          {...register('pricePerUnit', { valueAsNumber: true })}
        />

        {/* Fast månadsavgift (valfri) */}
        <Input
          label="Fast månadsavgift (valfri)"
          type="number"
          step="0.01"
          min="0"
          hint="Abonnemang. Lagras men tillämpas inte på debiteringen ännu."
          error={errors.fixedMonthlyFee?.message}
          {...register('fixedMonthlyFee', { valueAsNumber: true })}
        />

        {/* Giltig från */}
        <div className="col-span-2">
          <Input
            label="Giltig från"
            type="date"
            hint="En tidigare gällande tariff för samma omfattning stängs automatiskt dagen innan."
            error={errors.validFrom?.message}
            {...register('validFrom')}
          />
        </div>

        {/* Beräkningsgrund (JB 12:19) — valfri dokumentationstext */}
        <div className="col-span-2 space-y-1.5">
          <label
            htmlFor="tariff-calculation-basis"
            className="block text-[13px] font-medium text-gray-700"
          >
            Beräkningsgrund (valfri)
          </label>
          <textarea
            id="tariff-calculation-basis"
            rows={3}
            placeholder="T.ex. ”Självkostnad: faktisk förbrukning × leverantörens spotpris, ingen marginal.”"
            className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-[13px] text-gray-800 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
            {...register('calculationBasis')}
          />
          {errors.calculationBasis?.message ? (
            <p className="text-[12px] text-red-500">{errors.calculationBasis.message}</p>
          ) : (
            <p className="text-[12px] text-gray-400">
              Underlag för hur vidaredebiteringen beräknas (JB 12:19) — kan begäras av hyresnämnden.
              Påverkar inte debiteringen.
            </p>
          )}
        </div>
      </div>

      <ModalFooter>
        <Button type="button" onClick={onCancel} disabled={isSubmitting}>
          Avbryt
        </Button>
        <Button type="submit" variant="primary" disabled={isSubmitting}>
          {isSubmitting ? 'Sparar…' : 'Lägg till tariff'}
        </Button>
      </ModalFooter>
    </form>
  )
}
