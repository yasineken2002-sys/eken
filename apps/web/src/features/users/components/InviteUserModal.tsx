import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { useInviteUser } from '../hooks/useUsers'
import { readErrorMessage } from '@/features/auth/lib/password-schema'

const schema = z.object({
  email: z.string().email('Ogiltig e-postadress'),
  firstName: z.string().min(1, 'Förnamn krävs').max(100),
  lastName: z.string().min(1, 'Efternamn krävs').max(100),
  role: z.enum(['ADMIN', 'MANAGER']),
})
type FormValues = z.infer<typeof schema>

interface Props {
  open: boolean
  onClose: () => void
}

export function InviteUserModal({ open, onClose }: Props) {
  const [apiError, setApiError] = useState<string | null>(null)
  const invite = useInviteUser()

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { role: 'MANAGER' },
  })

  const handleClose = () => {
    setApiError(null)
    reset()
    onClose()
  }

  const onSubmit = (data: FormValues) => {
    setApiError(null)
    invite.mutate(data, {
      onSuccess: () => handleClose(),
      onError: (err) => setApiError(readErrorMessage(err, 'Kunde inte skicka inbjudan')),
    })
  }

  return (
    <Modal open={open} onClose={handleClose} title="Bjud in användare" size="md">
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        <p className="text-[13px] text-gray-500">
          En inbjudningslänk skickas till användarens e-postadress. Länken är giltig i 7 dagar.
        </p>

        <div className="grid grid-cols-2 gap-3">
          <Input label="Förnamn" error={errors.firstName?.message} {...register('firstName')} />
          <Input label="Efternamn" error={errors.lastName?.message} {...register('lastName')} />
        </div>

        <Input
          label="E-postadress"
          type="email"
          autoComplete="off"
          placeholder="namn@foretag.se"
          error={errors.email?.message}
          {...register('email')}
        />

        <div className="space-y-1.5">
          <label className="block text-[13px] font-medium text-gray-700">Roll</label>
          <select
            className="h-10 w-full rounded-xl border border-[#E5E7EB] bg-white px-3.5 text-[13.5px] text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/15"
            {...register('role')}
          >
            <option value="MANAGER">Förvaltare — fullständig hantering, ej ekonomi</option>
            <option value="ADMIN">Administratör — kan hantera allt utom ägarrätt</option>
          </select>
          {errors.role && <p className="text-[12px] text-red-500">{errors.role.message}</p>}
        </div>

        {apiError && (
          <div className="rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-[13px] text-red-600">
            {apiError}
          </div>
        )}

        <div className="flex items-center justify-end gap-2 border-t border-[#EAEDF0] pt-5">
          <Button
            type="button"
            variant="secondary"
            onClick={handleClose}
            disabled={invite.isPending}
          >
            Avbryt
          </Button>
          <Button type="submit" variant="primary" loading={invite.isPending}>
            Skicka inbjudan
          </Button>
        </div>
      </form>
    </Modal>
  )
}
