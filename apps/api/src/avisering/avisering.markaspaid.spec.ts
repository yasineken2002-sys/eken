/**
 * FIX 9 · PR 6 — markAsPaid bokför betalningen och sluter intäktscykeln.
 *
 * Verifierar att AviseringService.markAsPaid:
 *   • Tar avin obetald → PAID med en atomisk, race-säker updateMany (status-guard)
 *     och persisterar paymentMethod (audit).
 *   • Bokför betalningen (likvidkonto D / 1510 K) med rätt sätt, belopp, datum, aktör.
 *   • Blockerar redan betald (PAID) och avbruten (CANCELLED) avi, och ger 409 när
 *     en parallell process hann reglera avin (claim.count === 0).
 *   • Ångrar statusövergången om verifikatet inte kunde skapas — vare sig
 *     bokföringen kastar ELLER returnerar null (saknat konto) — så att ingen
 *     PAID-avi lämnas utan motpost (BFL 5 kap 6 §).
 */

jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))

import {
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
} from '@nestjs/common'
import { AviseringService } from './avisering.service'

function makeService(opts?: {
  notice?: Record<string, unknown>
  claimCount?: number
  priorAllocations?: Array<{ amount: number }>
}) {
  const notice = {
    id: 'rn-1',
    organizationId: 'org-1',
    noticeNumber: 'AVI-2026-06-0001',
    type: 'RENT',
    status: 'SENT',
    collectionStage: 'NONE',
    totalAmount: 10_000,
    // D5 (bank-härdning PR 3b) — markAsPaid läser nu skuldkomponenterna via
    // computeRentDebt för att avgöra om betalningen reglerar avin (PAID) eller är
    // en delbetalning. Defaulta de övriga fälten till 0.
    consumptionAmount: 0,
    miscChargeAmount: 0,
    reminderFeeAmount: 0,
    interestAccruedAmount: 0,
    credits: [],
    paymentMethod: null,
    ...opts?.notice,
  }

  const eventCreate = jest.fn().mockResolvedValue({})
  const prisma = {
    rentNotice: {
      // #108: markAsPaid läser avin TRE gånger — preflight (tydliga felmeddelanden),
      // omläsning INNANFÖR radlåset (sanningen), och en re-fetch för returvärdet.
      // De två första ska se den ÖPPNA avin; först därefter den betalda.
      findFirst: jest
        .fn()
        .mockResolvedValueOnce(notice)
        .mockResolvedValueOnce(notice)
        .mockResolvedValue({ ...notice, status: 'PAID' }),
      updateMany: jest.fn().mockResolvedValue({ count: opts?.claimCount ?? 1 }),
    },
    // Bankavstämnings-härdning PR 1 — MANUAL-allokering skrivs bredvid betalningen.
    // PR 3b — findMany läser tidigare allokeringar (D5-skuldberäkning). Default = [].
    // #518 — krediteringarna läses på samma vägar som allokeringarna.
    rentNoticeCredit: { findMany: jest.fn().mockResolvedValue([]) },
    rentNoticePayment: {
      findMany: jest.fn().mockResolvedValue(opts?.priorAllocations ?? []),
      create: jest.fn().mockResolvedValue({ id: 'rnp-1' }),
      delete: jest.fn().mockResolvedValue({}),
    },
    // PR 2 — append-only trail för kravstegs-nollställningen.
    rentNoticeEvent: { create: eventCreate },
    // F+E: cancelNotice lossar charges från den annullerade avin. Ingen
    // charge i de här fallen — beteendet bevisas i detach-specarna.
    rentNoticeLine: {
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    consumptionCharge: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    miscCharge: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    // cancelNotice kör statusflip + motverifikat (fix #4) atomiskt i $transaction.
    // Deklareras här, tilldelas nedan (undviker cirkulär typinferens på `prisma`).
    $transaction: undefined as unknown as jest.Mock,
    // #108 — radlåset. Attrappen behöver bara svara; låsets EFFEKT (serialisering)
    // kan inte modelleras utan en riktig databas och bevisas därför separat.
    $queryRaw: jest.fn().mockResolvedValue([]),
  }
  prisma.$transaction = jest.fn((cb: (t: unknown) => unknown) => cb(prisma))

  const accounting = {
    createJournalEntryForRentNoticeManualPayment: jest.fn().mockResolvedValue({ id: 'je-pay-1' }),
    // Fix #4 — annullering reverserar avins intäktsverifikat (no-op-mock räcker).
    reverseJournalEntryForRentNotice: jest.fn().mockResolvedValue(undefined),
    // A+B — annulleringen vänder även avgift och ränta (no-op-mock räcker här;
    // beteendet bevisas i accounting.fee-interest-reversal.spec.ts).
    reverseJournalEntryForReminderFee: jest.fn().mockResolvedValue(undefined),
    reverseJournalEntryForInterest: jest.fn().mockResolvedValue(undefined),
  }
  const noop = {}

  const service = new AviseringService(
    prisma as never,
    noop as never, // ocr
    noop as never, // mail
    noop as never, // pdf
    noop as never, // storage
    noop as never, // pdfQueue
    accounting as never,
    noop as never, // consumption
    noop as never, // miscCharges
    { ensureDepositForNotice: jest.fn().mockResolvedValue({ created: false }) } as never, // deposits
    {} as never, // rentNoticeEvents
  )
  return { service, prisma, accounting, eventCreate }
}

describe('FIX 9 · PR 6 — AviseringService.markAsPaid', () => {
  it('claimar status atomiskt → PAID med paymentMethod och bokför betalningen', async () => {
    const { service, prisma, accounting } = makeService()
    await service.markAsPaid('rn-1', 'org-1', 10_000, 'SWISH', '2026-06-15', 'user-1')

    // Atomisk claim: status-guard mot alla obetalda lägen, scopad till org.
    const claim = prisma.rentNotice.updateMany.mock.calls[0][0]
    expect(claim.where).toMatchObject({ id: 'rn-1', organizationId: 'org-1' })
    expect(claim.where.status.in).toEqual(
      expect.arrayContaining(['PENDING', 'SENT', 'OVERDUE', 'FAILED']),
    )
    expect(claim.data).toMatchObject({ status: 'PAID', paidAmount: 10_000, paymentMethod: 'SWISH' })

    // Bokföring med rätt argument.
    expect(accounting.createJournalEntryForRentNoticeManualPayment).toHaveBeenCalledTimes(1)
    const [noticeArg, amountArg, dateArg, methodArg, orgArg, byArg] =
      accounting.createJournalEntryForRentNoticeManualPayment.mock.calls[0]
    expect(noticeArg).toMatchObject({ id: 'rn-1', noticeNumber: 'AVI-2026-06-0001', type: 'RENT' })
    expect(amountArg).toBe(10_000)
    expect((dateArg as Date).toISOString().slice(0, 10)).toBe('2026-06-15')
    expect(methodArg).toBe('SWISH')
    expect(orgArg).toBe('org-1')
    expect(byArg).toBe('user-1')
  })

  it('claimar FÖRE bokföring (status sätts inte efter en lyckad bokning)', async () => {
    const { service, prisma, accounting } = makeService()
    const order: string[] = []
    prisma.rentNotice.updateMany.mockImplementationOnce(() => {
      order.push('claim')
      return Promise.resolve({ count: 1 })
    })
    accounting.createJournalEntryForRentNoticeManualPayment.mockImplementationOnce(() => {
      order.push('book')
      return Promise.resolve({ id: 'je-pay-1' })
    })
    await service.markAsPaid('rn-1', 'org-1', 10_000, 'BANK')
    expect(order).toEqual(['claim', 'book'])
  })

  it('bokföringen KASTAR → felet propageras och INGEN kompenserande revert görs', async () => {
    // #108: tidigare gjordes ett andra updateMany som backade statusen, och en
    // delete som städade allokeringen. Båda är borta — transaktionen rullar
    // tillbaka. Att INGEN revert sker är alltså beviset på att koden litar på
    // databasen i stället för på att processen överlever sitt eget catch-block.
    //
    // Att rollbacken FAKTISKT sker kan inte visas här: attrappens $transaction
    // kör bara callbacken och kan inte ångra något. Det bevisas mot en riktig
    // databas — se rapporten i PR:en.
    const { service, prisma, accounting } = makeService()
    accounting.createJournalEntryForRentNoticeManualPayment.mockRejectedValueOnce(
      new Error('DB nere'),
    )
    await expect(service.markAsPaid('rn-1', 'org-1', 10_000, 'BANK')).rejects.toThrow('DB nere')
    expect(prisma.rentNotice.updateMany).toHaveBeenCalledTimes(1) // bara claimen
    expect(prisma.rentNoticePayment.delete).not.toHaveBeenCalled()
  })

  it('allt som skrivs ligger i SAMMA transaktion som bokföringen', async () => {
    // Kärnan i #108. Claim, allokering och verifikat måste ta emot samma
    // transaktionsklient — annars är atomiciteten bara skenbar.
    const { service, prisma, accounting } = makeService()
    await service.markAsPaid('rn-1', 'org-1', 10_000, 'BANK')
    expect(prisma.$transaction).toHaveBeenCalledTimes(1)
    // Radlåset tas FÖRST, före varje läsning som beslutet vilar på.
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1)
    // Bokföringen får transaktionsklienten som sista argument.
    const bokförArgs = accounting.createJournalEntryForRentNoticeManualPayment.mock.calls[0]
    expect(bokförArgs[bokförArgs.length - 1]).toBe(prisma)
  })

  it('transaktionen har EXPLICITA gränser — en svälten betalning failar, hänger inte', async () => {
    // Låstiden växte med atomiciteten (~tio tur-och-retur i stället för ett par).
    // Utan uttalade gränser ärvs Prismas defaults tyst, och nästa läsare kan inte
    // se att någon tagit ställning. Testet kontrollerar BANDET, inte siffran:
    // gränserna ska vara generösa mot det uppmätta normalfallet (median 8,8 ms)
    // och långt under det som läser som en hängning.
    const { service, prisma } = makeService()
    await service.markAsPaid('rn-1', 'org-1', 10_000, 'BANK')
    const optioner = prisma.$transaction.mock.calls[0]![1] as {
      timeout: number
      maxWait: number
    }
    expect(optioner).toBeDefined()
    expect(optioner.timeout).toBeGreaterThanOrEqual(2_000)
    expect(optioner.timeout).toBeLessThanOrEqual(15_000)
    expect(optioner.maxWait).toBeGreaterThanOrEqual(1_000)
    expect(optioner.maxWait).toBeLessThanOrEqual(optioner.timeout)
  })

  it('saknat konto (bokföring returnerar null) för RENT → 500, transaktionen rullas tillbaka', async () => {
    const { service, prisma, accounting } = makeService()
    accounting.createJournalEntryForRentNoticeManualPayment.mockResolvedValueOnce(null)
    await expect(service.markAsPaid('rn-1', 'org-1', 10_000, 'SWISH')).rejects.toBeInstanceOf(
      InternalServerErrorException,
    )
    expect(prisma.rentNotice.updateMany).toHaveBeenCalledTimes(1) // bara claimen
  })

  it('DEPOSIT-avi: BLOCKERAS (#41/T2.2 — betalas via deposits.markPaid/bankmatch, en kanonisk väg)', async () => {
    const { service, prisma, accounting } = makeService({ notice: { type: 'DEPOSIT' } })
    await expect(service.markAsPaid('rn-1', 'org-1', 10_000, 'BANK')).rejects.toBeInstanceOf(
      BadRequestException,
    )
    // Ingen statusflip, ingen bokföring — deposits-modulen äger deposit-betalningen.
    expect(prisma.rentNotice.updateMany).not.toHaveBeenCalled()
    expect(accounting.createJournalEntryForRentNoticeManualPayment).not.toHaveBeenCalled()
  })

  it('redan betald (PAID) → BadRequestException, varken claim eller bokning', async () => {
    const { service, prisma, accounting } = makeService({ notice: { status: 'PAID' } })
    await expect(service.markAsPaid('rn-1', 'org-1', 10_000, 'BANK')).rejects.toBeInstanceOf(
      BadRequestException,
    )
    expect(prisma.rentNotice.updateMany).not.toHaveBeenCalled()
    expect(accounting.createJournalEntryForRentNoticeManualPayment).not.toHaveBeenCalled()
  })

  it('avbruten (CANCELLED) → BadRequestException, varken claim eller bokning', async () => {
    const { service, prisma, accounting } = makeService({ notice: { status: 'CANCELLED' } })
    await expect(service.markAsPaid('rn-1', 'org-1', 10_000, 'BANK')).rejects.toBeInstanceOf(
      BadRequestException,
    )
    expect(prisma.rentNotice.updateMany).not.toHaveBeenCalled()
    expect(accounting.createJournalEntryForRentNoticeManualPayment).not.toHaveBeenCalled()
  })

  it('parallell process hann först (claim.count === 0) → ConflictException, ingen bokning', async () => {
    const { service, accounting } = makeService({ claimCount: 0 })
    await expect(service.markAsPaid('rn-1', 'org-1', 10_000, 'BANK')).rejects.toBeInstanceOf(
      ConflictException,
    )
    expect(accounting.createJournalEntryForRentNoticeManualPayment).not.toHaveBeenCalled()
  })

  it('OVERDUE-avi kan markeras betald (fordran finns redan på 1510)', async () => {
    const { service, accounting } = makeService({ notice: { status: 'OVERDUE' } })
    await service.markAsPaid('rn-1', 'org-1', 10_000, 'BANK')
    expect(accounting.createJournalEntryForRentNoticeManualPayment).toHaveBeenCalledTimes(1)
  })

  it('defaultar paidAt till nu och aktör till null när de utelämnas', async () => {
    const { service, accounting } = makeService()
    await service.markAsPaid('rn-1', 'org-1', 10_000, 'BANK')
    const [, , dateArg, , , byArg] =
      accounting.createJournalEntryForRentNoticeManualPayment.mock.calls[0]
    expect(dateArg).toBeInstanceOf(Date)
    expect(byArg).toBeNull()
  })

  // ── Bankavstämnings-härdning PR 1 · C — MANUAL-allokering ──────────────────
  it('PR1: skriver en MANUAL-allokering (ingen bank-tx) bredvid betalningen', async () => {
    const { service, prisma } = makeService()
    await service.markAsPaid('rn-1', 'org-1', 10_000, 'SWISH', '2026-06-15')

    expect(prisma.rentNoticePayment.create).toHaveBeenCalledTimes(1)
    const data = prisma.rentNoticePayment.create.mock.calls[0][0].data
    expect(data).toMatchObject({
      rentNoticeId: 'rn-1',
      bankTransactionId: null,
      amount: 10_000,
      source: 'MANUAL',
    })
    expect((data.paidAt as Date).toISOString().slice(0, 10)).toBe('2026-06-15')
  })

  it('PR1→#108: allokeringen städas inte längre manuellt — den rullas tillbaka', async () => {
    // PR1 skrev allokeringen först och raderade den i ett catch om verifikatet
    // uteblev. Den städningen var själv .catch:ad och bara loggad: misslyckades
    // DEN blev allokeringen kvar utan verifikat. Nu ligger båda i samma
    // transaktion — inget att städa, och inget som kan misslyckas med att städa.
    const { service, prisma, accounting } = makeService()
    accounting.createJournalEntryForRentNoticeManualPayment.mockRejectedValueOnce(
      new Error('DB nere'),
    )
    await expect(service.markAsPaid('rn-1', 'org-1', 10_000, 'BANK')).rejects.toThrow('DB nere')
    expect(prisma.rentNoticePayment.delete).not.toHaveBeenCalled()
  })

  // ── Bankavstämnings-härdning PR 2 · kravstegs-nollställning ────────────────
  it('PR2: betald INKASSO_READY-avi nollställs ATOMISKT till NONE + trail skrivs', async () => {
    const { service, prisma, eventCreate } = makeService({
      notice: { collectionStage: 'INKASSO_READY' },
    })
    await service.markAsPaid('rn-1', 'org-1', 10_000, 'BANK', undefined, 'user-1')

    // Nollställningen sker i SAMMA claim-updateMany som PAID-övergången (atomiskt).
    expect(prisma.rentNotice.updateMany.mock.calls[0]![0].data).toMatchObject({
      status: 'PAID',
      collectionStage: 'NONE',
    })
    // Append-only trail med ursprungssteget.
    const ev = eventCreate.mock.calls[0]![0].data
    expect(ev.type).toBe('NOTE_ADDED')
    expect(ev.payload).toMatchObject({
      action: 'collection-stage-reset',
      from: 'INKASSO_READY',
      reason: 'paid',
    })
  })

  it('PR2: avi utanför kravtrappan (NONE) → ingen trail (mindre brus)', async () => {
    const { service, eventCreate } = makeService() // default collectionStage NONE
    await service.markAsPaid('rn-1', 'org-1', 10_000, 'BANK')
    expect(eventCreate).not.toHaveBeenCalled()
  })

  it('PR2: idempotens — parallell process hann först (claim.count 0) → ingen flip/trail', async () => {
    const { service, eventCreate } = makeService({
      notice: { collectionStage: 'INKASSO_READY' },
      claimCount: 0,
    })
    await expect(service.markAsPaid('rn-1', 'org-1', 10_000, 'BANK')).rejects.toThrow()
    expect(eventCreate).not.toHaveBeenCalled()
  })
})

// ── Bank-härdning PR 3b · D5 — delbetalning lämnar avin OBETALD ─────────────────
describe('PR3b · D5 — markAsPaid med delbelopp', () => {
  it('delbetalning (< payable) → avin förblir obetald, INGEN PAID-flip, allokering + verifikat', async () => {
    const { service, prisma, accounting } = makeService()
    // payable = 10 000, betalar 4 000 → ocrOutstanding 6 000 > 0 → INTE PAID.
    await service.markAsPaid('rn-1', 'org-1', 4_000, 'SWISH', '2026-06-15', 'user-1')

    const claim = prisma.rentNotice.updateMany.mock.calls[0][0]
    // Ingen status-flip: bara paidAmount-spegeln + betalsätt uppdateras.
    expect(claim.data.status).toBeUndefined()
    expect(claim.data).toMatchObject({ paidAmount: 4_000, paymentMethod: 'SWISH' })
    expect(claim.data.collectionStage).toBeUndefined()

    // Allokeringen (MANUAL) bokförs på det FAKTISKA delbeloppet.
    const alloc = prisma.rentNoticePayment.create.mock.calls[0][0].data
    expect(alloc).toMatchObject({ amount: 4_000, source: 'MANUAL', bankTransactionId: null })

    // Delverifikatet skapas på delbeloppet.
    expect(accounting.createJournalEntryForRentNoticeManualPayment).toHaveBeenCalledTimes(1)
    expect(accounting.createJournalEntryForRentNoticeManualPayment.mock.calls[0][1]).toBe(4_000)
  })

  it('andra delbetalningen som täcker resten → PAID, paidAmount = Σ allokeringar', async () => {
    // Tidigare delbetalning 6 000 finns; betalar 4 000 → Σ 10 000 == payable → PAID.
    const { service, prisma } = makeService({ priorAllocations: [{ amount: 6_000 }] })
    await service.markAsPaid('rn-1', 'org-1', 4_000, 'BANK')

    const claim = prisma.rentNotice.updateMany.mock.calls[0][0]
    expect(claim.data).toMatchObject({
      status: 'PAID',
      paidAmount: 10_000,
      collectionStage: 'NONE',
    })
  })

  it('delbetalning vars bokföring KASTAR → ingen revert-uträkning behövs längre', async () => {
    // Den gamla koden räknade fram vad paidAmount skulle återställas TILL (Σ
    // tidigare allokeringar, inte null — annars raderades cachen för redan
    // registrerade delbetalningar). Den uträkningen var en källa till fel i sig.
    // Transaktionen återställer det exakta tidigare värdet utan att någon behöver
    // räkna ut det.
    const { service, prisma, accounting } = makeService({ priorAllocations: [{ amount: 6_000 }] })
    accounting.createJournalEntryForRentNoticeManualPayment.mockRejectedValueOnce(
      new Error('DB nere'),
    )
    await expect(service.markAsPaid('rn-1', 'org-1', 1_000, 'BANK')).rejects.toThrow('DB nere')
    expect(prisma.rentNotice.updateMany).toHaveBeenCalledTimes(1) // bara claimen
  })

  it('delbetalning på INKASSO_READY-avi → INGEN kravstegs-nollställning, ingen trail', async () => {
    const { service, prisma, eventCreate } = makeService({
      notice: { collectionStage: 'INKASSO_READY', status: 'OVERDUE' },
    })
    await service.markAsPaid('rn-1', 'org-1', 3_000, 'BANK', undefined, 'user-1')
    // collectionStage rörs inte (delbetalning driver inte ut ur kravtrappan).
    expect(prisma.rentNotice.updateMany.mock.calls[0][0].data.collectionStage).toBeUndefined()
    expect(eventCreate).not.toHaveBeenCalled()
  })
})

describe('H4 — överbetalning avvisas, samma regel som fakturans manuella väg', () => {
  it('KÄRNAN: 20 000 på en 10 000-avi avvisas — ingen allokering, ingen bokning', async () => {
    // Före fixen: hela 20 000 allokerades, avin flippade PAID, och verifikatet
    // krediterade 1510 med 20 000 mot en fordran på 10 000 → kundfordran MINUS
    // 10 000. Bokföringen går inte att rätta med en kodfix i efterhand.
    const { service, prisma, accounting } = makeService()

    await expect(service.markAsPaid('rn-1', 'org-1', 20_000, 'BANK')).rejects.toThrow(
      /överstiger restskulden/,
    )

    expect(prisma.rentNoticePayment.create).not.toHaveBeenCalled()
    expect(accounting.createJournalEntryForRentNoticeManualPayment).not.toHaveBeenCalled()
    expect(prisma.rentNotice.updateMany).not.toHaveBeenCalled()
  })

  it('meddelandet namnger båda talen', async () => {
    const { service } = makeService()
    await expect(service.markAsPaid('rn-1', 'org-1', 12_500, 'BANK')).rejects.toThrow(
      /12500\.00.*10000\.00/,
    )
  })

  it('ETT ÖRE över avvisas — ingen tolerans, till skillnad från bankvägen', async () => {
    // Bankvägen absorberar en krona åt vardera hållet eftersom beloppet är ett
    // mätt faktum ur en bankfil. Här är det inskrivet av en människa som kan
    // rätta det, och en tyst absorption hade dolt skrivfelet.
    const { service, prisma } = makeService()
    await expect(service.markAsPaid('rn-1', 'org-1', 10_000.01, 'BANK')).rejects.toThrow(
      /överstiger restskulden/,
    )
    expect(prisma.rentNoticePayment.create).not.toHaveBeenCalled()
  })

  it('prövas mot RESTSKULDEN, inte mot totalen', async () => {
    // 6 000 redan betalt → restskuld 4 000. 5 000 är för mycket trots att det är
    // mindre än avins total. Samma fall som fakturaspecens motsvarighet.
    const { service } = makeService({ priorAllocations: [{ amount: 6_000 }] })
    await expect(service.markAsPaid('rn-1', 'org-1', 5_000, 'BANK')).rejects.toThrow(
      /överstiger restskulden/,
    )
  })

  it('exakt restskuld går fortfarande igenom — spärren rör inte normalfallet', async () => {
    const { service, prisma } = makeService({ priorAllocations: [{ amount: 6_000 }] })
    await service.markAsPaid('rn-1', 'org-1', 4_000, 'BANK')
    expect(prisma.rentNoticePayment.create).toHaveBeenCalledTimes(1)
  })

  it('spärren ligger INNANFÖR radlåset — restskulden läses efter FOR UPDATE', async () => {
    // Låg läsningen utanför kunde en samtidig bankmatchning skriva en allokering
    // emellan och göra kontrollen beräknad på inaktuell grund (#288-klassen).
    // Belägget: allokeringarna läses (findMany) efter att låset tagits.
    const { service, prisma } = makeService()
    await expect(service.markAsPaid('rn-1', 'org-1', 99_000, 'BANK')).rejects.toThrow()
    expect(prisma.rentNoticePayment.findMany).toHaveBeenCalled()
    expect(prisma.$queryRaw).toHaveBeenCalled()
  })
})

describe('PR2 — cancelNotice nollställer collectionStage (anti-zombie)', () => {
  it('avbruten INKASSO_READY-avi → CANCELLED + collectionStage NONE, org-scopad, trail', async () => {
    const { service, prisma, eventCreate } = makeService({
      notice: { collectionStage: 'INKASSO_READY' },
    })
    await service.cancelNotice('rn-1', 'org-1')

    const call = prisma.rentNotice.updateMany.mock.calls[0]![0]
    // Org-scopad updateMany med statusguard (inte update på enbart id).
    expect(call.where).toMatchObject({ id: 'rn-1', organizationId: 'org-1' })
    // #367: villkoret var `{ not: 'PAID' }` — CANCELLED matchade det, så claimen
    // träffade sin egen redan annullerade rad. Assertionens AVSIKT (claimen är
    // org-scopad och statusgrindad) är oförändrad; det är formen som utökats.
    // Uteslutningen i sig prövas i avisering.cancel-double.spec.ts.
    expect(call.where.status).toEqual({ notIn: ['PAID', 'CANCELLED'] })
    expect(call.data).toMatchObject({ status: 'CANCELLED', collectionStage: 'NONE' })
    // Trail dokumenterar nollställningen.
    expect(eventCreate.mock.calls[0]![0].data.payload).toMatchObject({
      action: 'collection-stage-reset',
      from: 'INKASSO_READY',
      reason: 'cancelled',
    })
  })

  it('redan betald avi → BadRequest, ingen mutering', async () => {
    const { service, prisma } = makeService({ notice: { status: 'PAID' } })
    await expect(service.cancelNotice('rn-1', 'org-1')).rejects.toBeInstanceOf(BadRequestException)
    expect(prisma.rentNotice.updateMany).not.toHaveBeenCalled()
  })

  it('delvis betald avi (paidAmount > 0) → BadRequest, ingen annullering/reversering', async () => {
    const { service, prisma, accounting } = makeService({
      notice: { status: 'OVERDUE', paidAmount: 5000 },
    })
    await expect(service.cancelNotice('rn-1', 'org-1')).rejects.toThrow(/delvis betald/i)
    expect(prisma.rentNotice.updateMany).not.toHaveBeenCalled()
    expect(accounting.reverseJournalEntryForRentNotice).not.toHaveBeenCalled()
  })
})
