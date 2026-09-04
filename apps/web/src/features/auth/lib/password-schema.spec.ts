import { describe, it, expect } from 'vitest'
import { passwordSchema, readErrorMessage } from './password-schema'

/**
 * Två påståenden:
 *
 *   1. `passwordSchema` är samma källa som backend använder — inte en egen
 *      kopia av kraven. Ett formulär som validerar svagare än API:t ger ett
 *      serverfel efter inskicket i stället för ett fältfel medan man skriver.
 *   2. `readErrorMessage` gräver fram API:ets meddelande ur axios-formen, och
 *      faller tillbaka i ALLA andra fall — den får aldrig kasta, för då byts
 *      ett felmeddelande mot en vit sida.
 */

describe('passwordSchema', () => {
  it('avvisar ett för kort lösenord', () => {
    expect(passwordSchema.safeParse('Kort1!').success).toBe(false)
  })

  it('kräver versal, gemen, siffra och specialtecken', () => {
    // Samma fyra krav som register.dto.ts. Ett prov per saknad klass, så att
    // ett borttaget krav inte döljs av att de andra fortfarande fäller.
    expect(passwordSchema.safeParse('testlosen123!').success).toBe(false) // ingen versal
    expect(passwordSchema.safeParse('TESTLOSEN123!').success).toBe(false) // ingen gemen
    expect(passwordSchema.safeParse('TestLosenOrd!').success).toBe(false) // ingen siffra
    expect(passwordSchema.safeParse('TestLosen1234').success).toBe(false) // inget specialtecken
  })

  it('godkänner ett lösenord som uppfyller allt', () => {
    // Motprovet. Utan det kan schemat avvisa ALLT och proven ovan vara gröna.
    expect(passwordSchema.safeParse('TestLosen123!').success).toBe(true)
  })
})

describe('readErrorMessage', () => {
  it('gräver fram API:ets meddelande ur axios-felets form', () => {
    const err = { response: { data: { error: { message: 'Organisationsnumret finns redan' } } } }
    expect(readErrorMessage(err, 'reserv')).toBe('Organisationsnumret finns redan')
  })

  it('faller tillbaka när någon nivå saknas', () => {
    // Varje nivå för sig: en optional chain som tappas ger annars ett kast i
    // en catch-gren, alltså ett fel medan man visar ett fel.
    expect(readErrorMessage({}, 'reserv')).toBe('reserv')
    expect(readErrorMessage({ response: {} }, 'reserv')).toBe('reserv')
    expect(readErrorMessage({ response: { data: {} } }, 'reserv')).toBe('reserv')
    expect(readErrorMessage({ response: { data: { error: {} } } }, 'reserv')).toBe('reserv')
  })

  it('faller tillbaka för null, undefined och primitiver utan att kasta', () => {
    // Ett nätverksfel ger ett Error utan `response` alls.
    expect(readErrorMessage(null, 'reserv')).toBe('reserv')
    expect(readErrorMessage(undefined, 'reserv')).toBe('reserv')
    expect(readErrorMessage('trasig sträng', 'reserv')).toBe('reserv')
    expect(readErrorMessage(new Error('Network Error'), 'reserv')).toBe('reserv')
  })
})
