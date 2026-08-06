/**
 * #347 — analyze_payment_behavior: MÄNGDEN, inte aritmetiken.
 *
 * #325 gav verktyget rätt BELOPP (restskuld via `invoiceOutstanding`). Kvar stod
 * ett för smalt statusfilter — `SENT || OVERDUE` — så PARTIAL och
 * SENT_TO_COLLECTION räknades inte alls och "utestående" UNDERSKATTADE.
 *
 * Det här är inte bara en beloppsändring: den ändrar VILKA HYRESGÄSTER som
 * över huvud taget får en utestående-siffra. En hyresgäst vars enda öppna
 * faktura är delbetald syntes tidigare utan skuld. Testerna nedan mäter både
 * beloppen, mängden hyresgäster och att ETIKETTEN följer med.
 *
 * FAR (#347): SENT_TO_COLLECTION räknas IN — överlämningen bokför ingenting,
 * fordran ligger kvar på 1510, inkassobolaget är ombud och inte ny borgenär.
 * Den SÄRREDOVISAS för att skillnaden är handlingsmässig, inte bokföringsmässig.
 */

jest.mock('../../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../../invoices/pdf.service', () => ({ PdfService: class {} }))

import { ToolExecutorService } from './tool-executor.service'

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
    { logToolExecution: jest.fn().mockResolvedValue(undefined) } as never,
    noop,
    noop,
    noop,
  )
}

type Row = { outstandingTotal: number; outstandingOwn: number; outstandingAtCollection: number }

async function analyze(invoices: unknown[]) {
  const prisma = { invoice: { findMany: jest.fn().mockResolvedValue(invoices) } }
  const res = await (
    makeExecutor(prisma) as unknown as {
      executeToolUnsafe: (
        n: string,
        i: Record<string, unknown>,
        o: string,
        u: string,
        r: string,
      ) => Promise<{ data?: unknown; message: string }>
    }
  ).executeToolUnsafe('analyze_payment_behavior', {}, 'org-1', 'user-1', 'OWNER')
  return { rows: res.data as Record<string, Row>, message: res.message }
}

/**
 * Beloppet formaterat som produktionskoden gör det. `toLocaleString('sv-SE')`
 * använder HÅRT mellanslag (U+00A0), inte vanligt — ett hårdkodat "4 000 kr"
 * med vanligt mellanslag matchar aldrig, så ett `not.toContain` på den formen
 * blir tyst grönt oavsett vad koden gör. Etiketttexten hårdkodas däremot med
 * flit: det är den som testas.
 */
const kr = (n: number) => `${n.toLocaleString('sv-SE')} kr`

const tenant = (id: string, name: string) => ({
  id,
  type: 'INDIVIDUAL',
  firstName: name,
  lastName: 'Testsson',
  companyName: null,
})

const inv = (tenantId: string, name: string, status: string, total: number, allocated = 0) => ({
  tenantId,
  paidAt: null,
  dueDate: new Date(Date.now() - 5 * DAY),
  total,
  status,
  payments: allocated ? [{ amount: allocated }] : [],
  tenant: tenant(tenantId, name),
})

describe('#347 · PARTIAL räknas in', () => {
  it('en hyresgäst med ENBART en delbetald faktura syns nu med sin restskuld', async () => {
    // Kärnfallet. Före #347 gav den här hyresgästen "utestående" = 0 och
    // klausulen utelämnades helt — hyresvärden såg ingen skuld alls.
    const { rows, message } = await analyze([inv('t1', 'Anna', 'PARTIAL', 10000, 9000)])

    expect(rows['t1']?.outstandingTotal).toBe(1000)
    expect(rows['t1']?.outstandingOwn).toBe(1000)
    // NEGATIVKONTROLL: gamla filtret hade gett 0 och ingen prosaklausul.
    expect(rows['t1']?.outstandingTotal).not.toBe(0)
    expect(message).toContain(`utestående: ${kr(1000)}`)
  })
})

describe('#347 · SENT_TO_COLLECTION räknas in men särredovisas', () => {
  it('inkassofordran höjer totalen — den försvinner aldrig ur skulden', async () => {
    const { rows, message } = await analyze([inv('t1', 'Anna', 'SENT_TO_COLLECTION', 3000)])

    expect(rows['t1']?.outstandingTotal).toBe(3000)
    expect(rows['t1']?.outstandingAtCollection).toBe(3000)
    expect(rows['t1']?.outstandingOwn).toBe(0)
    // NEGATIVKONTROLL: hade den exkluderats (alternativ B) vore totalen 0 och
    // rapporten hade visat en lägre skuld än huvudboken.
    expect(rows['t1']?.outstandingTotal).not.toBe(0)

    // EGEN RENDERINGSGREN, egen assertion: hela skulden hos ombudet ger
    // `outstandingOwn === 0`. Nollan SKRIVS UT i stället för att utelämnas, och
    // det är avsiktligt — den är svaret på hyresvärdens fråga "måste jag göra
    // något själv?". Ett utelämnat tal hade lämnat frågan obesvarad, och ett
    // ensamt "utestående: 3 000 kr" hade sett ut som något att driva in.
    expect(message).toContain(`utestående hos dig: ${kr(0)}, hos inkasso: ${kr(3000)}`)
  })

  it('blandad skuld delas i två tal — inte ett med fotnot', async () => {
    const { rows, message } = await analyze([
      inv('t1', 'Anna', 'OVERDUE', 2000),
      inv('t1', 'Anna', 'SENT_TO_COLLECTION', 3000),
    ])

    expect(rows['t1']).toMatchObject({
      outstandingTotal: 5000,
      outstandingOwn: 2000,
      outstandingAtCollection: 3000,
    })
    // ETIKETTEN: när en del ligger hos ombudet får "utestående" aldrig stå
    // ensamt över hela beloppet.
    expect(message).toContain(`utestående hos dig: ${kr(2000)}, hos inkasso: ${kr(3000)}`)
    expect(message).not.toContain(`utestående: ${kr(5000)}`)
  })

  it('utan inkassodel behålls den enkla etiketten — ingen tom uppdelning', async () => {
    const { message } = await analyze([inv('t1', 'Anna', 'SENT', 4000)])
    expect(message).toContain(`utestående: ${kr(4000)}`)
    expect(message).not.toContain('hos inkasso')
  })
})

describe('#347 · VILKA hyresgäster som tillkommer i urvalet', () => {
  it('exakt de med PARTIAL/SENT_TO_COLLECTION — ingen annan påverkas', async () => {
    // Fem hyresgäster, en per relevant status. Före #347 hade bara t-sent och
    // t-overdue en utestående-siffra; nu tillkommer t-partial och t-inkasso.
    // t-draft, t-paid och t-void ska ALDRIG få en — de bär ingen fordran.
    const { rows, message } = await analyze([
      inv('t-sent', 'Sven', 'SENT', 1000),
      inv('t-overdue', 'Olga', 'OVERDUE', 2000),
      inv('t-partial', 'Pia', 'PARTIAL', 5000, 4000),
      inv('t-inkasso', 'Ivar', 'SENT_TO_COLLECTION', 3000),
      inv('t-draft', 'Doris', 'DRAFT', 9000),
      inv('t-paid', 'Per', 'PAID', 8000),
      inv('t-void', 'Vera', 'VOID', 7000),
    ])

    const medSkuld = Object.entries(rows)
      .filter(([, r]) => r.outstandingTotal > 0)
      .map(([id]) => id)
      .sort()

    expect(medSkuld).toEqual(['t-inkasso', 't-overdue', 't-partial', 't-sent'])

    // TILLKOMMANDE, utskrivet: de två som saknades.
    expect(rows['t-partial']?.outstandingTotal).toBe(1000)
    expect(rows['t-inkasso']?.outstandingTotal).toBe(3000)

    // OFÖRÄNDRADE: de som redan räknades ska ge exakt samma tal som förut.
    expect(rows['t-sent']?.outstandingTotal).toBe(1000)
    expect(rows['t-overdue']?.outstandingTotal).toBe(2000)

    // ALDRIG: DRAFT/PAID/VOID får ingen skuldklausul i prosan.
    expect(rows['t-draft']?.outstandingTotal).toBe(0)
    expect(rows['t-paid']?.outstandingTotal).toBe(0)
    expect(rows['t-void']?.outstandingTotal).toBe(0)
    for (const namn of ['Doris', 'Per', 'Vera']) {
      const rad = message.split('\n').find((l) => l.includes(namn))
      expect(rad).toBeDefined()
      expect(rad).not.toContain('utestående')
    }
  })
})

describe('#347 · totalen är alltid delarnas summa', () => {
  it('outstandingTotal === own + atCollection för varje hyresgäst', async () => {
    // Invarianten som gör att modellen inte kan bli lurad oavsett vilket fält
    // den plockar: de tre talen kan aldrig glida isär.
    const { rows } = await analyze([
      inv('t1', 'Anna', 'PARTIAL', 10000, 9000),
      inv('t1', 'Anna', 'SENT_TO_COLLECTION', 3000, 500),
      inv('t2', 'Bo', 'SENT', 4000),
    ])

    for (const r of Object.values(rows)) {
      expect(r.outstandingTotal).toBe(r.outstandingOwn + r.outstandingAtCollection)
    }
    expect(rows['t1']?.outstandingTotal).toBe(1000 + 2500)
  })
})
