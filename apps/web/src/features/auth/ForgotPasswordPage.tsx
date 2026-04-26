import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { CheckCircle2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { AuthCard } from './components/AuthCard'
import { forgotPasswordApi } from './api/auth.api'
import { readErrorMessage } from './lib/password-schema'
import type { Route } from '@/App'

const schema = z.object({
  email: z.string().email('Ogiltig e-postadress'),
})
type FormValues = z.infer<typeof schema>

interface Props {
  onNavigate: (r: Route) => void
}

export function ForgotPasswordPage({ onNavigate }: Props) {
  const [apiError, setApiError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [submittedEmail, setSubmittedEmail] = useState<string | null>(null)

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<FormValues>({ resolver: zodResolver(schema) })

  const onSubmit = async (data: FormValues) => {
    setApiError(null)
    setPending(true)
    try {
      await forgotPasswordApi(data.email)
      setSubmittedEmail(data.email)
    } catch (err) {
      setApiError(readErrorMessage(err, 'Något gick fel — försök igen senare'))
    } finally {
      setPending(false)
    }
  }

  if (submittedEmail) {
    return (
      <AuthCard
        title="Kolla din inkorg"
        description={`Om ett konto finns för ${submittedEmail} har vi skickat en återställningslänk dit.`}
        footer={
          <button
            type="button"
            onClick={() => onNavigate('login')}
            className="font-semibold text-blue-600 hover:text-blue-700"
          >
            ← Tillbaka till inloggning
          </button>
        }
      >
        <div className="flex items-start gap-3 rounded-xl border border-emerald-100 bg-emerald-50/60 p-4 text-[13px] text-emerald-800">
          <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-emerald-600" strokeWidth={1.8} />
          <div>
            <p className="font-medium">Mailet är på väg.</p>
            <p className="mt-0.5 text-emerald-700/80">
              Länken är giltig i 1 timme och kan bara användas en gång. Hittar du inte mailet? Titta
              i skräpposten.
            </p>
          </div>
        </div>
      </AuthCard>
    )
  }

  return (
    <AuthCard
      title="Glömt lösenord?"
      description="Ange din e-postadress så skickar vi en återställningslänk."
      footer={
        <button
          type="button"
          onClick={() => onNavigate('login')}
          className="font-semibold text-blue-600 hover:text-blue-700"
        >
          ← Tillbaka till inloggning
        </button>
      }
    >
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        <Input
          label="E-postadress"
          type="email"
          autoComplete="email"
          placeholder="anna@foretag.se"
          error={errors.email?.message}
          {...register('email')}
        />
        {apiError && (
          <div className="rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-[13px] text-red-600">
            {apiError}
          </div>
        )}
        <Button type="submit" variant="primary" loading={pending} className="w-full">
          Skicka återställningslänk
        </Button>
      </form>
    </AuthCard>
  )
}
