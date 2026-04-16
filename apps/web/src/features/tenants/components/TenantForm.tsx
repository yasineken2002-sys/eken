import { useEffect } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { ModalFooter } from '@/components/ui/Modal'
import { cn } from '@/lib/cn'
import type { CreateTenantInput } from '@eken/shared'

// Flat schema for the form — address stored as top-level fields, converted to
// nested CreateTenantInput.address in handleFormSubmit before calling onSubmit.
const TenantFormSchema = z
  .object({
    type: z.enum(['INDIVIDUAL', 'COMPANY']),
    firstName: z.string().min(1).optional(),
    lastName: z.string().min(1).optional(),
    companyName: z.string().min(1).optional(),
    email: z.string().email('Ogiltig e-postadress'),
    phone: z.string().optional(),
    personalNumber: z.string().optional(),
    orgNumber: z.string().optional(),
    street: z.string().optional(),
    city: z.string().optional(),
    postalCode: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.type === 'INDIVIDUAL') {
      if (!data.firstName || data.firstName.trim() === '') {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Förnamn krävs', path: ['firstName'] })
      }
      if (!data.lastName || data.lastName.trim() === '') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Efternamn krävs',
          path: ['lastName'],
        })
      }
    }
    if (data.type === 'COMPANY') {
      if (!data.companyName || data.companyName.trim() === '') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Företagsnamn krävs',
          path: ['companyName'],
        })
      }
    }
  })

type TenantFormValues = z.infer<typeof TenantFormSchema>

interface Props {
  defaultValues?: Partial<CreateTenantInput>
  onSubmit: (data: CreateTenantInput) => void
  onCancel: () => void
  isSubmitting: boolean
  submitLabel?: string
}

function toFormValues(d: Partial<CreateTenantInput>): Partial<TenantFormValues> {
  return {
    ...(d.type != null ? { type: d.type } : {}),
    ...(d.firstName != null ? { firstName: d.firstName } : {}),
    ...(d.lastName != null ? { lastName: d.lastName } : {}),
    ...(d.companyName != null ? { companyName: d.companyName } : {}),
    ...(d.email != null ? { email: d.email } : {}),
    ...(d.phone != null ? { phone: d.phone } : {}),
    ...(d.personalNumber != null ? { personalNumber: d.personalNumber } : {}),
    ...(d.orgNumber != null ? { orgNumber: d.orgNumber } : {}),
    ...(d.address?.street != null ? { street: d.address.street } : {}),
    ...(d.address?.city != null ? { city: d.address.city } : {}),
    ...(d.address?.postalCode != null ? { postalCode: d.address.postalCode } : {}),
  }
}

export function TenantForm({
  defaultValues,
  onSubmit,
  onCancel,
  isSubmitting,
  submitLabel = 'Spara',
}: Props) {
  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors },
  } = useForm<TenantFormValues>({
    resolver: zodResolver(TenantFormSchema),
    defaultValues: { type: 'INDIVIDUAL', ...toFormValues(defaultValues ?? {}) },
  })

  const type = watch('type')

  // Clear fields that don't apply to the selected type
  useEffect(() => {
    if (type === 'INDIVIDUAL') {
      setValue('companyName', undefined)
      setValue('orgNumber', undefined)
    } else {
      setValue('firstName', undefined)
      setValue('lastName', undefined)
      setValue('personalNumber', undefined)
    }
  }, [type, setValue])

  const handleFormSubmit = (v: TenantFormValues) => {
    const dto: CreateTenantInput = {
      type: v.type,
      email: v.email,
      ...(v.phone ? { phone: v.phone } : {}),
      ...(v.type === 'INDIVIDUAL'
        ? {
            firstName: v.firstName,
            lastName: v.lastName,
            ...(v.personalNumber ? { personalNumber: v.personalNumber } : {}),
          }
        : {
            companyName: v.companyName,
            ...(v.orgNumber ? { orgNumber: v.orgNumber } : {}),
          }),
      ...(v.street
        ? {
            address: {
              street: v.street,
              city: v.city ?? '',
              postalCode: v.postalCode ?? '',
              country: 'SE',
            },
          }
        : {}),
    }
    onSubmit(dto)
  }

  return (
    <form onSubmit={handleSubmit(handleFormSubmit)} className="space-y-4">
      {/* Type toggle */}
      <div className="space-y-1.5">
        <label className="block text-[13px] font-medium text-gray-700">Typ av hyresgäst</label>
        <div className="flex gap-2">
          {(['INDIVIDUAL', 'COMPANY'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setValue('type', t, { shouldValidate: true })}
              className={cn(
                'h-9 flex-1 rounded-lg border px-4 text-[13px] font-medium transition-all active:scale-[0.97]',
                type === t
                  ? 'border-[#218F52] bg-blue-600/10 text-[#196638]'
                  : 'border-[#E5E7EB] text-gray-500 hover:border-gray-300 hover:text-gray-700',
              )}
            >
              {t === 'INDIVIDUAL' ? 'Privatperson' : 'Företag'}
            </button>
          ))}
        </div>
      </div>

      {/* Conditional name fields */}
      {type === 'INDIVIDUAL' ? (
        <div className="space-y-3">
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
            placeholder="YYYYMMDD-XXXX"
            error={errors.personalNumber?.message}
            {...register('personalNumber')}
          />
        </div>
      ) : (
        <div className="space-y-3">
          <Input
            label="Företagsnamn"
            placeholder="Exempelföretaget AB"
            error={errors.companyName?.message}
            {...register('companyName')}
          />
          <Input
            label="Organisationsnummer (valfritt)"
            placeholder="559123-4567"
            error={errors.orgNumber?.message}
            {...register('orgNumber')}
          />
        </div>
      )}

      {/* Common contact fields */}
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

      {/* Address section */}
      <div>
        <div className="mb-3 flex items-center gap-3">
          <p className="shrink-0 text-[12px] font-semibold uppercase tracking-wide text-gray-400">
            Adress
          </p>
          <div className="h-px flex-1 bg-[#EAEDF0]" />
        </div>
        <div className="space-y-3">
          <Input label="Gatuadress" placeholder="Storgatan 10" {...register('street')} />
          <div className="grid grid-cols-2 gap-3">
            <Input label="Postnummer" placeholder="123 45" {...register('postalCode')} />
            <Input label="Stad" placeholder="Stockholm" {...register('city')} />
          </div>
        </div>
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
