/**
 * Fix #1 (dubbelfaktureringsskydd) — restposten efter borttagningen av createBulk.
 *
 * Avisering (RentNotice) är den kanoniska hyresmotorn. En manuell RENT-faktura via
 * POST /invoices för ett avtal+period som redan aviserats skulle intäktsbokföra
 * samma hyra en andra gång (1510 D / 39xx K två gånger, BFL 4 kap 2 §). create()
 * ska nu blockera med ConflictException om en icke-annullerad RentNotice finns för
 * samma leaseId + månad/år.
 */

jest.mock('./pdf.service', () => ({ PdfService: class {} }))
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { ConflictException } from '@nestjs/common'
import { InvoicesService } from './invoices.service'
import { DUBBLETT_FAKTURA_FONSTER_MS } from './duplicate-invoice-window'

const DTO = {
  type: 'RENT' as const,
  leaseId: 'lease-1',
  issueDate: '2026-06-01',
  dueDate: '2026-06-30',
  lines: [{ description: 'Hyra', quantity: 1, unitPrice: 10000, vatRate: 0 }],
}

function makeService(opts: { existingNotice?: boolean; existingInvoice?: boolean } = {}) {
  const rentNoticeFindFirst = jest
    .fn()
    .mockResolvedValue(opts.existingNotice ? { id: 'rn-1' } : null)

  // Spärrens population är BÅDA tabellerna: en manuell RENT-faktura för samma
  // avtal och period är lika mycket en dubbelbokföring som en avi är.
  const invoiceFindFirst = jest
    .fn()
    .mockResolvedValue(opts.existingInvoice ? { id: 'inv-tidigare' } : null)

  const tx = {
    invoice: {
      create: jest.fn().mockResolvedValue({
        id: 'inv-1',
        invoiceNumber: 'F-2026-0001',
        lines: [{ id: 'l1' }],
      }),
    },
  }
  const prisma = {
    lease: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'lease-1',
        status: 'ACTIVE',
        tenantId: 'tenant-1',
        unit: { type: 'APARTMENT', voluntaryTaxLiability: false },
      }),
    },
    rentNotice: { findFirst: rentNoticeFindFirst },
    invoice: { findFirst: invoiceFindFirst },
    $transaction: (cb: (t: unknown) => unknown) => cb(tx),
  }
  const eventsService = { record: jest.fn().mockResolvedValue(undefined) }
  const accountingService = {
    createJournalEntryForInvoice: jest.fn().mockResolvedValue({ id: 'je-1' }),
  }
  const ocrService = { generateForInvoiceSequence: jest.fn().mockReturnValue('1234567890') }

  const service = new InvoicesService(
    prisma as never,
    eventsService as never,
    {} as never,
    {} as never,
    accountingService as never,
    {} as never,
    ocrService as never,
    {} as never,
  )
  ;(
    service as unknown as {
      generateInvoiceNumber: () => Promise<{ invoiceNumber: string; sequence: number }>
    }
  ).generateInvoiceNumber = () => Promise.resolve({ invoiceNumber: 'F-2026-0001', sequence: 1 })

  return { service, rentNoticeFindFirst, invoiceFindFirst, txCreate: tx.invoice.create }
}

describe('InvoicesService.create — dubbelfaktureringsspärren, båda tabellerna', () => {
  it('blockerar en RENT-faktura när en icke-annullerad hyresavi finns för perioden', async () => {
    const { service, rentNoticeFindFirst, txCreate } = makeService({ existingNotice: true })

    await expect(service.create('org-1', 'user-1', DTO as never)).rejects.toBeInstanceOf(
      ConflictException,
    )
    // Slår upp rätt avtal + period, exkluderar annullerade avier
    expect(rentNoticeFindFirst.mock.calls[0]?.[0]).toMatchObject({
      where: {
        leaseId: 'lease-1',
        type: 'RENT',
        month: 6,
        year: 2026,
        status: { not: 'CANCELLED' },
      },
    })
    // Ingen faktura skapades
    expect(txCreate).not.toHaveBeenCalled()
  })

  it('tillåter en RENT-faktura när ingen hyresavi finns för perioden', async () => {
    const { service, txCreate } = makeService({ existingNotice: false })

    const result = await service.create('org-1', 'user-1', DTO as never)
    expect(result).toMatchObject({ id: 'inv-1' })
    expect(txCreate).toHaveBeenCalledTimes(1)
  })

  // ── POPULATIONEN VAR HALV ────────────────────────────────────────────────
  //
  // Spärren frågade bara `RentNotice`. Två MANUELLA RENT-fakturor för samma
  // avtal och period passerade alltså båda så länge ingen avi fanns, och hyran
  // bokfördes två gånger. Nyckeln (avtal, period) var rätt hela tiden — den
  // ställdes mot fel mängd rader.

  it('SAMMA anrop två gånger: en befintlig RENT-FAKTURA för perioden blockerar', async () => {
    const { service, txCreate } = makeService({ existingInvoice: true })

    await expect(service.create('org-1', 'user-1', DTO as never)).rejects.toBeInstanceOf(
      ConflictException,
    )
    expect(txCreate).not.toHaveBeenCalled()
  })

  it('frågan avgränsas till avtalet, RENT och den civila MÅNADEN som intervall', async () => {
    // `issueDate` är en DATE-kolumn och bär ingen månad att jämföra direkt mot.
    // Blir intervallet fel blockerar spärren fel period — eller ingen alls.
    const { service, invoiceFindFirst } = makeService({ existingInvoice: false })
    await service.create('org-1', 'user-1', DTO as never)

    const where = invoiceFindFirst.mock.calls[0]?.[0].where
    expect(where).toMatchObject({ leaseId: 'lease-1', type: 'RENT', status: { not: 'VOID' } })
    expect(where.issueDate.gte.toISOString()).toBe('2026-06-01T00:00:00.000Z')
    expect(where.issueDate.lt.toISOString()).toBe('2026-07-01T00:00:00.000Z')
  })

  it('MOTPROV: en makulerad faktura gör inte längre anspråk på perioden', async () => {
    // Uttryckt i frågan (`status: { not: 'VOID' }`), inte i ett efterfilter —
    // annars hade en makulerad faktura blockerat en legitim ersättare.
    const { service, invoiceFindFirst } = makeService({ existingInvoice: false })
    await service.create('org-1', 'user-1', DTO as never)
    expect(invoiceFindFirst.mock.calls[0]?.[0].where.status).toEqual({ not: 'VOID' })
  })

  // ── GREN 2: ICKE-RENT ────────────────────────────────────────────────────
  //
  // Provet krävde tidigare att grenen frågade INGENTING. Det var sant och är
  // det inte längre, och ändringen är ett beslut: `create()` bokför
  // intäktsverifikatet i SAMMA transaktion som fakturan — även för ett utkast
  // (T5 A1) — så en oavsiktlig dubblett dubbelbokför intäkten. Grenen kunde
  // alltså inte stå tom.
  //
  // Den frågar fortfarande INGEN avi: en serviceavgift har ingen period.

  it('en ICKE-RENT-faktura frågar ingen AVI — bara sitt eget fönster', async () => {
    const { service, rentNoticeFindFirst, invoiceFindFirst, txCreate } = makeService()

    await service.create('org-1', 'user-1', { ...DTO, type: 'SERVICE' } as never)
    expect(rentNoticeFindFirst).not.toHaveBeenCalled()
    expect(invoiceFindFirst).toHaveBeenCalledTimes(1)
    expect(txCreate).toHaveBeenCalledTimes(1)
  })

  it('fönstrets signatur är avtal + typ + belopp + förfallodag, inom en tidsgräns', async () => {
    // RADBESKRIVNINGARNA STÅR UTANFÖR med flit: modellen formulerar om dem vid
    // ett omtag, och en nämnare som innehåller dem hade blivit för fin och
    // dedupat ingenting.
    const { service, invoiceFindFirst } = makeService()
    await service.create('org-1', 'user-1', { ...DTO, type: 'SERVICE' } as never)

    const where = invoiceFindFirst.mock.calls[0]?.[0].where
    expect(where).toMatchObject({
      leaseId: 'lease-1',
      type: 'SERVICE',
      total: 10000,
      status: { not: 'VOID' },
      creditedInvoiceId: null,
    })
    expect(where.dueDate).toBeInstanceOf(Date)
    expect(where.createdAt.gt).toBeInstanceOf(Date)
    expect(where.description).toBeUndefined()

    // ⚠️ ETT INTERVALL, INTE ETT TAK. Första versionen skrev
    // `expect(ålder).toBeLessThanOrEqual(60_000)` och var därmed grön bara om
    // NOLL tid förflutit mellan att `where` byggdes och att provet läste den —
    // alltså rött så fort en millisekund passerade. Den föll i en gruppkörning
    // och såg ut som en flake tills provet kördes igen och visade orsaken.
    //
    // Gränsen jämförs dessutom mot KONSTANTEN, inte mot 60000 skrivet en andra
    // gång: ett prov som upprepar talet slutar mäta att koden använder det.
    const ålder = Date.now() - where.createdAt.gt.getTime()
    expect(ålder).toBeGreaterThanOrEqual(DUBBLETT_FAKTURA_FONSTER_MS)
    expect(ålder).toBeLessThan(DUBBLETT_FAKTURA_FONSTER_MS + 5_000)
  })

  it('SAMMA anrop två gånger: en färsk identisk avgift blockerar, och ingen faktura skapas', async () => {
    const { service, txCreate } = makeService({ existingInvoice: true })

    await expect(
      service.create('org-1', 'user-1', { ...DTO, type: 'SERVICE' } as never),
    ).rejects.toBeInstanceOf(ConflictException)
    // Det som gör det här värt en spärr: utan den hade intäkten bokförts två
    // gånger i samma transaktion som den andra fakturan.
    expect(txCreate).not.toHaveBeenCalled()
  })

  it('TVÅ LEGITIMA anrop: utan färsk träff går den andra igenom', async () => {
    // Den obligatoriska andra kontrollen. En verklig andra avgift — annat
    // belopp, annan förfallodag, eller bara senare än fönstret — ska gå fram.
    //
    // ⚠️ MEN DEN BÄR INTE FÖR-GROV-KONTROLLEN HÄR, och det ska stå utskrivet.
    // Attrappen returnerar `null` oavsett `where`, så den kan inte se om
    // avgränsningen tappat ett fält. Uppmätt: med `total` och `dueDate`
    // borttagna ur signaturen förblir DET HÄR provet grönt — det är
    // signaturprovet ovan som faller.
    //
    // I ett db-prov hade de två fallit ihop. Här bärs för-grov-riktningen av
    // signaturen, och det är en gräns hos attrappen, inte hos regeln.
    const { service, txCreate } = makeService({ existingInvoice: false })

    await service.create('org-1', 'user-1', { ...DTO, type: 'SERVICE' } as never)
    expect(txCreate).toHaveBeenCalledTimes(1)
  })
})
