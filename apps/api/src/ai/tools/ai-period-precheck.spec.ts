/**
 * T5 PR1b — AI-lagrets förhandsbesked om stängd period går via den DELADE
 * uppslagningen.
 *
 * PR1a samlade periodkontrollen i closed-period.ts, men TVÅ direktläsningar blev
 * kvar i AI-lagret: `create_journal_entry` och `record_expense` slog upp
 * `ClosedAccountingPeriod` på egen hand. De VERKSTÄLLER inget — allocate() stoppar
 * ändå — men när representationen byttes i PR1b hade de blivit TYSTA TILLÅTARE på
 * förhandskontrollnivå: de läser en tabell som inte längre bär sanningen, säger
 * "perioden är öppen", och användaren kommer halvvägs in i ett flöde innan den
 * riktiga spärren säger ifrån med ett annat besked.
 *
 * Testerna vaktar att de två vägarna nu ställer SAMMA fråga som spärren, och att
 * beskeden är oförändrade mot PR1a (noll beteendeändring).
 */

jest.mock('../../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../../invoices/pdf.service', () => ({ PdfService: class {} }))

import { ToolExecutorService } from './tool-executor.service'

/** Prisma-attrapp: periodens senaste händelse + tom kontoplan. */
function makePrisma(latest: { type: string } | null) {
  const findFirst = jest.fn().mockResolvedValue(latest)
  return {
    prisma: {
      accountingPeriodEvent: { findFirst },
      // #704 PR 1: förhandsbeskedet frågar bara om månaden, men allocate i
      // samma flöde frågar om året. Inget år är stängt här.
      fiscalYearClose: { findUnique: jest.fn().mockResolvedValue(null) },
      // Tom kontoplan → flöden som tar sig FÖRBI periodkontrollen stannar här,
      // med ett annat (och igenkännbart) besked.
      account: { findMany: jest.fn().mockResolvedValue([]) },
    },
    findFirst,
  }
}

function makeExecutor(prisma: unknown) {
  const noop = {} as never
  const audit = {
    logToolExecution: jest.fn().mockResolvedValue(undefined),
    // Steg 3b: produktionsvägen öppnar och stänger spåret för FÖRE_EFFEKTEN-verktyg.
    beginToolExecution: jest.fn().mockResolvedValue(undefined),
    completeToolExecution: jest.fn().mockResolvedValue(undefined),
  }
  return new ToolExecutorService(
    prisma as never, // 1 prisma
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
    audit as never, // 21 audit
    noop,
    noop,
    noop,
  )
}

async function run(prisma: unknown, tool: string, input: Record<string, unknown>) {
  const executor = makeExecutor(prisma)
  return (
    executor as unknown as {
      executeToolUnsafe: (
        name: string,
        input: Record<string, unknown>,
        orgId: string,
        userId: string,
        role: string,
      ) => Promise<{ success: boolean; message: string }>
    }
  ).executeToolUnsafe(tool, input, 'org-1', 'user-1', 'OWNER')
}

const ENTRY_INPUT = {
  date: '2026-03-15',
  description: 'Manuell post',
  lines: [
    { accountNumber: 1930, debit: 100 },
    { accountNumber: 3011, credit: 100 },
  ],
}
const EXPENSE_INPUT = {
  date: '2026-03-15',
  amount: 500,
  description: 'Reparation',
  accountNumber: 5070,
}

describe('T5 PR1b · AI-lagrets periodbesked delar uppslagning med spärren', () => {
  describe('create_journal_entry', () => {
    it('stängd period → samma besked som förut, inget verifikat påbörjas', async () => {
      const { prisma } = makePrisma({ type: 'CLOSED' })
      const res = await run(prisma, 'create_journal_entry', ENTRY_INPUT)

      expect(res.success).toBe(false)
      expect(res.message).toBe(
        'Bokföringsperioden 2026-03 är stängd. Ändra datum eller återöppna perioden manuellt.',
      )
      // Kontoplanen slås inte ens upp — kontrollen sker först.
      expect(prisma.account.findMany).not.toHaveBeenCalled()
    })

    it('aldrig stängd period → släpps förbi periodkontrollen', async () => {
      const { prisma } = makePrisma(null)
      const res = await run(prisma, 'create_journal_entry', ENTRY_INPUT)

      expect(res.message).not.toMatch(/stängd/)
      expect(prisma.account.findMany).toHaveBeenCalled()
    })

    it('senaste händelsen REOPENED → släpps förbi (perioden ÄR öppen)', async () => {
      const { prisma } = makePrisma({ type: 'REOPENED' })
      const res = await run(prisma, 'create_journal_entry', ENTRY_INPUT)

      expect(res.message).not.toMatch(/stängd/)
    })

    it('frågan är org-scopad, utan typfilter, på senaste seq', async () => {
      const { prisma, findFirst } = makePrisma({ type: 'CLOSED' })
      await run(prisma, 'create_journal_entry', ENTRY_INPUT)

      const args = findFirst.mock.calls[0]![0] as {
        where: Record<string, unknown>
        orderBy: Record<string, unknown>
      }
      expect(args.where).toEqual({ organizationId: 'org-1', year: 2026, month: 3 })
      expect(args.where).not.toHaveProperty('type')
      expect(args.orderBy).toEqual({ seq: 'desc' })
    })
  })

  describe('record_expense', () => {
    it('stängd period → samma besked som förut', async () => {
      const { prisma } = makePrisma({ type: 'CLOSED' })
      const res = await run(prisma, 'record_expense', EXPENSE_INPUT)

      expect(res.success).toBe(false)
      expect(res.message).toBe('Bokföringsperioden 2026-03 är stängd.')
      expect(prisma.account.findMany).not.toHaveBeenCalled()
    })

    it('aldrig stängd period → släpps förbi periodkontrollen', async () => {
      const { prisma } = makePrisma(null)
      const res = await run(prisma, 'record_expense', EXPENSE_INPUT)

      expect(res.message).not.toMatch(/stängd/)
      expect(prisma.account.findMany).toHaveBeenCalled()
    })
  })

  describe('Periodhärledningen är svensk civil tid på båda vägarna', () => {
    it.each(['create_journal_entry', 'record_expense'])(
      '%s: 2026-03-31T22:30Z klassas som APRIL (sommartid)',
      async (tool) => {
        const { prisma, findFirst } = makePrisma(null)
        const input =
          tool === 'create_journal_entry'
            ? { ...ENTRY_INPUT, date: '2026-03-31T22:30:00Z' }
            : { ...EXPENSE_INPUT, date: '2026-03-31T22:30:00Z' }
        await run(prisma, tool, input)

        const args = findFirst.mock.calls[0]![0] as { where: { year: number; month: number } }
        expect(args.where).toMatchObject({ year: 2026, month: 4 })
      },
    )
  })
})
