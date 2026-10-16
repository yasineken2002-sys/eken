import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  TenantLoginSchema,
  type TenantLoginInput,
  type TenantLoginResolveResult,
} from '@eken/shared'
import { useSessionGuard } from '@/lib/session-guard'
import { kontraktsfel } from '@/lib/contract-gate'
import { resolvePasswordLogin } from '@/api/portal.api'
import { useSessionStore } from '@/store/session.store'
import { PasswordInput } from '@/components/PasswordInput/PasswordInput'
import { BankIdLogin } from '@/components/BankIdLogin/BankIdLogin'
import styles from './LoginPage.module.css'

type LoginChoice = Extract<TenantLoginResolveResult, { status: 'choose' }>
type FocusTarget = 'choice' | 'error' | 'password' | null

export function LoginPage() {
  const navigate = useNavigate()
  const currentSession = useSessionGuard()
  const setSession = useSessionStore((s) => s.setSession)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [choice, setChoice] = useState<LoginChoice | null>(null)
  const [organizationId, setOrganizationId] = useState('')
  const [pending, setPending] = useState(false)
  const [errorMsg, setErrorMsg] = useState('')
  const [focusTarget, setFocusTarget] = useState<FocusTarget>(null)
  const mounted = useRef(false)
  const attemptId = useRef(0)
  const activeController = useRef<AbortController | null>(null)
  const passwordInput = useRef<HTMLInputElement>(null)
  const choiceFieldset = useRef<HTMLFieldSetElement>(null)
  const errorMessage = useRef<HTMLParagraphElement>(null)

  const invalidateAttempt = useCallback(() => {
    attemptId.current += 1
    activeController.current?.abort()
    activeController.current = null
  }, [])

  const clearPrivateState = useCallback(() => {
    setPassword('')
    setChoice(null)
    setOrganizationId('')
    setPending(false)
    setErrorMsg('')
    setFocusTarget(null)
  }, [])

  useLayoutEffect(() => {
    mounted.current = true
    const unsubscribe = useSessionStore.subscribe((state, previous) => {
      if (state.sessionGeneration !== previous.sessionGeneration) {
        invalidateAttempt()
        clearPrivateState()
        setEmail('')
      }
    })
    return () => {
      // Layout-cleanup stänger försöket när navigationen avmonterar sidan.
      // Hemligheter och kandidater finns bara i komponentens lokala tillstånd,
      // aldrig i React Query, URL eller lagring.
      mounted.current = false
      unsubscribe()
      invalidateAttempt()
    }
  }, [clearPrivateState, invalidateAttempt])

  useEffect(() => {
    if (!focusTarget || !mounted.current || !currentSession()) return
    if (focusTarget === 'choice') choiceFieldset.current?.focus()
    if (focusTarget === 'error') errorMessage.current?.focus()
    if (focusTarget === 'password') passwordInput.current?.focus()
    setFocusTarget(null)
  }, [focusTarget, currentSession])

  function changeCredentials() {
    invalidateAttempt()
    setChoice(null)
    setOrganizationId('')
    setPending(false)
    setErrorMsg('')
    setFocusTarget(null)
  }

  function startOver() {
    invalidateAttempt()
    clearPrivateState()
    setFocusTarget('password')
  }

  function leavePasswordFlow() {
    invalidateAttempt()
    clearPrivateState()
    setEmail('')
  }

  async function submitPassword(selectedOrganizationId?: string) {
    if (!mounted.current || !currentSession() || activeController.current) return
    const payload: TenantLoginInput = {
      email: email.trim().toLowerCase(),
      password,
      ...(selectedOrganizationId ? { organizationId: selectedOrganizationId } : {}),
    }
    const invalid = kontraktsfel(TenantLoginSchema, payload)
    if (invalid) {
      setErrorMsg(invalid)
      setFocusTarget('error')
      return
    }

    invalidateAttempt()
    const id = attemptId.current
    const controller = new AbortController()
    activeController.current = controller
    setPending(true)
    setErrorMsg('')
    const stillCurrent = () =>
      mounted.current && currentSession() && id === attemptId.current && !controller.signal.aborted

    try {
      const result = await resolvePasswordLogin(payload, controller.signal)
      // Abort kan komma efter transportens sista kontroll. Försöks-id:t och
      // sessionsgrinden skyddar även ett redan mottaget men sent behandlat svar.
      if (!stillCurrent()) return
      if (result.status === 'choose') {
        setChoice(result)
        setOrganizationId('')
        setFocusTarget('choice')
      } else {
        leavePasswordFlow()
        setSession(result.sessionToken, result.tenant, result.expiresAt)
        navigate('/dashboard', { replace: true })
      }
    } catch (error: unknown) {
      if (!stillCurrent()) return
      clearPrivateState()
      const status = (error as { response?: { status?: number } })?.response?.status
      setErrorMsg(
        status === 401
          ? 'Felaktig e-post eller lösenord.'
          : status === 429
            ? 'Inloggning är tillfälligt begränsad. Vänta en stund och försök igen.'
            : 'Något gick fel. Försök igen.',
      )
      setFocusTarget('error')
    } finally {
      if (stillCurrent()) {
        activeController.current = null
        setPending(false)
      }
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (choice) {
      if (!choice.candidates.some((candidate) => candidate.organizationId === organizationId))
        return
      void submitPassword(organizationId)
    } else {
      void submitPassword()
    }
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

        <h1 className={styles.title}>Logga in</h1>
        <p className={styles.subtitle}>
          {choice
            ? 'Ditt lösenord stämmer hos flera hyresvärdar. Välj vem du vill logga in hos.'
            : 'Logga in med din e-post och ditt lösenord.'}
        </p>

        <form onSubmit={handleSubmit} className={styles.form} aria-busy={pending}>
          {choice ? (
            <fieldset
              ref={choiceFieldset}
              className={styles.choiceFieldset}
              tabIndex={-1}
              aria-describedby="landlord-choice-hint"
            >
              <legend className={styles.choiceLegend}>Välj hyresvärd</legend>
              <p id="landlord-choice-hint" className={styles.choiceHint}>
                Välj en hyresvärd och tryck på Fortsätt.
              </p>
              <div className={styles.choiceOptions}>
                {choice.candidates.map((candidate) => (
                  <label
                    key={candidate.organizationId}
                    className={[
                      styles.choiceOption,
                      organizationId === candidate.organizationId ? styles.choiceSelected : '',
                    ].join(' ')}
                  >
                    <input
                      type="radio"
                      name="organizationId"
                      value={candidate.organizationId}
                      className={styles.choiceRadio}
                      checked={organizationId === candidate.organizationId}
                      onChange={() => {
                        invalidateAttempt()
                        setPending(false)
                        setErrorMsg('')
                        setOrganizationId(candidate.organizationId)
                      }}
                    />
                    <span className={styles.choiceName}>{candidate.organizationName}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          ) : (
            <>
              <label className={styles.label} htmlFor="email">
                E-postadress
              </label>
              <input
                id="email"
                type="email"
                className={styles.input}
                placeholder="din@email.se"
                value={email}
                onChange={(event) => {
                  changeCredentials()
                  setEmail(event.target.value)
                }}
                required
                autoComplete="username"
                autoFocus
              />

              <label className={styles.label} htmlFor="password" style={{ marginTop: 12 }}>
                Lösenord
              </label>
              <PasswordInput
                ref={passwordInput}
                id="password"
                placeholder="Ditt lösenord"
                value={password}
                onChange={(event) => {
                  changeCredentials()
                  setPassword(event.target.value)
                }}
                required
                autoComplete="current-password"
              />
            </>
          )}

          {errorMsg && (
            <p ref={errorMessage} className={styles.errorMsg} role="alert" tabIndex={-1}>
              {errorMsg}
            </p>
          )}

          <button
            type="submit"
            className={styles.submitBtn}
            disabled={pending || !email.trim() || !password || (!!choice && !organizationId)}
          >
            {pending ? (
              <>
                <span className={styles.btnSpinner} aria-hidden="true" />
                Loggar in...
              </>
            ) : choice ? (
              'Fortsätt'
            ) : (
              'Logga in'
            )}
          </button>
          {(choice || pending) && (
            <button type="button" className={styles.backBtn} onClick={startOver}>
              {choice ? 'Tillbaka' : 'Börja om'}
            </button>
          )}
        </form>

        {/*
          BankID ligger UTANFÖR formuläret. En knapp inuti ett <form> är en
          submit-knapp om inget annat sägs, och den hör dessutom inte till
          lösenordsflödet: för en hyresgäst som aldrig aktiverat portalen är det
          den FÖRSTA vägen in, inte ett alternativ till ett lösenord hen inte har.
        */}
        <BankIdLogin
          onSession={(session) => {
            if (!mounted.current || !currentSession()) return
            leavePasswordFlow()
            setSession(session.sessionToken, session.tenant, session.expiresAt)
            navigate('/dashboard', { replace: true })
          }}
        />

        <div style={{ marginTop: 16, textAlign: 'center' }}>
          <Link
            to="/forgot-password"
            onClick={leavePasswordFlow}
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
