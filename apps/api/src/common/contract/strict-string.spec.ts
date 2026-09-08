/**
 * `@StrictString()` MOT DEN RIKTIGA PIPEN.
 *
 * Pipen bygger ur `VALIDATION_PIPE_OPTIONS` — samma objekt `main.ts` läser.
 */
import { ValidationPipe } from '@nestjs/common'
import { IsOptional, IsString } from 'class-validator'

import { VALIDATION_PIPE_OPTIONS } from './validation-pipe-options'
import { StrictString } from './strict-string.decorator'

class Obligatorisk {
  @StrictString()
  skal!: string
}

class Valfri {
  @IsOptional()
  @StrictString()
  note?: string
}

const pipe = new ValidationPipe(VALIDATION_PIPE_OPTIONS)
const genom = async (dto: unknown, kropp: Record<string, unknown>) => {
  try {
    const ut = (await pipe.transform(kropp, { type: 'body', metatype: dto as never })) as Record<
      string,
      unknown
    >
    return { ok: true as const, ut }
  } catch (e) {
    const svar = (e as { getResponse?: () => unknown }).getResponse?.() as
      | { message?: string[] }
      | undefined
    return { ok: false as const, meddelanden: svar?.message ?? [] }
  }
}

describe('@StrictString mot den riktiga pipen', () => {
  it('en sträng passerar oförändrad', async () => {
    const r = await genom(Obligatorisk, { skal: 'Rättar felkontering' })
    expect(r.ok).toBe(true)
    expect(r.ok && r.ut['skal']).toBe('Rättar felkontering')
  })

  it.each([[1234567890], [3.14], [true], [null], [{ a: 1 }], [['a']]])(
    'DEN AVGÖRANDE: %p avvisas med 400',
    async (v) => {
      expect((await genom(Obligatorisk, { skal: v })).ok).toBe(false)
    },
  )

  it('OBJEKTFALLET blir aldrig "[object Object]"', async () => {
    const r = await genom(Obligatorisk, { skal: { a: 1 } })
    expect(r.ok).toBe(false)
    // …och det som INTE fick hända: att strängen lagrats som data.
    expect(JSON.stringify(r)).not.toContain('[object Object]')
  })

  it('felmeddelandet är svenskt och NAMNGER fältet', async () => {
    const r = await genom(Obligatorisk, { skal: { a: 1 } })
    const text = r.ok ? '' : r.meddelanden.join(' ')
    expect(text).toContain('skal')
    expect(text).toContain('måste vara text')
    expect(text).toContain('ett objekt')
  })

  it('@IsOptional fungerar — ett saknat fält är inte ett felaktigt fält', async () => {
    expect((await genom(Valfri, {})).ok).toBe(true)
  })

  /**
   * KANARIEFÅGEL — mot att koercionen ens finns.
   *
   * Utan dekoratorn gör pipen `String(1234567890)` och `String({})`. Om den
   * raden inte längre stämmer mäter proven ovan något annat än de tror.
   */
  it('KANARIEFÅGEL: UTAN dekoratorn blir talet och objektet strängar', async () => {
    class Oskyddad {
      @IsString()
      skal!: string
    }
    IsString()(Oskyddad.prototype, 'skal')

    const tal = await genom(Oskyddad, { skal: 1234567890 })
    expect(tal.ok).toBe(true)
    expect(tal.ok && tal.ut['skal']).toBe('1234567890')

    const objekt = await genom(Oskyddad, { skal: { a: 1 } })
    expect(objekt.ok).toBe(true)
    expect(objekt.ok && objekt.ut['skal']).toBe('[object Object]')
  })
})
