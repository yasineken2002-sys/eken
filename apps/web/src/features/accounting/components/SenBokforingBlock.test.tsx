import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

import { SEN_BOKFORING_MIN_SKAL } from '@eken/shared'

import { SenBokforingBlock, skalDugerForSenBokforing } from './SenBokforingBlock'

/**
 * BLOCKET FÖR SEN BOKFÖRING — vad operatören ser, och vem som ser vad.
 *
 * ── VAD PROVET INTE KAN SE ──────────────────────────────────────────────────
 *
 * Att blocket VISAS vid rätt tillfälle. Villkoret (`aretStangt`) bor i de två
 * dialogerna och bygger på `useSenBokforingsLage`; här mäts komponenten när den
 * väl renderas. Att hooken frågar rätt sak prövas separat nedan i
 * `useSenBokforing.test.ts` (datumdelningen), och att bara ÅRET — aldrig
 * månaden — utlöser den är ett API-beteende som ägs av db-specen.
 *
 * Att rollspärren GÄLLER ägs inte heller av den här filen: `assertFarBokforaSent`
 * i API:t är spärren, det här döljer bara ett fält som ändå hade gett 403.
 */
describe('SenBokforingBlock', () => {
  const grund = { arsetikett: '2025', skal: '', onSkalChange: () => {} }

  it('förklarar vad som händer: första öppna dag, datumet bevaras', () => {
    render(<SenBokforingBlock {...grund} roll="OWNER" />)
    expect(screen.getByTestId('sen-bokforing')).toBeTruthy()
    expect(screen.getByText(/Räkenskapsåret 2025 är stängt/)).toBeTruthy()
    expect(screen.getByText(/första öppna dag/)).toBeTruthy()
    expect(screen.getByText(/bevaras/)).toBeTruthy()
  })

  it('ÄGAREN får ett skälfält', () => {
    render(<SenBokforingBlock {...grund} roll="OWNER" />)
    expect(screen.getByLabelText('Skäl till sen bokföring')).toBeTruthy()
    expect(screen.queryByTestId('sen-bokforing-ej-agare')).toBeNull()
  })

  it.each(['MANAGER', 'ADMIN', 'ACCOUNTANT', 'VIEWER', undefined])(
    '%s ser texten om att en ägare krävs, och INGET skälfält',
    (roll) => {
      render(<SenBokforingBlock {...grund} roll={roll} />)
      expect(screen.getByTestId('sen-bokforing-ej-agare')).toBeTruthy()
      expect(screen.getByText(/Bara organisationens ägare/)).toBeTruthy()
      expect(screen.queryByLabelText('Skäl till sen bokföring')).toBeNull()
    },
  )

  it('ett för kort skäl får ett felmeddelande — och gränsen LÄSES ur schemat', () => {
    // Talet skrivs inte här. Skulle `SEN_BOKFORING_MIN_SKAL` ändras i
    // @eken/shared följer både DTO:n, Zod-schemat och det här provet med.
    const forKort = 'x'.repeat(SEN_BOKFORING_MIN_SKAL - 1)
    render(<SenBokforingBlock {...grund} roll="OWNER" skal={forKort} />)
    expect(
      screen.getByText(`Skälet måste vara minst ${SEN_BOKFORING_MIN_SKAL} tecken`),
    ).toBeTruthy()
  })

  it('ett tomt fält larmar INTE — man har inte skrivit fel, man har inte börjat', () => {
    render(<SenBokforingBlock {...grund} roll="OWNER" skal="" />)
    expect(screen.queryByText(/minst \d+ tecken/)).toBeNull()
  })

  it('ett tillräckligt skäl larmar inte', () => {
    render(<SenBokforingBlock {...grund} roll="OWNER" skal={'x'.repeat(SEN_BOKFORING_MIN_SKAL)} />)
    expect(screen.queryByText(/minst \d+ tecken/)).toBeNull()
  })

  it('skrivning når anroparen', () => {
    const onSkalChange = vi.fn()
    render(<SenBokforingBlock {...grund} roll="OWNER" onSkalChange={onSkalChange} />)
    fireEvent.change(screen.getByLabelText('Skäl till sen bokföring'), {
      target: { value: 'Kom in i december' },
    })
    expect(onSkalChange).toHaveBeenCalledWith('Kom in i december')
  })
})

describe('skalDugerForSenBokforing', () => {
  it('kräver minst schemats min-längd EFTER trimning', () => {
    expect(skalDugerForSenBokforing('')).toBe(false)
    expect(skalDugerForSenBokforing(' '.repeat(SEN_BOKFORING_MIN_SKAL + 5))).toBe(false)
    expect(skalDugerForSenBokforing('x'.repeat(SEN_BOKFORING_MIN_SKAL - 1))).toBe(false)
    expect(skalDugerForSenBokforing('x'.repeat(SEN_BOKFORING_MIN_SKAL))).toBe(true)
  })

  it('KANARIEFÅGEL: gränsen kommer från schemat, inte från en literal här', () => {
    // Utan den här raden kunde provet ovan vara grönt mot ett eget tal — och
    // klienten släppa igenom något servern avvisar.
    expect(SEN_BOKFORING_MIN_SKAL).toBeGreaterThan(0)
    expect(skalDugerForSenBokforing('x'.repeat(SEN_BOKFORING_MIN_SKAL - 1))).toBe(false)
  })
})
