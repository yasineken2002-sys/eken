import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * DEN OMVÄNDA RIKTNINGEN: kan en inloggad användare koppla BankID till NÅGON
 * ANNANS konto?
 *
 * Spärren ligger i API:t (#745 PR 2): `enrollCollect` läser ordern, som bär det
 * `userId` den STARTADES av, och kastar 403 när den inloggade inte är den
 * användaren. Provet `CSRF: en ANNAN användares collect på samma orderRef NEKAS`
 * bär den halvan.
 *
 * Det här provet bär den andra halvan, och den är inte samma fråga: att KLIENTEN
 * aldrig ens försöker bestämma vem ordern gäller. Ett UI som skickade med ett
 * userId hade fungerat lika bra mot dagens server — servern ignorerar fältet —
 * men det hade sett ut som en parameter, och nästa person som rör
 * `enrollCollect` hade kunnat börja läsa den. Formen är därför en del av
 * spärren, inte kosmetik.
 *
 * MÄTT PÅ DEN SKICKADE KROPPEN, inte på funktionssignaturen: en signatur går att
 * hålla ren medan anropet bygger sitt eget objekt. Nyckelmängden är det som
 * faktiskt lämnar webbläsaren.
 */

const post = vi.fn()
const get = vi.fn()
const del = vi.fn()

vi.mock('@/lib/api', () => ({
  post: (...args: unknown[]) => post(...args) as unknown,
  get: (...args: unknown[]) => get(...args) as unknown,
  del: (...args: unknown[]) => del(...args) as unknown,
  api: {},
}))

const {
  bankIdEnrollCollect,
  bankIdEnrollStart,
  bankIdLoginChoose,
  bankIdLoginCollect,
  bankIdLoginStart,
  bankIdRemoveIdentity,
} = await import('./bankid.api')

beforeEach(() => {
  post.mockReset().mockResolvedValue({})
  get.mockReset().mockResolvedValue([])
  del.mockReset().mockResolvedValue(undefined)
})

/** Kroppen i det senaste post-anropet, som en nyckelmängd. */
function skickadeNycklar(): string[] {
  const body = post.mock.calls.at(-1)?.[1] as Record<string, unknown> | undefined
  return Object.keys(body ?? {}).sort()
}

describe('vad klienten skickar', () => {
  it('enroll/collect skickar ENDAST orderRef — aldrig ett userId', async () => {
    await bankIdEnrollCollect('order-1')
    expect(post).toHaveBeenCalledWith('/auth/bankid/enroll/collect', { orderRef: 'order-1' })
    expect(skickadeNycklar()).toEqual(['orderRef'])
  })

  it('login/collect skickar ENDAST orderRef', async () => {
    await bankIdLoginCollect('order-2')
    expect(skickadeNycklar()).toEqual(['orderRef'])
  })

  it('start-anropen bär ingen identitet alls', async () => {
    await bankIdEnrollStart()
    expect(skickadeNycklar()).toEqual([])
    await bankIdLoginStart()
    expect(skickadeNycklar()).toEqual([])
  })

  it('KANARIEFÅGEL: kontovalet ÄR det enda som får bära ett userId', async () => {
    // Utan den här raden går det inte att skilja "klienten skickar aldrig userId"
    // från "provet tittar på fel sak". Kontovalet är undantaget med avsikt:
    // användaren väljer mellan sina EGNA konton, och servern kontrollerar ändå
    // att kontot hör till den identifierade personen.
    await bankIdLoginChoose('ct', 'u2')
    expect(skickadeNycklar()).toEqual(['chooseToken', 'userId'])
  })

  it('bortkopplingen adresserar raden i URL:en, utan kropp', async () => {
    await bankIdRemoveIdentity('ident-1')
    expect(del).toHaveBeenCalledWith('/auth/bankid/identity/ident-1')
    expect(del.mock.calls.at(-1)).toHaveLength(1)
  })
})
