import { useLayoutEffect, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { SessionChangedError, useSessionMutation } from '@/lib/session-guard'
import { PortalNetworkError } from '@/lib/network-state'
import { validatePasswordStrength } from '@eken/shared'
import { resetPassword } from '@/api/portal.api'
import { useSessionStore } from '@/store/session.store'
import { PasswordRequirements } from '@/components/ui/PasswordRequirements'
import { PasswordInput } from '@/components/PasswordInput/PasswordInput'
import styles from '../LoginPage/LoginPage.module.css'

export function ResetPasswordPage() {
  const [searchParams] = useSearchParams()
  const token = searchParams.get('token') ?? ''
  // En annan länk måste få ett nytt formulär, utan tidigare utkast/godkännande.
  return <ResetPasswordForm key={token} token={token} />
}

function ResetPasswordForm({ token }: { token: string }) {
  const navigate = useNavigate()
  const setSession = useSessionStore((s) => s.setSession)
  const mounted = useRef(false)
  useLayoutEffect(() => {
    mounted.current = true
    return () => {
      // Ett skickat serveranrop kan slutföras, men får inte längre styra denna vy.
      mounted.current = false
    }
  }, [])

  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [errorMsg, setErrorMsg] = useState('')

  const mutation = useSessionMutation({
    meta: { handlesOwnError: true },
    mutationFn: () => {
      if (!mounted.current) throw new SessionChangedError()
      return resetPassword({ token, password })
    },
    onSuccess: (result) => {
      if (!mounted.current) return
      setSession(result.sessionToken, result.tenant, result.expiresAt)
      navigate('/dashboard', { replace: true })
    },
    onError: (err: unknown) => {
      if (!mounted.current) return
      if (err instanceof PortalNetworkError) {
        setErrorMsg(err.message)
        return
      }
      const e = err as {
        response?: { status?: number; data?: { error?: { message?: string } } }
      }
      const status = e?.response?.status
      const apiMsg = e?.response?.data?.error?.message
      if (status === 401) setErrorMsg('Återställningslänken är ogiltig eller har gått ut.')
      else if (status === 400 && apiMsg) setErrorMsg(apiMsg)
      else if (status === 400) setErrorMsg('Lösenordet uppfyller inte kraven.')
      else setErrorMsg('Något gick fel. Försök igen om en stund.')
    },
  })

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!mounted.current) return
    const strength = validatePasswordStrength(password)
    if (!strength.valid) {
      setErrorMsg(strength.errors[0] ?? 'Lösenordet uppfyller inte kraven.')
      return
    }
    if (password !== confirmPassword) {
      setErrorMsg('Lösenorden matchar inte.')
      return
    }
    setErrorMsg('')
    mutation.mutate()
  }

  if (!token) {
    return (
      <div className={styles.page}>
        <div className={styles.card}>
          <h1 className={styles.title}>Ingen token</h1>
          <p className={styles.subtitle}>Återställningslänken saknas.</p>
          <Link to="/forgot-password" className={styles.linkBtn}>
            Begär ny länk
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <div className={styles.brand}>
          <div className={styles.logo}>E</div>
          <div>
            <p className={styles.brandName}>Eveno</p>
            <p className={styles.brandSub}>Hyresgästportal</p>
          </div>
        </div>

        <h1 className={styles.title}>Välj nytt lösenord</h1>
        <p className={styles.subtitle}>Ange ett nytt lösenord för att logga in.</p>

        <form onSubmit={handleSubmit} className={styles.form}>
          <label className={styles.label} htmlFor="password">
            Nytt lösenord
          </label>
          <PasswordInput
            id="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoFocus
            disabled={mutation.isPending}
            autoComplete="new-password"
            placeholder="Minst 10 tecken med stor/liten/siffra/specialtecken"
          />
          <PasswordRequirements password={password} />

          <label className={styles.label} htmlFor="confirmPassword" style={{ marginTop: 12 }}>
            Bekräfta lösenord
          </label>
          <PasswordInput
            id="confirmPassword"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            required
            disabled={mutation.isPending}
            autoComplete="new-password"
          />

          {errorMsg && (
            <p className={styles.errorMsg} role="alert">
              {errorMsg}
            </p>
          )}

          <button
            type="submit"
            className={styles.submitBtn}
            disabled={mutation.isPending || !password || !confirmPassword}
          >
            {mutation.isPending ? (
              <>
                <span className={styles.btnSpinner} />
                Sparar...
              </>
            ) : (
              'Spara nytt lösenord'
            )}
          </button>
        </form>
      </div>
    </div>
  )
}
