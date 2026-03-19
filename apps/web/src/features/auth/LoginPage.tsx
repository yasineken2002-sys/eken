import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { LoginSchema, type LoginInput } from '@eken/shared'
import { post } from '@/lib/api'
import { useAuthStore } from '@/stores/auth.store'
import type { TokenPair, User } from '@eken/shared'

export function LoginPage() {
  const navigate = useNavigate()
  const setAuth = useAuthStore((s) => s.setAuth)

  const {
    register,
    handleSubmit,
    formState: { errors },
    setError,
  } = useForm<LoginInput>({ resolver: zodResolver(LoginSchema) })

  const mutation = useMutation({
    mutationFn: (data: LoginInput) => post<{ tokens: TokenPair; user: User }>('/auth/login', data),
    onSuccess: ({ tokens, user }) => {
      setAuth(user, tokens.accessToken, tokens.refreshToken)
      void navigate({ to: '/' })
    },
    onError: () => {
      setError('root', { message: 'Felaktig e-postadress eller lösenord' })
    },
  })

  return (
    <div className="w-full max-w-sm space-y-6">
      <div className="space-y-2 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Logga in</h1>
        <p className="text-muted-foreground text-sm">Ange dina uppgifter för att fortsätta</p>
      </div>

      <form onSubmit={handleSubmit((d) => mutation.mutate(d))} className="space-y-4">
        <div className="space-y-1">
          <label htmlFor="email" className="text-sm font-medium">
            E-postadress
          </label>
          <input
            id="email"
            type="email"
            className="border-input bg-background ring-offset-background placeholder:text-muted-foreground focus-visible:ring-ring flex h-10 w-full rounded-md border px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2"
            placeholder="anna@foretag.se"
            {...register('email')}
          />
          {errors.email && <p className="text-destructive text-xs">{errors.email.message}</p>}
        </div>

        <div className="space-y-1">
          <label htmlFor="password" className="text-sm font-medium">
            Lösenord
          </label>
          <input
            id="password"
            type="password"
            className="border-input bg-background ring-offset-background placeholder:text-muted-foreground focus-visible:ring-ring flex h-10 w-full rounded-md border px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2"
            {...register('password')}
          />
          {errors.password && <p className="text-destructive text-xs">{errors.password.message}</p>}
        </div>

        {errors.root && <p className="text-destructive text-sm">{errors.root.message}</p>}

        <button
          type="submit"
          disabled={mutation.isPending}
          className="bg-primary text-primary-foreground ring-offset-background hover:bg-primary/90 focus-visible:ring-ring inline-flex h-10 w-full items-center justify-center rounded-md px-4 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 disabled:pointer-events-none disabled:opacity-50"
        >
          {mutation.isPending ? 'Loggar in...' : 'Logga in'}
        </button>
      </form>

      <p className="text-muted-foreground text-center text-sm">
        Inget konto?{' '}
        <Link to="/register" className="text-primary underline-offset-4 hover:underline">
          Registrera dig
        </Link>
      </p>
    </div>
  )
}
