import { useEffect, useState } from 'react'
import { useForm, Controller } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import {
  Building2,
  MapPin,
  Maximize2,
  Layers,
  BedDouble,
  Hash,
  Plus,
  X,
  type LucideIcon,
} from 'lucide-react'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { ModalFooter } from '@/components/ui/Modal'
import { cn } from '@/lib/cn'
import { useProperties } from '@/features/properties/hooks/useProperties'
import { useUnits } from '@/features/units/hooks/useUnits'
import { useTenants } from '@/features/tenants/hooks/useTenants'
import { formatCurrency } from '@eken/shared'
import type { CreateLeaseWithTenantInput } from '../api/leases.api'
import type { Tenant, UnitType } from '@eken/shared'

const UNIT_TYPE_LABELS: Record<UnitType, string> = {
  APARTMENT: 'Lägenhet',
  OFFICE: 'Kontor',
  RETAIL: 'Butik',
  STORAGE: 'Förråd',
  PARKING: 'Parkering',
  OTHER: 'Övrigt',
}

// ─── Schema ───────────────────────────────────────────────────────────────────

const schema = z
  .object({
    propertyId: z.string().min(1, 'Välj en fastighet'),
    unitId: z.string().uuid('Välj en enhet'),
    tenantMode: z.enum(['existing', 'new']),
    existingTenantId: z.string().optional(),
    newTenantType: z.enum(['INDIVIDUAL', 'COMPANY']),
    firstName: z.string().optional(),
    lastName: z.string().optional(),
    companyName: z.string().optional(),
    email: z.string().optional(),
    phone: z.string().optional(),
    personalNumber: z.string().optional(),
    orgNumber: z.string().optional(),
    street: z.string().optional(),
    city: z.string().optional(),
    postalCode: z.string().optional(),
    monthlyRent: z.coerce.number().min(1, 'Ange månadshyra'),
    depositAmount: z.coerce.number().min(0).optional(),
    startDate: z.string().min(1, 'Ange startdatum'),
    endDate: z.string().optional(),
    leaseType: z.enum(['FIXED_TERM', 'INDEFINITE']),
    renewalPeriodMonths: z.coerce.number().int().min(1).optional(),
    noticePeriodMonths: z.coerce.number().int().min(0).default(3),
  })
  .superRefine((data, ctx) => {
    if (data.leaseType === 'FIXED_TERM' && !data.endDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Tidsbegränsade kontrakt kräver slutdatum',
        path: ['endDate'],
      })
    }
    if (data.tenantMode === 'existing') {
      if (!data.existingTenantId || data.existingTenantId.trim() === '') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Välj en hyresgäst',
          path: ['existingTenantId'],
        })
      }
    }
    if (data.tenantMode === 'new') {
      if (!data.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Ange en giltig e-postadress',
          path: ['email'],
        })
      }
      if (data.newTenantType === 'INDIVIDUAL') {
        if (!data.firstName?.trim()) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Förnamn krävs',
            path: ['firstName'],
          })
        }
        if (!data.lastName?.trim()) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Efternamn krävs',
            path: ['lastName'],
          })
        }
      }
      if (data.newTenantType === 'COMPANY') {
        if (!data.companyName?.trim()) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Företagsnamn krävs',
            path: ['companyName'],
          })
        }
      }
    }
  })

type FormValues = z.infer<typeof schema>

// ─── Helpers ──────────────────────────────────────────────────────────────────

function tenantLabel(t: Tenant): string {
  if (t.type === 'INDIVIDUAL') {
    return [t.firstName, t.lastName].filter(Boolean).join(' ') || t.email
  }
  return t.companyName ?? t.email
}

function SectionDivider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3">
      <p className="shrink-0 text-[12px] font-semibold uppercase tracking-wide text-gray-400">
        {label}
      </p>
      <div className="h-px flex-1 bg-[#EAEDF0]" />
    </div>
  )
}

function Fact({ icon: Icon, label, value }: { icon: LucideIcon; label: string; value: string }) {
  return (
    <div className="flex items-start gap-2.5">
      <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-white text-gray-500">
        <Icon size={13} strokeWidth={1.8} />
      </div>
      <div className="min-w-0">
        <p className="text-[11px] font-medium uppercase tracking-wide text-gray-400">{label}</p>
        <p className="mt-0.5 break-words text-[13px] font-medium text-gray-800">{value}</p>
      </div>
    </div>
  )
}

interface UnitInfoCardProps {
  unit: {
    unitNumber: string
    type: UnitType
    area: number
    rooms?: number
    floor?: number
    monthlyRent: number
  }
  property: {
    name: string
    propertyDesignation: string
    address: { street: string; postalCode: string; city: string }
  }
}

// Read-only sammanfattning av enheten + fastigheten. Allt här härleds från
// Unit/Property och får INTE redigeras i kontraktsformuläret — kontraktshyran
// är fortfarande redigerbar längre ner och kan avvika från enhetens
// marknadshyra (det är just det fältet ett kontrakt sätter).
function UnitInfoCard({ unit, property }: UnitInfoCardProps) {
  const fullAddress =
    `${property.address.street}, ${property.address.postalCode} ${property.address.city}`.trim()

  return (
    <div className="space-y-3 rounded-xl border border-[#EAEDF0] bg-gray-50/60 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-[13.5px] font-semibold text-gray-900">{property.name}</p>
          <p className="mt-0.5 text-[12px] text-gray-500">
            Fastighetsbeteckning {property.propertyDesignation}
          </p>
        </div>
        <span className="shrink-0 rounded-full bg-white px-2.5 py-0.5 text-[11px] font-medium text-gray-600 ring-1 ring-[#EAEDF0]">
          {UNIT_TYPE_LABELS[unit.type] ?? unit.type}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-2.5">
        <Fact icon={MapPin} label="Adress" value={fullAddress} />
        <Fact icon={Hash} label="Lägenhetsnummer" value={unit.unitNumber} />
        <Fact icon={Maximize2} label="Yta" value={`${unit.area} m²`} />
        {unit.rooms != null && (
          <Fact icon={BedDouble} label="Antal rum" value={String(unit.rooms)} />
        )}
        {unit.floor != null && <Fact icon={Layers} label="Våning" value={String(unit.floor)} />}
        <Fact
          icon={Building2}
          label="Marknadshyra"
          value={`${formatCurrency(Number(unit.monthlyRent))}/mån`}
        />
      </div>

      <p className="border-t border-[#EAEDF0] pt-2.5 text-[11.5px] text-gray-500">
        Uppgifterna ovan kommer från enheten och fastigheten — ändras de behöver enheten uppdateras
        i fastighetsregistret. Kontraktshyran kan ändå avvika och anges nedan.
      </p>
    </div>
  )
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  defaultValues?: Partial<CreateLeaseWithTenantInput>
  /** Pre-select a property (used in edit mode where the unit is already known) */
  initialPropertyId?: string
  onSubmit: (data: CreateLeaseWithTenantInput) => void
  onCancel: () => void
  isSubmitting: boolean
  submitLabel?: string
}

// ─── Component ────────────────────────────────────────────────────────────────

export function LeaseForm({
  defaultValues,
  initialPropertyId,
  onSubmit,
  onCancel,
  isSubmitting,
  submitLabel = 'Skapa kontrakt',
}: Props) {
  const today = new Date().toISOString().slice(0, 10)

  const {
    register,
    control,
    handleSubmit,
    watch,
    setValue,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      propertyId: initialPropertyId ?? '',
      unitId: defaultValues?.unitId ?? '',
      tenantMode: defaultValues?.existingTenantId ? 'existing' : 'new',
      existingTenantId: defaultValues?.existingTenantId ?? '',
      newTenantType: 'INDIVIDUAL',
      firstName: '',
      lastName: '',
      companyName: '',
      email: '',
      phone: '',
      personalNumber: '',
      orgNumber: '',
      street: '',
      city: '',
      postalCode: '',
      monthlyRent: defaultValues?.monthlyRent ?? 0,
      depositAmount: defaultValues?.depositAmount ?? 0,
      startDate: defaultValues?.startDate ?? today,
      endDate: defaultValues?.endDate ?? '',
      leaseType: defaultValues?.leaseType ?? 'INDEFINITE',
      ...(defaultValues?.renewalPeriodMonths != null
        ? { renewalPeriodMonths: defaultValues.renewalPeriodMonths }
        : { renewalPeriodMonths: 12 }),
      noticePeriodMonths: defaultValues?.noticePeriodMonths ?? 3,
    },
  })

  const leaseType = watch('leaseType')

  const propertyId = watch('propertyId')
  const unitId = watch('unitId')
  const tenantMode = watch('tenantMode')
  const newTenantType = watch('newTenantType')

  const { data: properties = [] } = useProperties()
  const { data: units = [] } = useUnits(propertyId || undefined)
  const { data: tenants = [] } = useTenants()

  // Clear unit when property changes
  useEffect(() => {
    setValue('unitId', '')
  }, [propertyId, setValue])

  // Pre-fill monthlyRent from selected unit
  useEffect(() => {
    if (!unitId) return
    const unit = units.find((u) => u.id === unitId)
    if (unit) {
      setValue('monthlyRent', Number(unit.monthlyRent))
    }
  }, [unitId, units, setValue])

  // Clear irrelevant name fields on type toggle
  useEffect(() => {
    if (newTenantType === 'INDIVIDUAL') setValue('companyName', '')
    else {
      setValue('firstName', '')
      setValue('lastName', '')
    }
  }, [newTenantType, setValue])

  const selectedUnit = units.find((u) => u.id === unitId)
  const selectedProperty = properties.find((p) => p.id === propertyId)

  // Hyresgästens kontaktadress kan i 99% av fallen härledas från lägenheten
  // — gör fälten valfria via en explicit toggle. Skickas inte alls om av.
  const [showAddressOverride, setShowAddressOverride] = useState(false)
  useEffect(() => {
    if (!showAddressOverride) {
      setValue('street', '')
      setValue('postalCode', '')
      setValue('city', '')
    }
  }, [showAddressOverride, setValue])

  const handleFormSubmit = (v: FormValues) => {
    const dto: CreateLeaseWithTenantInput = {
      unitId: v.unitId,
      monthlyRent: v.monthlyRent,
      startDate: v.startDate,
      leaseType: v.leaseType,
      noticePeriodMonths: v.noticePeriodMonths,
      ...(v.depositAmount ? { depositAmount: v.depositAmount } : {}),
      ...(v.endDate ? { endDate: v.endDate } : {}),
      ...(v.leaseType === 'FIXED_TERM' && v.renewalPeriodMonths
        ? { renewalPeriodMonths: v.renewalPeriodMonths }
        : {}),
    }

    if (v.tenantMode === 'existing') {
      if (v.existingTenantId) dto.existingTenantId = v.existingTenantId
    } else {
      dto.newTenant = {
        type: v.newTenantType,
        email: v.email ?? '',
        ...(v.phone ? { phone: v.phone } : {}),
        ...(v.street ? { street: v.street } : {}),
        ...(v.city ? { city: v.city } : {}),
        ...(v.postalCode ? { postalCode: v.postalCode } : {}),
        ...(v.newTenantType === 'INDIVIDUAL'
          ? {
              ...(v.firstName ? { firstName: v.firstName } : {}),
              ...(v.lastName ? { lastName: v.lastName } : {}),
              ...(v.personalNumber ? { personalNumber: v.personalNumber } : {}),
            }
          : {
              ...(v.companyName ? { companyName: v.companyName } : {}),
              ...(v.orgNumber ? { orgNumber: v.orgNumber } : {}),
            }),
      }
    }

    onSubmit(dto)
  }

  return (
    <form onSubmit={handleSubmit(handleFormSubmit)} className="space-y-5">
      {/* ── Section 1: Enhet ─────────────────────────────────────────────────── */}
      <SectionDivider label="Enhet" />

      <div className="space-y-3">
        {/* Property select */}
        <div className="space-y-1.5">
          <label className="block text-[13px] font-medium text-gray-700">Fastighet</label>
          <Controller
            control={control}
            name="propertyId"
            render={({ field }) => (
              <select
                {...field}
                className="h-9 w-full rounded-lg border border-[#E5E7EB] bg-white px-3 text-[13.5px] text-gray-800 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="">Välj fastighet…</option>
                {properties.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            )}
          />
          {errors.propertyId && (
            <p className="text-[12px] text-red-600">{errors.propertyId.message}</p>
          )}
        </div>

        {/* Unit select */}
        <div className="space-y-1.5">
          <label className="block text-[13px] font-medium text-gray-700">Enhet</label>
          <Controller
            control={control}
            name="unitId"
            render={({ field }) => (
              <select
                {...field}
                disabled={!propertyId}
                className={cn(
                  'h-9 w-full rounded-lg border border-[#E5E7EB] bg-white px-3 text-[13.5px] text-gray-800 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500',
                  !propertyId && 'cursor-not-allowed opacity-50',
                )}
              >
                <option value="">{propertyId ? 'Välj enhet…' : 'Välj fastighet först'}</option>
                {units.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                    {u.unitNumber ? ` (${u.unitNumber})` : ''}
                  </option>
                ))}
              </select>
            )}
          />
          {errors.unitId && <p className="text-[12px] text-red-600">{errors.unitId.message}</p>}
        </div>

        {/* Read-only fakta från Unit + Property — kontraktshyran sätts längre
            ner och kan avvika från enhetens marknadshyra. */}
        {selectedUnit && selectedProperty && (
          <UnitInfoCard
            unit={{
              unitNumber: selectedUnit.unitNumber,
              type: selectedUnit.type as UnitType,
              area: Number(selectedUnit.area),
              ...(selectedUnit.rooms != null ? { rooms: Number(selectedUnit.rooms) } : {}),
              ...(selectedUnit.floor != null ? { floor: Number(selectedUnit.floor) } : {}),
              monthlyRent: Number(selectedUnit.monthlyRent),
            }}
            property={{
              name: selectedProperty.name,
              propertyDesignation: selectedProperty.propertyDesignation,
              address: {
                street: selectedProperty.address.street,
                postalCode: selectedProperty.address.postalCode,
                city: selectedProperty.address.city,
              },
            }}
          />
        )}
      </div>

      {/* ── Section 2: Hyresgäst ─────────────────────────────────────────────── */}
      <SectionDivider label="Hyresgäst" />

      {/* Mode toggle */}
      <div className="flex gap-2">
        {(['existing', 'new'] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            onClick={() => setValue('tenantMode', mode, { shouldValidate: false })}
            className={cn(
              'h-9 flex-1 rounded-lg border px-4 text-[13px] font-medium transition-all active:scale-[0.97]',
              tenantMode === mode
                ? 'border-[#218F52] bg-blue-600/10 text-[#196638]'
                : 'border-[#E5E7EB] text-gray-500 hover:border-gray-300 hover:text-gray-700',
            )}
          >
            {mode === 'existing' ? 'Befintlig hyresgäst' : 'Ny hyresgäst'}
          </button>
        ))}
      </div>

      {tenantMode === 'existing' ? (
        /* Existing tenant select */
        <div className="space-y-1.5">
          <label className="block text-[13px] font-medium text-gray-700">Hyresgäst</label>
          <Controller
            control={control}
            name="existingTenantId"
            render={({ field }) => (
              <select
                {...field}
                className="h-9 w-full rounded-lg border border-[#E5E7EB] bg-white px-3 text-[13.5px] text-gray-800 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="">Välj hyresgäst…</option>
                {tenants.map((t) => (
                  <option key={t.id} value={t.id}>
                    {tenantLabel(t)}
                  </option>
                ))}
              </select>
            )}
          />
          {errors.existingTenantId && (
            <p className="text-[12px] text-red-600">{errors.existingTenantId.message}</p>
          )}
        </div>
      ) : (
        /* New tenant fields */
        <div className="space-y-3">
          {/* Type toggle */}
          <div className="space-y-1.5">
            <label className="block text-[13px] font-medium text-gray-700">Typ</label>
            <div className="flex gap-2">
              {(['INDIVIDUAL', 'COMPANY'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setValue('newTenantType', t, { shouldValidate: false })}
                  className={cn(
                    'h-9 flex-1 rounded-lg border px-4 text-[13px] font-medium transition-all active:scale-[0.97]',
                    newTenantType === t
                      ? 'border-blue-500 bg-blue-50 text-blue-700'
                      : 'border-[#E5E7EB] text-gray-500 hover:border-gray-300 hover:text-gray-700',
                  )}
                >
                  {t === 'INDIVIDUAL' ? 'Privatperson' : 'Företag'}
                </button>
              ))}
            </div>
          </div>

          {newTenantType === 'INDIVIDUAL' ? (
            <>
              <div className="grid grid-cols-2 gap-3">
                <Input
                  label="Förnamn"
                  placeholder="Anna"
                  error={errors.firstName?.message}
                  {...register('firstName')}
                />
                <Input
                  label="Efternamn"
                  placeholder="Svensson"
                  error={errors.lastName?.message}
                  {...register('lastName')}
                />
              </div>
              <Input
                label="Personnummer (valfritt)"
                placeholder="ÅÅÅÅMMDD-XXXX"
                {...register('personalNumber')}
              />
            </>
          ) : (
            <>
              <Input
                label="Företagsnamn"
                placeholder="Exempelföretaget AB"
                error={errors.companyName?.message}
                {...register('companyName')}
              />
              <Input
                label="Organisationsnummer (valfritt)"
                placeholder="556xxx-xxxx"
                {...register('orgNumber')}
              />
            </>
          )}

          <div className="grid grid-cols-2 gap-3">
            <Input
              label="E-post"
              type="email"
              placeholder="anna@exempel.se"
              error={errors.email?.message}
              {...register('email')}
            />
            <Input
              label="Telefon (valfritt)"
              type="tel"
              placeholder="070-123 45 67"
              {...register('phone')}
            />
          </div>

          {/* Hyresgästens kontaktadress används bara om den AVVIKER från
              lägenhetens (t.ex. delad lägenhet, andrahand, juridisk c/o-adress).
              I normalfallet ärver hyresgästen lägenhetens adress på backend. */}
          {!showAddressOverride ? (
            <button
              type="button"
              onClick={() => setShowAddressOverride(true)}
              className="flex w-full items-center justify-between gap-3 rounded-xl border border-dashed border-[#DDDFE4] bg-white px-3.5 py-2.5 text-left text-[13px] text-gray-600 transition-colors hover:border-gray-400 hover:text-gray-800"
            >
              <span className="flex items-center gap-2">
                <Plus size={14} strokeWidth={1.8} className="text-gray-400" />
                <span>Använd annan kontaktadress än lägenhetens</span>
              </span>
              <span className="text-[11.5px] text-gray-400">valfritt</span>
            </button>
          ) : (
            <div className="space-y-3 rounded-xl border border-[#EAEDF0] bg-amber-50/30 p-3.5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-[12.5px] font-semibold text-gray-800">Annan kontaktadress</p>
                  <p className="mt-0.5 text-[11.5px] text-gray-500">
                    Lämna tomt om hyresgästen ska använda lägenhetens adress.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setShowAddressOverride(false)}
                  aria-label="Ta bort kontaktadress"
                  className="flex h-7 w-7 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700"
                >
                  <X size={14} strokeWidth={1.8} />
                </button>
              </div>

              <Input label="Gatuadress" placeholder="Storgatan 12" {...register('street')} />
              <div className="grid grid-cols-2 gap-3">
                <Input label="Postnummer" placeholder="123 45" {...register('postalCode')} />
                <Input label="Stad" placeholder="Stockholm" {...register('city')} />
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Section 3: Kontraktsvillkor ──────────────────────────────────────── */}
      <SectionDivider label="Kontraktsvillkor" />

      <div className="space-y-3">
        {/* Lease type toggle */}
        <div className="space-y-1.5">
          <label className="block text-[13px] font-medium text-gray-700">Kontraktstyp</label>
          <div className="flex gap-2">
            {(
              [
                { id: 'INDEFINITE', label: 'Tillsvidare' },
                { id: 'FIXED_TERM', label: 'Tidsbegränsat' },
              ] as const
            ).map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setValue('leaseType', t.id, { shouldValidate: true })}
                className={cn(
                  'h-9 flex-1 rounded-lg border px-4 text-[13px] font-medium transition-all active:scale-[0.97]',
                  leaseType === t.id
                    ? 'border-blue-500 bg-blue-50 text-blue-700'
                    : 'border-[#E5E7EB] text-gray-500 hover:border-gray-300 hover:text-gray-700',
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
          <p className="text-[11px] text-gray-400">
            {leaseType === 'INDEFINITE'
              ? 'Tillsvidare: löper på obestämd tid, sägs upp med uppsägningstid.'
              : 'Tidsbegränsat: har slutdatum och förlängs automatiskt om det inte sägs upp.'}
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Startdatum"
            type="date"
            error={errors.startDate?.message}
            {...register('startDate')}
          />
          {leaseType === 'FIXED_TERM' ? (
            <Input
              label="Slutdatum"
              type="date"
              error={errors.endDate?.message}
              {...register('endDate')}
            />
          ) : (
            <div className="flex items-center text-[12px] text-gray-400">
              Inget slutdatum för tillsvidare-kontrakt
            </div>
          )}
        </div>

        {leaseType === 'FIXED_TERM' && (
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Förlängningsperiod (månader)"
              type="number"
              placeholder="12"
              error={errors.renewalPeriodMonths?.message}
              {...register('renewalPeriodMonths')}
            />
            <Input
              label="Uppsägningstid (månader)"
              type="number"
              placeholder="3"
              error={errors.noticePeriodMonths?.message}
              {...register('noticePeriodMonths')}
            />
          </div>
        )}

        {leaseType === 'INDEFINITE' && (
          <Input
            label="Uppsägningstid (månader)"
            type="number"
            placeholder="3"
            error={errors.noticePeriodMonths?.message}
            {...register('noticePeriodMonths')}
          />
        )}

        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Månadshyra (kr)"
            type="number"
            placeholder="9 200"
            error={errors.monthlyRent?.message}
            {...register('monthlyRent')}
          />
          <Input
            label="Deposition (kr, valfritt)"
            type="number"
            placeholder="27 600"
            {...register('depositAmount')}
          />
        </div>
      </div>

      <ModalFooter>
        <Button type="button" variant="secondary" onClick={onCancel} disabled={isSubmitting}>
          Avbryt
        </Button>
        <Button type="submit" variant="primary" loading={isSubmitting}>
          {submitLabel}
        </Button>
      </ModalFooter>
    </form>
  )
}
