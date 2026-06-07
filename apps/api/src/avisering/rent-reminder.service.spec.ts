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

function makeService() {
  const tx = { rentNotice: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) } }
  const prisma = {
    $transaction: jest.fn().mockImplementation((cb: (t: typeof tx) => unknown) => cb(tx)),
    rentNotice: { findMany: jest.fn().mockResolvedValue([]) },
  }
  const accounting = { bookReminderFee: jest.fn().mockResolvedValue({ id: 'je-1' }) }
  const rentNoticeEvents = { record: jest.fn().mockResolvedValue({ id: 'ev-1' }) }
  const rentInterest = { crystallizeInterest: jest.fn().mockResolvedValue(null) }
  const pdfQueue = { enqueue: jest.fn().mockResolvedValue('job-1') }
  const service = new RentReminderService(
    prisma as never,
    accounting as never,
    rentNoticeEvents as never,
    rentInterest as never,
    pdfQueue as never,
    {} as never,
    {} as never,
    {} as never,
  )
  return { service, prisma, tx, accounting, rentNoticeEvents, rentInterest, pdfQueue }
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
