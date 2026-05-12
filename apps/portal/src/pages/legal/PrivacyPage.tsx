import { CURRENT_PRIVACY_VERSION, LEGAL_DOCUMENT_UPDATED_AT, PLATFORM_COMPANY } from '@eken/shared'
import { LegalPageShell, type TocItem } from './LegalPageShell'

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
 * Integritetspolicy för hyresgästportalen. För hyresgäster är din
 * hyresvärd personuppgiftsansvarig för avtalsdata; Eveno är
 * personuppgiftsbiträde. För dina inloggningsuppgifter är Eveno
 * personuppgiftsansvarig.
 */
export function PrivacyPage() {
  return (
    <LegalPageShell
      title="Integritetspolicy"
      description="Beskriver hur Eveno behandlar personuppgifter enligt EU:s dataskyddsförordning (GDPR)."
      version={CURRENT_PRIVACY_VERSION}
      updatedAt={LEGAL_DOCUMENT_UPDATED_AT.privacy}
      toc={TOC}
    >
      <p>
        Denna integritetspolicy beskriver hur {PLATFORM_COMPANY.legalName} behandlar personuppgifter
        när du använder hyresgästportalen och hur dina rättigheter enligt GDPR fungerar.
      </p>

      <h2 id="sec-1">1. Personuppgiftsansvarig</h2>
      <p>
        <strong>{PLATFORM_COMPANY.legalName}</strong>, org.nr {PLATFORM_COMPANY.orgNumber}, är
        personuppgiftsansvarig för dina inloggningsuppgifter och teknisk loggdata i portalen.
      </p>
      <p>
        Din <strong>hyresvärd</strong> är personuppgiftsansvarig för dina hyresgästuppgifter (avtal,
        fakturor, kontaktuppgifter). Eveno är personuppgiftsbiträde och behandlar uppgifterna på
        uppdrag av hyresvärden.
      </p>

      <h2 id="sec-2">2. Vilka personuppgifter behandlar vi?</h2>
      <ul>
        <li>Kontaktuppgifter: namn, e-post, telefon, eventuellt personnummer</li>
        <li>Företagsuppgifter (för företagshyresgäster): orgnummer, adress</li>
        <li>Avtalsdata: hyreskontrakt, lägenhets-/lokaluppgifter, hyror, fakturor</li>
        <li>Felanmälningar och meddelanden du skickar via portalen</li>
        <li>Inloggningsdata: krypterat lösenord, sessionstokens, IP-adress</li>
        <li>Tekniska loggar och webbläsarinformation</li>
      </ul>

      <h2 id="sec-3">3. Hur använder vi uppgifterna?</h2>
      <ul>
        <li>Tillhandahålla portalen och hålla dig inloggad</li>
        <li>Visa dina avtal, fakturor och felanmälningar</li>
        <li>Skicka aviseringar och påminnelser via e-post</li>
        <li>Förhindra brute-force och upptäcka säkerhetsincidenter</li>
        <li>Felsöka tekniska problem (anonymiserad data via Sentry)</li>
      </ul>

      <h2 id="sec-4">4. Rättslig grund</h2>
      <p>Behandlingen sker med stöd av:</p>
      <ul>
        <li>
          <strong>Fullgörande av avtal</strong> (art. 6.1.b GDPR) — tillhandahålla portalen som en
          del av hyreskontraktet med din hyresvärd
        </li>
        <li>
          <strong>Rättslig förpliktelse</strong> (art. 6.1.c) — bokföringslagen
        </li>
        <li>
          <strong>Berättigat intresse</strong> (art. 6.1.f) — säkerhet och felsökning
        </li>
      </ul>

      <h2 id="sec-5">5. Mottagare av personuppgifter</h2>
      <ul>
        <li>
          <strong>Din hyresvärd</strong> — ser samtliga uppgifter du registrerar
        </li>
        <li>
          <strong>Vercel / Railway</strong> — hosting i EU-regionen
        </li>
        <li>
          <strong>Resend</strong> — transaktionella mejl
        </li>
        <li>
          <strong>Anthropic (USA, DPF-certifierad)</strong> — AI-assistent
        </li>
        <li>
          <strong>Sentry (EU-region)</strong> — anonymiserad felspårning
        </li>
      </ul>
      <p>Samtliga är bundna av personuppgiftsbiträdesavtal enligt artikel 28 GDPR.</p>

      <h2 id="sec-6">6. Internationell överföring</h2>
      <p>
        Vissa underleverantörer är etablerade i USA. Överföringar sker med EU-Kommissionens
        standardklausuler (SCC) eller EU-US Data Privacy Framework (DPF). All data är krypterad med
        TLS i transit och AES-256 i vila.
      </p>

      <h2 id="sec-7">7. Lagringstid</h2>
      <ul>
        <li>Aktivt portal-konto: under tiden hyresförhållandet pågår</li>
        <li>Inloggningsloggar: 90 dagar</li>
        <li>Fakturor och bokföring: 7 år (bokföringslagen 7 kap. 2 §)</li>
        <li>Avslutade konton: 90 dagar för återställning, sedan radering</li>
      </ul>

      <h2 id="sec-8">8. Dina rättigheter enligt GDPR</h2>
      <ul>
        <li>
          <strong>Tillgång (art. 15):</strong> ladda ner all data om dig själv via Inställningar
        </li>
        <li>
          <strong>Rättelse (art. 16):</strong> kontakta din hyresvärd för att ändra felaktiga
          uppgifter
        </li>
        <li>
          <strong>Radering (art. 17):</strong> radera ditt portal-konto via Inställningar.
          Räkenskapsmaterial som måste sparas enligt Bokföringslagen anonymiseras.
        </li>
        <li>
          <strong>Begränsning (art. 18):</strong> begär att behandlingen begränsas medan en
          invändning utreds
        </li>
        <li>
          <strong>Dataportabilitet (art. 20):</strong> få ut dina uppgifter i JSON/CSV
        </li>
        <li>
          <strong>Invändning (art. 21):</strong> mot berättigat-intresse-behandling
        </li>
      </ul>
      <p>
        Skicka förfrågan till{' '}
        <a href={`mailto:${PLATFORM_COMPANY.privacyEmail}`}>{PLATFORM_COMPANY.privacyEmail}</a>. Vi
        svarar inom en månad.
      </p>

      <h2 id="sec-9">9. Säkerhetsåtgärder</h2>
      <ul>
        <li>TLS 1.3 i transit, AES-256 i vila</li>
        <li>Lösenord lagras hashade med bcrypt (12 salt rounds)</li>
        <li>Sessionstokens lagras som SHA-256-hashar</li>
        <li>Konton låses i 15 min efter 10 misslyckade inloggningsförsök</li>
        <li>Daglig säkerhetskopiering med 30 dagars retention</li>
      </ul>

      <h2 id="sec-10">10. Cookies</h2>
      <p>
        Vi använder endast cookies som krävs för att hålla dig inloggad samt anonymiserad
        felspårning via Sentry. Inga marknadsföringscookies. Mer information i{' '}
        <a href="/legal/cookies">Cookie-policyn</a>.
      </p>

      <h2 id="sec-11">11. Klagomål till IMY</h2>
      <p>
        Vid klagomål kan du kontakta{' '}
        <a href="https://www.imy.se" target="_blank" rel="noreferrer">
          Integritetsskyddsmyndigheten (IMY)
        </a>{' '}
        — Box 8114, 104 20 Stockholm, telefon 08-657 61 00, e-post imy@imy.se.
      </p>
      <p>Vi uppskattar dock om du kontaktar oss först på {PLATFORM_COMPANY.privacyEmail}.</p>

      <h2 id="sec-12">12. Kontaktuppgifter</h2>
      <p>
        <strong>{PLATFORM_COMPANY.legalName}</strong>
        <br />
        {PLATFORM_COMPANY.street}, {PLATFORM_COMPANY.postalCode} {PLATFORM_COMPANY.city}
        <br />
        Dataskydd:{' '}
        <a href={`mailto:${PLATFORM_COMPANY.privacyEmail}`}>{PLATFORM_COMPANY.privacyEmail}</a>
      </p>
    </LegalPageShell>
  )
}
