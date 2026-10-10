/**
 * TESTKUND-041 (moms v1, B-5/B-6, ACCEPTANS B1–B3): AI:n får aldrig göra kundens momsval.
 *
 * Proven kör den RIKTIGA `executeToolUnsafe` (samma harness som ai-verifikat-origin.spec.ts, med en
 * riktig AccountingService ovanpå en prisma-attrapp) och läser vad som faktiskt skulle ha skrivits.
 * Modellen är en attrapp i den meningen att verktygsindata skrivs av provet — precis som en modell
 * skulle skriva dem, inklusive ett påhittat «vatTreatment»-fält som inte får godtas.
 */
jest.mock('../../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../../invoices/pdf.service', () => ({ PdfService: class {} }))

import { ToolExecutorService } from './tool-executor.service'
import { AccountingService } from '../../accounting/accounting.service'

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
      // Idempotensuppslaget som ligger FÖRE create i skrivvägen: finns redan ett
      // verifikat med samma (org, source, sourceId) skapas inget nytt. Här ska
      // det alltid skapas, så uppslaget svarar null.
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(async (args: { data: Created }) => {
        created.push(args.data)
        return { id: 'je-1', ...args.data, lines: [] }
      }),
    },
  }
  return {
    accountingPeriodEvent: { findFirst: jest.fn().mockResolvedValue(null) },
    // #704 PR 1: allocate frågar om räkenskapsåret först.
    fiscalYearClose: { findUnique: jest.fn().mockResolvedValue(null) },
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

function makeExecutor(prisma: unknown, accOverride?: unknown) {
  const noop = {} as never
  const verifikationsnummer = {
    allocate: jest.fn().mockResolvedValue({ series: 'A', verNumber: 1, fiscalYear: 2026 }),
  }
  const audit = {
    logToolExecution: jest.fn().mockResolvedValue(undefined),
    // Steg 3b: produktionsvägen öppnar och stänger spåret för FÖRE_EFFEKTEN-verktyg.
    beginToolExecution: jest.fn().mockResolvedValue(undefined),
    completeToolExecution: jest.fn().mockResolvedValue(undefined),
  }
  const svc = new ToolExecutorService(
    prisma as never,
    noop,
    noop,
    noop,
    noop,
    noop,
    noop,
    noop,
    // Position 9 (index 8) är AccountingService — den ENDA skrivvägen för
    // verifikat sedan AI:ns egen transaktion togs bort. En RIKTIG tjänst byggd
    // ur samma attrapp-prisma, inte en `noop`: provet mäter att AI-verifikat
    // märks `source: 'AI'`, och det måste mätas genom vägen som faktiskt körs.
    (accOverride ?? new AccountingService(prisma as never, verifikationsnummer as never)) as never,
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

    noop,
    {} as never, // #F034c bankAccounts (sist)
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

const UTGIFT = { date: '2026-08-18', description: 'Rörmokare', accountNumber: 5010, amount: 1250 }

describe('TESTKUND-041: AI och momsvalet', () => {
  it('B1: record_expense med moms stoppas med kundväg till «Registrera utgift»; inget verifikat', async () => {
    const { created, result } = await run(
      'record_expense',
      { ...UTGIFT, vatAmount: 250 },
      'exec-m1',
    )
    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Registrera utgift/)
    expect(created).toHaveLength(0)
  })

  it('B1: ett momsval som modellen själv skriver i indata godtas inte som mänskligt beslut', async () => {
    for (const vatTreatment of ['HELT_AVDRAG', 'INGET_AVDRAG']) {
      const { created, result } = await run(
        'record_expense',
        { ...UTGIFT, vatAmount: 250, vatTreatment, bekraftatAvMänniska: true },
        'exec-m2',
      )
      expect([result.success, created.length]).toEqual([false, 0])
    }
  })

  it('B1: utan moms bokförs utgiften som förut (ingen 2641-rad)', async () => {
    // Harnessen (som ai-verifikat-origin.spec.ts) mäter EFFEKTEN — det skrivna verifikatet.
    const { created } = await run('record_expense', UTGIFT, 'exec-m3')
    expect(created).toHaveLength(1)
    expect(JSON.stringify(created[0])).toContain('acc-5010')
    expect(JSON.stringify(created[0])).not.toContain('acc-2641')
  })

  it('B2: create_journal_entry med en rad på 2641 stoppas med kundväg till «Ny verifikation»; inget verifikat', async () => {
    const { created, result } = await run(
      'create_journal_entry',
      {
        date: '2026-08-18',
        description: 'AI försöker boka moms',
        lines: [
          { accountNumber: 5010, debit: 1000 },
          { accountNumber: 2641, debit: 250 },
          { accountNumber: 1930, credit: 1250 },
        ],
      },
      'exec-m4',
    )
    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Ny verifikation/)
    expect(created).toHaveLength(0)
  })

  it('B2: create_journal_entry utan 2641 fungerar som förut', async () => {
    const { created, result } = await run(
      'create_journal_entry',
      {
        date: '2026-08-18',
        description: 'AI-bokförd post',
        lines: [
          { accountNumber: 1930, debit: 100 },
          { accountNumber: 3011, credit: 100 },
        ],
      },
      'exec-m5',
    )
    void result
    expect(created).toHaveLength(1)
  })
})

describe('TESTKUND-041 P-4: AI redovisar fallbackintäkten med proveniens', () => {
  it('get_profit_loss_report nämner «intäktskonto okänt: avtal saknas» och påstår inte momsfri', async () => {
    const pl = {
      period: { from: '2026-09-01', to: '2026-09-30' },
      revenue: { total: 10000, accounts: [] },
      costs: {
        operating: { total: 0, accounts: [] },
        admin: { total: 0, accounts: [] },
        personnel: { total: 0, accounts: [] },
        depreciation: { total: 0, accounts: [] },
        financial: { total: 0, accounts: [] },
        total: 0,
      },
      result: 10000,
      okantIntaktskonto: {
        konto: 3914,
        belopp: 4000,
        antalVerifikat: 1,
        text: 'intäktskonto okänt: avtal saknas — intäkten bokades på 3914 eftersom avins avtal eller enhet saknades. Dess momsbehandling är okänd; den är inte belagd som momsfri bostadshyra.',
      },
    }
    const svc = makeExecutor(makePrisma([]), {
      getProfitLossReport: jest.fn().mockResolvedValue(pl),
    })
    const unsafe = (svc as unknown as { executeToolUnsafe: Unsafe }).executeToolUnsafe.bind(svc)
    const r = await unsafe(
      'get_profit_loss_report',
      { fromDate: '2026-09-01', toDate: '2026-09-30' },
      'org-1',
      'user-1',
      'OWNER',
    )
    expect(r.message).toMatch(/intäktskonto okänt: avtal saknas/)
    expect(r.message).toMatch(/inte belagd som momsfri/)
    expect(r.message).not.toMatch(/(?<!inte belagd som )momsfri bostadshyra\./)
  })
})

describe('TESTKUND-041 M7: AI läser momsvalet och källan, sätter det aldrig', () => {
  it('get_vat_report skickar vidare källor med val, aktör och tid; äldre utan val märks som ej angiven', async () => {
    const vr = {
      period: { from: '2026-08-01', to: '2026-08-31' },
      outgoing: { vat25: 0, vat12: 0, vat6: 0, total: 0 },
      incoming: {
        total: 250,
        sources: [
          {
            kalla: 'LEVERANTORSFAKTURA',
            verifikat: 'A1',
            datum: '2026-08-10',
            belopp: 250,
            momsval: 'HELT_AVDRAG',
            beslutadAv: 'u1',
            beslutadVid: '2026-08-10T10:00:00Z',
            leverantorsfakturaId: 'f1',
            text: 'Kundens val: Moms dras av',
          },
          {
            kalla: 'LEVERANTORSFAKTURA',
            verifikat: 'A2',
            datum: '2026-08-11',
            belopp: 0,
            momsval: null,
            beslutadAv: null,
            beslutadVid: null,
            leverantorsfakturaId: 'f2',
            text: 'Momsbehandling ej angiven (äldre, bokförd som avdragsgill)',
          },
        ],
      },
      netToPay: -250,
      direction: 'ÅTERBÄRING',
    }
    const acc = { getVatReport: jest.fn().mockResolvedValue(vr) }
    const svc = makeExecutor(makePrisma([]), acc)
    const unsafe = (svc as unknown as { executeToolUnsafe: Unsafe }).executeToolUnsafe.bind(svc)
    const r = (await unsafe(
      'get_vat_report',
      { fromDate: '2026-08-01', toDate: '2026-08-31' },
      'org-1',
      'user-1',
      'OWNER',
    )) as {
      success: boolean
      data?: {
        incoming: {
          sources: Array<{ momsval: string | null; beslutadAv: string | null; text: string }>
        }
      }
    }
    expect(r.success).toBe(true)
    expect(r.data!.incoming.sources.map((s) => [s.momsval, s.beslutadAv])).toEqual([
      ['HELT_AVDRAG', 'u1'],
      [null, null],
    ])
    expect(r.data!.incoming.sources[1]!.text).toMatch(/ej angiven/)
    expect(acc.getVatReport).toHaveBeenCalledTimes(1)
  })
})
