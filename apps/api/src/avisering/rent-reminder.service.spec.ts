/**
 * Inkasso PR 2 — RentReminderService (hyrespåminnelse).
 *
 * Täcker:
 *   • eskalering NONE→REMINDED med atomisk bokförd avgift (1510/3593 via delad
 *     bookReminderFee, source RENT_NOTICE),
 *   • INV-A: faller bokföringen (null) kastas felet → ingen REMINDER_SENT loggas
 *     (hela transaktionen rullas tillbaka),
 *   • idempotens: claim count=0 → ingen andra avgift,
 *   • fee=0 (bortkonfigurerad avgift) → eskalerar utan bokföring,
 *   • cron: dag < rentReminderDay hoppas över, saknad e-post hoppas över,
 *     betald-före-dag-7 faller ur urvalet (status-filter).
 */

// StorageService drar in @aws-sdk (ESM) som ts-jest inte transformerar — stubba
// den, precis som övriga avisering-specar. RentReminderService använder den bara
// för logo i PDF-bygget, vilket inte testas här.
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { RentReminderService } from './rent-reminder.service'
import { Decimal } from '@prisma/client/runtime/library'

const DAY = 24 * 60 * 60 * 1000

function makeService(opts: { ocrOutstanding?: number; staleOrgs?: Set<string> } = {}) {
  const tx = { rentNotice: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) } }
  const prisma = {
    $transaction: jest.fn().mockImplementation((cb: (t: typeof tx) => unknown) => cb(tx)),
    rentNotice: { findMany: jest.fn().mockResolvedValue([]) },
  }
  const accounting = { bookReminderFee: jest.fn().mockResolvedValue({ id: 'je-1' }) }
  const rentNoticeEvents = { record: jest.fn().mockResolvedValue({ id: 'ev-1' }) }
  const rentInterest = { crystallizeInterest: jest.fn().mockResolvedValue(null) }
  const pdfQueue = { enqueue: jest.fn().mockResolvedValue('job-1') }
  // PR 3a — RentDebtService. Default: OCR-restskuld kvar (ocrOutstanding > 0) så
  // eskaleringen släpps igenom om inget annat anges.
  const ocr = opts.ocrOutstanding ?? 7300
  const outstanding = jest.fn().mockResolvedValue({
    capital: 7000,
    consumption: 240,
    reminderFee: 60,
    interest: 0,
    claim: ocr,
    paid: 0,
    outstanding: Math.max(0, ocr),
    ocrOutstanding: Math.max(0, ocr),
  })
  const rentDebt = { outstanding }
  const evaluateAndAlert = jest.fn().mockResolvedValue(opts.staleOrgs ?? new Set())
  const service = new RentReminderService(
    prisma as never,
    accounting as never,
    rentNoticeEvents as never,
    rentInterest as never,
    pdfQueue as never,
    {} as never,
    {} as never,
    {} as never,
    rentDebt as never,
    { evaluateAndAlert } as never,
  )
  return {
    service,
    prisma,
    tx,
    accounting,
    rentNoticeEvents,
    rentInterest,
    pdfQueue,
    outstanding,
    evaluateAndAlert,
  }
}

describe('escalateNoticeToReminded', () => {
  it('flippar NONE→REMINDED, bokför avgift atomiskt och loggar REMINDER_SENT', async () => {
    const { service, tx, accounting, rentNoticeEvents } = makeService()
    const ok = await service.escalateNoticeToReminded('rn-1', 'org-1', 9, 60)
    expect(ok).toBe(true)

    // Claim: race-säker övergång, bara om fortfarande OVERDUE + stage NONE.
    const claimArg = tx.rentNotice.updateMany.mock.calls[0]![0]
    expect(claimArg.where).toMatchObject({
      id: 'rn-1',
      organizationId: 'org-1',
      status: 'OVERDUE',
      collectionStage: 'NONE',
    })
    expect(claimArg.data.collectionStage).toBe('REMINDED')
    expect(Number(claimArg.data.reminderFeeAmount)).toBe(60)

    // Avgiften bokförs via den DELADE hjälparen, inuti samma transaktion (tx).
    const feeArg = accounting.bookReminderFee.mock.calls[0]![0]
    expect(feeArg).toMatchObject({
      organizationId: 'org-1',
      source: 'RENT_NOTICE',
      sourceId: 'reminder-fee:rn-1',
      fee: 60,
    })
    expect(feeArg.tx).toBe(tx)

    const evArgs = rentNoticeEvents.record.mock.calls[0]!
    expect(evArgs[1]).toBe('REMINDER_SENT')
    expect(evArgs[4]).toMatchObject({ fee: 60, vatFree: true, journalEntryId: 'je-1' })
  })

  it('INV-A: bokföring saknas (null) → kastar och loggar INGEN REMINDER_SENT', async () => {
    const { service, accounting, rentNoticeEvents } = makeService()
    accounting.bookReminderFee.mockResolvedValueOnce(null) // saknat 1510/3593
    await expect(service.escalateNoticeToReminded('rn-1', 'org-1', 9, 60)).rejects.toThrow()
    expect(rentNoticeEvents.record).not.toHaveBeenCalled()
  })

  it('idempotent: claim count=0 → false, ingen bokföring, ingen logg', async () => {
    const { service, tx, accounting, rentNoticeEvents } = makeService()
    tx.rentNotice.updateMany.mockResolvedValueOnce({ count: 0 })
    const ok = await service.escalateNoticeToReminded('rn-1', 'org-1', 9, 60)
    expect(ok).toBe(false)
    expect(accounting.bookReminderFee).not.toHaveBeenCalled()
    expect(rentNoticeEvents.record).not.toHaveBeenCalled()
  })

  it('fee=0 (bortkonfigurerad) → eskalerar utan bokföring, loggar fee 0', async () => {
    const { service, accounting, rentNoticeEvents, tx } = makeService()
    const ok = await service.escalateNoticeToReminded('rn-1', 'org-1', 9, 0)
    expect(ok).toBe(true)
    expect(accounting.bookReminderFee).not.toHaveBeenCalled()
    expect(Number(tx.rentNotice.updateMany.mock.calls[0]![0].data.reminderFeeAmount)).toBe(0)
    expect(rentNoticeEvents.record.mock.calls[0]![4]).toMatchObject({ fee: 0 })
  })
})

describe('escalateOverdueRentNotices (cron)', () => {
  function candidate(over: { id: string; daysOverdue: number; email: string | null }) {
    return {
      id: over.id,
      organizationId: 'org-1',
      dueDate: new Date(Date.now() - over.daysOverdue * DAY),
      organization: { rentReminderDay: 7, reminderFeeSek: 60, remindersEnabled: true },
      tenant: { email: over.email },
    }
  }

  it('eskalerar avi, kristalliserar ränta och köar påminnelse-PDF', async () => {
    const { service, prisma, pdfQueue, rentInterest } = makeService()
    prisma.rentNotice.findMany.mockResolvedValueOnce([
      candidate({ id: 'rn-9', daysOverdue: 9, email: 'g@x.se' }),
    ])
    const spy = jest.spyOn(service, 'escalateNoticeToReminded').mockResolvedValue(true)
    const summary = await service.escalateOverdueRentNotices()
    expect(spy).toHaveBeenCalledWith('rn-9', 'org-1', 9, 60)
    // Dröjsmålsränta kristalliseras t.o.m. påminnelsedagen (PR 3).
    expect(rentInterest.crystallizeInterest).toHaveBeenCalledWith('rn-9', 'org-1', expect.any(Date))
    expect(pdfQueue.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'avisering-reminder', noticeId: 'rn-9' }),
    )
    expect(summary.reminded).toBe(1)
  })

  // PR 4 (B) — inaktuell betalningsdata pausar påminnelse-eskaleringen (avgift).
  it('STALE org: PAUSAR (ingen avgift/flip), pausedStale räknas, ingen ränta/PDF', async () => {
    const { service, prisma, pdfQueue, rentInterest } = makeService({
      staleOrgs: new Set(['org-1']),
    })
    prisma.rentNotice.findMany.mockResolvedValueOnce([
      candidate({ id: 'rn-9', daysOverdue: 20, email: 'g@x.se' }),
    ])
    const spy = jest.spyOn(service, 'escalateNoticeToReminded').mockResolvedValue(true)
    const summary = await service.escalateOverdueRentNotices()
    expect(spy).not.toHaveBeenCalled() // INGEN avgift tas ut (INV-B)
    expect(rentInterest.crystallizeInterest).not.toHaveBeenCalled()
    expect(pdfQueue.enqueue).not.toHaveBeenCalled()
    expect(summary.pausedStale).toBe(1)
    expect(summary.reminded).toBe(0)
  })

  it('hoppar över avi som ännu inte nått dag 7 (ingen avgift tas ut)', async () => {
    const { service, prisma, pdfQueue } = makeService()
    prisma.rentNotice.findMany.mockResolvedValueOnce([
      candidate({ id: 'rn-3', daysOverdue: 3, email: 'g@x.se' }),
    ])
    const spy = jest.spyOn(service, 'escalateNoticeToReminded').mockResolvedValue(true)
    const summary = await service.escalateOverdueRentNotices()
    expect(spy).not.toHaveBeenCalled()
    expect(pdfQueue.enqueue).not.toHaveBeenCalled()
    expect(summary.skipped).toBe(1)
  })

  it('hoppar över avi utan e-post (påminnelse kan inte skickas → ingen avgift)', async () => {
    const { service, prisma } = makeService()
    prisma.rentNotice.findMany.mockResolvedValueOnce([
      candidate({ id: 'rn-x', daysOverdue: 20, email: null }),
    ])
    const spy = jest.spyOn(service, 'escalateNoticeToReminded').mockResolvedValue(true)
    const summary = await service.escalateOverdueRentNotices()
    expect(spy).not.toHaveBeenCalled()
    expect(summary.skipped).toBe(1)
  })

  it('urvalet kräver OVERDUE + stage NONE (betald avi faller ur → ärendet dör)', async () => {
    const { service, prisma } = makeService()
    await service.escalateOverdueRentNotices()
    const where = prisma.rentNotice.findMany.mock.calls[0]![0].where
    expect(where).toMatchObject({ status: 'OVERDUE', type: 'RENT', collectionStage: 'NONE' })
  })

  // ── PR 3a (INV-A) — eskalering gatar på faktisk OCR-restskuld ──────────────
  it('PR3a: fullt reglerad OCR (ocrOutstanding=0) → ingen avgift, ingen eskalering', async () => {
    const { service, prisma, pdfQueue, rentInterest } = makeService({ ocrOutstanding: 0 })
    prisma.rentNotice.findMany.mockResolvedValueOnce([
      candidate({ id: 'rn-paid', daysOverdue: 20, email: 'g@x.se' }),
    ])
    const spy = jest.spyOn(service, 'escalateNoticeToReminded').mockResolvedValue(true)
    const summary = await service.escalateOverdueRentNotices()
    // INV-A: ingen kravstegsflip, ingen avgift, ingen ränta, ingen PDF.
    expect(spy).not.toHaveBeenCalled()
    expect(rentInterest.crystallizeInterest).not.toHaveBeenCalled()
    expect(pdfQueue.enqueue).not.toHaveBeenCalled()
    expect(summary.skipped).toBe(1)
    expect(summary.reminded).toBe(0)
  })

  it('PR3a: delbetald men OCR-restskuld kvar (ocrOutstanding>0) → eskalerar på residualen', async () => {
    const { service, prisma, outstanding } = makeService({ ocrOutstanding: 2000 })
    prisma.rentNotice.findMany.mockResolvedValueOnce([
      candidate({ id: 'rn-part', daysOverdue: 20, email: 'g@x.se' }),
    ])
    const spy = jest.spyOn(service, 'escalateNoticeToReminded').mockResolvedValue(true)
    const summary = await service.escalateOverdueRentNotices()
    expect(outstanding).toHaveBeenCalledWith('rn-part', 'org-1')
    expect(spy).toHaveBeenCalled()
    expect(summary.reminded).toBe(1)
  })
})

describe('processReminderSendJob — PR 4b₀ lagra påminnelse-PDF + message-id', () => {
  function makeSendService(opts: { messageId?: string | null; uploadFails?: boolean } = {}) {
    const notice = {
      id: 'rn-1',
      noticeNumber: 'AVI-2026-07-0001',
      ocrNumber: '1234567890',
      dueDate: new Date('2026-06-01'),
      totalAmount: new Decimal(8000),
      consumptionAmount: new Decimal(0),
      reminderFeeAmount: new Decimal(60),
      tenant: { type: 'INDIVIDUAL', email: 'g@x.se', firstName: 'Anna', lastName: 'A' },
      lease: null,
      lines: [],
    }
    const org = { id: 'org-1', name: 'Värd AB', invoiceColor: null, logoStorageKey: null }
    const update = jest.fn().mockResolvedValue({})
    const prisma = {
      organization: { findUnique: jest.fn().mockResolvedValue(org) },
      rentNotice: { findFirst: jest.fn().mockResolvedValue(notice), update },
      // alreadySent-kontrollen (type SENT) → ingen tidigare → fortsätt.
      rentNoticeEvent: { findFirst: jest.fn().mockResolvedValue(null) },
    }
    const rentNoticeEvents = { record: jest.fn().mockResolvedValue({ id: 'ev-1' }) }
    const pdfService = { generateFromHtml: jest.fn().mockResolvedValue(Buffer.from('%PDF-1.4')) }
    const uploadFile = opts.uploadFails
      ? jest.fn().mockRejectedValue(new Error('R2 nere'))
      : jest.fn().mockResolvedValue('https://signed.example/r2')
    const storage = { uploadFile }
    const mailService = {
      sendRentNoticeReminder: jest
        .fn()
        .mockResolvedValue(opts.messageId === undefined ? 'resend-msg-1' : opts.messageId),
    }
    const service = new RentReminderService(
      prisma as never,
      {} as never,
      rentNoticeEvents as never,
      {} as never,
      {} as never,
      mailService as never,
      pdfService as never,
      storage as never,
      { outstanding: jest.fn() } as never, // PR 3a: send-jobbet läser inte skuld
      { evaluateAndAlert: jest.fn().mockResolvedValue(new Set()) } as never,
    )
    return { service, prisma, update, uploadFile, mailService, rentNoticeEvents }
  }

  it('laddar upp påminnelse-PDF org-scopat och persisterar nyckel + message-id', async () => {
    const { service, update, uploadFile, mailService } = makeSendService()
    await service.processReminderSendJob('org-1', 'rn-1')

    // PDF lagras org-scopat (R2-tenant-isolation: reminders/{orgId}/…).
    expect(uploadFile).toHaveBeenCalledWith(
      expect.any(Buffer),
      'reminders/org-1/rn-1.pdf',
      'application/pdf',
    )
    expect(mailService.sendRentNoticeReminder).toHaveBeenCalledTimes(1)

    // Två update-anrop: nyckeln (storeReminderPdf) + message-id (efter send).
    const datas = update.mock.calls.map((c) => c[0].data)
    expect(datas).toContainEqual({ reminderPdfStorageKey: 'reminders/org-1/rn-1.pdf' })
    expect(datas).toContainEqual({ reminderMessageId: 'resend-msg-1' })
  })

  it('best-effort: R2-fel blockerar INTE utskicket (ingen throw, ingen PDF-nyckel)', async () => {
    const { service, update, mailService } = makeSendService({ uploadFails: true })
    await expect(service.processReminderSendJob('org-1', 'rn-1')).resolves.toBeUndefined()

    // Påminnelsen skickas ändå.
    expect(mailService.sendRentNoticeReminder).toHaveBeenCalledTimes(1)
    // PDF-nyckeln persisteras inte (uppladdningen föll), men message-id gör det.
    const datas = update.mock.calls.map((c) => c[0].data)
    expect(datas).not.toContainEqual(
      expect.objectContaining({ reminderPdfStorageKey: expect.any(String) }),
    )
    expect(datas).toContainEqual({ reminderMessageId: 'resend-msg-1' })
  })

  it('saknat message-id från Resend → ingen reminderMessageId-skrivning', async () => {
    const { service, update } = makeSendService({ messageId: null })
    await service.processReminderSendJob('org-1', 'rn-1')
    const datas = update.mock.calls.map((c) => c[0].data)
    expect(datas).toContainEqual({ reminderPdfStorageKey: 'reminders/org-1/rn-1.pdf' })
    expect(datas).not.toContainEqual(
      expect.objectContaining({ reminderMessageId: expect.any(String) }),
    )
  })
})

describe('escalateNoticeToInkassoReady — INV-B-grind + slutkristallisering (PR 4b steg 2)', () => {
  // En avi med KOMPLETT underlag — grinden ska godkänna. Override-bara delar för
  // att testa varje vägransfall.
  function completeNotice(over: Record<string, unknown> = {}) {
    return {
      id: 'rn-1',
      noticeNumber: 'AVI-2026-07-0001',
      organizationId: 'org-1',
      collectionStage: 'REMINDED',
      status: 'OVERDUE',
      sentAt: new Date('2026-06-02'),
      remindedAt: new Date('2026-06-09'),
      reminderPdfStorageKey: 'reminders/org-1/rn-1.pdf',
      dueDate: new Date('2026-06-01'),
      totalAmount: new Decimal(8000),
      consumptionAmount: new Decimal(0),
      reminderFeeAmount: new Decimal(60),
      paidAmount: null,
      tenant: {
        type: 'INDIVIDUAL',
        firstName: 'Anna',
        lastName: 'A',
        companyName: null,
        personalNumber: '900101-1234',
        orgNumber: null,
        email: 'g@x.se',
        phone: '070-1',
        street: 'Storgatan 1',
        postalCode: '111 22',
        city: 'Stockholm',
      },
      organization: {
        name: 'Värd AB',
        orgNumber: '556000-0001',
        street: 'Värdgatan 2',
        postalCode: '222 33',
        city: 'Stockholm',
      },
      ...over,
    }
  }

  function makeInkassoService(
    opts: {
      notice?: Record<string, unknown>
      events?: { type: string }[]
      claimCount?: number
      crystallizeThrows?: boolean
      ocrOutstanding?: number
    } = {},
  ) {
    const notice = opts.notice ?? completeNotice()
    const events = opts.events ?? [{ type: 'SENT' }, { type: 'EMAIL_DELIVERED' }]
    const fresh = {
      dueDate: new Date('2026-06-01'),
      totalAmount: new Decimal(8000),
      consumptionAmount: new Decimal(0),
      reminderFeeAmount: new Decimal(60),
      interestAccruedAmount: new Decimal(123.45),
      interestAccruedThrough: new Date('2026-06-22'),
      reminderPdfStorageKey: 'reminders/org-1/rn-1.pdf',
    }
    const tx = {
      rentNotice: {
        updateMany: jest.fn().mockResolvedValue({ count: opts.claimCount ?? 1 }),
        findUniqueOrThrow: jest.fn().mockResolvedValue(fresh),
      },
    }
    const prisma = {
      $transaction: jest.fn().mockImplementation((cb: (t: typeof tx) => unknown) => cb(tx)),
      rentNotice: { findFirst: jest.fn().mockResolvedValue(notice) },
      rentNoticeEvent: { findMany: jest.fn().mockResolvedValue(events) },
    }
    const rentNoticeEvents = { record: jest.fn().mockResolvedValue({ id: 'ev-1' }) }
    const crystallizeInterest = opts.crystallizeThrows
      ? jest.fn().mockRejectedValue(new Error('saknat 1510/8131'))
      : jest.fn().mockResolvedValue({ delta: 10, total: 123.45 })
    const rentInterest = { crystallizeInterest }
    // PR 3a — INV-B steg 10 läser ocrOutstanding härifrån. Default > 0 (skuld kvar).
    const ocr = opts.ocrOutstanding ?? 8060
    const outstanding = jest.fn().mockResolvedValue({
      capital: 8000,
      consumption: 0,
      reminderFee: 60,
      interest: 123.45,
      claim: ocr + 123.45,
      paid: 0,
      outstanding: Math.max(0, ocr + 123.45),
      ocrOutstanding: Math.max(0, ocr),
    })
    const rentDebt = { outstanding }
    const service = new RentReminderService(
      prisma as never,
      {} as never,
      rentNoticeEvents as never,
      rentInterest as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      rentDebt as never,
      { evaluateAndAlert: jest.fn().mockResolvedValue(new Set()) } as never,
    )
    return { service, prisma, tx, rentNoticeEvents, rentInterest, outstanding }
  }

  it('komplett underlag: slutkristalliserar, flippar REMINDED→INKASSO_READY, loggar COLLECTION_READY', async () => {
    const { service, tx, rentNoticeEvents, rentInterest } = makeInkassoService()
    const res = await service.escalateNoticeToInkassoReady('rn-1', 'org-1')
    expect(res).toEqual({ flipped: true })

    // Slutkristallisering t.o.m. idag (INV-A internt i crystallizeInterest).
    expect(rentInterest.crystallizeInterest).toHaveBeenCalledWith('rn-1', 'org-1', expect.any(Date))

    // Race-säker claim: bara om fortfarande OVERDUE + stage REMINDED.
    const claimArg = tx.rentNotice.updateMany.mock.calls[0]![0]
    expect(claimArg.where).toMatchObject({
      id: 'rn-1',
      organizationId: 'org-1',
      status: 'OVERDUE',
      collectionStage: 'REMINDED',
    })
    expect(claimArg.data.collectionStage).toBe('INKASSO_READY')
    expect(claimArg.data.collectionReadyAt).toBeInstanceOf(Date)

    // COLLECTION_READY med räntesnapshot (auktoritativ total, inte dagviktat snitt).
    const ev = rentNoticeEvents.record.mock.calls.find((c) => c[1] === 'COLLECTION_READY')!
    expect(ev[4]).toMatchObject({
      capital: 8000,
      reminderFeeAmount: 60,
      interestAccruedAmount: 123.45,
      totalClaim: 8183.45,
      reminderPdfStored: true,
    })
  })

  it('PR3a: INV-B steg 10 läser ocrOutstanding — fullt reglerad OCR (=0) blockerar inkasso-redo', async () => {
    const { service, tx, rentNoticeEvents, outstanding } = makeInkassoService({ ocrOutstanding: 0 })
    await expect(service.escalateNoticeToInkassoReady('rn-1', 'org-1')).rejects.toThrow(
      /ingen utestående skuld/,
    )
    // Skuld läses org-scopat från RentDebtService, inte paidAmount-cachen.
    expect(outstanding).toHaveBeenCalledWith('rn-1', 'org-1')
    expect(tx.rentNotice.updateMany).not.toHaveBeenCalled()
    const blocked = rentNoticeEvents.record.mock.calls.find(
      (c) => c[4] && (c[4] as { action?: string }).action === 'inkasso-ready-blocked',
    )!
    expect(blocked[4]).toMatchObject({
      missing: expect.arrayContaining(['ingen utestående skuld att driva in']),
    })
  })

  it('INV-B vägrar (ConflictException, ingen flip) när lagrad påminnelse-PDF saknas', async () => {
    const { service, tx, rentNoticeEvents } = makeInkassoService({
      notice: completeNotice({ reminderPdfStorageKey: null }),
    })
    await expect(service.escalateNoticeToInkassoReady('rn-1', 'org-1')).rejects.toThrow(
      /lagrad påminnelse-PDF saknas/,
    )
    expect(tx.rentNotice.updateMany).not.toHaveBeenCalled()
    // Avvikelsen loggas append-only innan undantaget.
    const blocked = rentNoticeEvents.record.mock.calls.find(
      (c) => c[4] && (c[4] as { action?: string }).action === 'inkasso-ready-blocked',
    )!
    expect(blocked[4]).toMatchObject({
      missing: expect.arrayContaining(['lagrad påminnelse-PDF saknas']),
    })
  })

  it('INV-B vägrar när påminnelsens leverans inte är verifierad (ingen EMAIL_DELIVERED)', async () => {
    const { service, tx } = makeInkassoService({ events: [{ type: 'SENT' }] })
    await expect(service.escalateNoticeToInkassoReady('rn-1', 'org-1')).rejects.toThrow(
      /leverans är inte verifierad/,
    )
    expect(tx.rentNotice.updateMany).not.toHaveBeenCalled()
  })

  it('INV-B vägrar när påminnelsen studsade (EMAIL_BOUNCED)', async () => {
    const { service } = makeInkassoService({
      events: [{ type: 'SENT' }, { type: 'EMAIL_DELIVERED' }, { type: 'EMAIL_BOUNCED' }],
    })
    await expect(service.escalateNoticeToInkassoReady('rn-1', 'org-1')).rejects.toThrow(/studsade/)
  })

  it('INV-B vägrar vid ofullständig gäldenär (saknar person-/orgnr OCH adress)', async () => {
    const { service } = makeInkassoService({
      notice: completeNotice({
        tenant: {
          type: 'INDIVIDUAL',
          firstName: 'Anna',
          lastName: 'A',
          personalNumber: null,
          orgNumber: null,
          street: null,
          postalCode: null,
          city: null,
        },
      }),
    })
    await expect(service.escalateNoticeToInkassoReady('rn-1', 'org-1')).rejects.toThrow(
      /gäldenärens person-\/organisationsnummer saknas/,
    )
  })

  it('INV-B vägrar vid saknad fordringsägardata (orgnr)', async () => {
    const { service } = makeInkassoService({
      notice: completeNotice({
        organization: {
          name: 'Värd AB',
          orgNumber: null,
          street: 'Värdgatan 2',
          postalCode: '222 33',
          city: 'Stockholm',
        },
      }),
    })
    await expect(service.escalateNoticeToInkassoReady('rn-1', 'org-1')).rejects.toThrow(
      /fordringsägarens organisationsnummer saknas/,
    )
  })

  it('idempotent: redan INKASSO_READY → no-op (ingen grind, ingen kristallisering, ingen flip)', async () => {
    const { service, prisma, tx, rentInterest } = makeInkassoService({
      notice: completeNotice({ collectionStage: 'INKASSO_READY' }),
    })
    const res = await service.escalateNoticeToInkassoReady('rn-1', 'org-1')
    expect(res).toEqual({ flipped: false })
    expect(prisma.rentNoticeEvent.findMany).not.toHaveBeenCalled()
    expect(rentInterest.crystallizeInterest).not.toHaveBeenCalled()
    expect(tx.rentNotice.updateMany).not.toHaveBeenCalled()
  })

  it('race: claim count=0 (annan körning hann före) → flipped:false, inget COLLECTION_READY', async () => {
    const { service, rentNoticeEvents } = makeInkassoService({ claimCount: 0 })
    const res = await service.escalateNoticeToInkassoReady('rn-1', 'org-1')
    expect(res).toEqual({ flipped: false })
    expect(rentNoticeEvents.record.mock.calls.some((c) => c[1] === 'COLLECTION_READY')).toBe(false)
  })

  it('INV-A: slutkristalliseringens bokföring faller (saknat 1510/8131) → kastar, ingen flip', async () => {
    const { service, tx } = makeInkassoService({ crystallizeThrows: true })
    await expect(service.escalateNoticeToInkassoReady('rn-1', 'org-1')).rejects.toThrow()
    expect(tx.rentNotice.updateMany).not.toHaveBeenCalled()
  })
})

describe('escalateRemindedToInkassoReady (cron)', () => {
  function makeCronService(staleOrgs: Set<string> = new Set()) {
    const prisma = {
      rentNotice: { findMany: jest.fn().mockResolvedValue([]) },
    }
    const evaluateAndAlert = jest.fn().mockResolvedValue(staleOrgs)
    const service = new RentReminderService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { outstanding: jest.fn() } as never, // PR 3a: cronen delegerar skuldläsning
      { evaluateAndAlert } as never,
    )
    return { service, prisma, evaluateAndAlert }
  }

  function candidate(daysOverdue: number) {
    return {
      id: 'rn-1',
      organizationId: 'org-1',
      dueDate: new Date(Date.now() - daysOverdue * DAY),
      organization: { rentReminderDay: 7, rentInkassoDaysAfterReminder: 14 },
    }
  }

  it('urvalet kräver OVERDUE + RENT + stage REMINDED', async () => {
    const { service, prisma } = makeCronService()
    await service.escalateRemindedToInkassoReady()
    const where = prisma.rentNotice.findMany.mock.calls[0]![0].where
    expect(where).toMatchObject({ status: 'OVERDUE', type: 'RENT', collectionStage: 'REMINDED' })
  })

  it('eskalerar avi förbi tröskeln (7+14=21 dgr) och räknar ready', async () => {
    const { service, prisma } = makeCronService()
    prisma.rentNotice.findMany.mockResolvedValueOnce([candidate(25)])
    const spy = jest
      .spyOn(service, 'escalateNoticeToInkassoReady')
      .mockResolvedValue({ flipped: true })
    const summary = await service.escalateRemindedToInkassoReady()
    expect(spy).toHaveBeenCalledWith('rn-1', 'org-1')
    expect(summary.ready).toBe(1)
  })

  it('hoppar över avi under tröskeln (ingen eskalering)', async () => {
    const { service, prisma } = makeCronService()
    prisma.rentNotice.findMany.mockResolvedValueOnce([candidate(15)])
    const spy = jest
      .spyOn(service, 'escalateNoticeToInkassoReady')
      .mockResolvedValue({ flipped: true })
    const summary = await service.escalateRemindedToInkassoReady()
    expect(spy).not.toHaveBeenCalled()
    expect(summary.skipped).toBe(1)
  })

  it('grind-blockerad avi (ConflictException) räknas som blocked, inte error', async () => {
    const { ConflictException } = await import('@nestjs/common')
    const { service, prisma } = makeCronService()
    prisma.rentNotice.findMany.mockResolvedValueOnce([candidate(25)])
    jest
      .spyOn(service, 'escalateNoticeToInkassoReady')
      .mockRejectedValue(new ConflictException('ofullständigt underlag'))
    const summary = await service.escalateRemindedToInkassoReady()
    expect(summary.blocked).toBe(1)
    expect(summary.errors).toBe(0)
  })

  // PR 4 (B) — inaktuell betalningsdata pausar inkasso-redo-eskaleringen.
  it('STALE org: avin PAUSAS (ingen flip), pausedStale räknas, larm delegeras', async () => {
    const { service, prisma, evaluateAndAlert } = makeCronService(new Set(['org-1']))
    prisma.rentNotice.findMany.mockResolvedValueOnce([candidate(25)]) // förbi tröskeln
    const spy = jest.spyOn(service, 'escalateNoticeToInkassoReady')
    const summary = await service.escalateRemindedToInkassoReady()
    expect(evaluateAndAlert).toHaveBeenCalledWith(['org-1'])
    expect(spy).not.toHaveBeenCalled() // INGEN inkasso-framflyttning
    expect(summary.pausedStale).toBe(1)
    expect(summary.ready).toBe(0)
  })

  it('FÄRSK org (tom stale-mängd): eskalerar normalt', async () => {
    const { service, prisma } = makeCronService(new Set())
    prisma.rentNotice.findMany.mockResolvedValueOnce([candidate(25)])
    const spy = jest
      .spyOn(service, 'escalateNoticeToInkassoReady')
      .mockResolvedValue({ flipped: true })
    const summary = await service.escalateRemindedToInkassoReady()
    expect(spy).toHaveBeenCalledWith('rn-1', 'org-1')
    expect(summary.ready).toBe(1)
    expect(summary.pausedStale).toBe(0)
  })
})

describe('buildReminderPdfHtml — innehåll (lag 1981:739 5 §)', () => {
  const notice = {
    noticeNumber: 'AVI-2026-07-0001',
    ocrNumber: '1234567890',
    dueDate: new Date('2026-06-01'),
    totalAmount: new Decimal(8000),
    consumptionAmount: new Decimal(0),
    reminderFeeAmount: new Decimal(60),
    tenant: { type: 'INDIVIDUAL', firstName: 'Anna', lastName: 'Andersson' },
  }

  it('innehåller fordringsägarens namn + adress, avgift och lagrum', async () => {
    const { service } = makeService()
    const html = await service.buildReminderPdfHtml(notice as never, {
      name: 'Värd AB',
      street: 'Storgatan 1',
      postalCode: '111 22',
      city: 'Stockholm',
      bankgiro: '123-4567',
      invoiceColor: null,
      logoStorageKey: null,
    })
    expect(html).toContain('Värd AB')
    expect(html).toContain('Storgatan 1')
    expect(html).toContain('Stockholm')
    expect(html).toContain('1981:739')
    expect(html).toContain('123-4567') // bankgiro visas när det finns
    expect(html).toContain('8 060,00 kr') // att betala = 8000 + 60 (sv-SE)
  })

  it('utelämnar bankgiro-raden helt när org saknar bankgiro (aldrig 0000-0000)', async () => {
    const { service } = makeService()
    const html = await service.buildReminderPdfHtml(notice as never, {
      name: 'Värd AB',
      street: null,
      postalCode: null,
      city: null,
      bankgiro: null,
      invoiceColor: null,
      logoStorageKey: null,
    })
    expect(html).not.toContain('0000-0000')
    expect(html).not.toContain('Bankgiro')
  })
})
