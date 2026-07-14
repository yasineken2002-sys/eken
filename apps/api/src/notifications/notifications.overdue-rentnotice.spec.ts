/**
 * Inkasso PR 1 — förfalloövervakning för hyresavier (markOverdueRentNotices).
 *
 * Verifierar att den dagliga cronen:
 *   • flippar en utskickad (SENT), förfallen avi → OVERDUE,
 *   • är PENGANEUTRAL och rör inte kravtrappan (collectionStage),
 *   • är tenant-säker: en global bulk-update utan org-filter där varje rad
 *     bedöms enbart på sin egen dueDate (ingen orgs data läses eller korsas),
 *   • eskalerar ENBART SENT (en avi som aldrig nått hyresgästen rörs inte).
 */

// NotificationsService → MonthlyReportService → den brandade shellen drar in
// storage.service (AWS SDK, ESM) som jest inte kan parsa. Stubbas — samma
// mönster som övriga specar som transitivt rör storage. (Steg 3, PR 3a.)
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
// T5 B1b — mocka Sentry för att bevisa att cronet nu LARMAR vid ett fel på
// första query istället för att dö tyst (samma mönster som cron-safety.spec).
jest.mock('@sentry/nestjs', () => ({ captureException: jest.fn() }))

import { captureException } from '@sentry/nestjs'
import { NotificationsService } from './notifications.service'

function makeService() {
  const prisma = {
    rentNotice: {
      updateMany: jest.fn().mockResolvedValue({ count: 2 }),
    },
  }
  const service = new NotificationsService(prisma as never, {} as never, {} as never, {} as never)
  return { service, prisma }
}

describe('Inkasso PR 1 — markOverdueRentNotices', () => {
  it('flippar SENT + förfallen → OVERDUE', async () => {
    const { service, prisma } = makeService()
    await service.markOverdueRentNotices()

    expect(prisma.rentNotice.updateMany).toHaveBeenCalledTimes(1)
    const arg = prisma.rentNotice.updateMany.mock.calls[0]![0]
    expect(arg.where.status).toBe('SENT')
    expect(arg.where.dueDate.lt).toBeInstanceOf(Date)
    expect(arg.data).toEqual({ status: 'OVERDUE' })
  })

  it('är penganeutral: rör inte kravtrappan (ingen collectionStage i data)', async () => {
    const { service, prisma } = makeService()
    await service.markOverdueRentNotices()
    const arg = prisma.rentNotice.updateMany.mock.calls[0]![0]
    expect(arg.data).not.toHaveProperty('collectionStage')
    expect(Object.keys(arg.data)).toEqual(['status'])
  })

  it('är tenant-säker: globalt per-rad-filter utan organizationId', async () => {
    const { service, prisma } = makeService()
    await service.markOverdueRentNotices()
    const arg = prisma.rentNotice.updateMany.mock.calls[0]![0]
    // Inget org-filter → varje rad flippas enbart på sin egen dueDate. Ingen
    // organisations data läses eller korsas (samma mönster som markOverdueInvoices).
    expect(arg.where).not.toHaveProperty('organizationId')
    expect(Object.keys(arg.where).sort()).toEqual(['dueDate', 'status'])
  })

  it('eskalerar bara SENT — aldrig PENDING/PAID/CANCELLED/FAILED', async () => {
    const { service, prisma } = makeService()
    await service.markOverdueRentNotices()
    const arg = prisma.rentNotice.updateMany.mock.calls[0]![0]
    // En enda statusvärde i filtret, och det är SENT.
    expect(arg.where.status).toBe('SENT')
  })

  // T5 B1b — bevisar RESILIENS-vinsten: ett fel på första query dör INTE tyst
  // längre, det larmar via Sentry (och sväljs så @nestjs/schedule inte kraschar).
  it('larmar via Sentry vid DB-blipp på första query istället för tyst död', async () => {
    ;(captureException as jest.Mock).mockClear()
    const { service, prisma } = makeService()
    prisma.rentNotice.updateMany.mockRejectedValueOnce(new Error('transient DB-blipp'))

    // Sväljs (resolvar, kastar inte) — @nestjs/schedule kraschar inte.
    await expect(service.markOverdueRentNotices()).resolves.toBeUndefined()

    // MEN felet larmas nu (skrubbat meddelande + cron-tagg).
    expect(captureException as jest.Mock).toHaveBeenCalledTimes(1)
    const [err, ctx] = (captureException as jest.Mock).mock.calls[0]
    expect((err as Error).message).not.toContain('DB-blipp') // skrubbat
    expect(ctx).toEqual(
      expect.objectContaining({
        tags: expect.objectContaining({ cron: 'mark-overdue-rent-notices' }),
      }),
    )
  })
})
