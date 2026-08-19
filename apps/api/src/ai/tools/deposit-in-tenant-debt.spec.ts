/**
 * #348 — DEPOSITIONER I HYRESGÄSTENS SKULD. ETT BESLUT, INTE EN LUCKA.
 *
 * Ärendet öppnades på antagandet att de två AI-verktygen SKULLE exkludera
 * DEPOSIT, symmetriskt med `OverdueDebtService`. FAR vände på premissen:
 *
 *   • En obetald deposition ÄR en bokförd fordran — `deposits.service.ts` bokför
 *     1510 D / 2890 K när fakturan skapas, och 1510 står öppen tills den betalas.
 *     Samma kontoklass som en obetald hyresfaktura.
 *   • `OverdueDebtService` exkluderar DEPOSIT för att "Försenat belopp" är PARAT
 *     MOT INTÄKTSSIDAN (Σ 3xxx) på dashboarden. `data-context` och
 *     `portfolio-analysis` ärver det för att de är DETALJVYER av samma tal.
 *   • De två verktygen här är varken parade mot intäktssidan eller detaljvyer.
 *     De ärver därför inte exkluderingen.
 *
 * "Det är ingen intäkt" och "det är ingen fordran" är två olika påståenden.
 *
 * Testerna låser INKLUDERINGEN som avsiktlig, så att en framtida granskare inte
 * "harmoniserar" bort den, och att depositionsdelen SÄRREDOVISAS — för att den är
 * en annan sorts fordran (2890-motpost, aldrig intäkt), inte för att systemet
 * skulle behandla den annorlunda.
 *
 * PÅSTÅ INGET OM KRAVTRAPPAN. Första versionen av den här ändringen skrev
 * "ingen kravtrappa, kräver manuell åtgärd" i prosan hyresvärden läser. Det var
 * FALSKT: `computeRentDebt` håller visserligen depositioner utanför kravtrappan,
 * men den styr RentNotice. Depositions-FAKTUROR går Invoice-vägen, och varken
 * `markOverdueInvoices` eller `processOverdueReminders` har typfilter — de
 * eskalerar, avgift inkluderad (egen bugg, #352). Flera tester nedan låser att
 * varken det gamla påståendet eller dess motsats kommer tillbaka.
 */

jest.mock('../../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../../invoices/pdf.service', () => ({ PdfService: class {} }))

import { ToolExecutorService } from './tool-executor.service'

const DAY = 86_400_000

/**
 * Formaterat som produktionen gör det. `toLocaleString('sv-SE')` ger HÅRT
 * mellanslag (U+00A0) — ett hårdkodat "5 000 kr" med vanligt mellanslag matchar
 * aldrig, och ett `not.toContain` på den formen blir tyst grönt oavsett vad
 * koden gör. (Läxan från #325; se dev-anteckningen om gröna tester.)
 */
const kr = (n: number) => `${n.toLocaleString('sv-SE')} kr`

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
    { logToolExecution: jest.fn().mockResolvedValue(undefined) } as never,
    noop,
    noop,
    noop,
  )
}

async function run(prisma: unknown, tool: string) {
  return (
    makeExecutor(prisma) as unknown as {
      executeToolUnsafe: (
        n: string,
        i: Record<string, unknown>,
        o: string,
        u: string,
        r: string,
      ) => Promise<{ data?: unknown; message: string }>
    }
  ).executeToolUnsafe(tool, {}, 'org-1', 'user-1', 'OWNER')
}

const TENANT = {
  id: 't1',
  type: 'INDIVIDUAL',
  firstName: 'Anna',
  lastName: 'Testsson',
  companyName: null,
}

type Row = {
  outstandingTotal: number
  outstandingOwn: number
  outstandingAtCollection: number
  outstandingDepositPortion: number
}

const inv = (type: string, status: string, total: number, allocated = 0, daysOld = 5) => ({
  tenantId: 't1',
  invoiceNumber: `F-${type}`,
  paidAt: null,
  dueDate: new Date(Date.now() - daysOld * DAY),
  total,
  status,
  type,
  payments: allocated ? [{ amount: allocated }] : [],
  creditNotes: [],
  tenant: TENANT,
  customer: null,
})

// ── URVALSGRINDEN ──────────────────────────────────────────────────────────
//
// DE HÄR TVÅ TESTERNA ÄR INTE VALFRIA, och skälet är mätt: prisma-attrapperna
// nedan returnerar en FAST ARRAY oavsett `where`. Testerna som mäter belopp och
// prosa är därför HELT BLINDA för filtret — jag lade in
// `type: { not: 'DEPOSIT' }` i båda queryerna och samtliga nio förblev gröna.
//
// En attrapp kan inte hindra en filterändring; bara en assertion PÅ ARGUMENTET
// kan. Utan dessa två skulle någon kunna "harmonisera" bort depositionerna i
// morgon och hela filen skulle fortsätta vara grön medan verktygen slutade visa
// dem. (Samma familj som den tyst gröna U+00A0-kontrollen i #325.)
describe('#348 · queryerna FILTRERAR INTE bort depositioner', () => {
  it('analyze_payment_behavior: `where` saknar typfiltrering helt', async () => {
    const findMany = jest.fn().mockResolvedValue([])
    await run({ invoice: { findMany } }, 'analyze_payment_behavior')

    const where = findMany.mock.calls[0]?.[0]?.where
    expect(where).toEqual({ organizationId: 'org-1' })
    expect(where).not.toHaveProperty('type')
  })

  it('find_optimization_opportunities: `where` grindar på status/datum, aldrig på typ', async () => {
    const findMany = jest.fn().mockResolvedValue([])
    await run(
      {
        invoice: { findMany },
        unit: { findMany: jest.fn().mockResolvedValue([]) },
        lease: { findMany: jest.fn().mockResolvedValue([]) },
      },
      'find_optimization_opportunities',
    )

    const overdueCall = findMany.mock.calls.find(
      (c: [{ where?: Record<string, unknown> }]) => c[0]?.where?.['status'] === 'OVERDUE',
    )
    expect(overdueCall).toBeDefined()
    expect(overdueCall?.[0].where).not.toHaveProperty('type')
    // Övriga grindar oförändrade — #348 rör typfrågan, inte urvalet i övrigt.
    expect(overdueCall?.[0].where).toMatchObject({
      organizationId: 'org-1',
      status: 'OVERDUE',
    })
  })
})

describe('#348 · analyze_payment_behavior räknar depositionen som fordran', () => {
  async function analyze(invoices: unknown[]) {
    const prisma = { invoice: { findMany: jest.fn().mockResolvedValue(invoices) } }
    const res = await run(prisma, 'analyze_payment_behavior')
    return { rows: res.data as Record<string, Row>, message: res.message }
  }

  it('en hyresgäst vars ENDA obetalda post är depositionen syns med skuld', async () => {
    // Kärnfallet. Hade verktyget exkluderat DEPOSIT (ärendets ursprungliga
    // antagande) vore den här hyresgästen skuldfri i AI:ns ögon — trots en öppen
    // 1510-post.
    const { rows, message } = await analyze([inv('DEPOSIT', 'OVERDUE', 12000)])

    expect(rows['t1']?.outstandingTotal).toBe(12000)
    expect(rows['t1']?.outstandingDepositPortion).toBe(12000)
    // NEGATIVKONTROLL: exkludering hade gett 0.
    expect(rows['t1']?.outstandingTotal).not.toBe(0)
    expect(message).toContain(kr(12000))
  })

  it('depositionsdelen SÄRREDOVISAS — och klausulen påstår bara vad beloppet är', async () => {
    const { rows, message } = await analyze([
      inv('RENT', 'OVERDUE', 8000),
      inv('DEPOSIT', 'OVERDUE', 5000),
    ])

    expect(rows['t1']?.outstandingTotal).toBe(13000)
    expect(rows['t1']?.outstandingDepositPortion).toBe(5000)

    // ETIKETTEN: talet ensamt hade sett ut som vilken hyresskuld som helst.
    expect(message).toContain(`utestående: ${kr(13000)}`)
    expect(message).toContain(`(varav ${kr(5000)} deposition)`)

    // KLAUSULEN FÅR INTE PÅSTÅ NÅGOT OM KRAVTRAPPAN. Här stod först "ingen
    // kravtrappa, kräver manuell åtgärd" — falskt, eftersom depositions-
    // FAKTUROR eskalerar via Invoice-vägen (inget typfilter i
    // markOverdueInvoices/processOverdueReminders). Testet låser att varken
    // det gamla påståendet eller dess motsats smyger tillbaka.
    expect(message).not.toContain('kravtrappa')
    expect(message).not.toContain('manuell åtgärd')
  })

  it('utan deposition tillkommer INGEN klausul — oförändrad för de flesta', async () => {
    const { rows, message } = await analyze([inv('RENT', 'OVERDUE', 8000)])

    expect(rows['t1']?.outstandingDepositPortion).toBe(0)
    expect(message).toContain(`utestående: ${kr(8000)}`)
    expect(message).not.toContain('deposition')
  })

  it('depositionsdelen är en DELMÄNGD, inte en fjärde hink', async () => {
    // Invarianten som hindrar dubbelräkning: Own + AtCollection === Total är
    // fortfarande en fullständig uppdelning, och depositionsdelen ligger INUTI
    // den. En modell som adderar alla fyra får fel svar — därför heter fältet
    // "Portion".
    const { rows } = await analyze([
      inv('RENT', 'OVERDUE', 8000),
      inv('DEPOSIT', 'OVERDUE', 5000),
      inv('RENT', 'SENT_TO_COLLECTION', 3000),
    ])
    const r = rows['t1']!

    expect(r.outstandingOwn + r.outstandingAtCollection).toBe(r.outstandingTotal)
    expect(r.outstandingDepositPortion).toBeLessThanOrEqual(r.outstandingTotal)
    // Depositionen låg hos hyresvärden, inte hos inkasso → den ingår i Own.
    expect(r.outstandingOwn).toBe(13000)
    expect(r.outstandingAtCollection).toBe(3000)
    expect(r.outstandingDepositPortion).toBe(5000)
  })

  it('deposition SOM LIGGER HOS INKASSO ger en sammanhängande text', async () => {
    // Kombinationen #347 × #348, som ingen av de andra testerna täckte.
    //
    // Det var här den gamla formuleringen sprack: "hos inkasso: 12 000 kr (varav
    // 12 000 kr deposition — ingen kravtrappa, kräver manuell åtgärd)" påstod
    // samtidigt att beloppet ligger hos ett ombud OCH att ingen åtgärd vidtagits.
    // När klausulen slutade påstå något om process försvann motsägelsen.
    const { rows, message } = await analyze([inv('DEPOSIT', 'SENT_TO_COLLECTION', 12000)])

    expect(rows['t1']?.outstandingAtCollection).toBe(12000)
    expect(rows['t1']?.outstandingDepositPortion).toBe(12000)
    expect(rows['t1']?.outstandingOwn).toBe(0)

    expect(message).toContain(`hos inkasso: ${kr(12000)}`)
    expect(message).toContain(`(varav ${kr(12000)} deposition)`)
    expect(message).not.toContain('manuell åtgärd')
  })

  it('delbetald deposition räknar resten — samma restskuldsregel som hyra', async () => {
    // #325:s aritmetik gäller lika för depositioner; ingen egen väg.
    const { rows } = await analyze([inv('DEPOSIT', 'PARTIAL', 12000, 9000)])
    expect(rows['t1']?.outstandingDepositPortion).toBe(3000)
    expect(rows['t1']?.outstandingDepositPortion).not.toBe(12000)
  })

  it('betald deposition bidrar 0 — och räknas ändå i "% i tid"', async () => {
    // FAR: en sent betald deposition är en lika verklig betalningsdatapunkt som
    // en sent betald hyra, så den hör hemma i beteendemåttet.
    const prisma = {
      invoice: {
        findMany: jest.fn().mockResolvedValue([
          {
            ...inv('DEPOSIT', 'PAID', 12000, 12000),
            paidAt: new Date(Date.now() - 1 * DAY), // betald 4 dagar EFTER förfall
          },
        ]),
      },
    }
    const res = await run(prisma, 'analyze_payment_behavior')
    const rows = res.data as Record<string, Row>

    expect(rows['t1']?.outstandingTotal).toBe(0)
    // Fakturan räknas i antalet och drar ner andelen i tid.
    expect(res.message).toContain('1 fakturor, 0% i tid')
  })
})

describe('#348 · find_optimization_opportunities märker ut depositionen', () => {
  function makePrisma(overdue: unknown[]) {
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

  it('depositionen STANNAR i åtgärdslistan — den har ingen annan kanal', async () => {
    // En obetald deposition är en verklig 1510-fordran (deposits.service.ts
    // bokför 1510 D / 2890 K vid skapandet). En åtgärdslista över förfallna
    // fordringar ska visa den; OverdueDebtService exkluderar den av ett skäl
    // som är lokalt till DEN ytans parning mot intäktssidan.
    const res = await run(
      makePrisma([inv('DEPOSIT', 'OVERDUE', 12000, 0, 60)]),
      'find_optimization_opportunities',
    )

    expect(res.message).toContain('F-DEPOSIT')
    expect(res.message).toContain('Förfallna fakturor >30 dagar (1 st,')
    // NEGATIVKONTROLL: exkludering hade gett en tom lista.
    expect(res.message).not.toContain('Förfallna fakturor >30 dagar (0 st')
  })

  it('raden bär markören — men markören påstår bara vad posten ÄR', async () => {
    const res = await run(
      makePrisma([inv('DEPOSIT', 'OVERDUE', 12000, 0, 60)]),
      'find_optimization_opportunities',
    )
    expect(res.message).toContain('(deposition)')
    // Inget påstående om kravtrappan — den eskalerar i själva verket.
    expect(res.message).not.toContain('kravtrappa')
  })

  it('en HYRESfaktura får ingen markör — markören betyder något', async () => {
    // Utan det här testet kunde markören ha satts på varje rad och ändå passerat
    // testet ovan.
    const res = await run(
      makePrisma([inv('RENT', 'OVERDUE', 12000, 0, 60)]),
      'find_optimization_opportunities',
    )
    expect(res.message).toContain('F-RENT')
    expect(res.message).not.toContain('deposition')
  })
})
