import { LEGAL_DOCUMENT_UPDATED_AT, LEGAL_DOCUMENT_VERSIONS, PLATFORM_COMPANY } from '@eken/shared'
import { LegalPageShell, type TocItem } from './LegalPageShell'

const TOC: TocItem[] = [
  { id: 'sec-1', label: '1. Vad är en cookie?' },
  { id: 'sec-2', label: '2. Vilka cookies använder vi' },
  { id: 'sec-3', label: '3. Hantera cookies' },
  { id: 'sec-4', label: '4. Tredjepartsmottagare' },
  { id: 'sec-5', label: '5. Ändringar' },
  { id: 'sec-6', label: '6. Kontakt' },
]

export function CookiesPage() {
  return (
    <LegalPageShell
      title="Cookie-policy"
      description="Beskriver vilka cookies och liknande teknologier Eveno använder och hur du kan hantera dem."
      version={LEGAL_DOCUMENT_VERSIONS.cookies}
      updatedAt={LEGAL_DOCUMENT_UPDATED_AT.cookies}
      toc={TOC}
    >
      <p>
        {PLATFORM_COMPANY.legalName} använder cookies och liknande teknologier på{' '}
        {PLATFORM_COMPANY.domain}. Denna policy förklarar vad cookies är, vilka vi använder och hur
        du kan hantera dem. Policyn kompletterar vår{' '}
        <a href="/legal/integritet">Integritetspolicy</a>.
      </p>

      <h2 id="sec-1">1. Vad är en cookie?</h2>
      <p>
        En <strong>cookie</strong> är en liten textfil som sparas i din webbläsare när du besöker en
        webbplats. Vi använder också <strong>localStorage</strong> och{' '}
        <strong>sessionStorage</strong> som tekniskt sett inte är cookies men fyller samma funktion.
        Reglerna finns i 6 kap. 18 § lag (2003:389) om elektronisk kommunikation (LEK).
      </p>

      <h2 id="sec-2">2. Vilka cookies använder vi?</h2>

      <h3>2.1 Nödvändiga cookies (inget samtycke krävs)</h3>
      <table>
        <thead>
          <tr>
            <th>Namn</th>
            <th>Syfte</th>
            <th>Lagringstid</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <code>tenant-session</code>
            </td>
            <td>Håller dig inloggad i portalen</td>
            <td>7 dagar</td>
          </tr>
          <tr>
            <td>
              <code>__Host-csrf</code>
            </td>
            <td>CSRF-skydd</td>
            <td>Session</td>
          </tr>
          <tr>
            <td>
              <code>cookie-consent</code>
            </td>
            <td>Sparar ditt val i cookie-bannern</td>
            <td>12 månader</td>
          </tr>
        </tbody>
      </table>

      <h3>2.2 Funktionella cookies</h3>
      <table>
        <thead>
          <tr>
            <th>Namn</th>
            <th>Syfte</th>
            <th>Lagringstid</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <code>eveno-portal-prefs</code>
            </td>
            <td>Sparar dina visningsinställningar</td>
            <td>12 månader</td>
          </tr>
        </tbody>
      </table>

      <h3>2.3 Analys-cookies (samtycke krävs)</h3>
      <p>
        Vi använder Sentry för anonymiserad felspårning. Inga IP-adresser eller direkt
        identifierande uppgifter samlas in.
      </p>
      <table>
        <thead>
          <tr>
            <th>Namn</th>
            <th>Syfte</th>
            <th>Leverantör</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <code>sentry-trace</code>
            </td>
            <td>Felspårning</td>
            <td>Sentry (EU)</td>
          </tr>
        </tbody>
      </table>
      <p>
        Vi använder <strong>inga</strong> marknadsföringscookies eller tredjeparts-spårning.
      </p>

      <h2 id="sec-3">3. Hur hanterar du cookies?</h2>
      <p>
        Klicka på "Cookie-inställningar" i sidfoten för att ändra ditt val. Du kan också blockera
        cookies i webbläsarens inställningar — observera att portalen då slutar fungera.
      </p>

      <h2 id="sec-4">4. Tredjepartsmottagare</h2>
      <ul>
        <li>
          <strong>Sentry, Inc.</strong> (EU-region, Frankfurt) — felspårning
        </li>
        <li>
          <strong>Vercel Inc.</strong> (EU-region, Frankfurt) — hosting
        </li>
      </ul>

      <h2 id="sec-5">5. Ändringar av denna policy</h2>
      <p>
        Vid materiella ändringar uppdaterar vi denna sida och visar en notis i portalen.
        Versionsnummer och ikraftträdandedatum framgår överst.
      </p>

      <h2 id="sec-6">6. Kontakt</h2>
      <p>
        <strong>{PLATFORM_COMPANY.legalName}</strong>
        <br />
        E-post:{' '}
        <a href={`mailto:${PLATFORM_COMPANY.privacyEmail}`}>{PLATFORM_COMPANY.privacyEmail}</a>
        <br />
        Klagomål:{' '}
        <a href="https://www.imy.se" target="_blank" rel="noreferrer">
          Integritetsskyddsmyndigheten (IMY)
        </a>
      </p>
    </LegalPageShell>
  )
}
