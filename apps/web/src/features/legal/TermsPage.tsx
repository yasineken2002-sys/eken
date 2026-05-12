import { LegalPageShell, type TocItem } from './LegalPageShell'
import { CURRENT_TERMS_VERSION, LEGAL_DOCUMENT_UPDATED_AT, PLATFORM_COMPANY } from '@eken/shared'

interface Props {
  onBack: () => void
}

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

/**
 * Användarvillkor (Terms of Service) — publik sida som måste accepteras
 * vid registrering. Innehåll speglar docs/legal/terms-of-service.md.
 * När innehållet ändras materiellt: uppdatera CURRENT_TERMS_VERSION så
 * att alla befintliga kunder tvingas re-acceptera vid nästa inloggning.
 */
export function TermsPage({ onBack }: Props) {
  return (
    <LegalPageShell
      title="Användarvillkor"
      description={`Reglerar din användning av ${PLATFORM_COMPANY.brandName}. Genom att skapa ett konto godkänner du dessa villkor.`}
      version={CURRENT_TERMS_VERSION}
      updatedAt={LEGAL_DOCUMENT_UPDATED_AT.terms}
      toc={TOC}
      onBack={onBack}
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
        {PLATFORM_COMPANY.street}, {PLATFORM_COMPANY.postalCode} {PLATFORM_COMPANY.city} ("
        <strong>Eveno</strong>", "<strong>vi</strong>", "<strong>oss</strong>"), tillhandahåller en
        webbaserad programvarutjänst för förvaltning av fastigheter, hyresgäster, hyresavtal,
        fakturering och bokföring.
      </p>
      <p>
        Genom att registrera ett konto, bocka i rutan "Jag accepterar Användarvillkor och
        Integritetspolicy" eller på annat sätt använda Tjänsten, ingår du ett juridiskt bindande
        avtal med Eveno. Om du accepterar Villkoren för en juridisk persons räkning intygar du
        samtidigt att du har behörighet att binda den juridiska personen.
      </p>

      <h2 id="sec-2">2. Definitioner</h2>
      <ul>
        <li>
          <strong>"Tjänsten"</strong> – Eveno-plattformen i sin helhet, inklusive webbgränssnitt,
          API:er, hyresgästportal och tillhörande dokumentation.
        </li>
        <li>
          <strong>"Kund"</strong> – den juridiska eller fysiska person som ingått avtal med Eveno om
          användning av Tjänsten.
        </li>
        <li>
          <strong>"Användare"</strong> – fysisk person som getts inloggning till Kundens konto
          (t.ex. anställda, revisorer eller förvaltare).
        </li>
        <li>
          <strong>"Hyresgäst"</strong> – fysisk eller juridisk person som hyr en bostad eller lokal
          hos Kunden och vars uppgifter registreras i Tjänsten.
        </li>
        <li>
          <strong>"Kunddata"</strong> – all data som Kunden eller dess Användare matar in eller
          genererar i Tjänsten.
        </li>
      </ul>

      <h2 id="sec-3">3. Tjänstens omfattning</h2>
      <p>
        Tjänsten består av register över fastigheter, lägenheter och hyresgäster, hyresavtal med
        statushantering, fakturering med automatiska avier och påminnelser, bokföring enligt
        BAS-kontoplanen, hyresgästportal, AI-assistent samt rapporter och exporter (SIE4, PDF, CSV).
        Exakt omfattning varierar med vald abonnemangsplan.
      </p>
      <p>
        Eveno utvecklar Tjänsten kontinuerligt. Nya funktioner kan läggas till och befintliga kan
        ändras, så länge förändringen inte väsentligt försämrar kärnfunktionerna i Kundens plan.
        Tjänsten är inte ett inkassobolag eller en bokföringsbyrå — Kunden ansvarar själv för att
        kontrollera och överlämna underlag.
      </p>

      <h2 id="sec-4">4. Användarens skyldigheter</h2>
      <p>
        Kunden ansvarar för att alla uppgifter som matas in i Tjänsten är korrekta, fullständiga och
        lagligen behandlas. Kunden får inte använda Tjänsten i strid med lag, försöka kringgå
        tekniska skyddsåtgärder, mata in skadlig kod eller återförsälja Tjänsten utan skriftligt
        godkännande.
      </p>
      <p>
        Kunden ansvarar för Användarnas handlingar som om de var Kundens egna och för att
        inloggningsuppgifter hålls hemliga.
      </p>

      <h2 id="sec-5">5. Evenos skyldigheter</h2>
      <ul>
        <li>Tillhandahålla Tjänsten i enlighet med dessa Villkor</li>
        <li>Upptid på minst 99,5% per kalendermånad, exklusive planerat underhåll</li>
        <li>Daglig säkerhetskopiering av Kunddata</li>
        <li>Underrätta Kunden om personuppgiftsincidenter inom 72 timmar (GDPR)</li>
        <li>Branschstandard för kryptering (TLS i transit, AES-256 i vila)</li>
        <li>
          Support via {PLATFORM_COMPANY.supportEmail} helgfri vardag 09:00–17:00, typisk svarstid
          under 24 timmar
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
          <strong>Dröjsmålsränta:</strong> Referensräntan + 8 procentenheter enligt 6 § räntelagen
        </li>
        <li>
          <strong>Påminnelseavgift:</strong> 60 kr enligt lag (1981:739) om ersättning för
          inkassokostnader
        </li>
      </ul>
      <p>
        <strong>Eskalering vid utebliven betalning:</strong>
      </p>
      <ul>
        <li>
          <strong>Dag 14 efter förfallodag:</strong> Påminnelse skickas
        </li>
        <li>
          <strong>Dag 30 efter förfallodag:</strong> Tjänsten pausas — läsläge endast
        </li>
        <li>
          <strong>Dag 60 efter förfallodag:</strong> Tjänsten stängs av och ärendet överlämnas till
          inkasso
        </li>
      </ul>
      <p>
        Eveno får ändra abonnemangspriserna med 60 dagars varsel. Kunden har rätt att säga upp
        avtalet utan kostnad fram till ikraftträdandet. Samtliga priser anges exklusive moms (25%
        svensk moms tillkommer).
      </p>

      <h2 id="sec-7">7. Trial-period</h2>
      <p>
        Nya konton får en kostnadsfri provperiod på 30 dagar från registreringsdatum. Under
        trial-perioden har Kunden full åtkomst till funktionerna i den valda planen, med ett tak på
        100 AI-anrop per månad. Trial-perioden kräver inga betalningsuppgifter och förnyas inte
        automatiskt. Vid trial-periodens slut måste Kunden välja en betald plan för att fortsätta
        använda Tjänsten.
      </p>

      <h2 id="sec-8">8. Uppsägning</h2>
      <p>
        <strong>Kunden</strong> kan när som helst säga upp avtalet med 30 dagars varsel till slutet
        av en kalendermånad via Inställningar → Konto eller skriftligen till{' '}
        {PLATFORM_COMPANY.supportEmail}.
      </p>
      <p>
        <strong>Eveno</strong> får med omedelbar verkan säga upp avtalet om Kunden väsentligt bryter
        mot Villkoren och inte rättar bristen inom 14 dagar efter skriftlig anmodan, vid obestånd
        eller vid lagbrott.
      </p>
      <p>
        När avtalet upphör tillhandahåller Eveno en exportfil med all Kunddata inom 30 dagar. Data
        lagras i 90 dagar för återställning och raderas därefter permanent, med undantag för data
        som måste behållas enligt bokföringslagen (typiskt 7 år).
      </p>

      <h2 id="sec-9">9. Ansvarsbegränsning</h2>
      <p>
        Eveno ansvarar inte för indirekta skador, följdskador, utebliven vinst eller skada till
        följd av felaktigheter i Kunddata. Evenos totala ansvar gentemot Kunden under varje
        12-månaders period är begränsat till de Avgifter som Kunden faktiskt betalat under samma
        period.
      </p>
      <p>
        Ansvarsbegränsningen gäller inte vid grov vårdslöshet, uppsåt eller vid skada till följd av
        Evenos brott mot dataskyddslagstiftningen.
      </p>

      <h2 id="sec-10">10. Datasäkerhet och GDPR</h2>
      <p>
        Eveno är personuppgiftsbiträde åt Kunden avseende personuppgifter om Hyresgäster och övriga
        personer som Kunden registrerar i Tjänsten. Ett separat Personuppgiftsbiträdesavtal (DPA)
        ingår som en del av dessa Villkor.
      </p>
      <p>
        För personuppgifter om Användare (inloggningar, supportkommunikation) är Eveno
        personuppgiftsansvarig — behandlingen beskrivs i vår{' '}
        <a href="/legal/integritet" className="text-blue-600 hover:underline">
          Integritetspolicy
        </a>
        .
      </p>

      <h2 id="sec-11">11. Immateriella rättigheter</h2>
      <p>
        Tjänsten, källkoden, varumärket "Eveno", logotyperna och dokumentationen ägs av Eveno.
        Kunden får en begränsad, icke-överlåtbar användarrätt. Kunden behåller alla rättigheter till
        sin Kunddata.
      </p>
      <p>
        Eveno får ta fram aggregerad och anonymiserad statistik för produktförbättring — sådan
        statistik får aldrig kunna kopplas till en specifik Kund eller Hyresgäst.
      </p>

      <h2 id="sec-12">12. Sekretess</h2>
      <p>
        Båda parter förbinder sig att behandla varandras affärshemligheter konfidentiellt och inte
        röja dem för andra ändamål än att fullgöra avtalet. Sekretessen gäller under avtalstiden och
        i fem år därefter.
      </p>

      <h2 id="sec-13">13. Ändringar av Villkoren</h2>
      <p>
        Eveno får ändra Villkoren med 30 dagars varsel via e-post och notis i Tjänsten. Vid
        ändringar visas en re-acceptance-modal vid nästa inloggning — Kunden måste acceptera de nya
        Villkoren för att fortsätta använda Tjänsten. Om Kunden inte accepterar har Kunden rätt att
        säga upp avtalet utan kostnad innan ändringarna träder i kraft.
      </p>

      <h2 id="sec-14">14. Tvist, tillämplig lag och övrigt</h2>
      <p>
        Svensk rätt tillämpas på avtalet. Tvist avgörs av {PLATFORM_COMPANY.jurisdiction} som första
        instans. För konsumenter gäller tvingande konsumentskydd enligt svensk lag oberoende av
        dessa Villkor.
      </p>
      <p>
        Parterna är befriade från ansvar vid force majeure (krig, naturkatastrof, strejk, omfattande
        internetstörningar m.m.). Kunden får inte överlåta avtalet utan Evenos skriftliga
        godkännande.
      </p>

      <h2 id="sec-15">15. Kontaktinformation</h2>
      <p>
        <strong>{PLATFORM_COMPANY.legalName}</strong>
        <br />
        {PLATFORM_COMPANY.street}
        <br />
        {PLATFORM_COMPANY.postalCode} {PLATFORM_COMPANY.city}
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
          Fakturering:{' '}
          <a href={`mailto:${PLATFORM_COMPANY.invoicingEmail}`}>
            {PLATFORM_COMPANY.invoicingEmail}
          </a>
        </li>
        <li>
          Dataskydd:{' '}
          <a href={`mailto:${PLATFORM_COMPANY.privacyEmail}`}>{PLATFORM_COMPANY.privacyEmail}</a>
        </li>
        <li>Org.nr: {PLATFORM_COMPANY.orgNumber}</li>
        <li>Momsreg.nr: {PLATFORM_COMPANY.vatNumber}</li>
      </ul>
    </LegalPageShell>
  )
}
