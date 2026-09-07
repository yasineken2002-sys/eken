/**
 * `?unread=` genom den RIKTIGA pipen.
 *
 * Query-parametrar anländer alltid som sträng, så fältet är det tydligaste
 * fallet där `@StrictBoolean()` måste godta strängformen. Provet finns därför
 * att `"1"` och `"yes"` — som den borttagna äldre transformen hade tolkat som
 * `false` — nu avvisas i stället för att gissas.
 */
import { ValidationPipe } from '@nestjs/common'

import { VALIDATION_PIPE_OPTIONS } from '../common/contract/validation-pipe-options'
import { QueryNotificationsDto } from './dto/query-notifications.dto'

const pipe = new ValidationPipe(VALIDATION_PIPE_OPTIONS)
const genom = async (q: Record<string, unknown>) => {
  try {
    return {
      ok: true as const,
      ut: await pipe.transform(q, { type: 'query', metatype: QueryNotificationsDto as never }),
    }
  } catch {
    return { ok: false as const }
  }
}

describe('?unread genom den riktiga pipen', () => {
  it.each([
    ['true', true],
    ['false', false],
  ])('?unread=%s → %p', async (v, vantat) => {
    const r = await genom({ unread: v })
    expect(r.ok).toBe(true)
    expect(r.ok && (r.ut as { unread?: unknown }).unread).toBe(vantat)
  })

  it('utelämnad parameter är giltig', async () => {
    expect((await genom({})).ok).toBe(true)
  })

  it.each([['1'], ['yes'], ['0'], ['']])('?unread=%s avvisas med 400', async (v) => {
    expect((await genom({ unread: v })).ok).toBe(false)
  })
})
