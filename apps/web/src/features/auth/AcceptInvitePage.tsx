import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { AuthCard } from './components/AuthCard'
import { PasswordInput } from './components/PasswordInput'
import { passwordSchema, readErrorMessage } from './lib/password-schema'
import { setLoginFlash } from './lib/login-flash'
import { acceptInviteApi } from './api/auth.api'
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

export function AcceptInvitePage({ token, onNavigate }: Props) {
  const [apiError, setApiError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<FormValues>({ resolver: zodResolver(schema) })

  if (!token) {
    return (
      <AuthCard title="Ogiltig inbjudningslänk" description="Länken saknar token.">
        <div className="flex items-start gap-3 rounded-xl border border-red-100 bg-red-50/60 p-4 text-[13px] text-red-700">
          <AlertCircle size={18} className="mt-0.5 shrink-0 text-red-600" strokeWidth={1.8} />
          <p>Be personen som bjöd in dig att skicka en ny inbjudan.</p>
        </div>
      </AuthCard>
    )
  }

  const onSubmit = async (data: FormValues) => {
    setApiError(null)
    setPending(true)
    try {
      const { email } = await acceptInviteApi({ token, newPassword: data.newPassword })
      // INGEN auto-login. Skicka användaren till login-sidan med flash-banner
      // och förfylld email; städa även URL:en så ?token=... försvinner.
      setLoginFlash({ kind: 'account-activated', email })
      window.history.replaceState({}, '', '/')
      onNavigate('login')
    } catch (err) {
      setApiError(readErrorMessage(err, 'Kunde inte aktivera kontot'))
    } finally {
      setPending(false)
    }
  }

  return (
    <AuthCard
      title="Sätt ditt lösenord"
      description="Välj ett lösenord för ditt nya Eveno-konto. Du loggar sedan in med din e-post och det här lösenordet."
    >
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        <PasswordInput
          label="Lösenord"
          hint="Min 8 tecken, minst 1 stor bokstav och 1 siffra"
          error={errors.newPassword?.message}
          {...register('newPassword')}
        />
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
