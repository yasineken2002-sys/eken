import { useState, useEffect } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { motion } from 'framer-motion'
import { Eye, EyeOff, Building2, BarChart3, Shield, Zap, CheckCircle2 } from 'lucide-react'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/cn'
import { loginApi } from './api/auth.api'
import { consumeLoginFlash } from './lib/login-flash'
import { useAuthStore } from '@/stores/auth.store'
import type { Route } from '@/App'

const schema = z.object({
  email: z.string().email('Ogiltig e-postadress'),
  password: z.string().min(1, 'Lösenord krävs'),
})

type FormValues = z.infer<typeof schema>

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
      {/* Subtle grid pattern */}
      <div
        className="absolute inset-0 opacity-[0.03]"
        style={{
          backgroundImage:
            'linear-gradient(rgba(255,255,255,1) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,1) 1px, transparent 1px)',
          backgroundSize: '40px 40px',
        }}
      />
      {/* Blue glow */}
      <div className="absolute left-1/3 top-1/4 h-96 w-96 rounded-full bg-blue-600/10 blur-3xl" />

      <div className="relative z-10 p-14">
        <div className="mb-16 flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-blue-600">
            <Building2 size={16} className="text-white" strokeWidth={2.2} />
          </div>
          <span className="text-[20px] font-bold tracking-tight text-white">Eveno</span>
        </div>

        <h2 className="text-[34px] font-bold leading-tight tracking-tight text-white">
          Fastighetsförvaltning
          <br />
          <span className="text-white/50">på enterprise-nivå</span>
        </h2>
        <p className="mt-4 max-w-sm text-[15px] leading-relaxed text-white/50">
          Allt du behöver för att driva din fastighetsportfölj effektivt — från hyresavtal till
          bokföring.
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

export function LoginPage({ onNavigate }: Props) {
  const [showPassword, setShowPassword] = useState(false)
  const [apiError, setApiError] = useState<string | null>(null)
  const [isPending, setIsPending] = useState(false)
  // Konsumera flash-signalen synkront vid first render — annars riskerar vi
  // att React StrictMode kallar effekten två gånger och nollar bannern.
  const [flash] = useState(() => consumeLoginFlash())
  const setAuth = useAuthStore((s) => s.setAuth)

  const {
    register,
    handleSubmit,
    setValue,
    formState: { errors },
  } = useForm<FormValues>({ resolver: zodResolver(schema) })

  useEffect(() => {
    if (flash?.kind === 'account-activated') {
      setValue('email', flash.email)
    }
  }, [flash, setValue])

  const onSubmit = async (data: FormValues) => {
    setApiError(null)
    setIsPending(true)
    try {
      const response = await loginApi(data)
      setAuth(response)
      onNavigate(response.user.mustChangePassword ? 'change-password' : 'dashboard')
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { error?: { message?: string } } } })?.response?.data?.error
          ?.message ?? 'Felaktig e-post eller lösenord'
      setApiError(msg)
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
          className="w-full max-w-[380px]"
        >
          {/* Mobile logo */}
          <div className="mb-8 flex items-center gap-2.5 lg:hidden">
            <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-blue-600">
              <Building2 size={14} className="text-white" strokeWidth={2.2} />
            </div>
            <span className="text-[18px] font-bold text-gray-900">Eveno</span>
          </div>

          <h1 className="text-[26px] font-bold leading-tight tracking-tight text-gray-900">
            Välkommen tillbaka
          </h1>
          <p className="mt-1.5 text-[14px] text-gray-500">Logga in på ditt Eveno-konto</p>

          {flash?.kind === 'account-activated' && (
            <div className="mt-6 flex items-start gap-3 rounded-xl border border-emerald-100 bg-emerald-50/60 p-3.5 text-[13px] text-emerald-800">
              <CheckCircle2
                size={16}
                className="mt-0.5 shrink-0 text-emerald-600"
                strokeWidth={1.8}
              />
              <div>
                <p className="font-medium">Konto aktiverat</p>
                <p className="mt-0.5 text-emerald-700/80">
                  Logga in med <strong>{flash.email}</strong> och lösenordet du nyss valde.
                </p>
              </div>
            </div>
          )}

          <form onSubmit={handleSubmit(onSubmit)} className="mt-8 space-y-4">
            <Input
              label="E-postadress"
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
                  autoComplete="current-password"
                  placeholder="••••••••"
                  className={cn(
                    'flex h-10 w-full rounded-xl border bg-white px-3.5 pr-10 text-[13.5px] text-gray-900 placeholder:text-gray-400',
                    'transition-all duration-150 focus:outline-none focus:ring-2 focus:ring-offset-0',
                    errors.password
                      ? 'border-red-300 focus:border-red-400 focus:ring-red-500/15'
                      : 'border-[#E5E7EB] hover:border-gray-300 focus:border-blue-500 focus:ring-blue-500/15',
                  )}
                  {...register('password')}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 transition-colors hover:text-gray-600"
                  tabIndex={-1}
                >
                  {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
              {errors.password && (
                <p className="text-[12px] text-red-500">{errors.password.message}</p>
              )}
            </div>

            <div className="-mt-1 flex justify-end">
              <button
                type="button"
                onClick={() => onNavigate('forgot-password')}
                className="text-[12.5px] font-medium text-blue-600 transition-colors hover:text-blue-700"
              >
                Glömt lösenord?
              </button>
            </div>

            {apiError && (
              <div className="rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-[13px] text-red-600">
                {apiError}
              </div>
            )}

            <Button
              type="submit"
              variant="primary"
              loading={isPending}
              className="mt-2 h-10 w-full rounded-xl text-[14px] font-semibold"
            >
              {isPending ? 'Loggar in...' : 'Logga in'}
            </Button>
          </form>

          <div className="my-7 flex items-center gap-3">
            <div className="h-px flex-1 bg-gray-100" />
            <span className="text-[12px] text-gray-400">eller</span>
            <div className="h-px flex-1 bg-gray-100" />
          </div>

          <p className="text-center text-[14px] text-gray-500">
            Inget konto?{' '}
            <button
              type="button"
              onClick={() => onNavigate('register')}
              className="font-semibold text-blue-600 transition-colors hover:text-blue-700"
            >
              Skapa ett här →
            </button>
          </p>

          <p className="mt-6 text-center text-[12px] text-gray-400">
            <button
              type="button"
              onClick={() => onNavigate('privacy')}
              className="hover:text-gray-600 hover:underline"
            >
              Integritetspolicy
            </button>
          </p>
        </motion.div>
      </div>
    </div>
  )
}
