import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { motion, AnimatePresence } from 'framer-motion'
import { Eye, EyeOff, Check, ArrowLeft, ArrowRight } from 'lucide-react'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/cn'
import { registerApi } from './api/auth.api'
import { useAuthStore } from '@/stores/auth.store'
import type { Route } from '@/App'

const schema = z
  .object({
    firstName: z.string().min(1, 'Förnamn krävs'),
    lastName: z.string().min(1, 'Efternamn krävs'),
    email: z.string().email('Ogiltig e-postadress'),
    password: z.string().min(8, 'Minst 8 tecken'),
    confirmPassword: z.string(),
    organizationName: z.string().min(1, 'Företagsnamn krävs'),
    orgNumber: z.string().optional(),
  })
  .superRefine(({ password, confirmPassword }, ctx) => {
    if (password !== confirmPassword) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Lösenorden matchar inte',
        path: ['confirmPassword'],
      })
    }
  })

type FormValues = z.infer<typeof schema>

const STEP1_FIELDS: (keyof FormValues)[] = [
  'firstName',
  'lastName',
  'email',
  'password',
  'confirmPassword',
]

interface Props {
  onNavigate: (route: Route) => void
}

const FEATURES = [
  'Hantera fastigheter och hyresgäster',
  'Automatisera fakturering',
  'Bokföring i realtid',
]

function BrandPanel() {
  return (
    <div
      className="hidden w-[42%] flex-shrink-0 flex-col justify-between p-12 lg:flex"
      style={{ background: '#1a6b3c' }}
    >
      <div>
        <div
          className="text-[32px] font-bold tracking-tight text-white"
          style={{ fontFamily: 'Georgia, serif' }}
        >
          Eken
        </div>
        <p className="mt-3 text-[15px] font-medium" style={{ color: 'rgba(255,255,255,0.75)' }}>
          Fastighetsförvaltning gjord enkelt
        </p>
        <ul className="mt-10 space-y-3">
          {FEATURES.map((f) => (
            <li key={f} className="flex items-start gap-3">
              <span
                className="mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full"
                style={{ background: 'rgba(255,255,255,0.15)' }}
              >
                <Check size={11} className="text-white" strokeWidth={2.5} />
              </span>
              <span className="text-[14px]" style={{ color: 'rgba(255,255,255,0.85)' }}>
                {f}
              </span>
            </li>
          ))}
        </ul>
      </div>
      <p className="text-[12px]" style={{ color: 'rgba(255,255,255,0.4)' }}>
        © 2025 Eken
      </p>
    </div>
  )
}

export function RegisterPage({ onNavigate }: Props) {
  const [step, setStep] = useState<1 | 2>(1)
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)
  const [apiError, setApiError] = useState<string | null>(null)
  const [isPending, setIsPending] = useState(false)
  const setAuth = useAuthStore((s) => s.setAuth)

  const {
    register,
    handleSubmit,
    trigger,
    formState: { errors },
  } = useForm<FormValues>({ resolver: zodResolver(schema), mode: 'onTouched' })

  const goToStep2 = async () => {
    const valid = await trigger(STEP1_FIELDS)
    if (valid) setStep(2)
  }

  const onSubmit = async (data: FormValues) => {
    setApiError(null)
    setIsPending(true)
    try {
      const response = await registerApi({
        email: data.email,
        password: data.password,
        firstName: data.firstName,
        lastName: data.lastName,
        organizationName: data.organizationName,
        ...(data.orgNumber ? { orgNumber: data.orgNumber } : {}),
      })
      setAuth(response)
      onNavigate('dashboard')
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { error?: { message?: string } } } })?.response?.data?.error
          ?.message ?? 'Något gick fel. Försök igen.'
      setApiError(msg)
      setStep(1)
    } finally {
      setIsPending(false)
    }
  }

  return (
    <div className="flex min-h-screen">
      <BrandPanel />

      {/* Right panel */}
      <div className="flex flex-1 items-center justify-center bg-white px-6 py-12">
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2 }}
          className="w-full max-w-[420px]"
        >
          {/* Mobile logo */}
          <div className="mb-8 flex items-center gap-2 lg:hidden">
            <div
              className="flex h-8 w-8 items-center justify-center rounded text-[13px] font-bold text-white"
              style={{ background: '#1a6b3c' }}
            >
              E
            </div>
            <span className="text-[17px] font-semibold text-gray-900">Eken</span>
          </div>

          <h1 className="text-[22px] font-semibold tracking-tight text-gray-900">Skapa konto</h1>
          <p className="mt-1 text-[13.5px] text-gray-500">
            Kom igång med Eken idag — gratis i 14 dagar
          </p>

          {/* Step indicator */}
          <div className="mt-6 flex items-center gap-2">
            {[1, 2].map((s) => (
              <div key={s} className="flex items-center gap-2">
                <div
                  className={cn(
                    'flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-semibold transition-colors',
                    step === s
                      ? 'text-white'
                      : s < step
                        ? 'text-white'
                        : 'bg-gray-100 text-gray-400',
                  )}
                  style={step === s || s < step ? { background: '#1a6b3c' } : undefined}
                >
                  {s < step ? <Check size={10} strokeWidth={3} /> : s}
                </div>
                <span
                  className={cn(
                    'text-[12.5px] font-medium',
                    step === s ? 'text-gray-900' : 'text-gray-400',
                  )}
                >
                  {s === 1 ? 'Ditt konto' : 'Ditt företag'}
                </span>
                {s < 2 && <div className="mx-1 h-px w-6 bg-gray-200" />}
              </div>
            ))}
          </div>

          <form onSubmit={handleSubmit(onSubmit)} className="mt-6">
            <AnimatePresence mode="wait">
              {step === 1 ? (
                <motion.div
                  key="step1"
                  initial={{ opacity: 0, x: -16 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -16 }}
                  transition={{ duration: 0.15 }}
                  className="space-y-4"
                >
                  <div className="grid grid-cols-2 gap-3">
                    <Input
                      label="Förnamn"
                      placeholder="Anna"
                      autoComplete="given-name"
                      error={errors.firstName?.message}
                      {...register('firstName')}
                    />
                    <Input
                      label="Efternamn"
                      placeholder="Andersson"
                      autoComplete="family-name"
                      error={errors.lastName?.message}
                      {...register('lastName')}
                    />
                  </div>

                  <Input
                    label="E-post"
                    type="email"
                    placeholder="anna@foretag.se"
                    autoComplete="email"
                    error={errors.email?.message}
                    {...register('email')}
                  />

                  <div className="space-y-1.5">
                    <label className="block text-[13px] font-medium text-gray-700">Lösenord</label>
                    <div className="relative">
                      <input
                        type={showPassword ? 'text' : 'password'}
                        autoComplete="new-password"
                        placeholder="Minst 8 tecken"
                        className={cn(
                          'flex h-9 w-full rounded-lg border bg-white px-3 pr-10 text-[13.5px] text-gray-900 placeholder:text-gray-400',
                          'transition-colors focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-0',
                          errors.password
                            ? 'border-red-300 focus:ring-red-400'
                            : 'border-[#DDDFE4] hover:border-gray-300',
                        )}
                        {...register('password')}
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword((v) => !v)}
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                        tabIndex={-1}
                      >
                        {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                      </button>
                    </div>
                    {errors.password && (
                      <p className="text-[12px] text-red-500">{errors.password.message}</p>
                    )}
                  </div>

                  <div className="space-y-1.5">
                    <label className="block text-[13px] font-medium text-gray-700">
                      Bekräfta lösenord
                    </label>
                    <div className="relative">
                      <input
                        type={showConfirm ? 'text' : 'password'}
                        autoComplete="new-password"
                        placeholder="Upprepa lösenord"
                        className={cn(
                          'flex h-9 w-full rounded-lg border bg-white px-3 pr-10 text-[13.5px] text-gray-900 placeholder:text-gray-400',
                          'transition-colors focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-0',
                          errors.confirmPassword
                            ? 'border-red-300 focus:ring-red-400'
                            : 'border-[#DDDFE4] hover:border-gray-300',
                        )}
                        {...register('confirmPassword')}
                      />
                      <button
                        type="button"
                        onClick={() => setShowConfirm((v) => !v)}
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                        tabIndex={-1}
                      >
                        {showConfirm ? <EyeOff size={15} /> : <Eye size={15} />}
                      </button>
                    </div>
                    {errors.confirmPassword && (
                      <p className="text-[12px] text-red-500">{errors.confirmPassword.message}</p>
                    )}
                  </div>

                  {apiError && (
                    <div className="rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-[13px] text-red-600">
                      {apiError}
                    </div>
                  )}

                  <Button
                    type="button"
                    variant="primary"
                    size="md"
                    className="mt-1 h-10 w-full text-[14px]"
                    onClick={goToStep2}
                  >
                    Nästa <ArrowRight size={14} />
                  </Button>
                </motion.div>
              ) : (
                <motion.div
                  key="step2"
                  initial={{ opacity: 0, x: 16 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 16 }}
                  transition={{ duration: 0.15 }}
                  className="space-y-4"
                >
                  <Input
                    label="Företagsnamn"
                    placeholder="Andersson Fastigheter AB"
                    autoComplete="organization"
                    error={errors.organizationName?.message}
                    {...register('organizationName')}
                  />

                  <Input
                    label="Organisationsnummer (valfritt)"
                    placeholder="559123-4567"
                    error={errors.orgNumber?.message}
                    {...register('orgNumber')}
                  />

                  {apiError && (
                    <div className="rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-[13px] text-red-600">
                      {apiError}
                    </div>
                  )}

                  <div className="flex gap-2 pt-1">
                    <Button
                      type="button"
                      variant="secondary"
                      size="md"
                      className="h-10"
                      onClick={() => setStep(1)}
                    >
                      <ArrowLeft size={14} /> Tillbaka
                    </Button>
                    <Button
                      type="submit"
                      variant="primary"
                      size="md"
                      loading={isPending}
                      className="h-10 flex-1 text-[14px]"
                    >
                      {isPending ? 'Skapar konto...' : 'Skapa konto'}
                    </Button>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </form>

          <div className="my-6 flex items-center gap-3">
            <div className="h-px flex-1 bg-[#EAEDF0]" />
            <span className="text-[12px] text-gray-400">eller</span>
            <div className="h-px flex-1 bg-[#EAEDF0]" />
          </div>

          <p className="text-center text-[13.5px] text-gray-500">
            Har du redan ett konto?{' '}
            <button
              type="button"
              onClick={() => onNavigate('login')}
              className="font-medium text-[#1a6b3c] hover:underline"
            >
              Logga in →
            </button>
          </p>
        </motion.div>
      </div>
    </div>
  )
}
