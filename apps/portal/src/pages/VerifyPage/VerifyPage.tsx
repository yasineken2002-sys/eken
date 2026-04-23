import { useEffect, useState } from 'react'
import { useSearchParams, useNavigate, Link } from 'react-router-dom'
import { verifyMagicLink } from '@/api/portal.api'
import { useSessionStore } from '@/store/session.store'
import { Spinner } from '@/components/ui/Spinner'
import styles from './VerifyPage.module.css'

type State = 'loading' | 'success' | 'error'

export function VerifyPage() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const setSession = useSessionStore((s) => s.setSession)
  const [state, setState] = useState<State>('loading')
  const [errorMsg, setErrorMsg] = useState('')

  useEffect(() => {
    const token = searchParams.get('token')
    if (!token) {
      setState('error')
      setErrorMsg('Ingen token hittades i länken.')
      return
    }

    verifyMagicLink(token)
      .then((result) => {
        setSession(result.sessionToken, result.tenant)
        setState('success')
        navigate('/dashboard', { replace: true })
      })
      .catch(() => {
        setState('error')
        setErrorMsg('Länken är ogiltig eller har gått ut.')
      })
  }, [searchParams, navigate, setSession])

  if (state === 'loading') {
    return (
      <div className={styles.page}>
        <div className={styles.card}>
          <Spinner size="lg" label="Verifierar din länk..." />
        </div>
      </div>
    )
  }

  if (state === 'error') {
    return (
      <div className={styles.page}>
        <div className={styles.card}>
          <div className={styles.errorIcon}>❌</div>
          <h1 className={styles.title}>Länken är ogiltig</h1>
          <p className={styles.subtitle}>{errorMsg}</p>
          <Link to="/login" className={styles.backBtn}>
            Begär ny länk
          </Link>
        </div>
      </div>
    )
  }

  return null
}
