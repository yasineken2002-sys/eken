import { useEffect } from 'react'
import { useForm, Controller } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { ModalFooter } from '@/components/ui/Modal'
import { cn } from '@/lib/cn'
import { useProperties } from '@/features/properties/hooks/useProperties'
import { useUnits } from '@/features/units/hooks/useUnits'
import { useTenants } from '@/features/tenants/hooks/useTenants'
import { formatCurrency } from '@eken/shared'
import type { CreateLeaseWithTenantInput } from '../api/leases.api'
import type { Tenant } from '@eken/shared'

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
        ...(v.newTenantType === 'INDIVIDUAL'
          ? {
              ...(v.firstName ? { firstName: v.firstName } : {}),
              ...(v.lastName ? { lastName: v.lastName } : {}),
            }
          : {
              ...(v.companyName ? { companyName: v.companyName } : {}),
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

        {/* Unit rent suggestion */}
        {selectedUnit && (
          <div className="rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-[12.5px] text-blue-700">
            Aktuell hyra:{' '}
            <span className="font-semibold">
              {formatCurrency(Number(selectedUnit.monthlyRent))}
            </span>
            /mån — förfylld nedan
          </div>
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
          ) : (
            <Input
              label="Företagsnamn"
              placeholder="Exempelföretaget AB"
              error={errors.companyName?.message}
              {...register('companyName')}
            />
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
