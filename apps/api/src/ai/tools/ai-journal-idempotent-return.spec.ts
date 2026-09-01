/**
 * SKRIVVÄGEN RETURNERAR DET BEFINTLIGA VERIFIKATET — den kastar inte P2002.
 *
 * Det unika indexet gör en dubblett OMÖJLIG (bevisat mot riktig Postgres i
 * `ai-journal-idempotens.db.spec.ts`). Men "omöjlig" kan se ut på två sätt för
 * den som använder systemet:
 *
 *   utan uppslaget före create → P2002 bubblar upp som ett internt fel
 *   med uppslaget              → det befintliga verifikatet returneras
 *
 * Bara det andra är idempotens. Den här specen äger den mekaniken; att
 * uppslaget över huvud taget finns i skrivvägen ägs av
 * `check-ai-journal-source.mjs`.
 */

jest.mock('../../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../../invoices/pdf.service', () => ({ PdfService: class {} }))

import { ToolExecutorService } from './tool-executor.service'
import { aiJournalSourceId } from './ai-journal-source'

const BEFINTLIGT = {
  id: 'je-befintligt',
  series: 'A',
  verNumber: 42,
  description: 'AI-verifikat',
  lines: [],
}

function makePrisma(befintligt: typeof BEFINTLIGT | null) {
  const create = jest.fn().mockResolvedValue({ ...BEFINTLIGT, id: 'je-nytt', verNumber: 43 })
  const findFirst = jest.fn().mockResolvedValue(befintligt)
  const tx = {
    journalEntry: { findFirst, create },
  }
  return {
    prisma: {
      // Perioden är öppen.
      accountingPeriodEvent: { findFirst: jest.fn().mockResolvedValue(null) },
      account: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'acc-1930', number: 1930 },
          { id: 'acc-2440', number: 2440 },
          { id: 'acc-5010', number: 5010 },
          { id: 'acc-2641', number: 2641 },
        ]),
      },
      $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
    },
    create,
    findFirst,
  }
}

function makeExecutor(prisma: unknown) {
  const noop = {} as never
  const verifikationsnummer = {
    allocate: jest.fn().mockResolvedValue({ series: 'A', verNumber: 43, fiscalYear: 2026 }),
  }
  const audit = {
    logToolExecution: jest.fn().mockResolvedValue(undefined),
    // Steg 3b: produktionsvägen öppnar och stänger spåret för FÖRE_EFFEKTEN-verktyg.
    beginToolExecution: jest.fn().mockResolvedValue(undefined),
    completeToolExecution: jest.fn().mockResolvedValue(undefined),
  }
  const args: unknown[] = Array.from({ length: 32 }, () => noop)
  args[0] = prisma
  args[9] = verifikationsnummer
  args[20] = audit
  return new (ToolExecutorService as unknown as new (...a: unknown[]) => ToolExecutorService)(
    ...args,
  )
}

function run(prisma: unknown, tool: string, input: Record<string, unknown>) {
  return (
    makeExecutor(prisma) as unknown as {
      executeToolUnsafe: (
        n: string,
        i: Record<string, unknown>,
        o: string,
        u: string,
        r: string,
      ) => Promise<{ success: boolean; message: string; data?: Record<string, unknown> }>
    }
  ).executeToolUnsafe(tool, input, 'org-1', 'user-1', 'OWNER')
}

const VERIFIKAT = {
  date: '2026-08-28',
  description: 'Omföring',
  lines: [
    { accountNumber: 1930, debit: 100 },
    { accountNumber: 2440, credit: 100 },
  ],
}
const UTGIFT = { date: '2026-08-28', description: 'Parkering', amount: 250, accountNumber: 5010 }

describe('create_journal_entry', () => {
  it('A1: finns verifikatet redan → INGET nytt skapas, det befintliga returneras', async () => {
    const { prisma, create } = makePrisma(BEFINTLIGT)
    const res = await run(prisma, 'create_journal_entry', VERIFIKAT)
    expect(create).not.toHaveBeenCalled()
    expect(res.success).toBe(true)
    expect(res.data?.alreadyExisted).toBe(true)
    expect(res.data?.id).toBe('je-befintligt')
  })

  it('A1: svaret SÄGER att inget skapades — "Verifikat skapat" vore en osanning', async () => {
    const { prisma } = makePrisma(BEFINTLIGT)
    const res = await run(prisma, 'create_journal_entry', VERIFIKAT)
    expect(res.message).toMatch(/finns redan/)
    expect(res.message).not.toMatch(/^Verifikat skapat/)
    // Och det pekar ut VILKET verifikat som gäller.
    expect(res.message).toContain('A42')
  })

  it('A2: finns det inte → skapas det, med nyckeln ur aiJournalSourceId', async () => {
    const { prisma, create } = makePrisma(null)
    const res = await run(prisma, 'create_journal_entry', VERIFIKAT)
    expect(create).toHaveBeenCalledTimes(1)
    expect(res.data?.alreadyExisted).toBe(false)
    expect(create.mock.calls[0]![0].data.sourceId).toBe(
      aiJournalSourceId('create_journal_entry', VERIFIKAT),
    )
  })

  it('uppslaget görs på samma (org, source, sourceId) som det unika indexet', async () => {
    const { prisma, findFirst } = makePrisma(null)
    await run(prisma, 'create_journal_entry', VERIFIKAT)
    expect(findFirst.mock.calls[0]![0].where).toEqual({
      organizationId: 'org-1',
      source: 'AI',
      sourceId: aiJournalSourceId('create_journal_entry', VERIFIKAT),
    })
  })
})

describe('record_expense', () => {
  it('A1: finns utgiften redan → INGET nytt verifikat, det befintliga returneras', async () => {
    const { prisma, create } = makePrisma(BEFINTLIGT)
    const res = await run(prisma, 'record_expense', UTGIFT)
    expect(create).not.toHaveBeenCalled()
    expect(res.data?.alreadyExisted).toBe(true)
    expect(res.message).toMatch(/redan bokförd/)
    expect(res.message).not.toMatch(/^Utgift bokförd/)
  })

  it('A2: en ANNAN utgift skapas — spärren hindrar inte riktigt arbete', async () => {
    const { prisma, create } = makePrisma(null)
    const res = await run(prisma, 'record_expense', { ...UTGIFT, amount: 251 })
    expect(create).toHaveBeenCalledTimes(1)
    expect(res.data?.alreadyExisted).toBe(false)
    expect(create.mock.calls[0]![0].data.sourceId).toBe(
      aiJournalSourceId('record_expense', { ...UTGIFT, amount: 251 }),
    )
    // ...och nyckeln skiljer sig från originalets.
    expect(create.mock.calls[0]![0].data.sourceId).not.toBe(
      aiJournalSourceId('record_expense', UTGIFT),
    )
  })
})
