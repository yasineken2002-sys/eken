import { organizationAddressIssues, type OrganizationAddressField } from '@eken/shared'

/**
 * Landet en kund skapad från "Ny kund" får. Formuläret har inget landfält, och
 * `PlatformOrganizationsService.create` lagrar då `'SE'` — samma värde som
 * avgör om den svenska postnummerregeln gäller där. Förkontrollen här måste
 * pröva mot SAMMA land, annars säger UI:t och servern olika om samma adress.
 */
export const NEW_ORGANIZATION_COUNTRY = 'SE'

export type NewOrganizationAddressErrors = Partial<Record<OrganizationAddressField, string>>

/**
 * Fältvisa fel för adressen i "Ny kund" — samma regel som registreringen,
 * inställningarna och servern (`organizationAddressIssues`, A5). Tomt objekt =
 * adressen får skickas. Servern prövar ändå; det här är bara så att felet syns
 * vid rätt fält innan något anrop görs.
 */
export function newOrganizationAddressErrors(address: {
  street: string
  postalCode: string
  city: string
}): NewOrganizationAddressErrors {
  const fel: NewOrganizationAddressErrors = {}
  for (const issue of organizationAddressIssues(address, NEW_ORGANIZATION_COUNTRY)) {
    fel[issue.path] ??= issue.message
  }
  return fel
}
