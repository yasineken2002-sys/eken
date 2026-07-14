// T5 B1c — bevisar isolerings-invarianten för processLifecycle:
// Promise.all → Promise.allSettled så ett delsystems fel INTE tar ner de andra,
// och att det felande delsystemet LARMAR (Sentry, egen subsystem-tagg).
jest.mock('@sentry/nestjs', () => ({ captureException: jest.fn() }))
// LeasesService → NotificationsService → MonthlyReportService → storage.service
// (AWS SDK, ESM) som jest inte kan parsa. Stubbas — samma mönster som övriga
// specar som transitivt rör storage.
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { captureException } from '@sentry/nestjs'
import { LeasesService } from './leases.service'

const mockedCapture = captureException as jest.Mock

function makeService() {
  const prisma = {} as never
  const deposits = {
    remindStaleRefundPending: jest.fn().mockResolvedValue(3),
    sweepTerminatedLeasesForRefundPending: jest.fn().mockResolvedValue(0),
  }
  const rentIncreases = { applyDueIncreases: jest.fn().mockResolvedValue(4) }
  const svc = new LeasesService(
    prisma,
    {} as never,
    deposits as never,
    rentIncreases as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  )
  // Tysta loggern (svc.logger är privat) för rent testutdata.
  ;(svc as unknown as { logger: unknown }).logger = {
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }
  return { svc, deposits, rentIncreases }
}

beforeEach(() => mockedCapture.mockClear())

describe('LeasesService.processLifecycle — B1c delsystems-isolering', () => {
  it('ett delsystem kastar → de andra tre körs ändå + det felande larmar (subsystem-tagg)', async () => {
    const { svc, deposits, rentIncreases } = makeService()
    jest.spyOn(svc as never, 'autoRenewExpiredFixedTerm').mockResolvedValue(1 as never)
    const expiry = jest.spyOn(svc as never, 'sendExpiryReminders').mockResolvedValue(2 as never)
    jest
      .spyOn(svc as never, 'terminateExpiredNoticeLeases')
      .mockRejectedValue(new Error('terminate DB-blipp') as never)

    await expect(svc.processLifecycle()).resolves.toBeUndefined()

    // De tre övriga delsystemen körde ändå (isolering):
    expect(expiry).toHaveBeenCalledTimes(1)
    expect(deposits.remindStaleRefundPending).toHaveBeenCalledTimes(1)
    expect(rentIncreases.applyDueIncreases).toHaveBeenCalledTimes(1)
    // refundSwept-säkerhetsnätet körde också (efter allSettled):
    expect(deposits.sweepTerminatedLeasesForRefundPending).toHaveBeenCalledTimes(1)

    // Det felande delsystemet larmade — INTE tyst — med egen subsystem-tagg:
    expect(mockedCapture).toHaveBeenCalledTimes(1)
    const [sentryErr, ctx] = mockedCapture.mock.calls[0]
    expect((sentryErr as Error).message).not.toContain('DB-blipp') // skrubbat
    expect((ctx as { tags: Record<string, string> }).tags).toEqual(
      expect.objectContaining({ cron: 'leases-process-lifecycle', subsystem: 'terminate-expired' }),
    )
  })

  it('allt lyckas → inget larm', async () => {
    const { svc } = makeService()
    jest.spyOn(svc as never, 'autoRenewExpiredFixedTerm').mockResolvedValue(1 as never)
    jest.spyOn(svc as never, 'sendExpiryReminders').mockResolvedValue(2 as never)
    jest.spyOn(svc as never, 'terminateExpiredNoticeLeases').mockResolvedValue(0 as never)

    await svc.processLifecycle()
    expect(mockedCapture).not.toHaveBeenCalled()
  })

  it('autoRenew (hård förutsättning) kastar → cronet larmar via runCronSafely, delsystemen körs INTE', async () => {
    const { svc, deposits, rentIncreases } = makeService()
    jest
      .spyOn(svc as never, 'autoRenewExpiredFixedTerm')
      .mockRejectedValue(new Error('org-findMany nere') as never)
    const expiry = jest.spyOn(svc as never, 'sendExpiryReminders').mockResolvedValue(2 as never)

    await expect(svc.processLifecycle()).resolves.toBeUndefined()

    // Delsystemen startades aldrig (T1.3: applyDueIncreases får inte köra på
    // ett icke-förnyat bestånd):
    expect(expiry).not.toHaveBeenCalled()
    expect(rentIncreases.applyDueIncreases).not.toHaveBeenCalled()
    expect(deposits.remindStaleRefundPending).not.toHaveBeenCalled()

    // runCronSafely larmade (cron-tagg, INGEN subsystem-tagg):
    expect(mockedCapture).toHaveBeenCalledTimes(1)
    const [, ctx] = mockedCapture.mock.calls[0]
    expect((ctx as { tags: Record<string, string> }).tags).toEqual(
      expect.objectContaining({ cron: 'leases-process-lifecycle' }),
    )
    expect((ctx as { tags: Record<string, string> }).tags.subsystem).toBeUndefined()
  })
})
