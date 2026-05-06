import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Eye,
  EyeOff,
  Check,
  ArrowLeft,
  ArrowRight,
  Building2,
  BarChart3,
  Shield,
  Zap,
} from 'lucide-react'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/cn'
import { registerApi } from './api/auth.api'
import { passwordSchema } from './lib/password-schema'
import { PasswordRequirements } from './components/PasswordRequirements'
import { useAuthStore } from '@/stores/auth.store'
import { COMPANY_FORM_OPTIONS, validateSwedishOrgNumber } from '@eken/shared'
import type { SwedishCompanyForm } from '@eken/shared'
import type { Route } from '@/App'

const COMPANY_FORM_VALUES = COMPANY_FORM_OPTIONS.map((o) => o.value) as [
  SwedishCompanyForm,
  ...SwedishCompanyForm[],
]

const schema = z
  .object({
    companyForm: z.enum(COMPANY_FORM_VALUES),
    firstName: z.string().min(1, 'Förnamn krävs'),
    lastName: z.string().min(1, 'Efternamn krävs'),
    email: z.string().email('Ogiltig e-postadress'),
    password: passwordSchema,
    confirmPassword: z.string(),
    organizationName: z.string().min(1, 'Namn krävs'),
    orgNumber: z.string().optional(),
    hasFSkatt: z.boolean().default(false),
    fSkattApprovedDate: z.string().optional(),
    vatNumber: z.string().optional(),
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
  .superRefine(({ orgNumber, companyForm }, ctx) => {
    // Validera orgnummer mot vald företagsform live i formuläret —
    // exakt samma regler som backend, så användaren får felet direkt
    // istället för efter submit.
    if (!orgNumber) return
    const result = validateSwedishOrgNumber(orgNumber, companyForm)
    if (!result.valid) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: result.error ?? 'Ogiltigt organisationsnummer',
        path: ['orgNumber'],
      })
    }
  })
  .superRefine(({ hasFSkatt, fSkattApprovedDate }, ctx) => {
    if (hasFSkatt && fSkattApprovedDate) {
      const d = new Date(fSkattApprovedDate)
      if (Number.isNaN(d.getTime()) || d > new Date()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'F-skatt-datum kan inte ligga i framtiden',
          path: ['fSkattApprovedDate'],
        })
      }
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

// För enskild firma är "organisationsnummer" personnummer-formaterat.
// Vi visar därför annan label, placeholder och hjälptext.
function orgNumberFieldProps(form: SwedishCompanyForm): {
  label: string
  placeholder: string
  helpText: string
} {
  if (form === 'ENSKILD_FIRMA') {
    return {
      label: 'Personnummer (valfritt)',
      placeholder: 'ÅÅÅÅMMDD-XXXX',
      helpText:
        'Som enskild näringsidkare är ditt personnummer ditt organisationsnummer hos Skatteverket.',
    }
  }
  return {
    label: 'Organisationsnummer (valfritt)',
    placeholder: '5XXXXX-XXXX',
    helpText: 'Tio siffror med Luhn-kontroll. Lämna tomt om du inte har det till hands.',
  }
}

interface Props {
  onNavigate: (route: Route) => void
}

const FEATURES = [
  { icon: Building2, title: 'Fastighetsöversikt', desc: 'Hantera hela portföljen på ett ställe' },
  {
    icon: BarChart3,
    title: 'Automatisk bokföring',
    desc: 'BAS-kontoplan och journalposter i realtid',
  },
  { icon: Zap, title: 'Smart fakturering', desc: 'Skicka hyresfakturor med ett klick' },
  { icon: Shield, title: 'Banknivå säkerhet', desc: 'JWT-autentisering och krypterad data' },
]

function BrandPanel() {
  return (
    <div
      className="relative hidden w-[46%] flex-shrink-0 flex-col justify-between overflow-hidden lg:flex"
      style={{ background: '#0F1117' }}
    >
      <div
        className="absolute inset-0 opacity-[0.03]"
        style={{
          backgroundImage:
            'linear-gradient(rgba(255,255,255,1) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,1) 1px, transparent 1px)',
          backgroundSize: '40px 40px',
        }}
      />
      <div className="absolute left-1/3 top-1/4 h-96 w-96 rounded-full bg-blue-600/10 blur-3xl" />

      <div className="relative z-10 p-14">
        <div className="mb-16 flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-blue-600">
            <Building2 size={16} className="text-white" strokeWidth={2.2} />
          </div>
          <span className="text-[20px] font-bold tracking-tight text-white">Eveno</span>
        </div>

        <h2 className="text-[34px] font-bold leading-tight tracking-tight text-white">
          Kom igång
          <br />
          <span className="text-white/50">på 2 minuter</span>
        </h2>
        <p className="mt-4 max-w-sm text-[15px] leading-relaxed text-white/50">
          Gratis i 14 dagar. Inget kreditkort krävs. Avsluta när som helst.
        </p>

        <div className="mt-12 space-y-4">
          {FEATURES.map(({ icon: Icon, title, desc }) => (
            <div key={title} className="flex items-start gap-3.5">
              <div className="bg-white/6 border-white/8 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg border">
                <Icon size={14} strokeWidth={1.8} className="text-white/60" />
              </div>
              <div>
                <p className="text-[13.5px] font-semibold text-white/80">{title}</p>
                <p className="mt-0.5 text-[12.5px] text-white/35">{desc}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      <p className="relative z-10 px-14 pb-10 text-[12px] text-white/20">
        © 2025 Eveno. Alla rättigheter förbehållna.
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
    watch,
    setValue,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    mode: 'onTouched',
    defaultValues: { companyForm: 'AB', hasFSkatt: false },
  })

  const companyForm = watch('companyForm')
  const hasFSkatt = watch('hasFSkatt')
  const passwordValue = watch('password') ?? ''
  const orgNumberField = orgNumberFieldProps(companyForm)
  const isPrivate = companyForm === 'ENSKILD_FIRMA'

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
        companyForm: data.companyForm,
        // accountType bevaras för bakåtkompatibilitet — enskild firma
        // mappas till PRIVATE, övriga former till COMPANY.
        accountType: data.companyForm === 'ENSKILD_FIRMA' ? 'PRIVATE' : 'COMPANY',
        hasFSkatt: data.hasFSkatt,
        ...(data.orgNumber ? { orgNumber: data.orgNumber } : {}),
        ...(data.hasFSkatt && data.fSkattApprovedDate
          ? { fSkattApprovedDate: data.fSkattApprovedDate }
          : {}),
        ...(data.vatNumber ? { vatNumber: data.vatNumber } : {}),
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
    <div className="flex min-h-screen bg-white">
      <BrandPanel />

      <div className="flex flex-1 items-center justify-center bg-white px-8 py-12">
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.22 }}
          className="w-full max-w-[400px]"
        >
          {/* Mobile logo */}
          <div className="mb-8 flex items-center gap-2.5 lg:hidden">
            <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-blue-600">
              <Building2 size={14} className="text-white" strokeWidth={2.2} />
            </div>
            <span className="text-[18px] font-bold text-gray-900">Eveno</span>
          </div>

          <h1 className="text-[26px] font-bold leading-tight tracking-tight text-gray-900">
            Skapa konto
          </h1>
          <p className="mt-1.5 text-[14px] text-gray-500">
            Kom igång med Eveno — gratis i 14 dagar
          </p>

          {/* Step indicator */}
          <div className="mt-6 flex items-center gap-3">
            {([1, 2] as const).map((s) => (
              <div key={s} className="flex items-center gap-2.5">
                <div
                  className={cn(
                    'flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-bold transition-all',
                    step === s
                      ? 'bg-blue-600 text-white'
                      : s < step
                        ? 'bg-blue-600 text-white'
                        : 'bg-gray-100 text-gray-400',
                  )}
                >
                  {s < step ? <Check size={10} strokeWidth={3} /> : s}
                </div>
                <span
                  className={cn(
                    'text-[13px] font-medium',
                    step === s ? 'text-gray-900' : s < step ? 'text-gray-500' : 'text-gray-400',
                  )}
                >
                  {s === 1 ? 'Ditt konto' : isPrivate ? 'Dina uppgifter' : 'Ditt företag'}
                </span>
                {s < 2 && <div className="mx-1 h-px w-8 bg-gray-200" />}
              </div>
            ))}
          </div>

          <form onSubmit={handleSubmit(onSubmit)} className="mt-7">
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
                    label="E-postadress"
                    type="email"
                    placeholder="anna@foretag.se"
                    autoComplete="email"
                    error={errors.email?.message}
                    {...register('email')}
                  />

                  {(['password', 'confirmPassword'] as const).map((field) => {
                    const show = field === 'password' ? showPassword : showConfirm
                    const setShow = field === 'password' ? setShowPassword : setShowConfirm
                    return (
                      <div key={field} className="space-y-1.5">
                        <label className="block text-[13px] font-medium text-gray-700">
                          {field === 'password' ? 'Lösenord' : 'Bekräfta lösenord'}
                        </label>
                        <div className="relative">
                          <input
                            type={show ? 'text' : 'password'}
                            autoComplete="new-password"
                            placeholder={
                              field === 'password'
                                ? 'Minst 10 tecken med stor/liten/siffra/specialtecken'
                                : 'Upprepa lösenord'
                            }
                            className={cn(
                              'flex h-10 w-full rounded-xl border bg-white px-3.5 pr-10 text-[13.5px] text-gray-900 placeholder:text-gray-400',
                              'transition-all duration-150 focus:outline-none focus:ring-2 focus:ring-offset-0',
                              errors[field]
                                ? 'border-red-300 focus:border-red-400 focus:ring-red-500/15'
                                : 'border-[#E5E7EB] hover:border-gray-300 focus:border-blue-500 focus:ring-blue-500/15',
                            )}
                            {...register(field)}
                          />
                          <button
                            type="button"
                            onClick={() => setShow((v) => !v)}
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 transition-colors hover:text-gray-600"
                            tabIndex={-1}
                          >
                            {show ? <EyeOff size={15} /> : <Eye size={15} />}
                          </button>
                        </div>
                        {field === 'password' && (
                          <PasswordRequirements password={passwordValue} className="mt-2" />
                        )}
                        {errors[field] && (
                          <p className="text-[12px] text-red-500">{errors[field]?.message}</p>
                        )}
                      </div>
                    )
                  })}

                  {apiError && (
                    <div className="rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-[13px] text-red-600">
                      {apiError}
                    </div>
                  )}

                  <Button
                    type="button"
                    variant="primary"
                    className="mt-1 h-10 w-full rounded-xl text-[14px] font-semibold"
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
                  {/* Företagsform — styr orgnummer-validering, BAS-kontoplan och kontraktstexter */}
                  <div>
                    <label
                      htmlFor="companyForm"
                      className="mb-1.5 block text-[13px] font-medium text-gray-700"
                    >
                      Företagsform
                    </label>
                    <select
                      id="companyForm"
                      value={companyForm}
                      onChange={(e) =>
                        setValue('companyForm', e.target.value as SwedishCompanyForm, {
                          shouldValidate: true,
                        })
                      }
                      className={cn(
                        'flex h-10 w-full rounded-xl border bg-white px-3.5 text-[13.5px] text-gray-900',
                        'border-[#E5E7EB] transition-all hover:border-gray-300 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/15',
                      )}
                    >
                      {COMPANY_FORM_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                    <p className="mt-1 text-[12px] text-gray-500">
                      {COMPANY_FORM_OPTIONS.find((o) => o.value === companyForm)?.description}
                    </p>
                  </div>

                  <Input
                    label={isPrivate ? 'Ditt namn (visas i systemet)' : 'Företagsnamn'}
                    placeholder={isPrivate ? 'Anders Andersson' : 'Andersson Fastigheter AB'}
                    autoComplete={isPrivate ? 'name' : 'organization'}
                    error={errors.organizationName?.message}
                    {...register('organizationName')}
                  />

                  <div className="space-y-1">
                    <Input
                      label={orgNumberField.label}
                      placeholder={orgNumberField.placeholder}
                      error={errors.orgNumber?.message}
                      {...register('orgNumber')}
                    />
                    {!errors.orgNumber && (
                      <p className="text-[12px] text-gray-500">{orgNumberField.helpText}</p>
                    )}
                  </div>

                  {/* F-skatt — lagkrav att visas på faktura enligt 11 kap. 8 § ML */}
                  <div className="rounded-xl border border-[#E5E7EB] bg-gray-50/50 p-3.5">
                    <label className="flex cursor-pointer items-start gap-2.5">
                      <input
                        type="checkbox"
                        className="mt-0.5 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-2 focus:ring-blue-500/30"
                        checked={hasFSkatt}
                        onChange={(e) =>
                          setValue('hasFSkatt', e.target.checked, { shouldValidate: true })
                        }
                      />
                      <div>
                        <p className="text-[13px] font-medium text-gray-800">Vi innehar F-skatt</p>
                        <p className="mt-0.5 text-[12px] text-gray-500">
                          Skrivs ut som "Godkänd för F-skatt" på fakturor (11 kap. 8 § ML).
                        </p>
                      </div>
                    </label>
                    {hasFSkatt && (
                      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <Input
                          label="Godkänd från"
                          type="date"
                          error={errors.fSkattApprovedDate?.message}
                          {...register('fSkattApprovedDate')}
                        />
                        <Input
                          label="Momsregistreringsnummer (valfritt)"
                          placeholder="SE556xxxxxxx01"
                          error={errors.vatNumber?.message}
                          {...register('vatNumber')}
                        />
                      </div>
                    )}
                  </div>

                  {apiError && (
                    <div className="rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-[13px] text-red-600">
                      {apiError}
                    </div>
                  )}

                  <div className="flex gap-2.5 pt-1">
                    <Button
                      type="button"
                      variant="secondary"
                      className="h-10 rounded-xl"
                      onClick={() => setStep(1)}
                    >
                      <ArrowLeft size={14} /> Tillbaka
                    </Button>
                    <Button
                      type="submit"
                      variant="primary"
                      loading={isPending}
                      className="h-10 flex-1 rounded-xl text-[14px] font-semibold"
                    >
                      {isPending ? 'Skapar konto...' : 'Skapa konto'}
                    </Button>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </form>

          <div className="my-7 flex items-center gap-3">
            <div className="h-px flex-1 bg-gray-100" />
            <span className="text-[12px] text-gray-400">eller</span>
            <div className="h-px flex-1 bg-gray-100" />
          </div>

          <p className="text-center text-[14px] text-gray-500">
            Har du redan ett konto?{' '}
            <button
              type="button"
              onClick={() => onNavigate('login')}
              className="font-semibold text-blue-600 transition-colors hover:text-blue-700"
            >
              Logga in →
            </button>
          </p>
        </motion.div>
      </div>
    </div>
  )
}
