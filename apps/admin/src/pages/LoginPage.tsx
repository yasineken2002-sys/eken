import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import axios from 'axios'
import { Button } from '@/components/ui/Button'
import { Input, Label } from '@/components/ui/Input'
import { useAuthStore } from '@/stores/auth.store'

interface LoginResponse {
  accessToken: string
  refreshToken: string
  user: {
    id: string
    email: string
    firstName: string
    lastName: string
    totpEnabled: boolean
  }
}

export function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [totpCode, setTotpCode] = useState('')
  const [needsTotp, setNeedsTotp] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const setSession = useAuthStore((s) => s.setSession)
  const navigate = useNavigate()

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)
    try {
      const { data } = await axios.post<{ data: LoginResponse }>('/api/v1/platform/auth/login', {
        email,
        password,
        ...(totpCode ? { totpCode } : {}),
      })
      setSession(data.data)
      navigate('/', { replace: true })
    } catch (err) {
      const payload = (
        err as {
          response?: { data?: { error?: { message?: string | { requires2fa?: boolean } } } }
        }
      ).response?.data?.error
      const msg = typeof payload?.message === 'string' ? payload.message : 'Inloggning misslyckades'
      if (msg === 'TOTP-kod krävs') {
        setNeedsTotp(true)
        setError('Ange din 2FA-kod.')
      } else {
        setError(msg)
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#F7F8FA] p-4">
      <div className="w-full max-w-sm rounded-2xl border border-[#EAEDF0] bg-white p-8 shadow-sm">
        <div className="mb-6 text-center">
          <div className="text-[12px] font-semibold uppercase tracking-wide text-gray-400">
            Eveno
          </div>
          <div className="mt-0.5 text-[20px] font-semibold text-gray-900">Plattforms-admin</div>
        </div>
        <form onSubmit={submit} className="space-y-4">
          <div>
            <Label htmlFor="email">E-post</Label>
            <Input
              id="email"
              type="email"
              value={email}
              autoComplete="email"
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <div>
            <Label htmlFor="password">Lösenord</Label>
            <Input
              id="password"
              type="password"
              value={password}
              autoComplete="current-password"
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          {needsTotp ? (
            <div>
              <Label htmlFor="totp">2FA-kod</Label>
              <Input
                id="totp"
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value)}
                inputMode="numeric"
                maxLength={6}
                required
              />
            </div>
          ) : null}
          {error ? (
            <div className="rounded-lg bg-red-50 px-3 py-2 text-[13px] text-red-700">{error}</div>
          ) : null}
          <Button type="submit" loading={loading} className="w-full">
            Logga in
          </Button>
        </form>
      </div>
    </div>
  )
}
