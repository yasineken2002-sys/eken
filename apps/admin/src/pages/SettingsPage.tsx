import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { AlertTriangle } from 'lucide-react'
import { PageHeader } from '@/components/ui/PageHeader'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Input, Label } from '@/components/ui/Input'
import { PasswordRequirements } from '@/components/ui/PasswordRequirements'
import { post } from '@/lib/api'
import { setAdminLoginFlash } from '@/lib/login-flash'
import { useAuthStore } from '@/stores/auth.store'

interface ChangePasswordResult {
  message: string
  loggedOut: true
}

export function SettingsPage() {
  const user = useAuthStore((s) => s.user)
  const setUser = useAuthStore((s) => s.setUser)
  const logout = useAuthStore((s) => s.logout)
  const navigate = useNavigate()
  const qc = useQueryClient()

  const [pwd, setPwd] = useState({ currentPassword: '', newPassword: '' })
  const [pwdMsg, setPwdMsg] = useState<string | null>(null)
  const pwdMutation = useMutation({
    mutationFn: () => post<ChangePasswordResult>('/platform/auth/change-password', pwd),
    onSuccess: (result) => {
      setPwd({ currentPassword: '', newPassword: '' })
      // Server revokerar samtliga refresh-tokens — städa lokal session och
      // skicka till login med en flash-banner i stället för att tappa
      // användaren tyst vid nästa 401.
      if (result.loggedOut) {
        setAdminLoginFlash({
          kind: 'password-changed',
          ...(user?.email ? { email: user.email } : {}),
        })
        logout()
        navigate('/login', { replace: true })
      } else {
        setPwdMsg(result.message)
      }
    },
    onError: (err) => {
      setPwdMsg((err as Error).message)
    },
  })

  const [qr, setQr] = useState<string | null>(null)
  const [secret, setSecret] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const setup = useMutation({
    mutationFn: () =>
      post<{ secret: string; qrCodeDataUrl: string }>('/platform/auth/2fa/setup', {}),
    onSuccess: (d) => {
      setQr(d.qrCodeDataUrl)
      setSecret(d.secret)
    },
  })
  const enable = useMutation({
    mutationFn: () => post('/platform/auth/2fa/enable', { code }),
    onSuccess: () => {
      if (user) setUser({ ...user, totpEnabled: true })
      setQr(null)
      setSecret(null)
      setCode('')
      qc.invalidateQueries()
    },
  })
  const disable = useMutation({
    mutationFn: () => post('/platform/auth/2fa/disable', { code }),
    onSuccess: () => {
      if (user) setUser({ ...user, totpEnabled: false })
      setCode('')
      qc.invalidateQueries()
    },
  })

  return (
    <>
      <PageHeader title="Inställningar" description="Ditt super-admin-konto" />
      <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <h3 className="text-[14px] font-semibold">Byt lösenord</h3>
          </CardHeader>
          <CardBody className="space-y-3">
            <div>
              <Label>Nuvarande lösenord</Label>
              <Input
                type="password"
                value={pwd.currentPassword}
                onChange={(e) => setPwd({ ...pwd, currentPassword: e.target.value })}
              />
            </div>
            <div>
              <Label>Nytt lösenord</Label>
              <Input
                type="password"
                placeholder="Minst 10 tecken med stor/liten/siffra/specialtecken"
                value={pwd.newPassword}
                onChange={(e) => setPwd({ ...pwd, newPassword: e.target.value })}
              />
            </div>
            <PasswordRequirements password={pwd.newPassword} />
            <div
              role="note"
              className="flex items-start gap-2.5 rounded-xl border border-amber-100 bg-amber-50/70 p-3 text-[12.5px] text-amber-900"
            >
              <AlertTriangle
                size={14}
                strokeWidth={1.8}
                className="mt-0.5 shrink-0 text-amber-600"
              />
              <p>
                När du byter lösenord loggas du ut från <strong>alla enheter</strong> och behöver
                logga in igen.
              </p>
            </div>
            {pwdMsg ? <div className="text-[13px] text-gray-700">{pwdMsg}</div> : null}
            <Button onClick={() => pwdMutation.mutate()} loading={pwdMutation.isPending}>
              Uppdatera
            </Button>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <h3 className="text-[14px] font-semibold">Tvåfaktorsautentisering (TOTP)</h3>
          </CardHeader>
          <CardBody className="space-y-3 text-[13.5px]">
            {user?.totpEnabled ? (
              <>
                <div className="text-emerald-700">2FA är aktiverat.</div>
                <Label>Bekräfta med din TOTP-kod för att avaktivera</Label>
                <Input
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="123456"
                />
                <Button
                  variant="danger"
                  onClick={() => disable.mutate()}
                  loading={disable.isPending}
                >
                  Avaktivera 2FA
                </Button>
              </>
            ) : qr ? (
              <>
                <p>
                  Scanna QR-koden i din authenticator-app (Google Authenticator, 1Password, Authy).
                </p>
                <img
                  src={qr}
                  alt="TOTP QR"
                  className="h-48 w-48 rounded-lg border border-[#EAEDF0]"
                />
                <div className="break-all text-[12px] text-gray-500">
                  Secret: <code className="font-mono">{secret}</code>
                </div>
                <Label>Bekräfta med en kod från appen</Label>
                <Input
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="123456"
                />
                <Button onClick={() => enable.mutate()} loading={enable.isPending}>
                  Aktivera
                </Button>
              </>
            ) : (
              <>
                <p className="text-gray-600">
                  2FA är inte aktiverat. Rekommenderas starkt för super-admin-konton.
                </p>
                <Button onClick={() => setup.mutate()} loading={setup.isPending}>
                  Starta setup
                </Button>
              </>
            )}
          </CardBody>
        </Card>
      </div>
    </>
  )
}
