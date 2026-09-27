import { formatPostalAddress, ORGANIZATION_ADDRESS_MISSING } from '@eken/shared'

interface OrganizationHeaderInput {
  customerNumber?: string | null
  orgNumber?: string | null
  address: { street?: string | null; postalCode?: string | null; city?: string | null }
}

/**
 * Rubrikraden på organisationens detaljsida: kundnummer · orgnummer · adress.
 *
 * Adressen går genom samma `formatPostalAddress` som adressraden längre ned på
 * sidan (F-10). En organisation registrerad före 2026-09-25 har tomma
 * adressfält, och den gamla raden `${street}, ${postalCode} ${city}` gav då
 * `… · , ` — en separator utan innehåll.
 */
export function organizationHeaderDescription(org: OrganizationHeaderInput): string {
  const adress = formatPostalAddress(org.address) ?? ORGANIZATION_ADDRESS_MISSING
  return `${org.customerNumber ?? '—'} · ${org.orgNumber ?? '—'} · ${adress}`
}
