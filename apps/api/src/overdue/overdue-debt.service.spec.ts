/**
 * T4/#47 — OverdueDebtService: DELAD sanningskälla för "Försenat belopp"
 * (dashboard + månadsrapport). Låser samma regler som PR2:
 *   • Σ computeRentDebt(n).outstanding för OVERDUE-avier, KLAMPAT PER AVI
 *     (Σmax(0,x) ≠ max(0,Σx) — överbetald avi bidrar 0, aldrig negativt),
 *   • outstanding (det obetalda), inte totalAmount — delbetald → bara resten,
 *   • DEPOSIT exkluderas i queryn (where type≠DEPOSIT), org-scopat,
 *   • + OVERDUE Invoice (type≠DEPOSIT), utan dubbelräkning,
 *   • count räknar bara poster med kvarvarande skuld; over30Count via dueDate.
 *
 * #325 — Invoice-grenen räknar RESTSKULDEN (invoiceOutstanding), inte
 * `Invoice.total`. Den gamla raden vilade på "Invoice saknar allokeringsmodell
 * → en OVERDUE-faktura är fullt obetald", vilket upphörde att gälla när
 * InvoicePayment kom (#307). Testerna nedan mäter symmetrin mot avi-grenen:
 * delbetald räknar resten, överbetald klampas per post, reglerad räknas inte
 * alls — samma tre regler på båda källorna.
 */

import { OverdueDebtService } from './overdue-debt.service'

const DAY = 86_400_000

function makeService(opts: {
  notices: Array<Record<string, unknown>>
  invoices: Array<Record<string, unknown>>
}) {
  const rentNoticeFindMany = jest.fn().mockResolvedValue(opts.notices)
  const invoiceFindMany = jest.fn().mockResolvedValue(opts.invoices)
  const prisma = {
    rentNotice: { findMany: rentNoticeFindMany },
    invoice: { findMany: invoiceFindMany },
  }
  return { service: new OverdueDebtService(prisma as never), rentNoticeFindMany, invoiceFindMany }
}

// dueDate default: nyligen förfallen (ej >30 dagar) om inget anges.
const RENT = (totalAmount: number, allocations: number[] = [], daysOverdue = 5) => ({
  type: 'RENT',
  totalAmount,
  consumptionAmount: 0,
  miscChargeAmount: 0,
  reminderFeeAmount: 0,
  interestAccruedAmount: 0,
  dueDate: new Date(Date.now() - daysOverdue * DAY),
  payments: allocations.map((amount) => ({ amount })),
})
// #325 — `allocations` speglar RENT():s signatur med flit. Fakturan och avin
// bär samma sorts allokeringar och ska räknas med samma regel; att hjälparna ser
// likadana ut gör en framtida asymmetri synlig i testfilen.
const INV = (total: number, allocations: number[] = [], daysOverdue = 5) => ({
  total,
  dueDate: new Date(Date.now() - daysOverdue * DAY),
  payments: allocations.map((amount) => ({ amount })),
})

describe('OverdueDebtService.getOverdueSnapshot', () => {
  const NOW = new Date()

  it('summerar outstanding per avi (klampat) + OVERDUE Invoice; räknar poster', async () => {
    const { service } = makeService({
      notices: [
        RENT(10000), //          obetald            → 10000
        RENT(10000, [4000]), //  delbetald          → 6000
        RENT(10000, [12000]), // ÖVERbetald (−2000) → 0 (klampad, räknas ej)
      ],
      invoices: [INV(5000)],
    })
    const snap = await service.getOverdueSnapshot('org-1', NOW)
    // 10000 + 6000 + 0 + 5000 = 21000. (Klampning av SUMMAN → 19000.)
    expect(snap.total).toBe(21000)
    // Två avier med skuld (0-avin räknas ej) + en faktura = 3 poster.
    expect(snap.count).toBe(3)
  })

  it('delbetald avi räknar bara resten (outstanding, inte totalAmount)', async () => {
    const { service } = makeService({ notices: [RENT(8000, [3000])], invoices: [] })
    const snap = await service.getOverdueSnapshot('org-1', NOW)
    expect(snap.total).toBe(5000)
    expect(snap.count).toBe(1)
  })

  it('betald/överbetald avi bidrar 0 och räknas inte', async () => {
    const { service } = makeService({
      notices: [RENT(5000, [5000]), RENT(5000, [9000])],
      invoices: [],
    })
    const snap = await service.getOverdueSnapshot('org-1', NOW)
    expect(snap.total).toBe(0)
    expect(snap.count).toBe(0)
  })

  it('over30Count räknar poster förfallna för mer än 30 dagar', async () => {
    const { service } = makeService({
      notices: [RENT(1000, [], 40), RENT(1000, [], 10)],
      invoices: [INV(1000, [], 45)],
    })
    const snap = await service.getOverdueSnapshot('org-1', NOW)
    expect(snap.count).toBe(3)
    expect(snap.over30Count).toBe(2) // avin (40 d) + fakturan (45 d)
  })

  it('queryn exkluderar DEPOSIT och är org-scopad på båda källorna', async () => {
    const { service, rentNoticeFindMany, invoiceFindMany } = makeService({
      notices: [],
      invoices: [],
    })
    await service.getOverdueSnapshot('org-XYZ', NOW)
    expect(rentNoticeFindMany.mock.calls[0][0].where).toMatchObject({
      organizationId: 'org-XYZ',
      status: 'OVERDUE',
      type: { not: 'DEPOSIT' },
    })
    expect(invoiceFindMany.mock.calls[0][0].where).toMatchObject({
      organizationId: 'org-XYZ',
      status: 'OVERDUE',
      type: { not: 'DEPOSIT' },
    })
  })

  it('OVERDUE Invoice med total <= 0 höjer varken belopp eller count (symmetri med avi-loopen)', async () => {
    const { service } = makeService({
      notices: [],
      invoices: [INV(0), INV(3000)],
    })
    const snap = await service.getOverdueSnapshot('org-1', NOW)
    expect(snap.total).toBe(3000)
    expect(snap.count).toBe(1) // 0-fakturan räknas inte
  })

  // ── #325 ─────────────────────────────────────────────────────────────────
  describe('#325 · Invoice-grenen räknar restskulden, inte ursprungsbeloppet', () => {
    it('DELBETALD OVERDUE-faktura bidrar med resten — ärendets huvudfall', async () => {
      // Ärendets exakta scenario: 10 000 fakturerat, 9 000 allokerat, statusen
      // flippad PARTIAL → OVERDUE (giltig kant, nåbar via PATCH
      // /invoices/:id/status). Före #325 bidrog raden med 10 000.
      const { service } = makeService({ notices: [], invoices: [INV(10000, [9000])] })
      const snap = await service.getOverdueSnapshot('org-1', NOW)
      expect(snap.total).toBe(1000)
      expect(snap.count).toBe(1)

      // NEGATIVKONTROLL — testet måste kunna se skillnaden. Ursprungsbeloppet
      // är 10 000; hade koden fallit tillbaka på `total` vore total 10 000 och
      // det här testet grönt av fel skäl.
      expect(snap.total).not.toBe(10000)
    })

    it('FULLT OBETALD OVERDUE-faktura är oförändrad — fixen rör bara delbetalda', async () => {
      // Regressionsgrinden: den överlägset vanligaste fakturan (cron flippar
      // SENT → OVERDUE, inga allokeringar) ska ge exakt samma tal som förut.
      const { service } = makeService({ notices: [], invoices: [INV(7500)] })
      const snap = await service.getOverdueSnapshot('org-1', NOW)
      expect(snap.total).toBe(7500)
      expect(snap.count).toBe(1)
    })

    it('ÖVERBETALD faktura klampas PER POST och kvittar aldrig mot en annan fordran', async () => {
      // Σmax(0,x) ≠ max(0,Σx). Fakturan med −2 000 i överskott bidrar 0, inte
      // −2 000 — annars hade den ätit av grannfakturans verkliga fordran.
      // (FAR: varje faktura är en egen verifikationskedja; kvittning kräver en
      // bokförd kvittningshandling.)
      const { service } = makeService({
        notices: [],
        invoices: [INV(5000, [7000]), INV(3000)],
      })
      const snap = await service.getOverdueSnapshot('org-1', NOW)
      expect(snap.total).toBe(3000)
      expect(snap.count).toBe(1)
      expect(snap.total).not.toBe(1000) // max(0,Σx) hade gett 1000
    })

    it('FULLT REGLERAD OVERDUE-faktura räknas varken i belopp, count ELLER over30Count', async () => {
      // Detta ÄNDRAR VILKA POSTER SOM RAPPORTERAS, inte bara beloppen: en
      // faktura vars skuld är noll men vars status ännu står OVERDUE försvinner
      // ur alla tre talen. Statusfältet är där en förlegad etikett, inte ett
      // skuldpåstående. Samma regel som avi-grenen redan tillämpar.
      const { service } = makeService({
        notices: [],
        invoices: [INV(4000, [4000], 60), INV(2000, [], 60)],
      })
      const snap = await service.getOverdueSnapshot('org-1', NOW)
      expect(snap.total).toBe(2000)
      expect(snap.count).toBe(1)
      expect(snap.over30Count).toBe(1) // den reglerade fakturan höjer inte heller detta
    })

    it('urvalet är ORÖRT — #325 ändrar summeringen, inte vilka fakturor som hämtas', async () => {
      // Spärren mot att en beloppsfix smyger med en urvalsändring: `where` ska
      // se exakt likadan ut som före, och `payments` ska ha tillkommit i
      // selecten (utan den kan restskulden inte beräknas alls).
      const { service, invoiceFindMany } = makeService({ notices: [], invoices: [] })
      await service.getOverdueSnapshot('org-1', NOW)
      const call = invoiceFindMany.mock.calls[0][0]
      expect(call.where).toEqual({
        organizationId: 'org-1',
        status: 'OVERDUE',
        type: { not: 'DEPOSIT' },
      })
      expect(call.select.payments).toEqual({ select: { amount: true } })
    })

    it('avi-grenen är oförändrad när fakturagrenen ändras (ingen korsläckage)', async () => {
      // RentNotice-sidan rörs inte av #325. Samma avi-uppsättning som det
      // första testet, utan fakturor: talet ska vara identiskt.
      const { service } = makeService({
        notices: [RENT(10000), RENT(10000, [4000]), RENT(10000, [12000])],
        invoices: [],
      })
      const snap = await service.getOverdueSnapshot('org-1', NOW)
      expect(snap.total).toBe(16000)
      expect(snap.count).toBe(2)
    })
  })

  it('inga poster → nollad snapshot', async () => {
    const { service } = makeService({ notices: [], invoices: [] })
    expect(await service.getOverdueSnapshot('org-1', NOW)).toEqual({
      total: 0,
      count: 0,
      over30Count: 0,
    })
  })
})
