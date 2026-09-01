/**
 * #325 — AI-VERKTYGENS ÖVERFÖRFALLNA BELOPP ÄR RESTSKULDEN.
 *
 * `OverdueDebtService` bar huvudfelet, men tre verktyg i ToolExecutorService
 * räknade `Invoice.total` på egen hand och presenterade det som skuld:
 *
 *   • `get_overdue_invoices`      — lämnade bara `total` till modellen, som
 *                                    därmed inte KUNDE svara något annat än
 *                                    ursprungsbeloppet.
 *   • `analyze_payment_behavior`  — fältet hette "utestående" och bar totalen.
 *   • `find_optimization_opportunities` — "Förfallna fakturor >30 dagar (n st,
 *                                    X kr)" på ursprungsbelopp.
 *
 * Underlaget nedan är genomgående ärendets fall: 10 000 fakturerat, 9 000
 * allokerat → 1 000 kvar. Varje test bär en NEGATIVKONTROLL mot 10 000, annars
 * hade det varit grönt även med den gamla koden.
 */

jest.mock('../../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../../invoices/pdf.service', () => ({ PdfService: class {} }))

import { ToolExecutorService } from './tool-executor.service'

const FAKTURERAT = 10000
const ALLOKERAT = 9000
const RESTSKULD = FAKTURERAT - ALLOKERAT // 1000
const DAY = 86_400_000

function makeExecutor(prisma: unknown) {
  const noop = {} as never
  return new ToolExecutorService(
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
    {
      logToolExecution: jest.fn().mockResolvedValue(undefined),
      // Steg 3b: produktionsvägen öppnar och stänger spåret för FÖRE_EFFEKTEN-verktyg.
      beginToolExecution: jest.fn().mockResolvedValue(undefined),
      completeToolExecution: jest.fn().mockResolvedValue(undefined),
    } as never,
    noop,
    noop,
    noop,
  )
}

async function run(prisma: unknown, tool: string, input: Record<string, unknown> = {}) {
  return (
    makeExecutor(prisma) as unknown as {
      executeToolUnsafe: (
        name: string,
        input: Record<string, unknown>,
        orgId: string,
        userId: string,
        role: string,
      ) => Promise<{ success: boolean; message: string; data?: unknown }>
    }
  ).executeToolUnsafe(tool, input, 'org-1', 'user-1', 'OWNER')
}

const TENANT = {
  id: 't1',
  type: 'INDIVIDUAL',
  firstName: 'Anna',
  lastName: 'Andersson',
  companyName: null,
  email: 'anna@example.se',
}

describe('#325 · get_overdue_invoices lämnar restskulden till modellen', () => {
  it('varje faktura bär `outstanding`; `total` finns kvar som fakturerat belopp', async () => {
    const prisma = {
      invoice: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'inv-1',
            invoiceNumber: 'F-1',
            total: FAKTURERAT,
            dueDate: new Date(Date.now() - 5 * DAY),
            payments: [{ amount: ALLOKERAT }],
            creditNotes: [],
            tenant: TENANT,
          },
        ]),
      },
    }

    const res = await run(prisma, 'get_overdue_invoices')
    const rows = res.data as Array<{ outstanding: number; total: number }>

    expect(rows[0]?.outstanding).toBe(RESTSKULD)
    // NEGATIVKONTROLL: hade fältet härletts ur `total` vore det 10 000.
    expect(rows[0]?.outstanding).not.toBe(FAKTURERAT)
    // `total` tas INTE bort — fakturerat och återstående är två olika, båda
    // sanna, uppgifter.
    expect(rows[0]?.total).toBe(FAKTURERAT)
  })
})

describe('#325 · analyze_payment_behavior — "utestående" betyder utestående', () => {
  it('en delbetald OVERDUE-faktura bidrar med resten, inte med hela beloppet', async () => {
    const prisma = {
      invoice: {
        findMany: jest.fn().mockResolvedValue([
          {
            tenantId: 't1',
            paidAt: null,
            dueDate: new Date(Date.now() - 5 * DAY),
            total: FAKTURERAT,
            status: 'OVERDUE',
            payments: [{ amount: ALLOKERAT }],
            creditNotes: [],
            tenant: TENANT,
          },
        ]),
      },
    }

    const res = await run(prisma, 'analyze_payment_behavior')
    const rows = res.data as Record<string, { outstandingTotal: number }>

    // #347 döpte om fältet (outstandingTotal/Own/AtCollection); talet är
    // detsamma som #325 låste.
    expect(rows['t1']?.outstandingTotal).toBe(RESTSKULD)
    expect(rows['t1']?.outstandingTotal).not.toBe(FAKTURERAT)
    // Prosan som modellen läser måste bära samma tal som strukturdatan.
    //
    // HÅRT MELLANSLAG: `toLocaleString('sv-SE')` ger U+00A0. Stod det "10 000"
    // med vanligt mellanslag här kunde negativkontrollen aldrig matcha och var
    // alltså tyst grön oavsett vad koden gjorde. (Upptäckt i #347.)
    expect(res.message).toContain('utestående')
    expect(res.message).not.toContain(FAKTURERAT.toLocaleString('sv-SE'))
    expect(res.message).toContain(RESTSKULD.toLocaleString('sv-SE'))
  })

  it('fullt obetald faktura är oförändrad — fixen rör bara de delbetalda', async () => {
    const prisma = {
      invoice: {
        findMany: jest.fn().mockResolvedValue([
          {
            tenantId: 't1',
            paidAt: null,
            dueDate: new Date(Date.now() - 5 * DAY),
            total: 4000,
            status: 'SENT',
            payments: [],
            creditNotes: [],
            tenant: TENANT,
          },
        ]),
      },
    }

    const res = await run(prisma, 'analyze_payment_behavior')
    expect((res.data as Record<string, { outstandingTotal: number }>)['t1']?.outstandingTotal).toBe(
      4000,
    )
  })
})

describe('#325 · find_optimization_opportunities — belopp OCH antal mäter samma mängd', () => {
  // Två fakturor >30 dagar: en reglerad (outstanding 0, statusen står kvar på
  // OVERDUE) och en med verklig skuld. Rätt svar: 1 st, 1 000 kr.
  function makePrisma() {
    const overdue = [
      {
        invoiceNumber: 'F-REGLERAD',
        total: 5000,
        payments: [{ amount: 5000 }],
        creditNotes: [],
        dueDate: new Date(Date.now() - 60 * DAY),
        tenant: TENANT,
        customer: null,
      },
      {
        invoiceNumber: 'F-SKULD',
        total: FAKTURERAT,
        payments: [{ amount: ALLOKERAT }],
        creditNotes: [],
        dueDate: new Date(Date.now() - 60 * DAY),
        tenant: TENANT,
        customer: null,
      },
    ]
    return {
      invoice: {
        findMany: jest
          .fn()
          .mockImplementation((args: { where?: Record<string, unknown> }) =>
            Promise.resolve(args?.where?.['status'] === 'OVERDUE' ? overdue : []),
          ),
      },
      unit: { findMany: jest.fn().mockResolvedValue([]) },
      lease: { findMany: jest.fn().mockResolvedValue([]) },
    }
  }

  it('summan är restskulden och utelämnar den reglerade fakturan', async () => {
    const res = await run(makePrisma(), 'find_optimization_opportunities')
    expect(res.message).toContain(`Förfallna fakturor >30 dagar (1 st,`)
    expect(res.message).toContain('F-SKULD')
    // Den reglerade fakturan ska inte stå på en lista som säger "driv in detta".
    expect(res.message).not.toContain('F-REGLERAD')
    // NEGATIVKONTROLL: gamla koden hade sagt "2 st" och räknat 15 000.
    expect(res.message).not.toContain('2 st')
  })

  it('`data.overdueOldCount` räknar SAMMA mängd som prosan — samma tool_result', async () => {
    // `data` och `message` serialiseras in i samma tool_result och läses av
    // samma modell. Divergerar de påstår ett och samma svar två olika saker.
    // (Fyndet kom ur code-reviewer-granskningen av #325: prosan var fixad,
    // strukturdatan räknade fortfarande den ofiltrerade listan.)
    const res = await run(makePrisma(), 'find_optimization_opportunities')
    expect((res.data as { overdueOldCount: number }).overdueOldCount).toBe(1)
    expect((res.data as { overdueOldCount: number }).overdueOldCount).not.toBe(2)
  })
})
