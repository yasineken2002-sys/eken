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
  // F-skatt-status visas på fakturan; obligatoriskt enligt 11 kap. 8 § ML.
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

// Versionsmärkning på juridiska dokument. När innehållet i en av
// markdown-filerna i docs/legal/ ändras materiellt ska motsvarande version
// här ökas — det triggar re-acceptance-modalen för alla aktiva kunder.
export const LEGAL_DOCUMENT_VERSIONS = {
  terms: '1.0',
  privacy: '1.0',
  cookies: '1.0',
} as const

// Aktuella versioner som används av register-flödet och re-acceptance-flödet.
// Det är dessa två som styr om en kund behöver godkänna nytt vid inloggning.
export const CURRENT_TERMS_VERSION = LEGAL_DOCUMENT_VERSIONS.terms
export const CURRENT_PRIVACY_VERSION = LEGAL_DOCUMENT_VERSIONS.privacy

// Datum när dokumenten senast ändrades — visas i "Senast uppdaterad"-fält
// på publika sidor. Uppdatera samtidigt som versionsfältet.
export const LEGAL_DOCUMENT_UPDATED_AT = {
  terms: '2026-05-12',
  privacy: '2026-05-12',
  cookies: '2026-05-12',
} as const

// URL-paths för publika juridiska sidor. Används av footer, register-form
// och mejl-mallar så att vi inte hårdkodar paths på flera ställen.
export const LEGAL_PATHS = {
  terms: '/legal/villkor',
  privacy: '/legal/integritet',
  cookies: '/legal/cookies',
} as const
