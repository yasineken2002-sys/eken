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
    reminderFeeAmount: 0,
    interestAccruedAmount: 0,
    paymentMethod: null,
    ...opts?.notice,
  }

  const eventCreate = jest.fn().mockResolvedValue({})
  const prisma = {
    rentNotice: {
      // 1:a findFirst = ladda avin, 2:a = re-fetch för returvärdet.
      findFirst: jest
        .fn()
        .mockResolvedValueOnce(notice)
        .mockResolvedValue({ ...notice, status: 'PAID' }),
      updateMany: jest.fn().mockResolvedValue({ count: opts?.claimCount ?? 1 }),
    },
    // Bankavstämnings-härdning PR 1 — MANUAL-allokering skrivs bredvid betalningen.
    // PR 3b — findMany läser tidigare allokeringar (D5-skuldberäkning). Default = [].
    rentNoticePayment: {
      findMany: jest.fn().mockResolvedValue(opts?.priorAllocations ?? []),
      create: jest.fn().mockResolvedValue({ id: 'rnp-1' }),
      delete: jest.fn().mockResolvedValue({}),
    },
    // PR 2 — append-only trail för kravstegs-nollställningen.
    rentNoticeEvent: { create: eventCreate },
  }

  const accounting = {
    createJournalEntryForRentNoticeManualPayment: jest.fn().mockResolvedValue({ id: 'je-pay-1' }),
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

  it('bokföringen KASTAR → statusövergången ångras och felet propageras', async () => {
    const { service, prisma, accounting } = makeService()
    accounting.createJournalEntryForRentNoticeManualPayment.mockRejectedValueOnce(
      new Error('DB nere'),
    )
    await expect(service.markAsPaid('rn-1', 'org-1', 10_000, 'BANK')).rejects.toThrow('DB nere')
    // Två updateMany-anrop: claim + revert.
    expect(prisma.rentNotice.updateMany).toHaveBeenCalledTimes(2)
    const revert = prisma.rentNotice.updateMany.mock.calls[1][0]
    expect(revert.data).toMatchObject({ status: 'SENT', paidAt: null, paymentMethod: null })
  })

  it('saknat konto (bokföring returnerar null) för RENT → 500 och status ångras', async () => {
    const { service, prisma, accounting } = makeService()
    accounting.createJournalEntryForRentNoticeManualPayment.mockResolvedValueOnce(null)
    await expect(service.markAsPaid('rn-1', 'org-1', 10_000, 'SWISH')).rejects.toBeInstanceOf(
      InternalServerErrorException,
    )
    expect(prisma.rentNotice.updateMany).toHaveBeenCalledTimes(2) // claim + revert
  })

  it('DEPOSIT-avi: bokföring returnerar null avsiktligt → status behålls (ingen revert)', async () => {
    const { service, prisma, accounting } = makeService({ notice: { type: 'DEPOSIT' } })
    accounting.createJournalEntryForRentNoticeManualPayment.mockResolvedValueOnce(null)
    await service.markAsPaid('rn-1', 'org-1', 10_000, 'BANK')
    // Bara claim, ingen revert.
    expect(prisma.rentNotice.updateMany).toHaveBeenCalledTimes(1)
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

  it('PR1: bokföringen KASTAR → allokeringen städas (delete) och felet propageras', async () => {
    const { service, prisma, accounting } = makeService()
    accounting.createJournalEntryForRentNoticeManualPayment.mockRejectedValueOnce(
      new Error('DB nere'),
    )
    await expect(service.markAsPaid('rn-1', 'org-1', 10_000, 'BANK')).rejects.toThrow('DB nere')
    // Allokeringen som skrevs före verifikatet rullas tillbaka.
    expect(prisma.rentNoticePayment.delete).toHaveBeenCalledWith({ where: { id: 'rnp-1' } })
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

  it('delbetalning vars bokföring KASTAR → paidAmount återställs till Σ tidigare allokeringar (ej null)', async () => {
    const { service, prisma, accounting } = makeService({ priorAllocations: [{ amount: 6_000 }] })
    accounting.createJournalEntryForRentNoticeManualPayment.mockRejectedValueOnce(
      new Error('DB nere'),
    )
    // Betalar 1 000 → delbetalning (Σ 7 000 < 10 000). Bokföringen kastar → revert.
    await expect(service.markAsPaid('rn-1', 'org-1', 1_000, 'BANK')).rejects.toThrow('DB nere')

    const revert = prisma.rentNotice.updateMany.mock.calls[1][0]
    // paidAmount återställs till 6 000 (de tidigare delbetalningarna), inte null.
    expect(revert.data.paidAmount).toBe(6_000)
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

describe('PR2 — cancelNotice nollställer collectionStage (anti-zombie)', () => {
  it('avbruten INKASSO_READY-avi → CANCELLED + collectionStage NONE, org-scopad, trail', async () => {
    const { service, prisma, eventCreate } = makeService({
      notice: { collectionStage: 'INKASSO_READY' },
    })
    await service.cancelNotice('rn-1', 'org-1')

    const call = prisma.rentNotice.updateMany.mock.calls[0]![0]
    // Org-scopad updateMany med PAID-guard (inte update på enbart id).
    expect(call.where).toMatchObject({ id: 'rn-1', organizationId: 'org-1' })
    expect(call.where.status).toEqual({ not: 'PAID' })
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
})
