import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery } from '@tanstack/react-query'
import { validatePasswordStrength } from '@eken/shared'
import { activateAccount, fetchActivationInfo } from '@/api/portal.api'
import { useSessionStore } from '@/store/session.store'
import { Spinner } from '@/components/ui/Spinner'
import { PasswordRequirements } from '@/components/ui/PasswordRequirements'
import styles from './ActivatePage.module.css'

const SEK = new Intl.NumberFormat('sv-SE', {
  style: 'currency',
  currency: 'SEK',
  maximumFractionDigits: 0,
})

function formatDate(d: string | null): string {
  if (!d) return 'Tills vidare'
  return new Date(d).toLocaleDateString('sv-SE', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
}

function tenantDisplayName(t: {
  type: string
  firstName: string | null
  lastName: string | null
  companyName: string | null
}): string {
  if (t.type === 'INDIVIDUAL') {
    return [t.firstName, t.lastName].filter(Boolean).join(' ').trim()
  }
  return t.companyName ?? ''
}

export function ActivatePage() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const setSession = useSessionStore((s) => s.setSession)
  const token = searchParams.get('token') ?? ''

  const today = useMemo(
    () =>
      new Date().toLocaleDateString('sv-SE', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      }),
    [],
  )

  const infoQuery = useQuery({
    queryKey: ['tenant-portal', 'activation', token],
    queryFn: () => fetchActivationInfo(token),
    enabled: !!token,
    retry: false,
  })

  const [signed, setSigned] = useState(false)
  const [signatureName, setSignatureName] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [errorMsg, setErrorMsg] = useState('')

  // Förifyll signaturnamn när infoQuery är klar
  useEffect(() => {
    if (infoQuery.data && !signatureName) {
      setSignatureName(tenantDisplayName(infoQuery.data.tenant))
    }
  }, [infoQuery.data, signatureName])

  const activateMutation = useMutation({
    mutationFn: () => activateAccount({ token, password }),
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
      if (status === 401) setErrorMsg('Aktiveringslänken är ogiltig eller har gått ut.')
      else if (status === 400 && apiMsg) setErrorMsg(apiMsg)
      else if (status === 400) setErrorMsg('Lösenordet uppfyller inte kraven.')
      else setErrorMsg('Något gick fel. Försök igen om en stund.')
    },
  })

  function validate(): string | null {
    if (!signed) return 'Du måste markera att du har läst och godkänner kontraktet.'
    if (!signatureName.trim()) return 'Ange ditt namn som signatur.'
    const strength = validatePasswordStrength(password)
    if (!strength.valid) return strength.errors[0] ?? 'Lösenordet uppfyller inte kraven.'
    if (password !== confirmPassword) return 'Lösenorden matchar inte.'
    return null
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const err = validate()
    if (err) {
      setErrorMsg(err)
      return
    }
    setErrorMsg('')
    activateMutation.mutate()
  }

  if (!token) {
    return (
      <div className={styles.page}>
        <div className={styles.card}>
          <div className={styles.errorIcon}>❌</div>
          <h1 className={styles.title}>Ingen aktiveringslänk</h1>
          <p className={styles.subtitle}>
            Aktiveringslänken saknas. Kontakta din hyresvärd om du behöver en ny.
          </p>
          <div className={styles.centerBlock}>
            <Link to="/login" className={styles.linkBack}>
              Till inloggningen
            </Link>
          </div>
        </div>
      </div>
    )
  }

  if (infoQuery.isLoading) {
    return (
      <div className={styles.page}>
        <div className={styles.card}>
          <Spinner size="lg" label="Hämtar dina kontraktsuppgifter..." />
        </div>
      </div>
    )
  }

  if (infoQuery.isError || !infoQuery.data) {
    return (
      <div className={styles.page}>
        <div className={styles.card}>
          <div className={styles.errorIcon}>❌</div>
          <h1 className={styles.title}>Länken är ogiltig</h1>
          <p className={styles.subtitle}>
            Aktiveringslänken är ogiltig eller har gått ut. Be din hyresvärd skicka en ny länk.
          </p>
          <div className={styles.centerBlock}>
            <Link to="/login" className={styles.linkBack}>
              Till inloggningen
            </Link>
          </div>
        </div>
      </div>
    )
  }

  const info = infoQuery.data
  const lease = info.lease
  const tenantName = tenantDisplayName(info.tenant) || info.tenant.email

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

        <h1 className={styles.title}>Välkommen, {tenantName}!</h1>
        <p className={styles.subtitle}>
          {info.organization.name} har skapat ett hyreskontrakt åt dig. Granska uppgifterna nedan,
          signera digitalt och välj sedan ett eget lösenord för att aktivera ditt konto.
        </p>

        <form onSubmit={handleSubmit}>
          {/* ── Kontrakt ────────────────────────────────────────────────── */}
          <div className={styles.section}>
            <p className={styles.sectionLabel}>Hyreskontrakt</p>
            <div className={styles.contractBox}>
              {lease ? (
                <>
                  <p className={styles.contractTitle}>
                    {lease.unit.property.name} · {lease.unit.name}
                  </p>
                  <div className={styles.detailRow}>
                    <span className={styles.detailLabel}>Adress</span>
                    <span className={styles.detailValue}>
                      {lease.unit.property.street}, {lease.unit.property.postalCode}{' '}
                      {lease.unit.property.city}
                    </span>
                  </div>
                  <div className={styles.detailRow}>
                    <span className={styles.detailLabel}>Lägenhetsnummer</span>
                    <span className={styles.detailValue}>{lease.unit.unitNumber}</span>
                  </div>
                  <div className={styles.detailRow}>
                    <span className={styles.detailLabel}>Hyrestyp</span>
                    <span className={styles.detailValue}>
                      {lease.leaseType === 'FIXED_TERM' ? 'Tidsbegränsat' : 'Tills vidare'}
                    </span>
                  </div>
                  <div className={styles.detailRow}>
                    <span className={styles.detailLabel}>Tillträde</span>
                    <span className={styles.detailValue}>{formatDate(lease.startDate)}</span>
                  </div>
                  {lease.endDate && (
                    <div className={styles.detailRow}>
                      <span className={styles.detailLabel}>Slutdatum</span>
                      <span className={styles.detailValue}>{formatDate(lease.endDate)}</span>
                    </div>
                  )}
                  <div className={styles.detailRow}>
                    <span className={styles.detailLabel}>Månadshyra</span>
                    <span className={styles.detailValue}>{SEK.format(lease.monthlyRent)}</span>
                  </div>
                  {lease.depositAmount > 0 && (
                    <div className={styles.detailRow}>
                      <span className={styles.detailLabel}>Deposition</span>
                      <span className={styles.detailValue}>{SEK.format(lease.depositAmount)}</span>
                    </div>
                  )}
                  <div className={styles.detailRow}>
                    <span className={styles.detailLabel}>Uppsägningstid</span>
                    <span className={styles.detailValue}>
                      {lease.noticePeriodMonths} månad
                      {lease.noticePeriodMonths === 1 ? '' : 'er'}
                    </span>
                  </div>
                </>
              ) : (
                <p className={styles.detailLabel}>
                  Inget aktivt kontrakt kunde visas. Du kan ändå aktivera kontot och kontakta din
                  hyresvärd vid frågor.
                </p>
              )}
            </div>
          </div>

          {/* ── Signering ───────────────────────────────────────────────── */}
          <div className={styles.section}>
            <p className={styles.sectionLabel}>Digital signering</p>
            <label className={styles.checkboxRow}>
              <input
                type="checkbox"
                className={styles.checkbox}
                checked={signed}
                onChange={(e) => setSigned(e.target.checked)}
                disabled={activateMutation.isPending}
              />
              <span>Jag har läst igenom hyreskontraktet och godkänner villkoren ovan.</span>
            </label>
            <div className={styles.fieldRow}>
              <div className={styles.fieldGroup}>
                <label className={styles.label} htmlFor="signatureName">
                  Namnunderskrift
                </label>
                <input
                  id="signatureName"
                  type="text"
                  className={styles.input}
                  value={signatureName}
                  onChange={(e) => setSignatureName(e.target.value)}
                  disabled={activateMutation.isPending}
                  required
                />
              </div>
              <div className={styles.fieldGroup}>
                <label className={styles.label}>Datum</label>
                <input type="text" className={styles.input} value={today} readOnly disabled />
              </div>
            </div>
          </div>

          {/* ── Lösenord ────────────────────────────────────────────────── */}
          <div className={styles.section}>
            <p className={styles.sectionLabel}>Välj lösenord</p>
            <div className={styles.fieldGroup}>
              <label className={styles.label} htmlFor="password">
                Nytt lösenord
              </label>
              <input
                id="password"
                type="password"
                className={styles.input}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={activateMutation.isPending}
                autoComplete="new-password"
                placeholder="Minst 10 tecken med stor/liten/siffra/specialtecken"
                required
              />
              <PasswordRequirements password={password} />
            </div>
            <div className={styles.fieldGroup}>
              <label className={styles.label} htmlFor="confirmPassword">
                Bekräfta lösenord
              </label>
              <input
                id="confirmPassword"
                type="password"
                className={styles.input}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                disabled={activateMutation.isPending}
                autoComplete="new-password"
                required
              />
            </div>
          </div>

          {errorMsg && <p className={styles.errorMsg}>{errorMsg}</p>}

          <button
            type="submit"
            className={styles.submitBtn}
            disabled={activateMutation.isPending}
            style={{ marginTop: 20 }}
          >
            {activateMutation.isPending ? (
              <>
                <span className={styles.btnSpinner} />
                Aktiverar...
              </>
            ) : (
              'Aktivera mitt konto'
            )}
          </button>
        </form>
      </div>
    </div>
  )
}
