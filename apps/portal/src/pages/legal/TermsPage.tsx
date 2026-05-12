import { CURRENT_TERMS_VERSION, LEGAL_DOCUMENT_UPDATED_AT, PLATFORM_COMPANY } from '@eken/shared'
import { LegalPageShell, type TocItem } from './LegalPageShell'

const TOC: TocItem[] = [
  { id: 'sec-1', label: '1. Introduktion' },
  { id: 'sec-2', label: '2. Definitioner' },
  { id: 'sec-3', label: '3. Tjänstens omfattning' },
  { id: 'sec-4', label: '4. Användarens skyldigheter' },
  { id: 'sec-5', label: '5. Evenos skyldigheter' },
  { id: 'sec-6', label: '6. Betalning' },
  { id: 'sec-7', label: '7. Trial-period' },
  { id: 'sec-8', label: '8. Uppsägning' },
  { id: 'sec-9', label: '9. Ansvarsbegränsning' },
  { id: 'sec-10', label: '10. Datasäkerhet' },
  { id: 'sec-11', label: '11. Immateriella rättigheter' },
  { id: 'sec-12', label: '12. Sekretess' },
  { id: 'sec-13', label: '13. Ändringar' },
  { id: 'sec-14', label: '14. Tvist & lag' },
  { id: 'sec-15', label: '15. Kontakt' },
]

export function TermsPage() {
  return (
    <LegalPageShell
      title="Användarvillkor"
      description={`Reglerar din användning av ${PLATFORM_COMPANY.brandName}. Genom att skapa ett konto godkänner du dessa villkor.`}
      version={CURRENT_TERMS_VERSION}
      updatedAt={LEGAL_DOCUMENT_UPDATED_AT.terms}
      toc={TOC}
    >
      <p>
        Dessa användarvillkor ("<strong>Villkoren</strong>") reglerar din användning av{' '}
        {PLATFORM_COMPANY.brandName}, ett molnbaserat fastighetssystem som tillhandahålls av{' '}
        {PLATFORM_COMPANY.legalName}. Genom att skapa ett konto eller använda Tjänsten accepterar du
        dessa Villkor.
      </p>

      <h2 id="sec-1">1. Introduktion och godkännande</h2>
      <p>
        {PLATFORM_COMPANY.legalName}, org.nr {PLATFORM_COMPANY.orgNumber}, med säte på{' '}
        {PLATFORM_COMPANY.street}, {PLATFORM_COMPANY.postalCode} {PLATFORM_COMPANY.city},
        tillhandahåller en webbaserad programvarutjänst för förvaltning av fastigheter. Genom att
        registrera ett konto och bocka i acceptansrutan ingår du ett juridiskt bindande avtal med
        Eveno.
      </p>

      <h2 id="sec-2">2. Definitioner</h2>
      <ul>
        <li>
          <strong>"Tjänsten"</strong> — Eveno-plattformen, inklusive webbgränssnitt, API:er,
          hyresgästportal och dokumentation.
        </li>
        <li>
          <strong>"Kund"</strong> — den juridiska eller fysiska person som ingått avtal med Eveno.
        </li>
        <li>
          <strong>"Användare"</strong> — fysisk person som getts inloggning till Kundens konto.
        </li>
        <li>
          <strong>"Hyresgäst"</strong> — person som hyr av Kunden och vars uppgifter finns i
          Tjänsten.
        </li>
        <li>
          <strong>"Kunddata"</strong> — all data Kunden matar in eller genererar i Tjänsten.
        </li>
      </ul>

      <h2 id="sec-3">3. Tjänstens omfattning</h2>
      <p>
        Tjänsten omfattar register över fastigheter, hyresavtal, fakturering, bokföring
        (BAS-kontoplanen), hyresgästportal, AI-assistent samt rapporter och exporter. Eveno
        utvecklar Tjänsten kontinuerligt — nya funktioner kan tillkomma och befintliga kan ändras så
        länge kärnfunktionerna inte väsentligt försämras.
      </p>

      <h2 id="sec-4">4. Användarens skyldigheter</h2>
      <p>
        Kunden ansvarar för att alla uppgifter är korrekta och lagligen behandlas. Kunden får inte
        använda Tjänsten i strid med lag, försöka kringgå skyddsåtgärder eller återförsälja Tjänsten
        utan godkännande.
      </p>

      <h2 id="sec-5">5. Evenos skyldigheter</h2>
      <ul>
        <li>Tillhandahålla Tjänsten enligt Villkoren</li>
        <li>Upptid minst 99,5% per månad, exkl. planerat underhåll</li>
        <li>Daglig säkerhetskopiering av Kunddata</li>
        <li>Underrättelse om incidenter inom 72 timmar (GDPR)</li>
        <li>Branschstandard för kryptering (TLS, AES-256)</li>
        <li>
          Support via {PLATFORM_COMPANY.supportEmail}, helgfri vardag 09:00–17:00, typisk svarstid
          &lt; 24 h
        </li>
      </ul>

      <h2 id="sec-6">6. Betalning och fakturering</h2>
      <ul>
        <li>
          <strong>Faktureringscykel:</strong> Månadsvis i förskott
        </li>
        <li>
          <strong>Betalningsvillkor:</strong> 30 dagar netto från fakturadatum
        </li>
        <li>
          <strong>Dröjsmålsränta:</strong> Referensräntan + 8 procentenheter (6 § räntelagen)
        </li>
        <li>
          <strong>Påminnelseavgift:</strong> 60 kr enligt lag (1981:739)
        </li>
      </ul>
      <p>
        <strong>Eskalering vid utebliven betalning:</strong>
      </p>
      <ul>
        <li>Dag 14 efter förfallodag: Påminnelse skickas</li>
        <li>Dag 30: Tjänsten pausas (läsläge)</li>
        <li>Dag 60: Avstängning och inkasso</li>
      </ul>
      <p>
        Eveno får ändra priser med 60 dagars varsel. Priser anges exklusive moms (25% moms
        tillkommer för svenska Kunder).
      </p>

      <h2 id="sec-7">7. Trial-period</h2>
      <p>
        Nya konton får en kostnadsfri provperiod på <strong>30 dagar</strong> med full åtkomst till
        funktionerna i den valda planen och 100 AI-anrop. Inga betalningsuppgifter krävs. Vid
        trial-periodens slut måste Kunden välja en betald plan för att fortsätta.
      </p>

      <h2 id="sec-8">8. Uppsägning</h2>
      <p>
        Kunden kan när som helst säga upp avtalet med 30 dagars varsel till slutet av en
        kalendermånad. Eveno får säga upp avtalet med omedelbar verkan vid väsentligt avtalsbrott
        som inte rättas inom 14 dagar.
      </p>
      <p>
        Vid uppsägning tillhandahåller Eveno en exportfil med all Kunddata inom 30 dagar. Data
        behålls 90 dagar för återställning och raderas därefter (med undantag för data som ska
        behållas enligt bokföringslagen, typiskt 7 år).
      </p>

      <h2 id="sec-9">9. Ansvarsbegränsning</h2>
      <p>
        Eveno ansvarar inte för indirekta skador eller följdskador. Evenos totala ansvar gentemot
        Kunden under en 12-månaders period är begränsat till de Avgifter som Kunden betalat under
        samma period. Begränsningen gäller inte vid grov vårdslöshet eller brott mot
        dataskyddslagstiftningen.
      </p>

      <h2 id="sec-10">10. Datasäkerhet och GDPR</h2>
      <p>
        Eveno är personuppgiftsbiträde åt Kunden för Hyresgästers personuppgifter. Ett separat
        Personuppgiftsbiträdesavtal (DPA) ingår i avtalet. För Användares kontouppgifter är Eveno
        personuppgiftsansvarig — se <a href="/legal/integritet">Integritetspolicy</a>.
      </p>

      <h2 id="sec-11">11. Immateriella rättigheter</h2>
      <p>
        Eveno äger Tjänsten, källkoden, varumärket och dokumentationen. Kunden behåller alla
        rättigheter till sin Kunddata. Eveno får ta fram aggregerad anonymiserad statistik som inte
        kan kopplas till en specifik Kund.
      </p>

      <h2 id="sec-12">12. Sekretess</h2>
      <p>
        Båda parter förbinder sig att behandla varandras affärshemligheter konfidentiellt under
        avtalstiden och fem år därefter.
      </p>

      <h2 id="sec-13">13. Ändringar av Villkoren</h2>
      <p>
        Eveno får ändra Villkoren med 30 dagars varsel. Vid ändringar visas en re-acceptance-modal
        vid nästa inloggning. Om Kunden inte accepterar har Kunden rätt att säga upp avtalet utan
        kostnad innan ändringarna träder i kraft.
      </p>

      <h2 id="sec-14">14. Tvist, tillämplig lag och övrigt</h2>
      <p>
        Svensk rätt tillämpas. Tvist avgörs av {PLATFORM_COMPANY.jurisdiction}. För konsumenter
        gäller tvingande konsumentskydd. Parterna är befriade från ansvar vid force majeure.
      </p>

      <h2 id="sec-15">15. Kontaktinformation</h2>
      <p>
        <strong>{PLATFORM_COMPANY.legalName}</strong>
        <br />
        {PLATFORM_COMPANY.street}, {PLATFORM_COMPANY.postalCode} {PLATFORM_COMPANY.city}
        <br />
        {PLATFORM_COMPANY.country}
      </p>
      <ul>
        <li>
          Allmänna frågor: <a href={`mailto:${PLATFORM_COMPANY.email}`}>{PLATFORM_COMPANY.email}</a>
        </li>
        <li>
          Support:{' '}
          <a href={`mailto:${PLATFORM_COMPANY.supportEmail}`}>{PLATFORM_COMPANY.supportEmail}</a>
        </li>
        <li>
          Dataskydd:{' '}
          <a href={`mailto:${PLATFORM_COMPANY.privacyEmail}`}>{PLATFORM_COMPANY.privacyEmail}</a>
        </li>
        <li>Org.nr: {PLATFORM_COMPANY.orgNumber}</li>
      </ul>
    </LegalPageShell>
  )
}
