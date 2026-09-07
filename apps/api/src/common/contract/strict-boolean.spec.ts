/**
 * `@StrictBoolean()` MOT DEN RIKTIGA PIPEN.
 *
 * Provet bygger sin pipe ur `VALIDATION_PIPE_OPTIONS` — samma objekt `main.ts`
 * läser. Ett prov som bygger en egen konfiguration mäter en pipe som inte finns;
 * det var precis den defekten #830 hittade i paritetsprovet.
 */
import { ValidationPipe } from '@nestjs/common'
import { IsOptional } from 'class-validator'

import { VALIDATION_PIPE_OPTIONS } from './validation-pipe-options'
import { StrictBoolean } from './strict-boolean.decorator'

class Obligatorisk {
  @StrictBoolean()
  bekraftad!: boolean
}

class Valfri {
  @IsOptional()
  @StrictBoolean()
  flagga?: boolean
}

const pipe = new ValidationPipe(VALIDATION_PIPE_OPTIONS)

async function genom(dto: unknown, kropp: Record<string, unknown>) {
  try {
    const ut = (await pipe.transform(kropp, { type: 'body', metatype: dto as never })) as Record<
      string,
      unknown
    >
    return { ok: true as const, varde: ut }
  } catch (e) {
    const svar = (e as { getResponse?: () => unknown }).getResponse?.() as
      | { message?: string[] }
      | undefined
    return { ok: false as const, meddelanden: svar?.message ?? [] }
  }
}

describe('@StrictBoolean mot den riktiga pipen', () => {
  it.each([
    ['false', false],
    ['true', true],
    [false, false],
    [true, true],
  ])('%p → %p', async (in_, ut) => {
    const r = await genom(Obligatorisk, { bekraftad: in_ })
    expect(r.ok).toBe(true)
    expect(r.ok && r.varde['bekraftad']).toBe(ut)
  })

  it.each([['yes'], ['0'], [1], [''], ['FALSE'], [null], [0]])(
    'DEN AVGÖRANDE: %p avvisas med 400',
    async (in_) => {
      const r = await genom(Obligatorisk, { bekraftad: in_ })
      expect(r.ok).toBe(false)
    },
  )

  it('felmeddelandet är svenskt och NAMNGER fältet', async () => {
    const r = await genom(Obligatorisk, { bekraftad: 'yes' })
    expect(r.ok).toBe(false)
    const text = r.ok ? '' : r.meddelanden.join(' ')
    expect(text).toContain('bekraftad')
    expect(text).toContain('måste vara true eller false')
    expect(text).toContain('strängen "yes"')
  })

  it('@IsOptional fungerar — ett SAKNAT fält är inte ett felaktigt fält', async () => {
    const r = await genom(Valfri, {})
    expect(r.ok).toBe(true)
  })

  it('men ett NÄRVARANDE felaktigt värde avvisas även när fältet är valfritt', async () => {
    const r = await genom(Valfri, { flagga: 'yes' })
    expect(r.ok).toBe(false)
  })

  /**
   * KANARIEFÅGEL — mot INSTRUMENTET.
   *
   * Proven ovan är gröna om pipen avvisar. De vore också gröna om pipen avvisade
   * ALLT — om metatypen aldrig lästes, eller om riggen skickade fel kropp. Den
   * här kräver att sonden kan ge motsatt utfall på samma väg.
   */
  it('KANARIEFÅGEL: samma rigg SLÄPPER IGENOM ett giltigt värde', async () => {
    const r = await genom(Obligatorisk, { bekraftad: true })
    expect(r.ok).toBe(true)
  })

  /**
   * KANARIEFÅGEL 2 — mot att koercionen ens finns.
   *
   * Utan `@StrictBoolean` gör pipen `Boolean('false') === true`. Om den raden
   * inte längre stämmer är hela dekoratorn onödig, och proven ovan mäter något
   * annat än de tror.
   */
  it('KANARIEFÅGEL: UTAN dekoratorn gör pipen "false" till true', async () => {
    const { IsBoolean } = await import('class-validator')
    class Oskyddad {
      @IsBoolean()
      bekraftad!: boolean
    }
    // Dekoratorn appliceras dynamiskt så klassen inte fångas av vakten.
    IsBoolean()(Oskyddad.prototype, 'bekraftad')
    const r = await genom(Oskyddad, { bekraftad: 'false' })
    expect(r.ok).toBe(true)
    expect(r.ok && r.varde['bekraftad']).toBe(true)
  })
})
