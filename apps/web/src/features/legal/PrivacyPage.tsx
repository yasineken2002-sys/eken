import { LegalPageShell, type TocItem } from './LegalPageShell'
import { CURRENT_PRIVACY_VERSION, LEGAL_DOCUMENT_UPDATED_AT, PLATFORM_COMPANY } from '@eken/shared'

interface Props {
  onBack: () => void
}

const TOC: TocItem[] = [
  { id: 'sec-1', label: '1. Personuppgiftsansvarig' },
  { id: 'sec-2', label: '2. Vilka uppgifter' },
  { id: 'sec-3', label: '3. Användning' },
  { id: 'sec-4', label: '4. Rättslig grund' },
  { id: 'sec-5', label: '5. Mottagare' },
  { id: 'sec-6', label: '6. Internationell överföring' },
  { id: 'sec-7', label: '7. Lagringstid' },
  { id: 'sec-8', label: '8. Dina rättigheter' },
  { id: 'sec-9', label: '9. Säkerhet' },
  { id: 'sec-10', label: '10. Cookies' },
  { id: 'sec-11', label: '11. Klagomål till IMY' },
  { id: 'sec-12', label: '12. Kontakt' },
]

/**
 * Integritetspolicy. Strukturen följer GDPR art. 13–14 (informationsplikt)
 * och kompletteras med kategoriserad redovisning av lagringstid, mottagare
 * och rättslig grund. Innehållet motsvarar docs/legal/privacy-policy.md.
 */
export function PrivacyPage({ onBack }: Props) {
  return (
    <LegalPageShell
      title="Integritetspolicy"
      description="Beskriver hur Eveno behandlar personuppgifter enligt EU:s dataskyddsförordning (GDPR) och kompletterande svensk lagstiftning."
      version={CURRENT_PRIVACY_VERSION}
      updatedAt={LEGAL_DOCUMENT_UPDATED_AT.privacy}
      toc={TOC}
      onBack={onBack}
    >
      <p>
        Denna integritetspolicy beskriver hur {PLATFORM_COMPANY.legalName} ("vi", "oss", "Eveno")
        behandlar personuppgifter när du använder vår fastighetsförvaltningstjänst. Policyn är
        utformad för att uppfylla kraven i EU:s dataskyddsförordning (GDPR), kompletterande svensk
        dataskyddslagstiftning och Integritetsskyddsmyndighetens (IMY) vägledningar.
      </p>

      <h2 id="sec-1">1. Personuppgiftsansvarig</h2>
      <p>
        <strong>{PLATFORM_COMPANY.legalName}</strong>, org.nr {PLATFORM_COMPANY.orgNumber}, är
        personuppgiftsansvarig för dina kontouppgifter, besöksdata på {PLATFORM_COMPANY.domain} och
        loggdata som genereras vid din användning av Tjänsten.
      </p>
      <p>
        För personuppgifter om Hyresgäster och övriga personer som Kunden lägger in i Tjänsten är{' '}
        <strong>Kunden</strong> (typiskt fastighetsägaren eller förvaltningsbolaget)
        personuppgiftsansvarig och Eveno endast personuppgiftsbiträde. Den behandlingen regleras i
        Personuppgiftsbiträdesavtalet (DPA) som ingår som en del av användarvillkoren.
      </p>

      <h2 id="sec-2">2. Vilka personuppgifter behandlar vi?</h2>
      <h3>2.1 Kontaktuppgifter</h3>
      <ul>
        <li>För- och efternamn</li>
        <li>E-postadress</li>
        <li>Telefonnummer (frivilligt)</li>
        <li>Roll i organisationen (OWNER, ADMIN, MANAGER, ACCOUNTANT, VIEWER)</li>
      </ul>
      <h3>2.2 Företagsuppgifter</h3>
      <ul>
        <li>Organisationsnamn, organisationsnummer, företagsform</li>
        <li>Adressuppgifter</li>
        <li>F-skatte- och momsregistreringsstatus</li>
        <li>Bankgiro</li>
      </ul>
      <h3>2.3 Inloggnings- och säkerhetsdata</h3>
      <ul>
        <li>Krypterat lösenord (bcrypt, 12 salt rounds — vi ser aldrig klartext)</li>
        <li>Tidpunkt för senaste inloggning</li>
        <li>IP-adress vid inloggning och säkerhetshändelser</li>
        <li>Webbläsare och operativsystem (User-Agent)</li>
        <li>Misslyckade inloggningsförsök och kontolåsningar</li>
      </ul>
      <h3>2.4 Innehåll du skapar</h3>
      <ul>
        <li>Fastighets-, lägenhets- och hyresgästdata</li>
        <li>Hyresavtal, fakturor, journalposter, bankavstämningar</li>
        <li>Uppladdade dokument (PDF, bilder)</li>
        <li>Meddelanden och kommentarer</li>
      </ul>
      <h3>2.5 AI-konversationer</h3>
      <ul>
        <li>Promptar och svar i AI-assistenten</li>
        <li>Verktygsanrop som AI:n utför å dina vägnar</li>
        <li>Tokenförbrukning per organisation och användare</li>
      </ul>
      <h3>2.6 Användnings- och loggdata</h3>
      <ul>
        <li>Klick, sidvisningar och funktionsanvändning (för produktförbättring)</li>
        <li>Felmeddelanden och stack-traces (Sentry — anonymiserade)</li>
        <li>Tidsstämplar för säkerhetshändelser</li>
      </ul>

      <h2 id="sec-3">3. Hur använder vi uppgifterna?</h2>
      <ul>
        <li>
          <strong>Tillhandahålla Tjänsten</strong> — skapa konto, autentisera, lagra och visa data
        </li>
        <li>
          <strong>Fakturering</strong> — räkna AI-anrop, skapa månadsfakturor
        </li>
        <li>
          <strong>Support</strong> — besvara frågor och felsöka
        </li>
        <li>
          <strong>Produktförbättring</strong> — anonymiserad användningsstatistik
        </li>
        <li>
          <strong>Säkerhet</strong> — förhindra brute-force, upptäcka intrång
        </li>
        <li>
          <strong>Bokföring</strong> — spara fakturaunderlag enligt bokföringslagen
        </li>
      </ul>

      <h2 id="sec-4">4. Rättslig grund</h2>
      <table>
        <thead>
          <tr>
            <th>Ändamål</th>
            <th>Rättslig grund (GDPR art. 6)</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Tillhandahålla Tjänsten</td>
            <td>Fullgörande av avtal (art. 6.1.b)</td>
          </tr>
          <tr>
            <td>Fakturering</td>
            <td>Fullgörande av avtal (art. 6.1.b)</td>
          </tr>
          <tr>
            <td>Bokföring</td>
            <td>Rättslig förpliktelse (art. 6.1.c)</td>
          </tr>
          <tr>
            <td>Support, säkerhet, produktförbättring</td>
            <td>Berättigat intresse (art. 6.1.f)</td>
          </tr>
          <tr>
            <td>Marknadsföring till prospekt</td>
            <td>Samtycke (art. 6.1.a)</td>
          </tr>
        </tbody>
      </table>

      <h2 id="sec-5">5. Mottagare av personuppgifter</h2>
      <h3>5.1 Underleverantörer (personuppgiftsbiträden)</h3>
      <ul>
        <li>
          <strong>Vercel Inc.</strong> — hosting av webb-frontend (EU/USA, Frankfurt-region)
        </li>
        <li>
          <strong>Railway / Render</strong> — hosting av API och databas (EU, Amsterdam-region)
        </li>
        <li>
          <strong>Anthropic, PBC</strong> — AI-modeller (USA, DPF-certifierad)
        </li>
        <li>
          <strong>Resend, Inc.</strong> — transaktionella mejl (EU/USA)
        </li>
        <li>
          <strong>Stripe Payments Europe Ltd.</strong> — kortbetalning av abonnemang (Irland)
        </li>
        <li>
          <strong>Sentry, Inc.</strong> — felspårning (EU-region, Frankfurt)
        </li>
        <li>
          <strong>Google Cloud Storage</strong> — säkerhetskopiering (EU)
        </li>
      </ul>
      <p>
        Samtliga underleverantörer är bundna av personuppgiftsbiträdesavtal enligt artikel 28 GDPR.
      </p>
      <h3>5.2 Myndigheter</h3>
      <p>
        Personuppgifter lämnas ut till myndigheter (Skatteverket, Polisen, Kronofogden m.fl.) endast
        när vi är skyldiga enligt lag eller efter rättsligt bindande beslut.
      </p>

      <h2 id="sec-6">6. Internationell överföring</h2>
      <p>
        Vissa underleverantörer är etablerade i USA. Överföringar till tredjeland sker med någon av
        följande skyddsåtgärder:
      </p>
      <ul>
        <li>EU-Kommissionens standardklausuler (SCC)</li>
        <li>EU-US Data Privacy Framework (DPF) för certifierade amerikanska leverantörer</li>
        <li>Tekniska tilläggsåtgärder — TLS i transit och AES-256 i vila</li>
      </ul>
      <p>
        Vid AI-anrop till Anthropic skickas endast den prompt som är nödvändig för att besvara
        frågan. Anthropic är avtalsmässigt förbjudet att använda data för modellträning.
      </p>

      <h2 id="sec-7">7. Lagringstid</h2>
      <table>
        <thead>
          <tr>
            <th>Datatyp</th>
            <th>Lagringstid</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Aktiva kontouppgifter</td>
            <td>Under avtalstiden</td>
          </tr>
          <tr>
            <td>Avslutade konton</td>
            <td>90 dagar efter uppsägning, sedan radering</td>
          </tr>
          <tr>
            <td>Fakturaunderlag och bokföring</td>
            <td>7 år (bokföringslagen 7 kap. 2 §)</td>
          </tr>
          <tr>
            <td>Inloggningsloggar</td>
            <td>90 dagar</td>
          </tr>
          <tr>
            <td>AI-konversationer</td>
            <td>24 månader</td>
          </tr>
          <tr>
            <td>Supportärenden</td>
            <td>36 månader efter senaste kontakt</td>
          </tr>
        </tbody>
      </table>

      <h2 id="sec-8">8. Dina rättigheter enligt GDPR</h2>
      <ul>
        <li>
          <strong>Rätt till information</strong> (art. 13–14) — denna policy
        </li>
        <li>
          <strong>Rätt till tillgång</strong> (art. 15) — registerutdrag på begäran
        </li>
        <li>
          <strong>Rätt till rättelse</strong> (art. 16) — felaktiga uppgifter rättas
        </li>
        <li>
          <strong>Rätt till radering</strong> (art. 17) — "rätten att bli glömd"
        </li>
        <li>
          <strong>Rätt till begränsning</strong> (art. 18)
        </li>
        <li>
          <strong>Rätt till dataportabilitet</strong> (art. 20) — exportera data i JSON/CSV
        </li>
        <li>
          <strong>Rätt att invända</strong> (art. 21) — mot berättigat-intresse-behandling
        </li>
        <li>
          <strong>Rätt att återkalla samtycke</strong>
        </li>
      </ul>
      <p>
        Skicka förfrågan till{' '}
        <a href={`mailto:${PLATFORM_COMPANY.privacyEmail}`}>{PLATFORM_COMPANY.privacyEmail}</a>. Vi
        besvarar inom en månad utan kostnad.
      </p>

      <h2 id="sec-9">9. Säkerhetsåtgärder</h2>
      <ul>
        <li>
          <strong>Kryptering i transit:</strong> All trafik krypteras med TLS 1.3
        </li>
        <li>
          <strong>Kryptering i vila:</strong> Databaser och säkerhetskopior med AES-256
        </li>
        <li>
          <strong>Lösenord:</strong> bcrypt, 12 salt rounds
        </li>
        <li>
          <strong>Brute-force-skydd:</strong> Konton låses i 15 min efter 10 misslyckade försök
        </li>
        <li>
          <strong>Åtkomstkontroll:</strong> RBAC och multi-tenant-isolation
        </li>
        <li>
          <strong>Loggning:</strong> Säkerhetshändelser och åtkomst loggas
        </li>
        <li>
          <strong>Backup:</strong> Daglig säkerhetskopiering, 30 dagars retention, geografiskt
          separerade kopior
        </li>
        <li>
          <strong>Incidenthantering:</strong> Rutin för rapportering till IMY inom 72 h
        </li>
      </ul>

      <h2 id="sec-10">10. Cookies</h2>
      <p>
        Vi använder cookies för autentisering, sessionshantering och anonymiserad felspårning via
        Sentry. Inga marknadsföringscookies eller tredjepartsspårning för annonsering. Detaljerad
        information finns i vår{' '}
        <a href="/legal/cookies" className="text-blue-600 hover:underline">
          Cookie-policy
        </a>
        .
      </p>

      <h2 id="sec-11">11. Klagomål till IMY</h2>
      <p>
        Om du anser att vi behandlar dina personuppgifter i strid med GDPR har du rätt att lämna in
        klagomål till tillsynsmyndigheten:
      </p>
      <p>
        <strong>Integritetsskyddsmyndigheten (IMY)</strong>
        <br />
        Box 8114, 104 20 Stockholm
        <br />
        Telefon: 08-657 61 00
        <br />
        E-post: imy@imy.se
        <br />
        Webb:{' '}
        <a href="https://www.imy.se" target="_blank" rel="noreferrer">
          imy.se
        </a>
      </p>
      <p>
        Vi uppskattar dock om du kontaktar oss först på {PLATFORM_COMPANY.privacyEmail} så att vi
        får möjlighet att rätta till eventuella brister.
      </p>

      <h2 id="sec-12">12. Kontaktuppgifter</h2>
      <p>
        <strong>{PLATFORM_COMPANY.legalName}</strong>
        <br />
        {PLATFORM_COMPANY.street}, {PLATFORM_COMPANY.postalCode} {PLATFORM_COMPANY.city}
      </p>
      <ul>
        <li>
          Dataskydd:{' '}
          <a href={`mailto:${PLATFORM_COMPANY.privacyEmail}`}>{PLATFORM_COMPANY.privacyEmail}</a>
        </li>
        <li>
          Allmänna frågor: <a href={`mailto:${PLATFORM_COMPANY.email}`}>{PLATFORM_COMPANY.email}</a>
        </li>
        <li>
          Support:{' '}
          <a href={`mailto:${PLATFORM_COMPANY.supportEmail}`}>{PLATFORM_COMPANY.supportEmail}</a>
        </li>
      </ul>
      <p>
        Vår dataskyddsfunktion nås på {PLATFORM_COMPANY.privacyEmail} och leds av CTO som ansvarar
        för efterlevnad av dataskyddslagstiftningen.
      </p>
    </LegalPageShell>
  )
}
