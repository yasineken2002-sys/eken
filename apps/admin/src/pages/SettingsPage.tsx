import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { PageHeader } from '@/components/ui/PageHeader'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Input, Label } from '@/components/ui/Input'
import { PasswordRequirements } from '@/components/ui/PasswordRequirements'
import { post } from '@/lib/api'
import { useAuthStore } from '@/stores/auth.store'

export function SettingsPage() {
  const user = useAuthStore((s) => s.user)
  const setUser = useAuthStore((s) => s.setUser)
  const qc = useQueryClient()

  const [pwd, setPwd] = useState({ currentPassword: '', newPassword: '' })
  const [pwdMsg, setPwdMsg] = useState<string | null>(null)
  const pwdMutation = useMutation({
    mutationFn: () => post('/platform/auth/change-password', pwd),
    onSuccess: () => {
      setPwd({ currentPassword: '', newPassword: '' })
      setPwdMsg('Lösenordet är uppdaterat.')
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
