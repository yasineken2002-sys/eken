/**
 * #326 F1 — fuzzy-fakturagrenen går genom den beprövade vägen.
 *
 * Grenen hade en HANDRULLAD matchningssekvens: status-guardad `updateMany` till
 * PAID utan radlås och utan `organizationId`, bank-länk, händelse, och
 * verifikatet i ett `try/catch` som svalde felet — fem separata skrivningar utan
 * transaktion. Ingen allokering skapades, ingen Deposit synkades, och ett
 * bokföringsfel var tyst i två riktningar (kastet fångades, `null`-returen
 * ignorerades utan att ens loggas).
 *
 * Testerna här hävdar att grenen DIRIGERAS till `applyMatchToInvoice` med rätt
 * argument, och att fuzzy-märkningen når händelseloggen. Att BÖCKERNA stämmer
 * efteråt — allokering, verifikat, deposition, atomicitet — bevisas mot riktig
 * Postgres i bevisriggen (#326 F1, S1–S6).
 */

jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { Decimal } from '@prisma/client/runtime/library'
import { ReconciliationService } from './reconciliation.service'

const ORG = 'org-1'

/**
 * Bygger en service där ALLA deterministiska grenar missar, så att
 * matchningen med säkerhet faller igenom till fuzzy. Transaktionen saknar OCR
 * och referens; kandidatlistorna styrs per test.
 */
function makeService(opts: {
  invoices?: Array<Record<string, unknown>>
  notices?: Array<Record<string, unknown>>
}) {
  const prisma = {
    invoice: { findFirst: jest.fn().mockResolvedValue(null), findMany: jest.fn() },
    rentNotice: { findFirst: jest.fn().mockResolvedValue(null), findMany: jest.fn() },
    bankTransaction: { update: jest.fn(), updateMany: jest.fn() },
  }
  prisma.invoice.findMany.mockResolvedValue(opts.invoices ?? [])
  prisma.rentNotice.findMany.mockResolvedValue(opts.notices ?? [])

  const service = new ReconciliationService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { record: jest.fn().mockResolvedValue({}) } as never, // #326 C — RentNoticeEventsService
  )
  // Vägarna stubbas — det som testas är DIRIGERINGEN, inte deras insida
  // (den är bevisad i sina egna sviter och i riggen).
  const applyMatchToInvoice = jest
    .spyOn(service as never, 'applyMatchToInvoice')
    .mockResolvedValue(true as never)
  const applyMatchToRentNotice = jest
    .spyOn(service as never, 'applyMatchToRentNotice')
    .mockResolvedValue(true as never)

  return { service, prisma, applyMatchToInvoice, applyMatchToRentNotice }
}

/** Transaktion utan OCR och utan referens → hamnar garanterat i fuzzy. */
const FUZZY_TX = {
  id: 'tx-1',
  organizationId: ORG,
  date: new Date('2026-07-15'),
  description: 'Inbetalning',
  reference: null,
  rawOcr: null,
  amount: new Decimal(12500),
} as never

/** Kandidat vars TOTAL ligger inom toleransen för transaktionsbeloppet. */
const CANDIDATE = {
  id: 'inv-1',
  invoiceNumber: 'F-2026-0042',
  total: new Decimal(12500),
  status: 'OVERDUE',
}

describe('#326 F1 — fuzzy dirigeras till applyMatchToInvoice', () => {
  it('anropar den beprövade vägen i stället för att skriva statusen själv', async () => {
    const { service, prisma, applyMatchToInvoice } = makeService({ invoices: [CANDIDATE] })

    await expect(service.matchTransaction(FUZZY_TX, ORG)).resolves.toBe(true)

    expect(applyMatchToInvoice).toHaveBeenCalledTimes(1)
    // Den handrullade sekvensen är BORTA: ingen direkt statusskrivning, ingen
    // direkt bank-länk. Skulle någon återinföra dem faller det här.
    expect(prisma.bankTransaction.update).not.toHaveBeenCalled()
    expect(prisma.bankTransaction.updateMany).not.toHaveBeenCalled()
  })

  it('skickar rätt argument: fakturans total, transaktionens belopp, allowPartial=false', async () => {
    const { service, applyMatchToInvoice } = makeService({ invoices: [CANDIDATE] })

    await service.matchTransaction(FUZZY_TX, ORG)

    const args = applyMatchToInvoice.mock.calls[0] as unknown as unknown[]
    expect(args[0]).toBe('tx-1') // transaktionen
    expect(args[1]).toBe('inv-1') // fakturan
    expect(args[2]).toBe(ORG) // org-scopat
    expect(Number(args[3])).toBe(12500) // fakturans total
    expect(Number(args[4])).toBe(12500) // FAKTISKT mottaget belopp
    expect(args[6]).toBeNull() // ingen användare — automatmatchning
    expect(args[8]).toBe(false) // allowPartial: en gissning blir ALDRIG delbetalning
  })

  it("bär matchType 'fuzzy' — regleringar som vilar på en gissning ska gå att hitta i efterhand", async () => {
    // BFL 5 kap 11 §. Utan märkningen går det inte att i efterhand plocka fram
    // precis de regleringar som vilar på en sannolikhet.
    const { service, applyMatchToInvoice } = makeService({ invoices: [CANDIDATE] })

    await service.matchTransaction(FUZZY_TX, ORG)

    expect((applyMatchToInvoice.mock.calls[0] as unknown as unknown[])[9]).toBe('fuzzy')
  })

  it('märkningen bärs som matchType, INTE som actorLabel — HUR och VEM är olika frågor', async () => {
    // `actorLabel` betyder VEM överallt annars i kodbasen ('System',
    // 'Manuell markering'). 'fuzzy' där hade påstått att aktören var fuzzy, och
    // samtidigt tappat den sökbara `matchType`-nyckeln.
    const { service, applyMatchToInvoice } = makeService({ invoices: [CANDIDATE] })

    await service.matchTransaction(FUZZY_TX, ORG)

    expect((applyMatchToInvoice.mock.calls[0] as unknown as unknown[])[7]).toBeNull() // actorLabel
  })
})

describe('#326 F1 — fuzzy-filtrets egna regler är oförändrade', () => {
  it('flera kandidater → ingen match (för osäkert)', async () => {
    const { service, applyMatchToInvoice } = makeService({
      invoices: [CANDIDATE, { ...CANDIDATE, id: 'inv-2', invoiceNumber: 'F-2026-0043' }],
    })

    await expect(service.matchTransaction(FUZZY_TX, ORG)).resolves.toBe(false)
    expect(applyMatchToInvoice).not.toHaveBeenCalled()
  })

  it('en faktura OCH en avi inom toleransen → ingen match (räknas över BÅDA tabellerna)', async () => {
    const { service, applyMatchToInvoice, applyMatchToRentNotice } = makeService({
      invoices: [CANDIDATE],
      notices: [
        {
          id: 'rn-1',
          totalAmount: new Decimal(12500),
          consumptionAmount: new Decimal(0),
          miscChargeAmount: new Decimal(0),
          reminderFeeAmount: new Decimal(0),
          credits: [],
        },
      ],
    })

    await expect(service.matchTransaction(FUZZY_TX, ORG)).resolves.toBe(false)
    expect(applyMatchToInvoice).not.toHaveBeenCalled()
    expect(applyMatchToRentNotice).not.toHaveBeenCalled()
  })

  it('belopp utanför toleransen (1 kr) → ingen match', async () => {
    // DISKRIMINERANDE: 12 498 mot 12 500 är 2 kr fel — precis utanför.
    const { service, applyMatchToInvoice } = makeService({
      invoices: [{ ...CANDIDATE, total: new Decimal(12498) }],
    })

    await expect(service.matchTransaction(FUZZY_TX, ORG)).resolves.toBe(false)
    expect(applyMatchToInvoice).not.toHaveBeenCalled()
  })

  it('inom toleransen men inte exakt (öresavrundning) → matchar', async () => {
    const { service, applyMatchToInvoice } = makeService({
      invoices: [{ ...CANDIDATE, total: new Decimal('12499.50') }],
    })

    await expect(service.matchTransaction(FUZZY_TX, ORG)).resolves.toBe(true)
    // Beloppet som allokeras är det FAKTISKT mottagna, inte fakturans total.
    expect(Number((applyMatchToInvoice.mock.calls[0] as unknown as unknown[])[4])).toBe(12500)
  })
})

describe('#326 F1 — avi-grenen är orörd', () => {
  it('en ensam avi-kandidat går fortfarande till applyMatchToRentNotice med allowPartial=false', async () => {
    const { service, applyMatchToRentNotice, applyMatchToInvoice } = makeService({
      notices: [
        {
          id: 'rn-1',
          totalAmount: new Decimal(12500),
          consumptionAmount: new Decimal(0),
          miscChargeAmount: new Decimal(0),
          reminderFeeAmount: new Decimal(0),
          credits: [],
        },
      ],
    })

    await expect(service.matchTransaction(FUZZY_TX, ORG)).resolves.toBe(true)

    expect(applyMatchToInvoice).not.toHaveBeenCalled()
    expect(applyMatchToRentNotice).toHaveBeenCalledTimes(1)
    const args = applyMatchToRentNotice.mock.calls[0] as unknown as unknown[]
    expect(args[1]).toBe('rn-1')
    expect(args[6]).toBe(false) // allowPartial — oförändrat
  })
})
