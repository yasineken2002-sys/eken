/**
 * G17 (FORTNOX-100): månadsaviseringen ska nå bolag i provperiod och med förfallen
 * plattformsbetalning, men inte pausade eller avslutade bolag. Kundeffekten (decemberavier
 * för ett TRIAL-bolag med 100 avtal) mäts i C1:s rigg (K3); detta låser urvalet.
 */
jest.mock('./avisering.service', () => ({ AviseringService: class {} }))

import { AviseringScheduler, AVISERING_ORG_STATUSES } from './avisering.scheduler'

describe('AviseringScheduler.runForMonth — urval av organisationer', () => {
  it('TRIAL, ACTIVE och PAST_DUE avieras; SUSPENDED och CANCELLED inte', async () => {
    const orgs = [
      { id: 'o-trial', status: 'TRIAL' },
      { id: 'o-active', status: 'ACTIVE' },
      { id: 'o-pastdue', status: 'PAST_DUE' },
      { id: 'o-suspended', status: 'SUSPENDED' },
      { id: 'o-cancelled', status: 'CANCELLED' },
    ]
    const prisma = {
      organization: {
        findMany: jest.fn(async ({ where }: { where: { status: { in: string[] } } }) =>
          orgs
            .filter((o) => where.status.in.includes(o.status))
            .map((o) => ({ id: o.id, name: o.id })),
        ),
      },
    }
    const avierade: string[] = []
    const avisering = {
      generateMonthlyNotices: jest.fn(async (orgId: string) => {
        avierade.push(orgId)
        return { created: 1, skipped: 0, failed: 0, queued: 1, blocked: 0 }
      }),
    }
    const s = new AviseringScheduler(
      prisma as never,
      avisering as never,
      { report: jest.fn() } as never,
    )
    const r = await s.runForMonth(2026, 12)
    expect(avierade.sort()).toEqual(['o-active', 'o-pastdue', 'o-trial'])
    expect(r.organizations).toBe(3)
    expect([...AVISERING_ORG_STATUSES]).toEqual(['TRIAL', 'ACTIVE', 'PAST_DUE'])
  })
})
