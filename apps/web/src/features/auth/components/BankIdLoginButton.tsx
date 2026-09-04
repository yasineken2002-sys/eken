import { useEffect, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { useAuthStore } from '@/stores/auth.store'
import { extractApiError } from '@/lib/api'
import { usePublicFeatures } from '@/lib/public-config'
import { useBankIdLogin } from '../hooks/useBankIdFlow'
import { bankIdLoginChoose } from '../api/bankid.api'
import { BankIdModal } from './BankIdModal'

/**
 * "Logga in med BankID" — knapp plus hela flödet.
 *
 * ── KNAPPEN VISAS BARA NÄR API:T SÄGER ATT DEN FUNGERAR ───────────────────
 *
 * `usePublicFeatures()` frågar `GET /v1/public/config`. Är BankID av svarar
 * hela API-ytan 503 (Stub-providern), och en knapp som leder dit gör felet till
 * användarens: hen trycker, väntar, och får något som inte går att skilja från
 * ett trasigt BankID. Hooken faller dessutom tillbaka på "av" när frågan inte
 * kunde ställas — vet vi inte, visar vi inte.
 *
 * ── VARFÖR SETAUTH SKER I EN EFFEKT ───────────────────────────────────────
 *
 * Inloggningen kan bli klar på två vägar — direkt (`complete`) eller efter ett
 * kontoval — och båda slutar i samma tillstånd. Att sätta store:n på ETT ställe,
 * i en effekt på det tillståndet, gör att de två vägarna inte kan glida isär.
 * Samma nyttolast som lösenordsinloggningen: `session` ÄR AuthResponse.
 */
export function BankIdLoginButton() {
  const navigate = useNavigate()
  const setAuth = useAuthStore((s) => s.setAuth)
  const { bankId } = usePublicFeatures()
  const { state, starta, avbryt, dispatch } = useBankIdLogin()
  const [valjerKonto, setValjerKonto] = useState(false)

  useEffect(() => {
    if (state.steg !== 'klar' || !state.session) return
    const session = state.session
    setAuth(session)
    void navigate({ to: session.user.mustChangePassword ? '/change-password' : '/' })
  }, [state, setAuth, navigate])

  if (!bankId) return null

  const valjKonto = (userId: string) => {
    if (state.steg !== 'val') return
    setValjerKonto(true)
    bankIdLoginChoose(state.chooseToken, userId)
      .then((session) => dispatch({ typ: 'vald', session }))
      .catch((err: unknown) =>
        dispatch({
          typ: 'fel',
          meddelande: extractApiError(err, 'Kontovalet kunde inte slutföras'),
        }),
      )
      .finally(() => setValjerKonto(false))
  }

  return (
    <>
      <Button
        type="button"
        variant="secondary"
        onClick={starta}
        data-testid="bankid-login-button"
        className="mt-3 h-10 w-full rounded-xl text-[14px] font-semibold"
      >
        <ShieldCheck size={15} strokeWidth={1.8} className="mr-2" />
        Logga in med BankID
      </Button>

      <BankIdModal
        open={state.steg !== 'inaktiv' && state.steg !== 'klar'}
        onClose={avbryt}
        state={state}
        title="Logga in med BankID"
        description="Legitimera dig med BankID på den här enheten eller med QR-kod."
        onRetry={starta}
        onChooseAccount={valjKonto}
        valjerKonto={valjerKonto}
      />
    </>
  )
}
