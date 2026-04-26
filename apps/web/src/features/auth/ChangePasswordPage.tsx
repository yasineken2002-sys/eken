import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Button } from '@/components/ui/Button'
import { AuthCard } from './components/AuthCard'
import { PasswordInput } from './components/PasswordInput'
import { passwordSchema, readErrorMessage } from './lib/password-schema'
import { changePasswordApi } from './api/auth.api'
import { useAuthStore } from '@/stores/auth.store'
import type { Route } from '@/App'

const schema = z
  .object({
    currentPassword: z.string().min(1, 'Nuvarande lösenord krävs'),
    newPassword: passwordSchema,
    confirmPassword: z.string(),
  })
  .refine((v) => v.newPassword === v.confirmPassword, {
    path: ['confirmPassword'],
    message: 'Lösenorden matchar inte',
  })
  .refine((v) => v.newPassword !== v.currentPassword, {
    path: ['newPassword'],
    message: 'Det nya lösenordet måste skilja sig från det gamla',
  })

type FormValues = z.infer<typeof schema>

interface Props {
  // Påtvingad? (mustChangePassword=true → ingen "Avbryt"-knapp).
  forced?: boolean
  onNavigate: (r: Route) => void
}

export function ChangePasswordPage({ forced = false, onNavigate }: Props) {
  const [apiError, setApiError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const user = useAuthStore((s) => s.user)
  const setAuth = useAuthStore((s) => s.setAuth)

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<FormValues>({ resolver: zodResolver(schema) })

  const onSubmit = async (data: FormValues) => {
    setApiError(null)
    setPending(true)
    try {
      await changePasswordApi({
        currentPassword: data.currentPassword,
        newPassword: data.newPassword,
      })
      // Backend invaliderar refresh-tokens; uppdatera lokalt user-flag så att
      // appen släpper igenom användaren framöver. Tokens är fortfarande giltiga
      // i denna session (axios bryr sig först om 401).
      if (user) {
        const current = useAuthStore.getState()
        if (current.accessToken && current.refreshToken && current.organization) {
          setAuth({
            accessToken: current.accessToken,
            refreshToken: current.refreshToken,
            organization: current.organization,
            user: { ...user, mustChangePassword: false },
          })
        }
      }
      onNavigate('dashboard')
    } catch (err) {
      setApiError(readErrorMessage(err, 'Kunde inte byta lösenord'))
    } finally {
      setPending(false)
    }
  }

  return (
    <AuthCard
      title={forced ? 'Sätt ett nytt lösenord' : 'Byt lösenord'}
      description={
        forced
          ? 'Innan du fortsätter måste du välja ett nytt lösenord för ditt konto.'
          : 'Välj ett nytt lösenord för ditt konto.'
      }
    >
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        <PasswordInput
          label="Nuvarande lösenord"
          autoComplete="current-password"
          error={errors.currentPassword?.message}
          {...register('currentPassword')}
        />
        <PasswordInput
          label="Nytt lösenord"
          hint="Min 8 tecken, minst 1 stor bokstav och 1 siffra"
          error={errors.newPassword?.message}
          {...register('newPassword')}
        />
        <PasswordInput
          label="Bekräfta nytt lösenord"
          error={errors.confirmPassword?.message}
          {...register('confirmPassword')}
        />

        {apiError && (
          <div className="rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-[13px] text-red-600">
            {apiError}
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-2">
          {!forced && (
            <Button type="button" variant="secondary" onClick={() => onNavigate('settings')}>
              Avbryt
            </Button>
          )}
          <Button type="submit" variant="primary" loading={pending}>
            Spara nytt lösenord
          </Button>
        </div>
      </form>
    </AuthCard>
  )
}
