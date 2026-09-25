/**
 * F-10 — organisationens adressregel och adressvisning (`@eken/shared`).
 *
 * Den här filen mäter de rena funktionerna och kontraktets hyresvärdsrad. Att
 * registreringen och PATCH faktiskt ANVÄNDER regeln mäts av de två
 * `*-http.db.spec.ts`-proven; att dokumenten inte visar ett ensamt komma mäts
 * här för kontraktet och i `avisering.notice-render-date.spec.ts` för avin.
 */
import {
  formatPostalAddress,
  organizationAddressIssues,
  ORGANIZATION_ADDRESS_MISSING,
  REGISTRATION_COUNTRY,
} from '@eken/shared'
import { partiesSection } from '../contracts/contract-template.shared'
import type { ContractTemplateInput } from '../contracts/contract-template.shared'

const giltig = { street: 'Storgatan 1', postalCode: '111 22', city: 'Stockholm' }

describe('organizationAddressIssues', () => {
  it('registreringens land är SE (Organization.country-default)', () => {
    expect(REGISTRATION_COUNTRY).toBe('SE')
  })

  it.each([['111 22'], ['11122'], ['984 99'], ['100 00']])('SE godtar %s', (pn) => {
    expect(organizationAddressIssues({ ...giltig, postalCode: pn }, 'SE')).toEqual([])
  })

  it.each([['1234'], ['012 34'], ['985 00'], ['abcde'], ['111  22']])('SE avvisar %s', (pn) => {
    expect(organizationAddressIssues({ ...giltig, postalCode: pn }, 'SE')).toEqual([
      { path: 'postalCode', message: 'Postnummer måste vara fem siffror, t.ex. 111 22' },
    ])
  })

  it('ANNAT land får inte den svenska postnummerregeln — bara krav på ifyllt', () => {
    expect(organizationAddressIssues({ ...giltig, postalCode: '0154' }, 'NO')).toEqual([])
    expect(organizationAddressIssues({ ...giltig, postalCode: ' ' }, 'NO')).toEqual([
      { path: 'postalCode', message: 'Postnummer krävs' },
    ])
  })

  it('prövar TRIMMADE värden: blanktecken är tomt', () => {
    expect(
      organizationAddressIssues({ street: '  ', postalCode: '\t', city: ' ' }, 'SE').map(
        (i) => i.path,
      ),
    ).toEqual(['street', 'postalCode', 'city'])
    expect(
      organizationAddressIssues({ street: ' A 1 ', postalCode: ' 111 22 ', city: ' B ' }, 'SE'),
    ).toEqual([])
  })

  it('saknade fält (undefined/null) ger fel, inte krasch', () => {
    expect(organizationAddressIssues({}, 'SE')).toHaveLength(3)
    expect(
      organizationAddressIssues({ street: null, postalCode: null, city: null }, 'SE'),
    ).toHaveLength(3)
  })

  it('längdtak', () => {
    expect(organizationAddressIssues({ ...giltig, street: 'x'.repeat(201) }, 'SE')[0]?.path).toBe(
      'street',
    )
    expect(organizationAddressIssues({ ...giltig, city: 'x'.repeat(101) }, 'SE')[0]?.path).toBe(
      'city',
    )
  })
})

describe('formatPostalAddress — aldrig en ensam separator', () => {
  it('komplett adress', () => {
    expect(formatPostalAddress(giltig)).toBe('Storgatan 1, 111 22 Stockholm')
  })

  it('historisk organisation (tomma strängar) → null', () => {
    expect(formatPostalAddress({ street: '', postalCode: '', city: '' })).toBeNull()
    expect(formatPostalAddress({ street: '  ', postalCode: null, city: undefined })).toBeNull()
  })

  it.each([
    [{ street: 'Storgatan 1', postalCode: '', city: '' }, 'Storgatan 1'],
    [{ street: '', postalCode: '111 22', city: 'Stockholm' }, '111 22 Stockholm'],
    [{ street: '', postalCode: '', city: 'Stockholm' }, 'Stockholm'],
  ])('ofullständig %j → %s', (a, forvantat) => {
    const ut = formatPostalAddress(a)
    expect(ut).toBe(forvantat)
    expect(ut).not.toMatch(/^[\s,]|[\s,]$/)
  })
})

describe('kontraktet — hyresvärdens adressrad (partiesSection)', () => {
  const input = (org: Record<string, unknown>) =>
    ({
      organization: {
        name: 'Värd AB',
        orgNumber: null,
        vatNumber: null,
        email: 'v@example.invalid',
        phone: null,
        bankgiro: null,
        companyForm: 'AB',
        hasFSkatt: false,
        ...org,
      },
      tenant: {
        type: 'INDIVIDUAL',
        firstName: 'Hyr',
        lastName: 'Gäst',
        email: 'h@example.invalid',
        street: null,
        postalCode: null,
        city: null,
      },
    }) as unknown as ContractTemplateInput

  const adressRad = (html: string) =>
    /<span class="field-label">Adress<\/span><span class="field-value">([^<]*)<\/span>/.exec(
      html,
    )?.[1]

  it('historisk organisation: raden säger att adressen saknas — inte ","', () => {
    const rad = adressRad(partiesSection(input({ street: '', postalCode: '', city: '' })))
    expect(rad).toBe(ORGANIZATION_ADDRESS_MISSING)
    expect(rad?.trim()).not.toBe(',')
  })

  it('sparad adress skrivs ut som förut', () => {
    expect(adressRad(partiesSection(input(giltig)))).toBe('Storgatan 1, 111 22 Stockholm')
  })
})
