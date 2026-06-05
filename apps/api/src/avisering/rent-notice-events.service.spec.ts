/**
 * Inkasso PR 2 — RentNoticeEventsService org-isolation (PR 1 security-LOW).
 *
 * Kravloggen saknar egen organizationId och scopas via avin. getTimeline MÅSTE
 * därför org-verifiera avin INNAN händelser läses — annars kan ett läckt
 * rentNoticeId exponera en annan organisations logg. Här verifieras att org A
 * aldrig kan läsa org B:s logg.
 */

import { NotFoundException } from '@nestjs/common'
import { RentNoticeEventsService } from './rent-notice-events.service'

function makeService(ownerOrgId: string) {
  const events = [
    { id: 'ev-1', rentNoticeId: 'rn-1', type: 'REMINDER_SENT' },
    { id: 'ev-2', rentNoticeId: 'rn-1', type: 'SENT' },
  ]
  const prisma = {
    rentNotice: {
      // Org-scopad findFirst: returnerar avin BARA om organizationId matchar ägaren.
      findFirst: jest
        .fn()
        .mockImplementation((args: { where: { organizationId: string } }) =>
          Promise.resolve(args.where.organizationId === ownerOrgId ? { id: 'rn-1' } : null),
        ),
    },
    rentNoticeEvent: { findMany: jest.fn().mockResolvedValue(events) },
  }
  const service = new RentNoticeEventsService(prisma as never)
  return { service, prisma, events }
}

describe('RentNoticeEventsService.getTimeline — org-isolation', () => {
  it('ägar-org får tidslinjen (org-verifiering passerar)', async () => {
    const { service, prisma, events } = makeService('org-A')
    const result = await service.getTimeline('rn-1', 'org-A')
    expect(result).toEqual(events)
    expect(prisma.rentNotice.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'rn-1', organizationId: 'org-A' } }),
    )
  })

  it('annan org nekas (NotFound) och kravloggen läses ALDRIG', async () => {
    const { service, prisma } = makeService('org-A')
    await expect(service.getTimeline('rn-1', 'org-B')).rejects.toBeInstanceOf(NotFoundException)
    // Avgörande: events-tabellen rörs aldrig när ägarskapskontrollen failar.
    expect(prisma.rentNoticeEvent.findMany).not.toHaveBeenCalled()
  })

  it('läsningen sker FÖRST efter ägarskapskontroll (ordning)', async () => {
    const { service, prisma } = makeService('org-A')
    await service.getTimeline('rn-1', 'org-A')
    const ownerCheckOrder = prisma.rentNotice.findFirst.mock.invocationCallOrder[0]!
    const readOrder = prisma.rentNoticeEvent.findMany.mock.invocationCallOrder[0]!
    expect(ownerCheckOrder).toBeLessThan(readOrder)
  })
})
