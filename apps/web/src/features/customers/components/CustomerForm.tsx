import { useForm, Controller } from 'react-hook-form'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { ModalFooter } from '@/components/ui/Modal'
import { cn } from '@/lib/cn'
import type { Customer, CreateCustomerInput, CustomerType } from '../api/customers.api'

interface CustomerFormProps {
  defaultValues?: Partial<Customer>
  onSubmit: (data: CreateCustomerInput) => void
  onCancel: () => void
  isSubmitting?: boolean
  submitLabel?: string
}

interface FormState {
  type: CustomerType
  firstName: string
  lastName: string
  personalNumber: string
  companyName: string
  orgNumber: string
  contactPerson: string
  email: string
  phone: string
  street: string
  city: string
  postalCode: string
  reference: string
  notes: string
}

const TYPE_OPTIONS = [
  { value: 'INDIVIDUAL', label: 'Privatperson' },
  { value: 'COMPANY', label: 'Företag' },
]

export function CustomerForm({
  defaultValues,
  onSubmit,
  onCancel,
  isSubmitting = false,
  submitLabel = 'Skapa kund',
}: CustomerFormProps) {
  const {
    register,
    control,
    handleSubmit,
    watch,
    formState: { errors },
  } = useForm<FormState>({
    defaultValues: {
      type: defaultValues?.type ?? 'COMPANY',
      firstName: defaultValues?.firstName ?? '',
      lastName: defaultValues?.lastName ?? '',
      personalNumber: defaultValues?.personalNumber ?? '',
      companyName: defaultValues?.companyName ?? '',
      orgNumber: defaultValues?.orgNumber ?? '',
      contactPerson: defaultValues?.contactPerson ?? '',
      email: defaultValues?.email ?? '',
      phone: defaultValues?.phone ?? '',
      street: defaultValues?.street ?? '',
      city: defaultValues?.city ?? '',
      postalCode: defaultValues?.postalCode ?? '',
      reference: defaultValues?.reference ?? '',
      notes: defaultValues?.notes ?? '',
    },
  })

  const type = watch('type')

  function submit(data: FormState) {
    if (data.type === 'INDIVIDUAL' && (!data.firstName.trim() || !data.lastName.trim())) {
      return
    }
    if (data.type === 'COMPANY' && !data.companyName.trim()) {
      return
    }
    const input: CreateCustomerInput = {
      type: data.type,
      ...(data.firstName ? { firstName: data.firstName } : {}),
      ...(data.lastName ? { lastName: data.lastName } : {}),
      ...(data.personalNumber ? { personalNumber: data.personalNumber } : {}),
      ...(data.companyName ? { companyName: data.companyName } : {}),
      ...(data.orgNumber ? { orgNumber: data.orgNumber } : {}),
      ...(data.contactPerson ? { contactPerson: data.contactPerson } : {}),
      ...(data.email ? { email: data.email } : {}),
      ...(data.phone ? { phone: data.phone } : {}),
      ...(data.street ? { street: data.street } : {}),
      ...(data.city ? { city: data.city } : {}),
      ...(data.postalCode ? { postalCode: data.postalCode } : {}),
      ...(data.reference ? { reference: data.reference } : {}),
      ...(data.notes ? { notes: data.notes } : {}),
    }
    onSubmit(input)
  }

  return (
    <form onSubmit={handleSubmit(submit)} className="space-y-4">
      {/* Typ-väljare som flikar */}
      <Controller
        control={control}
        name="type"
        render={({ field }) => (
          <div className="flex w-fit gap-1 rounded-xl bg-gray-100/70 p-1">
            {TYPE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => field.onChange(opt.value)}
                className={cn(
                  'h-8 rounded-lg px-3 text-[13px] font-medium transition-all',
                  field.value === opt.value
                    ? 'bg-white text-gray-900 shadow-sm'
                    : 'text-gray-500 hover:text-gray-700',
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
        )}
      />

      <div className="grid grid-cols-2 gap-3">
        {type === 'INDIVIDUAL' ? (
          <>
            <Input
              label="Förnamn"
              error={errors.firstName?.message}
              {...register('firstName', { required: 'Förnamn krävs' })}
            />
            <Input
              label="Efternamn"
              error={errors.lastName?.message}
              {...register('lastName', { required: 'Efternamn krävs' })}
            />
            <div className="col-span-2">
              <Input
                label="Personnummer (valfri)"
                placeholder="ÅÅÅÅMMDD-XXXX"
                {...register('personalNumber')}
              />
            </div>
          </>
        ) : (
          <>
            <div className="col-span-2">
              <Input
                label="Företagsnamn"
                error={errors.companyName?.message}
                {...register('companyName', { required: 'Företagsnamn krävs' })}
              />
            </div>
            <Input
              label="Organisationsnummer"
              placeholder="556xxx-xxxx"
              {...register('orgNumber')}
            />
            <Input label="Kontaktperson" {...register('contactPerson')} />
          </>
        )}

        <Input label="E-post" type="email" {...register('email')} />
        <Input label="Telefon" {...register('phone')} />

        <div className="col-span-2">
          <Input label="Gatuadress" {...register('street')} />
        </div>
        <Input label="Postnummer" {...register('postalCode')} />
        <Input label="Ort" {...register('city')} />

        <div className="col-span-2">
          <Input
            label="Er referens (valfri)"
            placeholder="t.ex. inköpsorder eller kostnadsställe"
            {...register('reference')}
          />
        </div>

        <div className="col-span-2">
          <Input label="Anteckningar (valfri)" placeholder="Internt" {...register('notes')} />
        </div>
      </div>

      <ModalFooter>
        <Button type="button" onClick={onCancel} disabled={isSubmitting}>
          Avbryt
        </Button>
        <Button type="submit" variant="primary" disabled={isSubmitting}>
          {isSubmitting ? 'Sparar…' : submitLabel}
        </Button>
      </ModalFooter>
    </form>
  )
}
