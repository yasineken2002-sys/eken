/**
 * Atomär, race-säker allokering av PLATTFORMS-fakturanummer. Ersätter den
 * tidigare count()+1-racen (nextInvoiceNumber) som kunde ge två fakturor SAMMA
 * nummer. Speglar invoice-number.spec.ts (org-fakturor).
 */

import { allocatePlatformInvoiceNumber } from './platform-invoice-number'

// Mock-tx vars upsert-increment är ATOMÄR (som Postgres row-lock): en delad
// räknare per scope, en synkron läs-öka-skriv utan await-gap emellan → speglar
// att två samtidiga UPSERT ...increment serialiseras och aldrig ger samma tal.
function statefulTx(seed: Record<string, number> = {}) {
  const counters: Record<string, number> = { ...seed }
  const upsert = jest.fn(
    async ({ where, create }: { where: { scope: string }; create: { lastNumber: number } }) => {
      const scope = where.scope
      counters[scope] = counters[scope] === undefined ? create.lastNumber : counters[scope] + 1
      return { lastNumber: counters[scope] }
    },
  )
  return { platformInvoiceNumberSequence: { upsert }, _counters: counters, _upsert: upsert }
}

const JUL_2026 = new Date('2026-07-14T10:00:00.000Z')

describe('allocatePlatformInvoiceNumber', () => {
  it('PLAN_FEE → PLT-{år}-{nnnnn} (5 siffror)', async () => {
    const tx = statefulTx({ 'PLT-2026': 41 })
    const n = await allocatePlatformInvoiceNumber(tx as never, 'PLAN_FEE', JUL_2026)
    expect(n).toBe('PLT-2026-00042')
  })

  it('OTHER delar PLT-årsserie med PLAN_FEE', async () => {
    const tx = statefulTx({ 'PLT-2026': 41 })
    const n = await allocatePlatformInvoiceNumber(tx as never, 'OTHER', JUL_2026)
    expect(n).toBe('PLT-2026-00042')
  })

  it('AI_CREDITS → CR-{åååmm}-{nnnn} (4 siffror, egen månadsserie)', async () => {
    const tx = statefulTx({ 'CR-202607': 3 })
    const n = await allocatePlatformInvoiceNumber(tx as never, 'AI_CREDITS', JUL_2026)
    expect(n).toBe('CR-202607-0004')
  })

  it('första numret i en ny serie börjar på 1 (create-grenen)', async () => {
    const tx = statefulTx()
    expect(await allocatePlatformInvoiceNumber(tx as never, 'PLAN_FEE', JUL_2026)).toBe(
      'PLT-2026-00001',
    )
  })

  it('använder ATOMÄR upsert med increment (Postgres row-lock, race-säker)', async () => {
    const tx = statefulTx()
    await allocatePlatformInvoiceNumber(tx as never, 'PLAN_FEE', JUL_2026)
    expect(tx._upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { scope: 'PLT-2026' },
        create: { scope: 'PLT-2026', lastNumber: 1 },
        update: { lastNumber: { increment: 1 } },
      }),
    )
  })

  it('två samtidiga allokeringar i samma serie får OLIKA nummer (ingen kollision)', async () => {
    const tx = statefulTx({ 'PLT-2026': 0 })
    const [a, b] = await Promise.all([
      allocatePlatformInvoiceNumber(tx as never, 'PLAN_FEE', JUL_2026),
      allocatePlatformInvoiceNumber(tx as never, 'PLAN_FEE', JUL_2026),
    ])
    expect(a).not.toBe(b)
    expect(new Set([a, b])).toEqual(new Set(['PLT-2026-00001', 'PLT-2026-00002']))
  })

  it('olika serier (PLT vs CR) räknas oberoende', async () => {
    const tx = statefulTx()
    const plt = await allocatePlatformInvoiceNumber(tx as never, 'PLAN_FEE', JUL_2026)
    const cr = await allocatePlatformInvoiceNumber(tx as never, 'AI_CREDITS', JUL_2026)
    expect(plt).toBe('PLT-2026-00001')
    expect(cr).toBe('CR-202607-0001')
  })
})
