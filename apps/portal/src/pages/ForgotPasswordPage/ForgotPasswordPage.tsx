import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useSessionMutation } from '@/lib/session-guard'
import { PortalNetworkError } from '@/lib/network-state'
import { requestForgotPassword } from '@/api/portal.api'
import styles from '../LoginPage/LoginPage.module.css'

type State = 'idle' | 'sent'

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const [state, setState] = useState<State>('idle')
  const [errorMsg, setErrorMsg] = useState('')

  const mutation = useSessionMutation({
    mutationFn: (em: string) => requestForgotPassword(em),
    onSuccess: () => setState('sent'),
    onError: (error: unknown) =>
      setErrorMsg(
        error instanceof PortalNetworkError
          ? error.message
          : 'Något gick fel. Försök igen om en stund.',
      ),
  })

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!email.trim()) return
    setErrorMsg('')
    mutation.mutate(email.trim().toLowerCase())
  }

  if (state === 'sent') {
    return (
      <div className={styles.page}>
        <div className={styles.card}>
          <div className={styles.successIcon}>📧</div>
          <h1 className={styles.title}>Mejl skickat</h1>
          <p className={styles.subtitle}>
            Om det finns aktiverade konton för <strong>{email}</strong> skickar vi instruktioner för
            att återställa lösenordet. Varje länk är giltig i 24 timmar.
          </p>
          <p className={styles.smallHint}>
            Har du konton hos flera hyresvärdar får du separata länkar. Hyresvärdens namn står i
            mejlet så att du kan välja rätt konto.
          </p>
          <p className={styles.smallHint}>Inget mail? Kontrollera skräpposten.</p>
          <Link to="/login" className={styles.linkBtn}>
            Tillbaka till inloggningen
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

        <h1 className={styles.title}>Glömt lösenord</h1>
        <p className={styles.subtitle}>
          Ange din e-postadress så skickar vi en länk för att återställa lösenordet.
        </p>

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

          {errorMsg && (
            <p className={styles.errorMsg} role="alert">
              {errorMsg}
            </p>
          )}

          <button
            type="submit"
            className={styles.submitBtn}
            disabled={mutation.isPending || !email.trim()}
          >
            {mutation.isPending ? (
              <>
                <span className={styles.btnSpinner} />
                Skickar...
              </>
            ) : (
              'Skicka återställningslänk'
            )}
          </button>
        </form>

        <div style={{ marginTop: 16, textAlign: 'center' }}>
          <Link
            to="/login"
            style={{
              fontSize: 13,
              color: 'var(--color-text-muted)',
              textDecoration: 'underline',
            }}
          >
            Tillbaka till inloggningen
          </Link>
        </div>
      </div>
    </div>
  )
}
