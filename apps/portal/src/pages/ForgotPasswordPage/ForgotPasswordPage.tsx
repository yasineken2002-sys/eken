import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation } from '@tanstack/react-query'
import { requestForgotPassword } from '@/api/portal.api'
import styles from '../LoginPage/LoginPage.module.css'

type State = 'idle' | 'sent'

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const [state, setState] = useState<State>('idle')
  const [errorMsg, setErrorMsg] = useState('')

  const mutation = useMutation({
    mutationFn: (em: string) => requestForgotPassword(em),
    onSuccess: () => setState('sent'),
    onError: () => setErrorMsg('Något gick fel. Försök igen om en stund.'),
  })

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!email.trim()) return
    setErrorMsg('')
    mutation.mutate(email.trim())
  }

  if (state === 'sent') {
    return (
      <div className={styles.page}>
        <div className={styles.card}>
          <div className={styles.successIcon}>📧</div>
          <h1 className={styles.title}>Mejl skickat</h1>
          <p className={styles.subtitle}>
            Om ett konto finns för <strong>{email}</strong> har vi skickat instruktioner för att
            återställa lösenordet. Länken är giltig i 24 timmar.
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

          {errorMsg && <p className={styles.errorMsg}>{errorMsg}</p>}

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
