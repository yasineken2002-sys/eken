import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { exportMyData, deleteMyAccount, logoutSession } from '@/api/portal.api'
import { useSessionStore } from '@/store/session.store'

const card: React.CSSProperties = {
  background: '#fff',
  border: '1px solid #e5e7eb',
  borderRadius: 16,
  padding: 20,
}

const btnPrimary: React.CSSProperties = {
  height: 36,
  padding: '0 16px',
  background: '#2563eb',
  color: '#fff',
  border: 'none',
  borderRadius: 8,
  fontSize: 13,
  fontWeight: 500,
  cursor: 'pointer',
}

const btnSecondary: React.CSSProperties = {
  height: 36,
  padding: '0 12px',
  background: '#fff',
  color: '#374151',
  border: '1px solid #d1d5db',
  borderRadius: 8,
  fontSize: 13,
  fontWeight: 500,
  cursor: 'pointer',
}

export function SettingsPage() {
  const navigate = useNavigate()
  const sessionToken = useSessionStore((s) => s.sessionToken)
  const tenant = useSessionStore((s) => s.tenant)
  const clearSession = useSessionStore((s) => s.clearSession)

  const [exportLoading, setExportLoading] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deletePassword, setDeletePassword] = useState('')
  const [deleteLoading, setDeleteLoading] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const handleExport = async () => {
    setExportLoading(true)
    try {
      const data = await exportMyData()
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `eveno-mina-uppgifter-${new Date().toISOString().slice(0, 10)}.json`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } finally {
      setExportLoading(false)
    }
  }

  const handleDelete = async () => {
    setDeleteError(null)
    setDeleteLoading(true)
    try {
      await deleteMyAccount(deletePassword)
      if (sessionToken) {
        await logoutSession(sessionToken).catch(() => undefined)
      }
      clearSession()
      navigate('/login', { replace: true })
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: { message?: string } } }; message?: string }
      setDeleteError(e?.response?.data?.error?.message ?? e?.message ?? 'Kunde inte radera kontot')
      setDeleteLoading(false)
    }
  }

  return (
    <div style={{ minHeight: '100vh', background: '#f9fafb', padding: '32px 16px' }}>
      <div style={{ maxWidth: 640, margin: '0 auto' }}>
        <Link
          to="/"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            fontSize: 13,
            fontWeight: 500,
            color: '#4b5563',
            textDecoration: 'none',
          }}
        >
          ← Tillbaka
        </Link>
        <h1
          style={{
            marginTop: 16,
            fontSize: 24,
            fontWeight: 600,
            letterSpacing: '-0.02em',
            color: '#111827',
          }}
        >
          Inställningar
        </h1>
        <p style={{ marginTop: 4, fontSize: 13, color: '#6b7280' }}>
          {tenant?.email ?? ''}
          {tenant?.firstName
            ? ` · ${tenant.firstName}`
            : tenant?.companyName
              ? ` · ${tenant.companyName}`
              : ''}
        </p>

        <div style={{ marginTop: 24, display: 'flex', flexDirection: 'column', gap: 20 }}>
          <section style={card}>
            <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: '#111827' }}>
              Dina rättigheter (GDPR)
            </h2>
            <p style={{ marginTop: 8, fontSize: 13, lineHeight: 1.5, color: '#6b7280' }}>
              Du har rätt att exportera och radera dina personuppgifter. Räkenskapsmaterial som
              måste sparas enligt Bokföringslagen (7 år) anonymiseras snarare än raderas.
            </p>

            <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                  padding: 14,
                  background: '#f9fafb',
                  border: '1px solid #f3f4f6',
                  borderRadius: 12,
                }}
              >
                <div>
                  <p style={{ margin: 0, fontSize: 13.5, fontWeight: 500, color: '#1f2937' }}>
                    Exportera mina uppgifter
                  </p>
                  <p style={{ margin: '2px 0 0', fontSize: 12.5, color: '#6b7280' }}>
                    JSON-fil med all data om ditt konto.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleExport}
                  disabled={exportLoading}
                  style={btnSecondary}
                >
                  {exportLoading ? 'Hämtar…' : 'Ladda ner'}
                </button>
              </div>

              <div
                style={{
                  padding: 14,
                  background: 'rgba(254, 226, 226, 0.4)',
                  border: '1px solid #fecaca',
                  borderRadius: 12,
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 12,
                  }}
                >
                  <div>
                    <p style={{ margin: 0, fontSize: 13.5, fontWeight: 500, color: '#1f2937' }}>
                      Radera mitt konto
                    </p>
                    <p style={{ margin: '2px 0 0', fontSize: 12.5, color: '#6b7280' }}>
                      Detta kan inte ångras. Sessioner avslutas och kontot anonymiseras omedelbart.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setConfirmDelete((v) => !v)}
                    disabled={confirmDelete}
                    style={btnSecondary}
                  >
                    Radera konto
                  </button>
                </div>

                {confirmDelete && (
                  <div
                    style={{
                      marginTop: 12,
                      paddingTop: 12,
                      borderTop: '1px solid #fecaca',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 8,
                    }}
                  >
                    <input
                      type="password"
                      placeholder="Bekräfta med ditt lösenord"
                      value={deletePassword}
                      onChange={(e) => setDeletePassword(e.target.value)}
                      style={{
                        height: 36,
                        padding: '0 12px',
                        border: '1px solid #d1d5db',
                        borderRadius: 8,
                        fontSize: 13.5,
                        outline: 'none',
                      }}
                    />
                    {deleteError && (
                      <p style={{ margin: 0, fontSize: 12, color: '#dc2626' }}>{deleteError}</p>
                    )}
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button
                        type="button"
                        onClick={() => {
                          setConfirmDelete(false)
                          setDeletePassword('')
                          setDeleteError(null)
                        }}
                        style={btnSecondary}
                      >
                        Avbryt
                      </button>
                      <button
                        type="button"
                        onClick={handleDelete}
                        disabled={deleteLoading || deletePassword.length === 0}
                        style={{
                          ...btnPrimary,
                          opacity: deleteLoading || !deletePassword ? 0.6 : 1,
                        }}
                      >
                        {deleteLoading ? 'Raderar…' : 'Bekräfta radering'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </section>

          <p style={{ textAlign: 'center', fontSize: 12, color: '#9ca3af' }}>
            <Link to="/integritet" style={{ color: 'inherit', textDecoration: 'none' }}>
              Integritetspolicy
            </Link>
          </p>
        </div>
      </div>
    </div>
  )
}
