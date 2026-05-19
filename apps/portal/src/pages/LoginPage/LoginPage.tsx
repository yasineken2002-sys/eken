import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useMutation } from '@tanstack/react-query'
import { loginWithPassword } from '@/api/portal.api'
import { useSessionStore } from '@/store/session.store'
import { PasswordInput } from '@/components/PasswordInput/PasswordInput'
import { EvenoLogo } from '@/components/ui/EvenoLogo'
import styles from './LoginPage.module.css'

export function LoginPage() {
  const navigate = useNavigate()
  const setSession = useSessionStore((s) => s.setSession)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [errorMsg, setErrorMsg] = useState('')

  const mutation = useMutation({
    // E-post är case-insensitiv. Backend matchar nu också case-insensitivt,
    // men vi normaliserar i klienten också så samma e-post inte sparas i
    // flera olika varianter över tid.
    mutationFn: () => loginWithPassword({ email: email.trim().toLowerCase(), password }),
    onSuccess: (result) => {
      setSession(result.sessionToken, result.tenant, result.expiresAt)
      navigate('/dashboard', { replace: true })
    },
    onError: (err: unknown) => {
      const status = (err as { response?: { status?: number } })?.response?.status
      if (status === 401) {
        setErrorMsg('Felaktig e-post eller lösenord.')
      } else {
        setErrorMsg('Något gick fel. Försök igen.')
      }
    },
  })

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!email.trim() || !password) return
    setErrorMsg('')
    mutation.mutate()
  }

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <div className={styles.brand}>
          <EvenoLogo size="md" subtitle="Hyresgästportal" />
        </div>

        <h1 className={styles.title}>Logga in</h1>
        <p className={styles.subtitle}>Logga in med din e-post och ditt lösenord.</p>

        <form onSubmit={handleSubmit} className={styles.form}>
          <label className={styles.label} htmlFor="email">
            E-postadress
          </label>
          <input
            id="email"
            type="email"
            className={styles.input}
            placeholder="din@email.se"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoFocus
            disabled={mutation.isPending}
          />

          <label className={styles.label} htmlFor="password" style={{ marginTop: 12 }}>
            Lösenord
          </label>
          <PasswordInput
            id="password"
            placeholder="Ditt lösenord"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            disabled={mutation.isPending}
          />

          {errorMsg && <p className={styles.errorMsg}>{errorMsg}</p>}

          <button
            type="submit"
            className={styles.submitBtn}
            disabled={mutation.isPending || !email.trim() || !password}
          >
            {mutation.isPending ? (
              <>
                <span className={styles.btnSpinner} />
                Loggar in...
              </>
            ) : (
              'Logga in'
            )}
          </button>
        </form>

        <div style={{ marginTop: 16, textAlign: 'center' }}>
          <Link
            to="/forgot-password"
            style={{
              fontSize: 13,
              color: 'var(--color-text-muted)',
              textDecoration: 'underline',
            }}
          >
            Glömt lösenord?
          </Link>
        </div>
      </div>
    </div>
  )
}
