/**
 * `@StrictIsoDatum()` MOT `IsoDatumSchema` — paritet, inte avvikelse.
 *
 * Fem former godtogs av `@IsISO8601()` och avvisades av schemat. Provet kräver
 * att de två nu svarar LIKADANT på varje form; det var tidigare en dokumenterad
 * avvikelse i paritetsprovet.
 */
import { ValidationPipe } from '@nestjs/common'
import { IsoDatumSchema } from '@eken/shared'

import { VALIDATION_PIPE_OPTIONS } from './validation-pipe-options'
import { StrictIsoDatum, arIsoDatum } from './strict-iso-datum.decorator'

class Datum {
  @StrictIsoDatum()
  paidDate!: string
}

const pipe = new ValidationPipe(VALIDATION_PIPE_OPTIONS)
const godtas = async (v: unknown) => {
  try {
    await pipe.transform({ paidDate: v }, { type: 'body', metatype: Datum as never })
    return true
  } catch {
    return false
  }
}

/** De fem former `@IsISO8601()` godtog men schemat avvisade. */
const AVVEK = ['2026', '2026-09', '2026-09-07T12:00:00', '20260907', '2026-W12']
const GILTIGA = ['2026-09-07', '2026-09-07T12:00:00Z', '2026-09-07T12:00:00+02:00']

describe('@StrictIsoDatum har PARITET med IsoDatumSchema', () => {
  it.each([...GILTIGA, ...AVVEK])('%s — DTO och schema svarar likadant', async (v) => {
    expect({ v, dto: await godtas(v) }).toEqual({ v, dto: IsoDatumSchema.safeParse(v).success })
  })

  it('DEN AVGÖRANDE: en tidsstämpel UTAN tidszon avvisas', async () => {
    // `new Date('2026-09-07T12:00:00')` tolkas i SERVERNS lokaltid. För ett
    // bokföringsdatum betyder det fel dag, och därmed fel period.
    expect(await godtas('2026-09-07T12:00:00')).toBe(false)
    expect(await godtas('2026-09-07T12:00:00Z')).toBe(true)
  })

  /**
   * `Date.parse` RULLAR ÖVER och duger inte som enda kontroll: `2026-02-30`
   * blir 2 mars, `2025-02-29` blir 1 mars — båda utan NaN. Zod avvisar dem.
   * Raderna nedan är paritet mot schemat, inte en egen regel.
   */
  it.each([
    ['2026-02-30', false],
    ['2025-02-29', false],
    ['2024-02-29', true],
    ['2026-13-01', false],
    ['2026-02-28', true],
  ])('omöjliga datum: %s → %p, samma som schemat', (v, vantat) => {
    expect(arIsoDatum(v)).toBe(vantat)
    expect(IsoDatumSchema.safeParse(v).success).toBe(vantat)
  })

  /**
   * KANARIEFÅGEL — mot INSTRUMENTET. Proven ovan är gröna om båda sidor säger
   * NEJ till allt. Den här kräver att sonden kan ge JA.
   */
  it('KANARIEFÅGEL: ett giltigt datum godtas av båda', async () => {
    expect(await godtas('2026-09-07')).toBe(true)
    expect(IsoDatumSchema.safeParse('2026-09-07').success).toBe(true)
  })
})
