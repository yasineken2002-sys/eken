import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { requestMagicLink } from '@/api/portal.api'
import styles from './LoginPage.module.css'

type State = 'idle' | 'pending' | 'sent' | 'error'

export function LoginPage() {
  const [email, setEmail] = useState('')
  const [state, setState] = useState<State>('idle')
  const [errorMsg, setErrorMsg] = useState('')

  const mutation = useMutation({
    mutationFn: requestMagicLink,
    onSuccess: () => setState('sent'),
    onError: (err: unknown) => {
      const status = (err as { response?: { status?: number } })?.response?.status
      if (status === 404) {
        setErrorMsg('E-postadressen hittades inte i systemet.')
      } else {
        setErrorMsg('Något gick fel. Försök igen.')
      }
      setState('error')
    },
  })

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!email.trim()) return
    setState('pending')
    setErrorMsg('')
    mutation.mutate(email.trim())
  }

  if (state === 'sent') {
    return (
      <div className={styles.page}>
        <div className={styles.card}>
          <div className={styles.successIcon}>✅</div>
          <h1 className={styles.title}>Kolla din e-post!</h1>
          <p className={styles.subtitle}>
            Vi har skickat en inloggningslänk till <strong>{email}</strong>
          </p>
          <p className={styles.hint}>Länken är giltig i 24 timmar.</p>
          <p className={styles.smallHint}>Inget mail? Kontrollera skräpposten.</p>
          <button
            className={styles.linkBtn}
            onClick={() => {
              setState('idle')
              setEmail('')
            }}
          >
            Försök igen
          </button>
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
            <p className={styles.brandName}>Eken</p>
            <p className={styles.brandSub}>Hyresgästportal</p>
          </div>
        </div>

        <h1 className={styles.title}>Logga in</h1>
        <p className={styles.subtitle}>Ange din e-postadress så skickar vi en inloggningslänk.</p>

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
            disabled={state === 'pending'}
          />

          {state === 'error' && <p className={styles.errorMsg}>{errorMsg}</p>}

          <button
            type="submit"
            className={styles.submitBtn}
            disabled={state === 'pending' || !email.trim()}
          >
            {state === 'pending' ? (
              <>
                <span className={styles.btnSpinner} />
                Skickar...
              </>
            ) : (
              'Skicka inloggningslänk'
            )}
          </button>
        </form>

        {import.meta.env.DEV && (
          <button
            type="button"
            onClick={async () => {
              const emailInput = document.querySelector('input') as HTMLInputElement
              const em = emailInput?.value?.trim() ?? email.trim()
              if (!em) {
                alert('Skriv in din e-post först')
                return
              }
              try {
                const apiBase = import.meta.env.VITE_API_URL
                  ? `${import.meta.env.VITE_API_URL}/v1/portal`
                  : '/api/portal'
                const res = await fetch(`${apiBase}/auth/dev-link?email=${encodeURIComponent(em)}`)
                const text = await res.text()
                const data = JSON.parse(text) as {
                  success?: boolean
                  data?: { token?: string }
                  message?: string
                }
                if (data.success && data.data?.token) {
                  window.location.href = `/auth/verify?token=${data.data.token}`
                } else {
                  alert('Fel: ' + text)
                }
              } catch (err) {
                alert('Nätverksfel: ' + String(err))
              }
            }}
            style={{
              marginTop: 16,
              color: '#999',
              fontSize: 12,
              background: 'none',
              border: 'none',
              cursor: 'pointer',
            }}
          >
            🔧 Dev: Logga in direkt
          </button>
        )}
      </div>
    </div>
  )
}
