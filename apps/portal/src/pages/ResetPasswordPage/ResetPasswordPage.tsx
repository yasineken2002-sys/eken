import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useMutation } from '@tanstack/react-query'
import { validatePasswordStrength } from '@eken/shared'
import { resetPassword } from '@/api/portal.api'
import { useSessionStore } from '@/store/session.store'
import { PasswordRequirements } from '@/components/ui/PasswordRequirements'
import styles from '../LoginPage/LoginPage.module.css'

export function ResetPasswordPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const setSession = useSessionStore((s) => s.setSession)
  const token = searchParams.get('token') ?? ''

  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [errorMsg, setErrorMsg] = useState('')

  const mutation = useMutation({
    mutationFn: () => resetPassword({ token, password }),
    onSuccess: (result) => {
      setSession(result.sessionToken, result.tenant, result.expiresAt)
      navigate('/dashboard', { replace: true })
    },
    onError: (err: unknown) => {
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
          <input
            id="password"
            type="password"
            className={styles.input}
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
          <input
            id="confirmPassword"
            type="password"
            className={styles.input}
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            required
            disabled={mutation.isPending}
            autoComplete="new-password"
          />

          {errorMsg && <p className={styles.errorMsg}>{errorMsg}</p>}

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
