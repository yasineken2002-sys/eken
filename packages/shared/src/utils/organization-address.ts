/**
 * ORGANISATIONENS POSTADRESS — regeln och visningen, på ETT ställe.
 *
 * Registreringen skrev fram till 2026-09-25 `street/city/postalCode = ''` för
 * varje ny organisation (F-10), och flera dokument skrev adressen som
 * `${street}, ${postalCode} ${city}`. Utfallet i kundprovet var ett kontrakt vars
 * hyresvärdsadress bestod av ett ensamt kommatecken.
 *
 * Två delar, och de svarar på olika frågor:
 *
 *   organizationAddressIssues   får den här adressen SPARAS? (webb + API)
 *   formatPostalAddress         hur SKRIVS en sparad adress ut? (alla dokument)
 *
 * Den andra returnerar `null` när det inte finns något att skriva — aldrig en
 * separator utan innehåll. Anroparen väljer vad som ska stå i stället
 * (`ORGANIZATION_ADDRESS_MISSING`), så att ett dokument säger att uppgiften
 * saknas i stället för att se ifyllt ut.
 */

// Svenska postnummer: första tre siffrorna pekar ut PostNord-områden i
// intervallet 100 (Stockholm) till 984 (Pajala). Allt utanför dvs. 0XX
// och 985–999 är ogiltigt. Ett frivilligt mellanslag mellan siffergrupperna
// accepteras (t.ex. "111 22").
const SWEDISH_POSTAL_CODE_REGEX = /^[1-9]\d{2}\s?\d{2}$/
const SWEDISH_POSTAL_AREA_MIN = 100
const SWEDISH_POSTAL_AREA_MAX = 984

export function isValidSwedishPostalCode(value: string): boolean {
  if (!SWEDISH_POSTAL_CODE_REGEX.test(value)) return false
  const area = parseInt(value.slice(0, 3), 10)
  return area >= SWEDISH_POSTAL_AREA_MIN && area <= SWEDISH_POSTAL_AREA_MAX
}

/**
 * LANDET EN NY ORGANISATION FÅR VID REGISTRERING.
 *
 * Registreringen har inget landfält, och `Organization.country` defaultar till
 * `"SE"` i schemat. Det är inte ett antagande om kunden utan det befintliga
 * kontraktet: formuläret erbjuder bara svenska företagsformer och prövar
 * orgnumret mot Skatteverkets format. Den svenska postnummerregeln gäller därför
 * vid registrering — och ENBART för `"SE"` i övrigt (se nedan).
 */
export const REGISTRATION_COUNTRY = 'SE'

export const ORGANIZATION_ADDRESS_MAX_LENGTH = {
  street: 200,
  postalCode: 20,
  city: 100,
} as const

export type OrganizationAddressField = 'street' | 'postalCode' | 'city'

export interface OrganizationAddressInput {
  street?: string | null | undefined
  postalCode?: string | null | undefined
  city?: string | null | undefined
}

export interface OrganizationAddressIssue {
  path: OrganizationAddressField
  message: string
}

/**
 * Felen i en företagsadress, i fältordning. Tom lista = adressen får sparas.
 *
 * Värdena prövas TRIMMADE, eftersom det är den formen som lagras: `'   '` är
 * lika tomt som `''`.
 *
 * `country` styr bara postnumret. En organisation med ett annat land än `"SE"`
 * får inte en svensk postnummerregel påtvingad — det finns ingen produktgrund
 * för något annat lands format, så där krävs bara att fältet är ifyllt.
 */
export function organizationAddressIssues(
  input: OrganizationAddressInput,
  country: string,
): OrganizationAddressIssue[] {
  const issues: OrganizationAddressIssue[] = []
  const street = input.street?.trim() ?? ''
  const postalCode = input.postalCode?.trim() ?? ''
  const city = input.city?.trim() ?? ''

  if (!street) issues.push({ path: 'street', message: 'Gatuadress krävs' })
  else if (street.length > ORGANIZATION_ADDRESS_MAX_LENGTH.street)
    issues.push({
      path: 'street',
      message: `Gatuadressen får vara högst ${ORGANIZATION_ADDRESS_MAX_LENGTH.street} tecken`,
    })

  if (!postalCode) issues.push({ path: 'postalCode', message: 'Postnummer krävs' })
  else if (postalCode.length > ORGANIZATION_ADDRESS_MAX_LENGTH.postalCode)
    issues.push({
      path: 'postalCode',
      message: `Postnumret får vara högst ${ORGANIZATION_ADDRESS_MAX_LENGTH.postalCode} tecken`,
    })
  else if (country === 'SE' && !isValidSwedishPostalCode(postalCode))
    issues.push({
      path: 'postalCode',
      message: 'Postnummer måste vara fem siffror, t.ex. 111 22',
    })

  if (!city) issues.push({ path: 'city', message: 'Ort krävs' })
  else if (city.length > ORGANIZATION_ADDRESS_MAX_LENGTH.city)
    issues.push({
      path: 'city',
      message: `Orten får vara högst ${ORGANIZATION_ADDRESS_MAX_LENGTH.city} tecken`,
    })

  return issues
}

/** Texten ett dokument visar när organisationens adress inte finns sparad. */
export const ORGANIZATION_ADDRESS_MISSING = 'Adress saknas'

/**
 * `"Storgatan 1, 111 22 Stockholm"` — eller `null` om ingen del finns.
 *
 * Tomma delar hoppas över, så en ofullständig adress skrivs ut som det den är
 * ("Storgatan 1") och aldrig som en separator utan innehåll (", "). Historiska
 * organisationer har tomma strängar i alla tre fälten; de ger `null`.
 */
export function formatPostalAddress(
  address: OrganizationAddressInput,
  separator = ', ',
): string | null {
  const street = address.street?.trim() ?? ''
  const locality = [address.postalCode?.trim(), address.city?.trim()].filter(Boolean).join(' ')
  const line = [street, locality].filter(Boolean).join(separator)
  return line || null
}
