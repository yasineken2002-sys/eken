/**
 * Bokföringsfix #2 — manuell betalningsregistrering bokför inbetalningen.
 *
 * Tidigare satte PATCH /invoices/:id/status → PAID bara status, aldrig ett
 * verifikat: 1510 (Kundfordringar) stod kvar öppen (BFL 5 kap 6 §-brott).
 * markAsPaidManually ska istället:
 *   • atomiskt claima fakturan (SENT/PARTIAL/OVERDUE/SENT_TO_COLLECTION → PAID)
 *   • boka betalningen (likvidkonto D / 1510 K) med det MOTTAGNA beloppet
 *   • vägra dubbelbetalning och ogiltiga övergångar
 *
 * Sedan #288 sker allt i EN transaktion: uteblir verifikatet rullas hela
 * skrivningen tillbaka av databasen, i stället för att en catch-gren försöker
 * ångra det som redan hunnit committa.
 *
 * ── Varför attrappen ger tx ETT EGET OBJEKT ─────────────────────────────────
 *
 * Enklaste attrappen är `$transaction: (cb) => cb(prisma)` — den låter
 * transaktionsklienten VARA prisma-attrappen. Då blir `tx.invoice.updateMany`
 * och `this.prisma.invoice.updateMany` samma mock, och ett anrop som av misstag
 * går utanför transaktionen ser exakt likadant ut som ett som går innanför.
 *
 * Det är inte hypotetiskt: under bygget av #288 låg claimen kvar på
 * `this.prisma`. Den självblockerade på vårt eget FOR UPDATE-lås och committade
 * dessutom fristående — precis det halvtillstånd fixen skulle ta bort. En
 * attrapp av den enkla sorten hade varit grön hela tiden. Därför får `tx` egna
 * mockar här, och testerna kontrollerar att prisma-sidans skrivmockar ALDRIG
 * anropas.
 */

jest.mock('./pdf.service', () => ({ PdfService: class {} }))
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { InvoicesService, toPaymentMethod } from './invoices.service'

function makeService(
  opts: {
    status?: string
    journalReturnsNull?: boolean
    claimCount?: number
    priorAllocations?: Array<{ amount: number }>
  } = {},
) {
  const status = opts.status ?? 'SENT'
  const invoiceRow = {
    id: 'inv-1',
    status,
    invoiceNumber: 'F-2026-0001',
    total: 1250,
  }

  const updateMany = jest.fn().mockResolvedValue({ count: opts.claimCount ?? 1 })
  const findFirst = jest.fn().mockResolvedValue(invoiceRow)
  const findFirstOrThrow = jest.fn().mockResolvedValue({ ...invoiceRow, status: 'PAID' })
  // Allokeringsmodellen (C4/C5). Tom lista = inga tidigare betalningar, så
  // restskulden är hela totalen och en full betalning reglerar fakturan.
  //
  // #290 — raden returnerar ett RIKTIGT id. En attrapp som svarar `{}` ger
  // allokeringen id === undefined, och då blir verifikatets nyckel densamma
  // ("...:undefined") oavsett hur många betalningar som registreras — attrappen
  // skulle utplåna just den distinktion nyckeln bygger på.
  const invoicePaymentCreate = jest.fn().mockResolvedValue({ id: 'alloc-1' })

  // Transaktionsklienten — egna mockar, se docblocken överst. Attrappen kör bara
  // callbacken; att rollbacken FAKTISKT sker bevisas mot riktig Postgres.
  const tx = {
    invoice: { findFirst, updateMany },
    invoicePayment: {
      findMany: jest.fn().mockResolvedValue(opts.priorAllocations ?? []),
      create: invoicePaymentCreate,
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    $queryRaw: jest.fn().mockResolvedValue([]),
  }

  // Prisma-sidans SKRIVmockar ska aldrig röras av markAsPaidManually. Läsningen
  // findFirstOrThrow (returvärdet, efter commit) är det enda legitima anropet.
  const utanförTx = {
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    create: jest.fn().mockResolvedValue({}),
    deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    findMany: jest.fn().mockResolvedValue([]),
    findFirst: jest.fn().mockResolvedValue(invoiceRow),
    queryRaw: jest.fn().mockResolvedValue([]),
  }
  const prisma = {
    invoice: {
      findFirst: utanförTx.findFirst,
      findFirstOrThrow,
      updateMany: utanförTx.updateMany,
    },
    invoicePayment: {
      findMany: utanförTx.findMany,
      create: utanförTx.create,
      deleteMany: utanförTx.deleteMany,
    },
    $transaction: undefined as unknown as jest.Mock,
    $queryRaw: utanförTx.queryRaw,
  }
  prisma.$transaction = jest.fn((cb: (t: unknown) => unknown) => cb(tx))

  const createJournalEntryForInvoiceManualPayment = jest.fn(() =>
    opts.journalReturnsNull ? Promise.resolve(null) : Promise.resolve({ id: 'je-pay-1' }),
  )
  const accountingService = { createJournalEntryForInvoiceManualPayment }
  const eventsService = { record: jest.fn().mockResolvedValue(undefined) }
  const notificationsService = { createForAllOrgUsers: jest.fn().mockResolvedValue(undefined) }

  const service = new InvoicesService(
    prisma as never,
    eventsService as never,
    {} as never,
    {} as never,
    accountingService as never,
    notificationsService as never,
    {} as never,
    {} as never,
  )

  return {
    service,
    prisma,
    tx,
    utanförTx,
    updateMany,
    invoicePaymentCreate,
    createJournalEntryForInvoiceManualPayment,
    eventsService,
    notificationsService,
  }
}

describe('InvoicesService.markAsPaidManually — bokför inbetalningen', () => {
  it('full betalning: bokför det mottagna beloppet (= hela restskulden) och sätter PAID', async () => {
    const { service, updateMany, createJournalEntryForInvoiceManualPayment, eventsService } =
      makeService()

    await service.markAsPaidManually('inv-1', 'org-1', 'BANK', 'user-1', 'USER', {
      enteredAmount: 1250,
      reference: 'OCR123',
    })

    // atomisk claim till PAID
    expect(updateMany).toHaveBeenCalledTimes(1)
    expect(updateMany.mock.calls[0]?.[0]).toMatchObject({ data: { status: 'PAID' } })
    // Bokför det MOTTAGNA beloppet. Här sammanfaller det med totalen (1250),
    // vilket är varför detta test aldrig kunde fånga C5 — se
    // invoices.partial-payment.spec.ts för fallet där de skiljer sig.
    expect(createJournalEntryForInvoiceManualPayment).toHaveBeenCalledTimes(1)
    const args = createJournalEntryForInvoiceManualPayment.mock.calls[0] as unknown[]
    expect(args[1]).toBe(1250)
    expect(args[3]).toBe('BANK')
    // #290 — verifikatet nycklas på den allokering som just skapades, inte på
    // fakturan. Även en full betalning går den vägen: en faktura kan ha fått en
    // delbetalning tidigare, och då är detta den andra allokeringen.
    expect(args[6]).toBe('alloc-1')
    expect(args[6]).not.toBe('inv-1')
    // append-only PAYMENT_RECEIVED-händelse
    expect(eventsService.record).toHaveBeenCalledWith(
      'inv-1',
      'PAYMENT_RECEIVED',
      'USER',
      'user-1',
      expect.objectContaining({ newStatus: 'PAID', settlementAmount: 1250, reference: 'OCR123' }),
      // #288 — händelseposten skrivs i SAMMA transaktion som claimen och
      // verifikatet. Sista argumentet BÄR transaktionsklienten; utan den vore
      // loggraden en separat skrivning som kunde överleva en rollback.
      expect.objectContaining({ tx: expect.anything() }),
    )
  })

  it('verifikatet uteblir (kontoplan saknas) → INGEN kompenserande revert (#288)', async () => {
    // Tidigare låste det här testet det kompenserande mönstret: två updateMany,
    // den andra en revert till SENT. Att de nu är EN är beviset på att koden
    // litar på databasens rollback i stället för på att processen överlever sitt
    // eget catch-block. Att rollbacken FAKTISKT sker kan inte visas med en
    // attrapp — den kör bara callbacken — utan bevisas mot riktig Postgres.
    const { service, updateMany, tx, eventsService } = makeService({
      journalReturnsNull: true,
    })

    await expect(
      service.markAsPaidManually('inv-1', 'org-1', 'BANK', 'user-1', 'USER', {}),
    ).rejects.toThrow(/verifikat kunde inte skapas/i)

    expect(updateMany).toHaveBeenCalledTimes(1) // bara claimen — ingen revert
    expect(tx.invoicePayment.deleteMany).not.toHaveBeenCalled()
    // ingen betald-händelse skrevs för en betalning som inte gick igenom
    expect(eventsService.record).not.toHaveBeenCalled()
  })

  it('allt som skrivs ligger i SAMMA transaktion som bokföringen (#288)', async () => {
    const { service, prisma, tx, utanförTx, createJournalEntryForInvoiceManualPayment } =
      makeService()

    await service.markAsPaidManually('inv-1', 'org-1', 'BANK', 'user-1', 'USER', {})

    expect(prisma.$transaction).toHaveBeenCalledTimes(1)
    // Radlåset tas FÖRST, före varje läsning beslutet vilar på — och det tas på
    // TRANSAKTIONSKLIENTEN, inte bredvid den.
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1)
    expect(utanförTx.queryRaw).not.toHaveBeenCalled()
    // Bokföringen får transaktionsklienten som sista argument. Allokerings-id:t
    // (#290) sköts in FÖRE den — tx ligger kvar sist, som avi-vägen.
    const bokförArgs = createJournalEntryForInvoiceManualPayment.mock.calls[0] as unknown[]
    expect(bokförArgs[bokförArgs.length - 1]).toBe(tx)
    expect(bokförArgs).toHaveLength(8)
  })

  it('INGEN skrivning går utanför transaktionen (#288 — fångar en glömd this.prisma)', async () => {
    // Den här kontrollen är hela skillnaden mot en attrapp där tx === prisma.
    // Faller den: någon skrivning har hamnat utanför transaktionen och kan
    // överleva en rollback.
    const { service, tx, utanförTx } = makeService()

    await service.markAsPaidManually('inv-1', 'org-1', 'BANK', 'user-1', 'USER', {})

    expect(tx.invoice.updateMany).toHaveBeenCalledTimes(1)
    expect(tx.invoicePayment.create).toHaveBeenCalledTimes(1)
    expect(utanförTx.updateMany).not.toHaveBeenCalled()
    expect(utanförTx.create).not.toHaveBeenCalled()
    expect(utanförTx.deleteMany).not.toHaveBeenCalled()
    expect(utanförTx.findMany).not.toHaveBeenCalled()
    expect(utanförTx.findFirst).not.toHaveBeenCalled()
  })

  it('transaktionen har EXPLICITA gränser — en svälten betalning failar, hänger inte', async () => {
    // Låstiden växte med atomiciteten. Utan uttalade gränser ärvs Prismas
    // defaults tyst. Testet kontrollerar BANDET, inte siffran: generöst över det
    // uppmätta normalfallet (median 16,5 ms med skarp bokföring), långt under
    // det som läser som en hängning.
    const { service, prisma } = makeService()
    await service.markAsPaidManually('inv-1', 'org-1', 'BANK', 'user-1', 'USER', {})
    const optioner = prisma.$transaction.mock.calls[0]![1] as { timeout: number; maxWait: number }
    expect(optioner).toBeDefined()
    expect(optioner.timeout).toBeGreaterThanOrEqual(2_000)
    expect(optioner.timeout).toBeLessThanOrEqual(15_000)
    expect(optioner.maxWait).toBeGreaterThanOrEqual(1_000)
    expect(optioner.maxWait).toBeLessThanOrEqual(optioner.timeout)
  })

  it('vägrar dubbelbetalning (redan PAID)', async () => {
    const { service, updateMany } = makeService({ status: 'PAID' })

    await expect(
      service.markAsPaidManually('inv-1', 'org-1', 'BANK', 'user-1', 'USER', {}),
    ).rejects.toThrow(/redan betald/i)
    expect(updateMany).not.toHaveBeenCalled()
  })

  it('vägrar betalning på ett utkast (DRAFT → PAID är ogiltig)', async () => {
    const { service, updateMany } = makeService({ status: 'DRAFT' })

    await expect(
      service.markAsPaidManually('inv-1', 'org-1', 'BANK', 'user-1', 'USER', {}),
    ).rejects.toThrow(/inte tillåten/i)
    expect(updateMany).not.toHaveBeenCalled()
  })

  it('kastar konflikt om en parallell process hann reglera fakturan (claim count 0)', async () => {
    const { service, createJournalEntryForInvoiceManualPayment } = makeService({ claimCount: 0 })

    await expect(
      service.markAsPaidManually('inv-1', 'org-1', 'BANK', 'user-1', 'USER', {}),
    ).rejects.toThrow(/redan reglerad eller makulerad/i)
    expect(createJournalEntryForInvoiceManualPayment).not.toHaveBeenCalled()
  })
})

describe('toPaymentMethod — UI-sträng → PaymentMethod-enum', () => {
  it('mappar visningssträngarna till rätt enum', () => {
    expect(toPaymentMethod('Bankgiro')).toBe('BANK')
    expect(toPaymentMethod('Plusgiro')).toBe('BANK')
    expect(toPaymentMethod('Autogiro')).toBe('BANK')
    expect(toPaymentMethod('Swish')).toBe('SWISH')
    expect(toPaymentMethod('Kontant')).toBe('CASH')
  })

  it('faller tillbaka till MANUAL för okänt/utelämnat betalsätt', () => {
    expect(toPaymentMethod(undefined)).toBe('MANUAL')
    expect(toPaymentMethod('')).toBe('MANUAL')
    expect(toPaymentMethod('Bitcoin')).toBe('MANUAL')
  })
})
