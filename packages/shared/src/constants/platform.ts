import { DEFAULT_BRAND_COLOR } from './branding'

// Plattformens juridiska identitet. Allt som behöver hänvisa till bolaget
// (juridiska dokument, footer, mejl, fakturor) ska läsa från denna källa så
// att uppgifterna är konsekventa och kan uppdateras på ett ställe.
//
// Versionsfält styr re-acceptance-flödet: när TERMS_VERSION eller
// PRIVACY_VERSION ökas tvingas befintliga organisationer att godkänna
// villkoren igen vid nästa inloggning.

export const PLATFORM_COMPANY = {
  legalName: 'Eveno AB',
  brandName: 'Eveno',
  // Placeholder tills Eveno AB är registrerat — uppdatera här och deploya.
  orgNumber: '559999-9999',
  vatNumber: 'SE559999999901',
  // F-skatt-status visas på plattformsfakturan som frivillig uppgift — inte
  // ett lagkrav (kanonisk not i invoices/templates/invoice-pdf.template.ts, #392).
  hasFSkatt: true,
  street: 'Sveavägen 1',
  postalCode: '111 57',
  city: 'Stockholm',
  country: 'Sverige',
  phone: '',
  email: 'kontakt@eveno.se',
  supportEmail: 'support@eveno.se',
  privacyEmail: 'dataskydd@eveno.se',
  invoicingEmail: 'fakturor@eveno.se',
  website: 'https://eveno.se',
  domain: 'eveno.se',
  // Betalningsuppgifter för plattformsfakturor — placeholder tills Eveno
  // AB har ett riktigt bankgiro.
  bankgiro: '000-0000',
  // Default betalningsvillkor (dagar mellan fakturadatum och förfallodatum).
  paymentTermsDays: 14,
  // Färg som används som primärtoken i plattformsfaktura-PDF.
  primaryColor: DEFAULT_BRAND_COLOR,
  // Juridisk hemvist för tvister enligt användarvillkoren
  jurisdiction: 'Stockholms tingsrätt',
} as const

export type PlatformCompany = typeof PLATFORM_COMPANY

/**
 * Genererar OCR-nummer enligt MOD-10 (Luhn) baserat på fakturanumret.
 * Behåller bara siffror och lägger på en checksiffra. Detta används som
 * paymentReference på plattformsfakturor.
 */
export function generatePlatformOcr(invoiceNumber: string): string {
  const digits = invoiceNumber.replace(/\D/g, '').slice(0, 14)
  if (!digits) return ''
  let sum = 0
  let alt = true
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i])
    if (alt) {
      n *= 2
      if (n > 9) n -= 9
    }
    sum += n
    alt = !alt
  }
  const check = (10 - (sum % 10)) % 10
  return `${digits}${check}`
}

// ─── VERSIONSMÄRKNING PÅ JURIDISKA DOKUMENT ─────────────────────────────────
//
// KÄLLAN ÄR APPENS RENDERADE TEXT. Beslutat i #576: det kunden faktiskt läser
// och godkänner i `TermsReacceptanceModal` är det som binder — inte en fil i
// repot. Den här kommentaren sa tidigare att versionen skulle höjas när
// `docs/legal/*.md` ändrades materiellt; det pekade ut fel dokument som källa
// och är rättat här.
//
// Sidorna som utgör varje dokument räknas upp i `LEGAL_DOCUMENTS` i
// scripts/check-legal-text-version.mjs — en per app, samma version.
//
// ─── VAD SOM ÄR EN MATERIELL ÄNDRING ────────────────────────────────────────
//
// Regeln saknades, och det är därför konventionen kunde brista utan att någon
// märkte det (#574 tog bort ett avtalsåtagande och bumpade ingenting).
//
// MATERIELL — versionen MÅSTE bumpas, och alla aktiva kunder tvingas godkänna om:
//   • ett åtagande från Eveno läggs till, ändras eller TAS BORT
//   • en rättighet eller skyldighet för kunden ändras
//   • ett underbiträde, en mottagare eller en överföring till tredjeland ändras
//   • en lagringstid, en frist eller ett belopp ändras
//   • rättslig grund, ändamål eller kategorier av personuppgifter ändras
//
// REDAKTIONELL — versionen står kvar:
//   • stavning, interpunktion, ordföljd som inte ändrar innebörden
//   • rubriknumrering, ankarlänkar, styckeindelning
//   • formatering och radbrytning
//
// GRÄNSFALL GÅR TILL MATERIELL. En bump kostar en extra klick för kunden; en
// utebliven bump gör att ett versionsnummer betecknar två olika texter, och då
// går frågan "vad accepterade kunden" inte längre att besvara.
//
// Kontrolleras av scripts/check-legal-text-version.mjs: texten hashas, och
// hashen ligger i LEGAL_DOCUMENT_HASHES nedan. Ändras texten utan att manifestet
// följer med blir CI röd — konventionen är alltså inte längre frivillig.
export const LEGAL_DOCUMENT_VERSIONS = {
  // 1.0 → 1.1 (#574, mergad som c4b7b2f): backup-utfästelserna gick till
  // variant A. Punkten "Daglig säkerhetskopiering av Kunddata" TOGS BORT ur
  // Evenos skyldigheter — ett borttaget åtagande, alltså materiellt.
  terms: '1.1',
  // 1.0 → 1.1 (samma ändring): säkerhetsavsnittets backup-punkt skrevs om och
  // "säkerhetskopior" ströks ur kryptering-i-vila-punkten.
  privacy: '1.1',
  // Orörd av #574 — cookie-texten ändrades inte.
  cookies: '1.0',
} as const

// ─── FÖRBRUKADE VERSIONSNUMMER (append-only) ────────────────────────────────
//
// Ett versionsnummer som en gång bundits till en text får aldrig betyda en
// annan text. Vakten fäller om ett nummer här återanvänds — och DET är vad som
// gör bumpen obligatorisk i stället för frivillig: vill man ändra texten måste
// den gamla posten pensioneras, och då är numret förbrukat.
//
// Lägg till, ta aldrig bort.
export const LEGAL_DOCUMENT_VERSION_HISTORY = [
  { doc: 'terms', version: '1.0', retiredAt: '2026-08-28' },
  { doc: 'privacy', version: '1.0', retiredAt: '2026-08-28' },
] as const

// ─── INNEHÅLLSHASH PER DOKUMENT ─────────────────────────────────────────────
//
// sha256 över den normaliserade prosan i dokumentets sidor (web + portal).
// Genereras med `node scripts/check-legal-text-version.mjs --print`.
//
// Hashen täcker PROSAN, inte interpolationer som {PLATFORM_COMPANY.brandName}
// — se guardens docblock för varför gränsen ligger där.
export const LEGAL_DOCUMENT_HASHES = {
  terms: {
    version: '1.1',
    sha256: '2777746208020045cba385120cb2a8cb02d274c4319ba6861558470173d02c6a',
  },
  // #576: hashen ändrades av att MÄNGDEN växte, inte av att en text gjorde det.
  // Portalens publika integritetssida (`/integritet`, `/integritetspolicy`,
  // `/privacy`) togs in i LEGAL_DOCUMENTS; den fanns och var oförändrad, men låg
  // utanför manifestet.
  //
  // VERSIONEN STÅR DÄRFÖR KVAR PÅ 1.1, och det är ett beslut och ingen genväg:
  // en bump tvingar VARJE befintlig organisation att godkänna om vid nästa
  // inloggning (se kommentaren överst). Att skicka den signalen när ingen text
  // ändrats vore ett falskt besked om att villkoren ändrats — och det urholkar
  // exakt den mekanism re-acceptansen finns för. Versionen betecknar den text
  // kunden ser; den texten är densamma idag som igår.
  privacy: {
    version: '1.1',
    sha256: 'dcf9e6cfca4849ed70b0c19d493bbb98e918a419a502b8d2a9c25999940e3a9e',
  },
  cookies: {
    version: '1.0',
    sha256: '10fd4171f2ae65f41e707711a45b5c382cd0725cf24c1a24d92699cef24972f4',
  },
} as const

// Villkorsversionen är den som STYR. Den snapshot:as till Organization.termsVersion
// och User.termsVersion, och re-acceptance-modalen jämför mot den.
export const CURRENT_TERMS_VERSION = LEGAL_DOCUMENT_VERSIONS.terms

// ⚠️ CURRENT_PRIVACY_VERSION UTLÖSER INGENTING. Den visar bara ett nummer på
// de publika sidorna (PrivacyPage i web och portal). Den skrivs ALDRIG till
// databasen och ingår INTE i re-acceptance-jämförelsen — trots att
// registreringsrutan säger att kunden accepterar "Användarvillkor OCH
// Integritetspolicy". För policyn finns alltså varken version eller hash
// lagrad per kund, bara ett datum via acceptedTermsAt.
//
// Att bumpa den här är alltså kosmetiskt: det ändrar vad sidan visar, inte vad
// någon måste godkänna. Låt den inte se ut som en fungerande mekanism.
// Luckan är #577:s fråga och löses inte här.
export const CURRENT_PRIVACY_VERSION = LEGAL_DOCUMENT_VERSIONS.privacy

// Datum när dokumenten senast ändrades — visas i "Senast uppdaterad"-fält
// på publika sidor. Uppdatera samtidigt som versionsfältet.
//
// HÄRLETT UR ÄNDRINGEN, inte ur "vilken dag är det idag":
//   git show -s --format=%ci c4b7b2f  →  2026-08-28 00:42:35 +0200
// Offseten är Stockholm, och texterna är svenska och riktade till svenska
// kunder — alltså 2026-08-28. (I UTC var det fortfarande den 27:e; svensk
// lokaltid är rätt nämnare för ett svenskt avtalsdokument.)
export const LEGAL_DOCUMENT_UPDATED_AT = {
  terms: '2026-08-28',
  privacy: '2026-08-28',
  // Cookie-texten rördes inte av #574.
  cookies: '2026-05-12',
} as const

// URL-paths för publika juridiska sidor. Används av footer, register-form
// och mejl-mallar så att vi inte hårdkodar paths på flera ställen.
export const LEGAL_PATHS = {
  terms: '/legal/villkor',
  privacy: '/legal/integritet',
  cookies: '/legal/cookies',
} as const
