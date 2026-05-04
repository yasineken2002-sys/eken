import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { CheckCircle2, AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { AuthCard } from './components/AuthCard'
import { PasswordInput } from './components/PasswordInput'
import { PasswordRequirements } from './components/PasswordRequirements'
import { passwordSchema, readErrorMessage } from './lib/password-schema'
import { resetPasswordApi } from './api/auth.api'
import type { Route } from '@/App'

const schema = z
  .object({
    newPassword: passwordSchema,
    confirmPassword: z.string(),
  })
  .refine((v) => v.newPassword === v.confirmPassword, {
    path: ['confirmPassword'],
    message: 'Lösenorden matchar inte',
  })

type FormValues = z.infer<typeof schema>

interface Props {
  token: string | null
  onNavigate: (r: Route) => void
}

export function ResetPasswordPage({ token, onNavigate }: Props) {
  const [apiError, setApiError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [success, setSuccess] = useState(false)

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors },
  } = useForm<FormValues>({ resolver: zodResolver(schema), mode: 'onTouched' })

  const newPasswordValue = watch('newPassword') ?? ''

  if (!token) {
    return (
      <AuthCard
        title="Ogiltig länk"
        description="Återställningslänken saknas eller är ogiltig."
        footer={
          <button
            type="button"
            onClick={() => onNavigate('forgot-password')}
            className="font-semibold text-blue-600 hover:text-blue-700"
          >
            Begär en ny länk
          </button>
        }
      >
        <div className="flex items-start gap-3 rounded-xl border border-red-100 bg-red-50/60 p-4 text-[13px] text-red-700">
          <AlertCircle size={18} className="mt-0.5 shrink-0 text-red-600" strokeWidth={1.8} />
          <p>Klicka på "Begär en ny länk" nedan för att starta om återställningen.</p>
        </div>
      </AuthCard>
    )
  }

  if (success) {
    return (
      <AuthCard
        title="Lösenordet är uppdaterat"
        description="Du kan nu logga in med ditt nya lösenord."
      >
        <div className="flex items-start gap-3 rounded-xl border border-emerald-100 bg-emerald-50/60 p-4 text-[13px] text-emerald-800">
          <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-emerald-600" strokeWidth={1.8} />
          <p>Av säkerhetsskäl har alla aktiva sessioner avslutats. Logga in igen.</p>
        </div>
        <Button
          type="button"
          variant="primary"
          className="mt-5 w-full"
          onClick={() => onNavigate('login')}
        >
          Gå till inloggning
        </Button>
      </AuthCard>
    )
  }

  const onSubmit = async (data: FormValues) => {
    setApiError(null)
    setPending(true)
    try {
      await resetPasswordApi({ token, newPassword: data.newPassword })
      setSuccess(true)
    } catch (err) {
      setApiError(readErrorMessage(err, 'Kunde inte återställa lösenordet'))
    } finally {
      setPending(false)
    }
  }

  return (
    <AuthCard
      title="Välj ett nytt lösenord"
      description="Välj ett lösenord du inte använder någon annanstans."
    >
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        <PasswordInput
          label="Nytt lösenord"
          error={errors.newPassword?.message}
          {...register('newPassword')}
        />
        <PasswordRequirements password={newPasswordValue} />
        <PasswordInput
          label="Bekräfta lösenord"
          error={errors.confirmPassword?.message}
          {...register('confirmPassword')}
        />
        {apiError && (
          <div className="rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-[13px] text-red-600">
            {apiError}
          </div>
        )}
        <Button type="submit" variant="primary" loading={pending} className="w-full">
          Spara lösenord
        </Button>
      </form>
    </AuthCard>
  )
}
