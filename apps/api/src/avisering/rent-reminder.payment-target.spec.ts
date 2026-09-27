/**
 * K2 — KRAVTRAPPAN TAR INTE UT AVGIFTEN UTAN BETALNINGSMÅL.
 *
 * Avin är grindad i `sendNotices`, så en NY organisation utan bankgiro får ingen
 * avi SENT och därmed ingen OVERDUE — trappan når aldrig dit. Hålet som kvarstår
 * är det omvända: mål ifyllt → avi skickad → målet RENSAS → avin förfaller.
 * Då hade en påminnelseavgift bokförts och ett kravbrev skickats för en fordran
 * som inte gick att betala.
 *
 * Provet mäter tre saker, i tur och ordning: att avgiften inte tas ut, att
 * påminnelsen inte skickas, och att en ORGANISATION MED giltigt mål fortfarande
 * eskalerar — utan den sista raden hade en grind som alltid säger nej sett
 * likadan ut.
 */

jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { RentReminderService } from './rent-reminder.service'
import { Decimal } from '@prisma/client/runtime/library'

const DAY = 24 * 60 * 60 * 1000
const GILTIGT = '5050-1055'

/** Kravtrappans dygnskörning. Attrapp i samma form som rent-reminder.service.spec.ts. */
function cronRig(bankgiro: string | null) {
  const tx = {
    rentNotice: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findFirstOrThrow: jest.fn().mockResolvedValue({
        periodStart: new Date('2026-07-01'),
        dueDate: new Date('2026-06-30'),
        lease: { reminderFeeTermsFrom: new Date('2020-01-01') },
      }),
    },
  }
  const kandidat = {
    id: 'rn-9',
    organizationId: 'org-1',
    dueDate: new Date(Date.now() - 20 * DAY),
    organization: {
      rentReminderDay: 7,
      reminderFeeSek: 60,
      remindersEnabled: true,
      bankgiro,
    },
    tenant: { email: 'hyresgast@eveno.test' },
  }
  const prisma = {
    $transaction: jest.fn().mockImplementation((cb: (t: typeof tx) => unknown) => cb(tx)),
    rentNotice: { findMany: jest.fn().mockResolvedValue([kandidat]) },
  }
  const accounting = { bookReminderFee: jest.fn().mockResolvedValue({ id: 'je-1' }) }
  const rentNoticeEvents = { record: jest.fn().mockResolvedValue({ id: 'ev-1' }) }
  const rentInterest = { crystallizeInterest: jest.fn().mockResolvedValue(null) }
  const pdfQueue = { enqueue: jest.fn().mockResolvedValue('job-1') }
  const rentDebt = {
    outstanding: jest.fn().mockResolvedValue({
      capital: 7000,
      consumption: 0,
      reminderFee: 0,
      interest: 0,
      paid: 0,
      outstanding: 7000,
      ocrOutstanding: 7000,
    }),
  }
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
    {
      evaluateAndAlert: jest.fn().mockResolvedValue(new Set<string>()),
      assertAutomaticEffectAllowed: jest.fn().mockResolvedValue(undefined),
      sveparGranskningspauser: jest.fn().mockResolvedValue({ behandlade: 0 }),
    } as never,
    {
      report: () => {
        throw new Error('#605: cronErrors.report anropades oväntat i test')
      },
    } as never,
    { create: jest.fn() } as never,
  )
  return { service, accounting, rentNoticeEvents, rentInterest, pdfQueue, tx }
}

describe('K2 — kravtrappans cron', () => {
  beforeEach(() => jest.clearAllMocks())

  it.each([
    ['SAKNAT', null],
    ['BLANKT', '   '],
    ['KÄNT OGILTIGT', '0000-0000'],
  ])(
    '%s betalningsmål: INGEN avgift bokförs, INGEN påminnelse köas, avin räknas som hoppad',
    async (_namn, bankgiro) => {
      const rig = cronRig(bankgiro as string | null)
      const spion = jest.spyOn(rig.service, 'escalateNoticeToReminded').mockResolvedValue(true)

      const summary = await rig.service.escalateOverdueRentNotices()

      // Grinden ligger FÖRE eskaleringen — avgiften och kravsteget är
      // oåterkalleliga när den väl körts.
      expect(spion).not.toHaveBeenCalled()
      expect(rig.accounting.bookReminderFee).not.toHaveBeenCalled()
      expect(rig.tx.rentNotice.updateMany).not.toHaveBeenCalled()
      expect(rig.rentInterest.crystallizeInterest).not.toHaveBeenCalled()
      expect(rig.pdfQueue.enqueue).not.toHaveBeenCalled()
      // Avin förblir NONE och omprövas nästa dygn — samma form som saknad e-post.
      expect(summary.skipped).toBe(1)
      expect(summary.reminded).toBe(0)
      expect(summary.errors).toBe(0)
    },
  )

  it('GILTIGT mål: trappan går vidare som förut — grinden säger inte nej till allt', async () => {
    const rig = cronRig(GILTIGT)
    const spion = jest.spyOn(rig.service, 'escalateNoticeToReminded').mockResolvedValue(true)

    const summary = await rig.service.escalateOverdueRentNotices()

    expect(spion).toHaveBeenCalledWith('rn-9', 'org-1', 20, 60)
    expect(rig.pdfQueue.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'avisering-reminder', noticeId: 'rn-9' }),
    )
    expect(summary.reminded).toBe(1)
  })
})

/** Påminnelsejobbet — andra sidan kön, och den manuella omsändningens väg. */
function sendRig(bankgiro: string | null) {
  const notice = {
    id: 'rn-1',
    noticeNumber: 'AVI-2026-07-0001',
    ocrNumber: '1234567890',
    dueDate: new Date('2026-06-01'),
    totalAmount: new Decimal(8000),
    consumptionAmount: new Decimal(0),
    miscChargeAmount: new Decimal(0),
    reminderFeeAmount: new Decimal(60),
    interestAccruedAmount: new Decimal(0),
    credits: [],
    type: 'RENT',
    payments: [],
    tenant: { type: 'INDIVIDUAL', email: 'hyresgast@eveno.test', firstName: 'Alva', lastName: 'P' },
    lease: null,
    lines: [],
  }
  const org = {
    id: 'org-1',
    name: 'Eveno Kundprov 20260923',
    invoiceColor: null,
    logoStorageKey: null,
    bankgiro,
  }
  const prisma = {
    organization: { findUnique: jest.fn().mockResolvedValue(org) },
    rentNotice: { findFirst: jest.fn().mockResolvedValue(notice), update: jest.fn() },
    rentNoticeEvent: { findFirst: jest.fn().mockResolvedValue(null) },
    rentNoticeSend: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'send-1' }),
      update: jest.fn().mockResolvedValue({}),
    },
  }
  const rentNoticeEvents = { record: jest.fn().mockResolvedValue({ id: 'ev-1' }) }
  const pdfService = { generateFromHtml: jest.fn().mockResolvedValue(Buffer.from('%PDF-1.4')) }
  const storage = { uploadFile: jest.fn().mockResolvedValue('https://signed.example/r2') }
  const mailService = { sendRentNoticeReminder: jest.fn().mockResolvedValue('resend-msg-1') }
  const service = new RentReminderService(
    prisma as never,
    {} as never,
    rentNoticeEvents as never,
    {} as never,
    {} as never,
    mailService as never,
    pdfService as never,
    storage as never,
    { outstanding: jest.fn() } as never,
    {
      assertAutomaticEffectAllowed: jest.fn().mockResolvedValue(undefined),
      evaluateAndAlert: jest.fn().mockResolvedValue(new Set<string>()),
      sveparGranskningspauser: jest.fn().mockResolvedValue({ behandlade: 0 }),
    } as never,
    {
      report: () => {
        throw new Error('#605: cronErrors.report anropades oväntat i test')
      },
    } as never,
    { create: jest.fn() } as never,
  )
  return { service, mailService, pdfService, rentNoticeEvents, prisma }
}

describe('K2 — påminnelsejobbet', () => {
  beforeEach(() => jest.clearAllMocks())

  it('utan giltigt mål: inget brev, ingen PDF, en SEND_FAILED-händelse — och INGET kast', async () => {
    const rig = sendRig(null)

    // Ett kast hade gett fem Bull-retries av ett fel bara hyresvärden kan rätta.
    await expect(rig.service.processReminderSendJob('org-1', 'rn-1')).resolves.toBeUndefined()

    expect(rig.mailService.sendRentNoticeReminder).not.toHaveBeenCalled()
    expect(rig.pdfService.generateFromHtml).not.toHaveBeenCalled()
    expect(rig.prisma.rentNoticeSend.create).not.toHaveBeenCalled()
    const anrop = rig.rentNoticeEvents.record.mock.calls[0]!
    expect(anrop[1]).toBe('SEND_FAILED')
    expect(anrop[4]).toMatchObject({ code: 'PAYMENT_TARGET_MISSING' })
    expect(String((anrop[4] as { reason: string }).reason)).toMatch(/Inställningar/)
  })

  it('ogiltigt (0000-0000) ger koden PAYMENT_TARGET_INVALID — saknat och fel är två fall', async () => {
    const rig = sendRig('0000-0000')
    await rig.service.processReminderSendJob('org-1', 'rn-1')
    expect(rig.rentNoticeEvents.record.mock.calls[0]![4]).toMatchObject({
      code: 'PAYMENT_TARGET_INVALID',
    })
  })

  it('med giltigt mål skickas påminnelsen — och brevet bär målet', async () => {
    const rig = sendRig(GILTIGT)
    await rig.service.processReminderSendJob('org-1', 'rn-1')
    expect(rig.mailService.sendRentNoticeReminder).toHaveBeenCalledTimes(1)
    const html = rig.pdfService.generateFromHtml.mock.calls[0]![0] as string
    expect(html).toContain(GILTIGT)
    expect(html).not.toContain('0000-0000')
  })
})
