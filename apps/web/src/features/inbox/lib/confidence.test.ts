import { describe, expect, it } from 'vitest'

import { formatKonfidens, formatTraffgrad, konfidensVariant } from './confidence'

describe('konfidensVariant — en signal, inte ett tillstånd', () => {
  it('≥ 0,8 är success', () => {
    expect(konfidensVariant(0.8)).toBe('success')
    expect(konfidensVariant(1)).toBe('success')
  })
  it('0,6–0,8 är warning', () => {
    expect(konfidensVariant(0.6)).toBe('warning')
    expect(konfidensVariant(0.79)).toBe('warning')
  })
  it('under 0,6 är danger', () => {
    expect(konfidensVariant(0.59)).toBe('danger')
    expect(konfidensVariant(0)).toBe('danger')
  })
  it('null är NEUTRALT — inte danger', () => {
    // "Modellen svarade inte" är inte samma sak som "modellen var osäker".
    // Ett rött märke hade påstått något om agenten som ingen mätt.
    expect(konfidensVariant(null)).toBe('default')
    expect(konfidensVariant(undefined)).toBe('default')
  })
})

describe('formatKonfidens', () => {
  it('svenskt decimaltecken', () => {
    expect(formatKonfidens(0.72)).toBe('0,72')
  })
  it('null blir tankstreck, inte 0,00', () => {
    expect(formatKonfidens(null)).toBe('—')
  })
})

describe('formatTraffgrad — tomt facit är inte noll procent', () => {
  it('utan facit: tankstreck', () => {
    // Hela poängen: 0 % hade fått en fungerande agent att se trasig ut sin
    // första dag, innan någon hunnit avsluta ett enda ärende.
    expect(formatTraffgrad({ category: { besvarade: 0, traffar: 0, andel: null } })).toBe('—')
    expect(formatTraffgrad(undefined)).toBe('—')
  })
  it('ett rätt och ett fel ger 50 %', () => {
    expect(
      formatTraffgrad({
        category: { besvarade: 2, traffar: 1, andel: 0.5 },
      }),
    ).toBe('50 %')
  })
  it('väger över FÄLT — ett fält utan facit sänker inte talet', () => {
    expect(
      formatTraffgrad({
        category: { besvarade: 2, traffar: 2, andel: 1 },
        assignedToId: { besvarade: 0, traffar: 0, andel: null },
      }),
    ).toBe('100 %')
  })
})
