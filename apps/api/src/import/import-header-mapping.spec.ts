/**
 * Import — rubrik-mappning (normalizeHeaders).
 *
 * Regression: delsträngsmatchningen tog första-träff-i-map-ordning, så den korta
 * generiska varianten 'namn'/'typ' "stal" mer specifika rubriker — "förnamn"
 * (innehåller "namn") mappades till `name` i stället för `firstName`, vilket
 * bröt tenant-CSV-import (onboarding). Fixen: exakt träff slår delsträng, och
 * längsta varianten vinner. Dessa tester låser rätt mappning för svenska OCH
 * engelska rubriker.
 */

import { ImportService } from './import.service'

function service() {
  // normalizeHeaders använder inga injicerade beroenden.
  return new ImportService(null as never, null as never, null as never)
}

describe('ImportService.normalizeHeaders', () => {
  const map = (headers: string[]) => service().normalizeHeaders(headers)

  it('hyresgäst (svenska rubriker) mappas till rätt fält — inte allt till name', () => {
    expect(map(['typ', 'förnamn', 'efternamn', 'e-post', 'telefon'])).toEqual({
      typ: 'type',
      förnamn: 'firstName',
      efternamn: 'lastName',
      'e-post': 'email',
      telefon: 'phone',
    })
  })

  it('hyresgäst (engelska rubriker) mappas korrekt', () => {
    expect(map(['type', 'first name', 'last name', 'email', 'phone'])).toEqual({
      type: 'type',
      'first name': 'firstName',
      'last name': 'lastName',
      email: 'email',
      phone: 'phone',
    })
  })

  it('företagsnamn → companyName (inte name)', () => {
    expect(map(['företagsnamn'])).toEqual({ företagsnamn: 'companyName' })
    expect(map(['company name'])).toEqual({ 'company name': 'companyName' })
  })

  it('enhetstyp/unit type → unitType (inte type)', () => {
    expect(map(['enhetstyp'])).toEqual({ enhetstyp: 'unitType' })
    expect(map(['unit type'])).toEqual({ 'unit type': 'unitType' })
  })

  it('tenant email → tenantEmail (inte email)', () => {
    expect(map(['tenant email'])).toEqual({ 'tenant email': 'tenantEmail' })
    expect(map(['hyresgäst e-post'])).toEqual({ 'hyresgäst e-post': 'tenantEmail' })
  })

  it('exakta generiska rubriker mappar fortfarande rätt', () => {
    expect(map(['namn', 'name'])).toEqual({ namn: 'name', name: 'name' })
    expect(map(['typ', 'type'])).toEqual({ typ: 'type', type: 'type' })
  })

  it('fastighetsrubriker', () => {
    expect(map(['namn', 'beteckning', 'gata', 'stad', 'postnummer'])).toEqual({
      namn: 'name',
      beteckning: 'propertyDesignation',
      gata: 'street',
      stad: 'city',
      postnummer: 'postalCode',
    })
  })

  it('fuzzy rubrik: längsta (mest specifika) varianten vinner', () => {
    // "förnamn på hyresgäst" innehåller både 'förnamn' (firstName) och 'namn'
    // (name) — den längre, mer specifika varianten ska vinna.
    expect(map(['Förnamn på hyresgäst'])).toEqual({ 'Förnamn på hyresgäst': 'firstName' })
  })

  it('okänd rubrik mappas inte (lämnas utanför)', () => {
    expect(map(['helt_okänd_kolumn'])).toEqual({})
  })

  it('skiftläge spelar ingen roll', () => {
    expect(map(['FÖRNAMN', 'Efternamn', 'E-Post'])).toEqual({
      FÖRNAMN: 'firstName',
      Efternamn: 'lastName',
      'E-Post': 'email',
    })
  })
})
