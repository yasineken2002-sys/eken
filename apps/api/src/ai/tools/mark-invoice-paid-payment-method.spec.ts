/**
 * AI-VÄGENS BETALSÄTT — MÄTT GENOM EXEKVERAREN, INTE GENOM EN KOPIA AV DEN.
 *
 * ── VAD DEN HÄR FILEN FINNS FÖR ──────────────────────────────────────────────
 *
 * `mark_invoice_paid` läste `toolInput.paymentMethod` genom
 * `PaymentMethodSchema.catch('MANUAL').parse(...)`. `.catch()` gör att
 * `.parse()` ALDRIG kastar: 'Bankgiro', 42 och '' blev alla tyst `MANUAL` —
 * exakt den gissning `toPaymentMethod` togs bort för i samma ändring. Formen
 * som ersatte den defaultar bara ett UTELÄMNAT fält och kastar på allt annat.
 *
 * ── VARFÖR PROVET GÅR GENOM `executeToolUnsafe` ──────────────────────────────
 *
 * Ett prov som skriver om villkoret —
 * `const som_i_utforaren = (v) => v === undefined ? 'MANUAL' : Schema.parse(v)`
 * — mäter sin egen rad. Det är grönt oavsett vad exekveraren gör, och skulle
 * INTE ha varit rött mot `.catch('MANUAL')`, eftersom `.catch()` aldrig fanns i
 * kopian. Samma defekt som CLAUDE.md beskriver för vakter vars sond skriver om
 * mönstret den ska pröva (#754, #764).
 *
 * Provet nedan anropar därför produktionsmetoden och läser det argument som
 * FAKTISKT når `markAsPaidManually`. Återinförs `.catch('MANUAL')` blir
 * "KASTAR"-fallen röda, för då returnerar vägen 'MANUAL' i stället för att
 * stanna.
 *
 * ── VAD DET HÄR PROVET INTE KAN SE ───────────────────────────────────────────
 *
 * Det mäter vad exekveraren SKICKAR, inte vad `InvoicesService` sedan bokför —
 * tjänsten är en attrapp här. Konteringen per betalsätt (1930/1910) ägs av
 * `accounting.service.ts` och mäts av `invoices.manual-payment.spec.ts` och
 * `dto-contract.spec.ts`. Det mäter heller inte människovägens DTO; den bärs av
 * `@IsEnum` och av kontraktsprovet.
 */

// Exekveraren drar in hela beroendeträdet; de här två bär ESM i node_modules som
// Jest inte transformerar. Samma två mockar som övriga verktygsspecar.
jest.mock('../../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../../invoices/pdf.service', () => ({ PdfService: class {} }))

import { ToolExecutorService } from './tool-executor.service'

const FAKTURA_ID = 'faktura-1'
const ORG_ID = 'org-1'

type Unsafe = (
  name: string,
  input: Record<string, unknown>,
  orgId: string,
  userId: string,
  role: string,
) => Promise<{ success: boolean; message?: string }>

function makeExecutor(markAsPaidManually: jest.Mock) {
  const noop = {} as never
  const prisma = {
    invoice: {
      // Org-kontrollen i `mark_invoice_paid` sker före betalsättet; den ska
      // hitta fakturan, annars returnerar vägen tidigt och provet mäter
      // uppslagningen i stället för valideringen.
      findFirst: jest.fn().mockResolvedValue({ id: FAKTURA_ID }),
    },
  }
  const audit = {
    logToolExecution: jest.fn().mockResolvedValue(undefined),
    beginToolExecution: jest.fn().mockResolvedValue(undefined),
    completeToolExecution: jest.fn().mockResolvedValue(undefined),
  }
  const svc = new ToolExecutorService(
    prisma as never,
    // Position 2 (index 1) är InvoicesService — den enda vi bryr oss om här.
    { markAsPaidManually } as never,
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

    noop,
  )
  return svc
}

/** Kör produktionsvägen och returnerar betalsättet som NÅDDE tjänsten. */
async function betalsattetSomNadde(paymentMethod: unknown) {
  const markAsPaidManually = jest.fn().mockResolvedValue(undefined)
  const svc = makeExecutor(markAsPaidManually)
  const unsafe = (svc as unknown as { executeToolUnsafe: Unsafe }).executeToolUnsafe.bind(svc)
  await unsafe(
    'mark_invoice_paid',
    {
      invoiceId: FAKTURA_ID,
      invoiceNumber: 'F-1',
      amount: 1000,
      // `undefined` som värde är samma sak som utelämnat fält för `in`-fri
      // läsning via `toolInput.paymentMethod`, vilket är hur koden läser det.
      ...(paymentMethod === undefined ? {} : { paymentMethod }),
    },
    ORG_ID,
    'user-1',
    'OWNER',
  )
  expect(markAsPaidManually).toHaveBeenCalledTimes(1)
  return markAsPaidManually.mock.calls[0]?.[2] as unknown
}

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: riggen når verkligen tjänsteanropet', async () => {
    // Utan den här raden kan varje "KASTAR"-fall nedan vara grönt av att vägen
    // aldrig kom fram — en tidig retur på org-kontrollen ser likadan ut som en
    // lyckad validering, eftersom ingendera anropar tjänsten.
    await expect(betalsattetSomNadde('BANK')).resolves.toBe('BANK')
  })
})

describe('mark_invoice_paid — betalsättet valideras, det gissas inte', () => {
  it('utelämnat betyder MANUAL — samma default som controllern', async () => {
    await expect(betalsattetSomNadde(undefined)).resolves.toBe('MANUAL')
  })

  it.each(['BANK', 'CASH', 'SWISH', 'MANUAL'])('%s når tjänsten oförändrat', async (v) => {
    await expect(betalsattetSomNadde(v)).resolves.toBe(v)
  })

  it.each([
    ['Bankgiro', 'etiketten — den översätts numera i klienten'],
    ['bank', 'gamla mappningen lowercase:ade och hade godtagit den'],
    ['', 'tom sträng'],
    [42, 'fel typ'],
    [null, 'null, inte undefined — ska INTE defaultas'],
  ])('DEN AVGÖRANDE: %p stannar anropet (%s)', async (varde: unknown, _skal: string) => {
    // Med `.catch('MANUAL')` hade var och en av dessa nått tjänsten som
    // 'MANUAL' och bokförts på 1930 utan att någon valt det.
    const markAsPaidManually = jest.fn().mockResolvedValue(undefined)
    const svc = makeExecutor(markAsPaidManually)
    const unsafe = (svc as unknown as { executeToolUnsafe: Unsafe }).executeToolUnsafe.bind(svc)

    const utfall = await unsafe(
      'mark_invoice_paid',
      { invoiceId: FAKTURA_ID, invoiceNumber: 'F-1', amount: 1000, paymentMethod: varde },
      ORG_ID,
      'user-1',
      'OWNER',
    ).then(
      (r) => ({ kastade: false, r }),
      () => ({ kastade: true, r: undefined }),
    )

    // Vägen får antingen kasta eller returnera ett misslyckande — men den får
    // ALDRIG bokföra. Det är bokföringen provet skyddar.
    expect(markAsPaidManually).not.toHaveBeenCalled()
    if (!utfall.kastade) expect(utfall.r?.success).toBe(false)
  })
})
