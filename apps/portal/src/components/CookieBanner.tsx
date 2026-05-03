import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'

const STORAGE_KEY = 'eveno-portal-cookies-consent'

export function CookieBanner() {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const consent = localStorage.getItem(STORAGE_KEY)
    if (!consent) setVisible(true)
  }, [])

  const accept = (value: 'accepted' | 'necessary-only') => {
    localStorage.setItem(STORAGE_KEY, value)
    localStorage.setItem(`${STORAGE_KEY}-at`, new Date().toISOString())
    setVisible(false)
  }

  if (!visible) return null

  return (
    <div
      role="dialog"
      aria-label="Cookies"
      style={{
        position: 'fixed',
        bottom: 16,
        left: 16,
        right: 16,
        maxWidth: 640,
        margin: '0 auto',
        padding: 20,
        background: '#fff',
        border: '1px solid #e5e7eb',
        borderRadius: 16,
        boxShadow: '0 12px 32px rgba(0,0,0,0.12)',
        zIndex: 50,
      }}
    >
      <p style={{ margin: 0, fontSize: 14, fontWeight: 600, color: '#111827' }}>
        Vi värnar om din integritet
      </p>
      <p style={{ margin: '6px 0 0', fontSize: 13, lineHeight: 1.5, color: '#4b5563' }}>
        Eveno använder cookies som krävs för inloggning och säkerhet. Inga tredjepartscookies för
        marknadsföring eller spårning sätts.{' '}
        <Link to="/integritet" style={{ color: '#2563eb', fontWeight: 500 }}>
          Läs vår integritetspolicy
        </Link>
        .
      </p>
      <div style={{ marginTop: 16, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={() => accept('accepted')}
          style={{
            height: 36,
            padding: '0 16px',
            background: '#2563eb',
            color: '#fff',
            border: 'none',
            borderRadius: 8,
            fontSize: 13.5,
            fontWeight: 500,
            cursor: 'pointer',
          }}
        >
          Godkänn
        </button>
        <button
          type="button"
          onClick={() => accept('necessary-only')}
          style={{
            height: 36,
            padding: '0 16px',
            background: '#fff',
            color: '#374151',
            border: '1px solid #d1d5db',
            borderRadius: 8,
            fontSize: 13.5,
            fontWeight: 500,
            cursor: 'pointer',
          }}
        >
          Endast nödvändiga
        </button>
      </div>
    </div>
  )
}
