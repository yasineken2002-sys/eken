import { useEffect, useState } from 'react'
import { useForm, Controller } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { AlertTriangle } from 'lucide-react'
import { Input, Select } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { ModalFooter } from '@/components/ui/Modal'
import { CreateReadingSchema, type CreateReadingInput, type ReadingType } from '@eken/shared'
import { useUnits } from '@/features/units/hooks/useUnits'
import { useLeases } from '@/features/leases/hooks/useLeases'
import { useMeters } from '../hooks/useMeterQueries'
import { useReadings } from '../hooks/useReadingQueries'

interface ReadingFormProps {
  onSubmit: (data: CreateReadingInput) => void
  onCancel: () => void
  isSubmitting?: boolean
}

const METER_TYPE_LABELS: Record<string, string> = {
  ELECTRICITY: 'El',
  WATER_COLD: 'Kallvatten',
  WATER_HOT: 'Varmvatten',
  HEATING: 'Värme',
}

// Mjuk rimlighetsgräns: en period vars förbrukning är mer än så här många gånger
// den föregående perioden flaggas (men blockerar ALDRIG). Ren UX-heuristik —
// den hårda spärren (negativ CUMULATIVE-delta → 400) ligger i backend.
const HIGH_READING_FACTOR = 3

const today = new Date().toISOString().split('T')[0]!
const firstOfMonth = (() => {
  const d = new Date()
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`
})()

export function ReadingForm({ onSubmit, onCancel, isSubmitting = false }: ReadingFormProps) {
  const { data: units = [], isLoading: unitsLoading } = useUnits()
  const { data: meters = [] } = useMeters()
  const { data: leases = [] } = useLeases()

  const [unitId, setUnitId] = useState('')

  const {
    register,
    control,
    handleSubmit,
    watch,
    setValue,
    formState: { errors },
  } = useForm<CreateReadingInput>({
    resolver: zodResolver(CreateReadingSchema),
    defaultValues: {
      meterId: '',
      value: 0,
      readingType: 'CUMULATIVE',
      source: 'MANUAL',
      readingDate: today,
      periodStart: firstOfMonth,
      periodEnd: today,
    },
  })

  const meterId = watch('meterId')
  const readingType = (watch('readingType') ?? 'CUMULATIVE') as ReadingType
  const value = watch('value')
  const periodEnd = watch('periodEnd')

  // Mätare för vald enhet (endast aktiva — backend avvisar avläsning på icke-aktiv).
  const unitMeters = meters.filter((m) => m.unitId === unitId && m.status === 'ACTIVE')
  const selectedMeter = meters.find((m) => m.id === meterId)
  const measure = selectedMeter?.unitOfMeasure ?? ''

  // Aktivt hyresförhållande för enheten (informativt — backend härleder själv).
  const activeLease = leases.find((l) => l.unitId === unitId && l.status === 'ACTIVE')

  // Den valda mätarens historik (för delta-/rimlighetsberäkning). Backend
  // sorterar redan på periodEnd desc.
  const { data: history = [] } = useReadings(meterId ? { meterId } : undefined)

  // Byt enhet → nollställ mätarval.
  useEffect(() => {
    setValue('meterId', '')
  }, [unitId, setValue])

  // ── Mjuk rimlighetsberäkning (speglar backendens delta-logik, blockerar ej) ──
  // Föregående avläsning = senaste med periodEnd före den aktuella periodens slut.
  const prior = history.filter((r) => (periodEnd ? r.periodEnd < periodEnd : true))
  const prev = prior[0]
  const prev2 = prior[1]
  const numericValue = Number(value)

  // Förbrukning för den avläsning som registreras nu.
  const currentConsumption: number | undefined =
    readingType === 'PERIOD_VOLUME'
      ? numericValue
      : prev
        ? numericValue - Number(prev.value)
        : undefined // CUMULATIVE utan föregående = öppningsavläsning (baslinje).

  // Referens = föregående periods förbrukning (samma härledning per typ).
  const referenceConsumption: number | undefined = prev
    ? prev.readingType === 'PERIOD_VOLUME'
      ? Number(prev.value)
      : prev2
        ? Number(prev.value) - Number(prev2.value)
        : undefined
    : undefined

  const isBaseline = readingType === 'CUMULATIVE' && !prev
  const showHighWarning =
    currentConsumption !== undefined &&
    referenceConsumption !== undefined &&
    referenceConsumption > 0 &&
    currentConsumption > HIGH_READING_FACTOR * referenceConsumption

  const unitOptions = units.map((u) => ({
    value: u.id,
    label: `${u.property.name} · ${u.unitNumber}`,
  }))

  function handleClean(data: CreateReadingInput) {
    const clean: CreateReadingInput = {
      meterId: data.meterId,
      value: data.value,
      readingType: data.readingType ?? 'CUMULATIVE',
      source: 'MANUAL',
      readingDate: data.readingDate,
      periodStart: data.periodStart,
      periodEnd: data.periodEnd,
      ...(data.notes?.trim() ? { notes: data.notes.trim() } : {}),
    }
    onSubmit(clean)
  }

  const valueLabel =
    readingType === 'PERIOD_VOLUME' ? 'Periodförbrukning' : 'Mätarställning (ackumulerad)'

  return (
    <form onSubmit={handleSubmit(handleClean)} className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        {/* Enhet (filtrerar mätare) */}
        <div className="col-span-2">
          <Select
            label="Enhet"
            value={unitId}
            onChange={(e) => setUnitId(e.target.value)}
            disabled={unitsLoading || unitOptions.length === 0}
            options={
              unitsLoading
                ? [{ value: '', label: 'Laddar enheter…' }]
                : unitOptions.length === 0
                  ? [{ value: '', label: 'Inga enheter upplagda' }]
                  : [{ value: '', label: 'Välj enhet…' }, ...unitOptions]
            }
          />
        </div>

        {/* Mätare (för vald enhet) */}
        <div className="col-span-2">
          <Controller
            control={control}
            name="meterId"
            render={({ field }) => (
              <Select
                label="Mätare"
                options={
                  !unitId
                    ? [{ value: '', label: 'Välj enhet först' }]
                    : unitMeters.length === 0
                      ? [{ value: '', label: 'Inga aktiva mätare på enheten' }]
                      : [
                          { value: '', label: 'Välj mätare…' },
                          ...unitMeters.map((m) => ({
                            value: m.id,
                            label: `${METER_TYPE_LABELS[m.type] ?? m.type} (${m.unitOfMeasure})`,
                          })),
                        ]
                }
                disabled={!unitId || unitMeters.length === 0}
                error={errors.meterId?.message}
                {...field}
                value={field.value ?? ''}
              />
            )}
          />
        </div>

        {/* Aktiv lease (informativt) */}
        {unitId && (
          <div className="col-span-2 rounded-lg border border-[#EAEDF0] bg-gray-50 px-3 py-2 text-[12px]">
            {activeLease ? (
              <span className="text-gray-600">
                Aktivt hyresavtal hittat — avläsningen kopplas automatiskt till perioden.
              </span>
            ) : (
              <span className="text-gray-500">
                Inget aktivt hyresavtal på enheten — avläsningen registreras men ger ingen
                debitering.
              </span>
            )}
          </div>
        )}

        {/* Avläsningssätt */}
        <Select
          label="Avläsningssätt"
          options={[
            { value: 'CUMULATIVE', label: 'Mätarställning (ackumulerad)' },
            { value: 'PERIOD_VOLUME', label: 'Periodförbrukning' },
          ]}
          error={errors.readingType?.message}
          {...register('readingType')}
        />

        {/* Värde */}
        <Input
          label={measure ? `${valueLabel} (${measure})` : valueLabel}
          type="number"
          step="0.001"
          min="0"
          error={errors.value?.message}
          {...register('value', { valueAsNumber: true })}
        />

        {/* Avläsningsdatum */}
        <Input
          label="Avläsningsdatum"
          type="date"
          error={errors.readingDate?.message}
          {...register('readingDate')}
        />

        {/* Mätperiod */}
        <Input
          label="Period fr.o.m."
          type="date"
          error={errors.periodStart?.message}
          {...register('periodStart')}
        />
        <Input
          label="Period t.o.m."
          type="date"
          hint="Mätperiodens slut styr räkenskapsåret (skilt från fakturadatum)."
          error={errors.periodEnd?.message}
          {...register('periodEnd')}
        />

        {/* Notering */}
        <div className="col-span-2">
          <Input
            label="Notering (valfri)"
            placeholder="Intern notering om avläsningen"
            error={errors.notes?.message}
            {...register('notes')}
          />
        </div>
      </div>

      {/* Neutral förbruknings-förhandsvisning */}
      {meterId && isBaseline && (
        <div className="rounded-lg border border-[#EAEDF0] bg-gray-50 px-3 py-2 text-[12px] text-gray-600">
          Öppningsavläsning (baslinje) — ingen förbrukning debiteras för denna första avläsning.
        </div>
      )}
      {meterId && !isBaseline && currentConsumption !== undefined && (
        <div className="rounded-lg border border-blue-100 bg-blue-50/60 px-3 py-2 text-[12px] text-blue-700">
          Beräknad förbrukning för perioden:{' '}
          <span className="font-semibold">
            {currentConsumption.toLocaleString('sv-SE', { maximumFractionDigits: 3 })} {measure}
          </span>
        </div>
      )}

      {/* Mjuk rimlighetsvarning — blockerar ALDRIG */}
      {showHighWarning && (
        <div
          role="note"
          className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-[13px] text-amber-800"
        >
          <AlertTriangle size={16} className="mt-0.5 flex-shrink-0" />
          <div>
            <p className="font-medium">Ovanligt hög förbrukning</p>
            <p className="mt-0.5 text-amber-700">
              Periodens förbrukning är mer än {HIGH_READING_FACTOR} gånger föregående period (
              {referenceConsumption?.toLocaleString('sv-SE', { maximumFractionDigits: 3 })}{' '}
              {measure}
              ). Kontrollera att värdet och perioden stämmer. Du kan ändå spara avläsningen.
            </p>
          </div>
        </div>
      )}

      <ModalFooter>
        <Button type="button" onClick={onCancel} disabled={isSubmitting}>
          Avbryt
        </Button>
        <Button type="submit" variant="primary" disabled={isSubmitting}>
          {isSubmitting ? 'Sparar…' : 'Registrera avläsning'}
        </Button>
      </ModalFooter>
    </form>
  )
}
