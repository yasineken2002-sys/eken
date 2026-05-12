import { LegalPageShell, type TocItem } from './LegalPageShell'
import { LEGAL_DOCUMENT_UPDATED_AT, LEGAL_DOCUMENT_VERSIONS, PLATFORM_COMPANY } from '@eken/shared'

interface Props {
  onBack: () => void
}

const TOC: TocItem[] = [
  { id: 'sec-1', label: '1. Vad är en cookie?' },
  { id: 'sec-2', label: '2. Vilka cookies använder vi' },
  { id: 'sec-3', label: '3. Hantera cookies' },
  { id: 'sec-4', label: '4. Tredjepartsmottagare' },
  { id: 'sec-5', label: '5. Ändringar' },
  { id: 'sec-6', label: '6. Kontakt' },
]

/**
 * Cookie-policy. Krav följer 6 kap. 18 § lag (2003:389) om elektronisk
 * kommunikation (LEK): samtycke krävs för cookies som inte är absolut
 * nödvändiga för en uttryckligen begärd tjänst.
 */
export function CookiesPage({ onBack }: Props) {
  return (
    <LegalPageShell
      title="Cookie-policy"
      description="Beskriver vilka cookies och liknande teknologier Eveno använder, vad de gör och hur du kan hantera dem."
      version={LEGAL_DOCUMENT_VERSIONS.cookies}
      updatedAt={LEGAL_DOCUMENT_UPDATED_AT.cookies}
      toc={TOC}
      onBack={onBack}
    >
      <p>
        {PLATFORM_COMPANY.legalName} använder cookies och liknande teknologier på{' '}
        {PLATFORM_COMPANY.domain}. Denna policy förklarar vad cookies är, vilka cookies vi använder
        och hur du kan hantera dem. Policyn kompletterar vår{' '}
        <a href="/legal/integritet" className="text-blue-600 hover:underline">
          Integritetspolicy
        </a>
        .
      </p>

      <h2 id="sec-1">1. Vad är en cookie?</h2>
      <p>
        En <strong>cookie</strong> är en liten textfil som sparas i din webbläsare när du besöker en
        webbplats. Cookien innehåller information som webbplatsen kan läsa vid senare besök —
        typiskt för att hålla dig inloggad, komma ihåg dina inställningar eller mäta hur webbplatsen
        används.
      </p>
      <p>
        Vi använder också <strong>localStorage</strong> och <strong>sessionStorage</strong> som
        tekniskt sett inte är cookies men fyller samma funktion. I denna policy avses samtliga
        sådana lagringstekniker när vi skriver "cookies".
      </p>
      <p>
        Reglerna om cookies finns i 6 kap. 18 § lag (2003:389) om elektronisk kommunikation (LEK).
        Lagen kräver samtycke för cookies som inte är absolut nödvändiga för att tillhandahålla en
        tjänst som du uttryckligen begärt.
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
              <code>eken-auth</code>
            </td>
            <td>Sparar JWT-access och refresh-token för att hålla dig inloggad</td>
            <td>30 dagar</td>
          </tr>
          <tr>
            <td>
              <code>__Host-csrf</code>
            </td>
            <td>CSRF-skydd på känsliga endpoints</td>
            <td>Session</td>
          </tr>
          <tr>
            <td>
              <code>tenant-session</code>
            </td>
            <td>Hyresgästportalens session-token</td>
            <td>7 dagar</td>
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

      <h3>2.2 Funktionella cookies (samtycke krävs)</h3>
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
              <code>eveno-theme</code>
            </td>
            <td>Sparar ditt val av tema (ljust/mörkt)</td>
            <td>12 månader</td>
          </tr>
          <tr>
            <td>
              <code>eveno-sidebar-collapsed</code>
            </td>
            <td>Sparar om sidomenyn ska vara minimerad</td>
            <td>12 månader</td>
          </tr>
          <tr>
            <td>
              <code>eveno-table-prefs-*</code>
            </td>
            <td>Sparar kolumninställningar och filter i tabeller</td>
            <td>12 månader</td>
          </tr>
        </tbody>
      </table>

      <h3>2.3 Analys-cookies (samtycke krävs)</h3>
      <p>
        Vi använder Sentry för att spåra fel och prestandaproblem. Sentry samlar inte in IP-adresser
        eller andra direkt identifierande uppgifter — endast anonymiserade stack-traces och tekniska
        metadata.
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
            <td>Spårar request-händelser för felspårning</td>
            <td>Sentry (EU)</td>
          </tr>
          <tr>
            <td>
              <code>sentry-session-id</code>
            </td>
            <td>Anonym sessions-ID för att gruppera fel</td>
            <td>Sentry (EU)</td>
          </tr>
        </tbody>
      </table>
      <p>
        Vi använder <strong>inga</strong> marknadsföringscookies eller tredjeparts-spårning för
        annonsering (Google Analytics, Facebook Pixel m.fl.).
      </p>

      <h2 id="sec-3">3. Hur hanterar du cookies?</h2>
      <h3>3.1 Via cookie-bannern</h3>
      <p>
        Första gången du besöker Tjänsten visas en cookie-banner där du kan välja mellan "Acceptera
        alla", "Bara nödvändiga" eller "Anpassa". Ditt val sparas i <code>cookie-consent</code> och
        du kan när som helst ändra det via "Cookie-inställningar" i sidfoten.
      </p>
      <h3>3.2 Via webbläsaren</h3>
      <p>Du kan blockera eller radera cookies i webbläsarens inställningar:</p>
      <ul>
        <li>
          <strong>Chrome:</strong> Inställningar → Sekretess och säkerhet → Cookies
        </li>
        <li>
          <strong>Safari:</strong> Inställningar → Sekretess
        </li>
        <li>
          <strong>Firefox:</strong> Inställningar → Sekretess och säkerhet
        </li>
        <li>
          <strong>Edge:</strong> Inställningar → Cookies och webbplatsbehörigheter
        </li>
      </ul>
      <p>
        Om du blockerar nödvändiga cookies kommer du inte kunna logga in eller använda Tjänsten.
      </p>

      <h2 id="sec-4">4. Tredjepartsmottagare</h2>
      <p>
        Vi delar cookie-data med följande tredje parter, samtliga reglerade genom
        personuppgiftsbiträdesavtal:
      </p>
      <ul>
        <li>
          <strong>Sentry, Inc.</strong> (EU-region, Frankfurt) — felspårning
        </li>
        <li>
          <strong>Vercel Inc.</strong> (EU-region, Frankfurt) — hosting och edge-cache
        </li>
      </ul>

      <h2 id="sec-5">5. Ändringar av denna policy</h2>
      <p>
        Om vi börjar använda nya cookies eller ändrar syftet med befintliga cookies uppdaterar vi
        denna policy och visar en notis i Tjänsten. Versionsnummer och ikraftträdandedatum framgår
        överst på sidan.
      </p>

      <h2 id="sec-6">6. Kontakt</h2>
      <p>
        <strong>{PLATFORM_COMPANY.legalName}</strong>
        <br />
        {PLATFORM_COMPANY.street}, {PLATFORM_COMPANY.postalCode} {PLATFORM_COMPANY.city}
        <br />
        E-post:{' '}
        <a href={`mailto:${PLATFORM_COMPANY.privacyEmail}`}>{PLATFORM_COMPANY.privacyEmail}</a>
      </p>
      <p>
        Du har också rätt att lämna in ett klagomål till{' '}
        <a href="https://www.imy.se" target="_blank" rel="noreferrer">
          Integritetsskyddsmyndigheten (IMY)
        </a>
        .
      </p>
    </LegalPageShell>
  )
}
