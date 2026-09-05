import { describe, it, expect } from 'vitest'
import {
  validateEquipment,
  validateReplacement,
  toCreatePayload,
  toReplacementPayload,
  tolkaBelopp,
  TOM_UTRUSTNING,
  TOMT_BYTE,
} from './equipment-form'

describe('utrustningsformuläret', () => {
  it('kräver sort och installationsdatum — NÄR-halvan av frågan får inte saknas', () => {
    const fel = validateEquipment(TOM_UTRUSTNING)
    expect(fel.kind).toBeDefined()
    expect(fel.installedAt).toBeDefined()
  })

  it('släpper igenom ett ifyllt formulär', () => {
    const fel = validateEquipment({
      ...TOM_UTRUSTNING,
      kind: 'REFRIGERATOR',
      installedAt: '2020-01-15',
    })
    expect(fel).toEqual({})
  })

  it('TOM förväntan är GILTIG — ett tal ska komma från en människa, inte från en default', () => {
    // Regeln står i schemat: sätter koden ett tal börjar systemet larma på hela
    // beståndet utifrån en siffra ingen bestämt.
    const fel = validateEquipment({
      ...TOM_UTRUSTNING,
      kind: 'STOVE',
      installedAt: '2021-05-01',
      expectedLifespanYears: '',
      serviceIntervalMonths: '',
    })
    expect(fel).toEqual({})
    const payload = toCreatePayload('u1', {
      ...TOM_UTRUSTNING,
      kind: 'STOVE',
      installedAt: '2021-05-01',
    })
    // FÄLTET SKICKAS INTE ALLS — inte som undefined, inte som 0.
    expect('expectedLifespanYears' in payload).toBe(false)
    expect('serviceIntervalMonths' in payload).toBe(false)
    expect('label' in payload).toBe(false)
  })

  it('avvisar en förväntan som inte är ett helt positivt tal', () => {
    for (const dåligt of ['0', '-3', '2,5', 'abc']) {
      const fel = validateEquipment({
        ...TOM_UTRUSTNING,
        kind: 'BOILER',
        installedAt: '2020-01-01',
        expectedLifespanYears: dåligt,
      })
      expect(fel.expectedLifespanYears, `värdet ${dåligt} skulle ha avvisats`).toBeDefined()
    }
  })

  it('avvisar ett ogiltigt datum i stället för att skicka NaN', () => {
    const fel = validateEquipment({
      ...TOM_UTRUSTNING,
      kind: 'WINDOW',
      installedAt: 'inte-ett-datum',
    })
    expect(fel.installedAt).toBe('Ogiltigt datum')
  })
})

describe('bytesformuläret', () => {
  it('kräver när bytet skedde', () => {
    expect(validateReplacement(TOMT_BYTE).occurredAt).toBeDefined()
  })

  it('UTELÄMNAD kostnad är giltig och skickas INTE — okänt är inte noll', () => {
    const v = { ...TOMT_BYTE, occurredAt: '2026-02-20' }
    expect(validateReplacement(v)).toEqual({})
    const payload = toReplacementPayload(v)
    // Skillnaden mellan "gratis" och "vi vet inte" ska överleva formuläret.
    expect('cost' in payload).toBe(false)
  })

  it('NOLL kostnad skickas — det är ett svar, inte frånvaro av svar', () => {
    const payload = toReplacementPayload({ ...TOMT_BYTE, occurredAt: '2026-02-20', cost: '0' })
    expect(payload.cost).toBe(0)
  })

  it('tolkar svensk beloppsinmatning i stället för att ge NaN', () => {
    // "12 000,50" är hur en svensk hyresvärd skriver det, och Number() ger NaN.
    expect(tolkaBelopp('12 000,50')).toBe(12000.5)
    expect(tolkaBelopp('8500')).toBe(8500)
    expect(tolkaBelopp('')).toBeNull()
    expect(tolkaBelopp('inte ett tal')).toBeNull()
  })

  it('avvisar en negativ kostnad', () => {
    const fel = validateReplacement({ ...TOMT_BYTE, occurredAt: '2026-02-20', cost: '-5' })
    expect(fel.cost).toBeDefined()
  })

  it('utelämnad sort skickas inte — servern ärver då föregångarens', () => {
    const payload = toReplacementPayload({ ...TOMT_BYTE, occurredAt: '2026-02-20' })
    expect('kind' in payload).toBe(false)
    const medSort = toReplacementPayload({
      ...TOMT_BYTE,
      occurredAt: '2026-02-20',
      kind: 'DISHWASHER',
    })
    expect(medSort.kind).toBe('DISHWASHER')
  })
})
