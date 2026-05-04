import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { AuthCard } from './components/AuthCard'
import { PasswordInput } from './components/PasswordInput'
import { PasswordRequirements } from './components/PasswordRequirements'
import { passwordSchema, readErrorMessage } from './lib/password-schema'
import { setLoginFlash } from './lib/login-flash'
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
  const logout = useAuthStore((s) => s.logout)

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors },
  } = useForm<FormValues>({ resolver: zodResolver(schema), mode: 'onTouched' })

  const newPasswordValue = watch('newPassword') ?? ''

  const onSubmit = async (data: FormValues) => {
    setApiError(null)
    setPending(true)
    try {
      const result = await changePasswordApi({
        currentPassword: data.currentPassword,
        newPassword: data.newPassword,
      })
      // Backend revokerar samtliga refresh-tokens (inkl. denna session) — vi
      // städar lokal auth-state och redirectar till login med en flash-banner
      // i stället för att låta nästa /refresh-401 göra jobbet tyst.
      if (result.loggedOut) {
        setLoginFlash({ kind: 'password-changed', ...(user?.email ? { email: user.email } : {}) })
        logout()
        onNavigate('login')
      } else {
        onNavigate('dashboard')
      }
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
          error={errors.newPassword?.message}
          {...register('newPassword')}
        />
        <PasswordRequirements password={newPasswordValue} />
        <PasswordInput
          label="Bekräfta nytt lösenord"
          error={errors.confirmPassword?.message}
          {...register('confirmPassword')}
        />

        <div
          role="note"
          className="flex items-start gap-3 rounded-xl border border-amber-100 bg-amber-50/70 p-3.5 text-[13px] text-amber-900"
        >
          <AlertTriangle size={16} strokeWidth={1.8} className="mt-0.5 shrink-0 text-amber-600" />
          <p>
            När du byter lösenord loggas du ut från <strong>alla enheter</strong> och behöver logga
            in igen med det nya lösenordet.
          </p>
        </div>

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
