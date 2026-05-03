import { ArrowLeft } from 'lucide-react'

interface Props {
  onBack: () => void
}

/**
 * Integritetspolicy / GDPR-information. Visar hur Eveno behandlar
 * personuppgifter enligt GDPR, vad som lagras, vilka rättigheter användaren
 * har och hur man använder dem (export + radering finns under Inställningar
 * → Mitt konto). Sidan ska kunna nås utan inloggning.
 */
export function PrivacyPage({ onBack }: Props) {
  return (
    <div className="min-h-screen bg-[#F7F8FA] px-4 py-12">
      <div className="mx-auto max-w-3xl">
        <button
          onClick={onBack}
          className="inline-flex items-center gap-2 text-[13px] font-medium text-gray-600 hover:text-gray-900"
        >
          <ArrowLeft className="h-4 w-4" /> Tillbaka
        </button>
        <h1 className="mt-6 text-[28px] font-semibold tracking-tight text-gray-900">
          Integritetspolicy
        </h1>
        <p className="mt-2 text-[13px] text-gray-500">Senast uppdaterad: 2026-05-03</p>

        <div className="prose prose-sm mt-8 max-w-none text-[14px] leading-relaxed text-gray-700">
          <h2 className="mt-8 text-[18px] font-semibold text-gray-900">
            1. Personuppgiftsansvarig
          </h2>
          <p>
            Eveno (&quot;vi&quot;) tillhandahåller programvara för fastighetsförvaltning. När du
            använder Eveno är vi personuppgiftsbiträde för de uppgifter du som hyresvärd lagrar om
            dina hyresgäster. För dina egna kontouppgifter är vi personuppgiftsansvarig.
          </p>

          <h2 className="mt-8 text-[18px] font-semibold text-gray-900">
            2. Vilka uppgifter behandlar vi?
          </h2>
          <ul className="mt-2 list-disc space-y-1 pl-6">
            <li>
              Kontouppgifter: namn, e-post, krypterat lösenord, roll, organisationsnummer, telefon
            </li>
            <li>Loggdata: senaste inloggning, IP-adress vid inloggning, säkerhetshändelser</li>
            <li>
              Hyresgäst-data (som du som hyresvärd lagt in): namn, personnummer, kontraktsdata
            </li>
            <li>Transaktionsdata: hyror, fakturor, bankavstämning, bokföring</li>
          </ul>

          <h2 className="mt-8 text-[18px] font-semibold text-gray-900">3. Rättslig grund</h2>
          <p>
            Vi behandlar uppgifterna med stöd av avtal (när du är kund hos oss), berättigat intresse
            (säkerhetsloggar) och rättslig förpliktelse (Bokföringslagen 7 kap. 2 § kräver att
            verifikationer sparas i minst 7 år).
          </p>

          <h2 className="mt-8 text-[18px] font-semibold text-gray-900">4. Cookies</h2>
          <p>
            Eveno använder endast cookies som är nödvändiga för inloggning och säkerhet. Vi sätter
            inga tredjepartscookies för marknadsföring eller spårning.
          </p>

          <h2 className="mt-8 text-[18px] font-semibold text-gray-900">5. Dina rättigheter</h2>
          <ul className="mt-2 list-disc space-y-1 pl-6">
            <li>
              <strong>Tillgång (Art. 15)</strong>: ladda ner all data om dig själv via Inställningar
              → Mitt konto → Exportera mina uppgifter.
            </li>
            <li>
              <strong>Rättelse (Art. 16)</strong>: ändra felaktiga uppgifter under Inställningar.
            </li>
            <li>
              <strong>Radering (Art. 17)</strong>: radera ditt konto via Inställningar → Mitt konto
              → Radera konto. Räkenskapsmaterial som måste sparas enligt lag kommer att anonymiseras
              snarare än raderas.
            </li>
            <li>
              <strong>Dataportabilitet (Art. 20)</strong>: exporten är i strukturerat JSON-format.
            </li>
            <li>
              <strong>Klagomål</strong>: du kan kontakta Integritetsskyddsmyndigheten (IMY) på
              imy.se.
            </li>
          </ul>

          <h2 className="mt-8 text-[18px] font-semibold text-gray-900">6. Lagring och säkerhet</h2>
          <p>
            Lösenord lagras hashade med bcrypt (12 rounds). Refresh- och sessionstokens lagras som
            SHA-256-hashar — vi kan därför inte återskapa sessioner från databasen om den skulle
            komprometteras. All trafik krypteras med TLS.
          </p>

          <h2 className="mt-8 text-[18px] font-semibold text-gray-900">7. Kontakt</h2>
          <p>
            Frågor om integritet eller hur dina uppgifter behandlas: skicka ett mejl till
            <a href="mailto:dataskydd@eveno.se" className="ml-1 text-blue-600 hover:underline">
              dataskydd@eveno.se
            </a>
            .
          </p>
        </div>
      </div>
    </div>
  )
}
