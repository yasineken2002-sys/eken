import { Link } from 'react-router-dom'

export function PrivacyPage() {
  return (
    <div style={{ minHeight: '100vh', background: '#f9fafb', padding: '48px 16px' }}>
      <div style={{ maxWidth: 720, margin: '0 auto' }}>
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
            marginTop: 24,
            fontSize: 28,
            fontWeight: 600,
            letterSpacing: '-0.02em',
            color: '#111827',
          }}
        >
          Integritetspolicy
        </h1>
        <p style={{ marginTop: 8, fontSize: 13, color: '#6b7280' }}>
          Senast uppdaterad: 2026-05-03
        </p>

        <div style={{ marginTop: 32, fontSize: 14, lineHeight: 1.7, color: '#374151' }}>
          <h2 style={{ fontSize: 18, fontWeight: 600, color: '#111827', marginTop: 24 }}>
            1. Personuppgiftsansvarig
          </h2>
          <p>
            Din hyresvärd är personuppgiftsansvarig för dina hyresgästuppgifter. Eveno är
            personuppgiftsbiträde och behandlar uppgifterna på uppdrag av hyresvärden för att
            tillhandahålla portalen. För dina inloggningsuppgifter (e-post, lösenord) är Eveno
            personuppgiftsansvarig.
          </p>

          <h2 style={{ fontSize: 18, fontWeight: 600, color: '#111827', marginTop: 24 }}>
            2. Vilka uppgifter
          </h2>
          <ul style={{ marginTop: 8, paddingLeft: 24 }}>
            <li>Namn, e-post, telefon, eventuellt personnummer</li>
            <li>Hyreskontrakt, lägenhetsuppgifter, hyror och fakturor</li>
            <li>Felanmälningar du gör i portalen</li>
            <li>Tekniska loggar (inloggning, session)</li>
          </ul>

          <h2 style={{ fontSize: 18, fontWeight: 600, color: '#111827', marginTop: 24 }}>
            3. Cookies
          </h2>
          <p>
            Vi använder endast cookies som krävs för att hålla dig inloggad. Inga tredjepartscookies
            för marknadsföring eller spårning sätts.
          </p>

          <h2 style={{ fontSize: 18, fontWeight: 600, color: '#111827', marginTop: 24 }}>
            4. Dina rättigheter
          </h2>
          <ul style={{ marginTop: 8, paddingLeft: 24 }}>
            <li>
              <strong>Tillgång (Art. 15)</strong>: ladda ner all data om dig själv via
              Inställningar.
            </li>
            <li>
              <strong>Rättelse (Art. 16)</strong>: kontakta din hyresvärd för att ändra felaktiga
              uppgifter.
            </li>
            <li>
              <strong>Radering (Art. 17)</strong>: radera ditt portal-konto via Inställningar.
              Räkenskapsmaterial som måste sparas enligt Bokföringslagen anonymiseras.
            </li>
            <li>
              <strong>Klagomål</strong>: Integritetsskyddsmyndigheten (imy.se).
            </li>
          </ul>

          <h2 style={{ fontSize: 18, fontWeight: 600, color: '#111827', marginTop: 24 }}>
            5. Säkerhet
          </h2>
          <p>
            Lösenord lagras hashade med bcrypt. Sessionstokens lagras som SHA-256-hashar. All trafik
            krypteras med TLS.
          </p>
        </div>
      </div>
    </div>
  )
}
