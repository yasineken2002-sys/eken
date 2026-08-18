/**
 * VAKT: ett AI-skapat verifikat ska inte gå att förväxla med ett handskrivet.
 *
 * Före #494 beslut 4 skrev båda AI-vägarna `source: 'MANUAL', createdById: userId`.
 * Ett verifikat som en modell hade satt ihop var därmed bit för bit identiskt med
 * ett som en människa knappat in — och det fanns ingen väg tillbaka till
 * verktygsloggen, eftersom ingen referens skrevs.
 *
 * Testerna nedan kör den RIKTIGA `executeToolUnsafe` mot en prisma-attrapp och
 * läser vad som faktiskt skulle ha skrivits. Återinför någon `source: 'MANUAL'`
 * på AI-vägen faller de.
 *
 * Vad de INTE påstår: att `createdById` ska bort. Den bär användaren som BAD om
 * posten, och det är fortfarande den ansvariga människan. Testet låser fast att
 * den står kvar.
 */

jest.mock('../../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../../invoices/pdf.service', () => ({ PdfService: class {} }))

import { ToolExecutorService } from './tool-executor.service'

type Created = Record<string, unknown>

/**
 * Prisma-attrapp: öppen period, en kontoplan som räcker för båda verktygen, och
 * en $transaction som fångar det som skulle ha skrivits.
 */
function makePrisma(created: Created[]) {
  const accounts = [
    { id: 'acc-1930', number: 1930, name: 'Bank', type: 'ASSET', isActive: true },
    { id: 'acc-3011', number: 3011, name: 'Hyresintäkt', type: 'REVENUE', isActive: true },
    { id: 'acc-5010', number: 5010, name: 'Lokalhyra', type: 'EXPENSE', isActive: true },
    { id: 'acc-2641', number: 2641, name: 'Ingående moms', type: 'ASSET', isActive: true },
  ]
  const tx = {
    journalEntry: {
      create: jest.fn(async (args: { data: Created }) => {
        created.push(args.data)
        return { id: 'je-1', ...args.data, lines: [] }
      }),
    },
  }
  return {
    accountingPeriodEvent: { findFirst: jest.fn().mockResolvedValue(null) },
    closedAccountingPeriod: { findFirst: jest.fn().mockResolvedValue(null) },
    account: {
      findMany: jest.fn().mockResolvedValue(accounts),
      findFirst: jest.fn(
        async (args: { where?: { number?: number } }) =>
          accounts.find((a) => a.number === args?.where?.number) ?? null,
      ),
    },
    $transaction: jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx)),
  }
}

function makeExecutor(prisma: unknown) {
  const noop = {} as never
  const verifikationsnummer = {
    allocate: jest.fn().mockResolvedValue({ series: 'A', verNumber: 1, fiscalYear: 2026 }),
  }
  const audit = { logToolExecution: jest.fn().mockResolvedValue(undefined) }
  const svc = new ToolExecutorService(
    prisma as never,
    noop,
    noop,
    noop,
    noop,
    noop,
    noop,
    noop,
    noop,
    noop,
    noop,
    noop,
    noop,
    noop,
    noop,
    noop,
    noop,
    noop,
    noop,
    noop,
    audit as never,
    noop,
    noop,
    noop,
  )
  // Verifikationsnummerserien injiceras positionellt i konstruktorn; hitta den
  // egenskap som bär allocate() och ersätt den, så testet inte pinnas till ett
  // argumentindex som flyttar sig.
  const holder = svc as unknown as Record<string, { allocate?: unknown }>
  for (const key of Object.keys(holder)) {
    if (holder[key] && typeof holder[key] === 'object' && 'allocate' in (holder[key] as object)) {
      holder[key] = verifikationsnummer as never
    }
  }
  if (!Object.values(holder).some((v) => v === (verifikationsnummer as unknown))) {
    // Ingen befintlig egenskap bar allocate — sätt den på det namn koden använder.
    holder['verifikationsnummer'] = verifikationsnummer as never
  }
  return svc
}

type Unsafe = (
  name: string,
  input: Record<string, unknown>,
  orgId: string,
  userId: string,
  role: string,
  executionId?: string,
) => Promise<{ success: boolean; message?: string }>

async function run(tool: string, input: Record<string, unknown>, executionId?: string) {
  const created: Created[] = []
  const svc = makeExecutor(makePrisma(created))
  const unsafe = (svc as unknown as { executeToolUnsafe: Unsafe }).executeToolUnsafe.bind(svc)
  const result = await unsafe(tool, input, 'org-1', 'user-1', 'OWNER', executionId)
  return { created, result }
}

const JOURNAL_INPUT = {
  date: '2026-08-18',
  description: 'AI-bokförd post',
  lines: [
    { accountNumber: 1930, debit: 100 },
    { accountNumber: 3011, credit: 100 },
  ],
}

const EXPENSE_INPUT = {
  date: '2026-08-18',
  description: 'Städning',
  accountNumber: 5010,
  amount: 100,
}

describe('AI-skapade verifikat är märkta som AI', () => {
  it('create_journal_entry skriver source AI — inte MANUAL', async () => {
    const { created } = await run('create_journal_entry', JOURNAL_INPUT, 'exec-1')
    expect(created).toHaveLength(1)
    expect(created[0]!['source']).toBe('AI')
    expect(created[0]!['source']).not.toBe('MANUAL')
  })

  it('record_expense skriver source AI — inte MANUAL', async () => {
    const { created } = await run('record_expense', EXPENSE_INPUT, 'exec-2')
    expect(created).toHaveLength(1)
    expect(created[0]!['source']).toBe('AI')
    expect(created[0]!['source']).not.toBe('MANUAL')
  })

  it('verifikatet pekar på verktygskörningen', async () => {
    const { created } = await run('create_journal_entry', JOURNAL_INPUT, 'exec-3')
    expect(created[0]!['aiToolExecutionId']).toBe('exec-3')
  })

  it('utan förhandsallokerat id skrivs posten ändå, med null-referens', async () => {
    // Referensen är en bekvämlighet; märkningen är faktumet. Att den saknas får
    // aldrig göra posten omärkt.
    const { created } = await run('create_journal_entry', JOURNAL_INPUT)
    expect(created[0]!['source']).toBe('AI')
    expect(created[0]!['aiToolExecutionId']).toBeNull()
  })

  it('createdById står kvar — människan som bad om posten är fortfarande ansvarig', async () => {
    const { created } = await run('create_journal_entry', JOURNAL_INPUT, 'exec-4')
    expect(created[0]!['createdById']).toBe('user-1')
  })
})
