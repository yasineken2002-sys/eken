import { Prisma } from '@prisma/client'
import { HISTORY_SOURCES } from './history-sources.registry'

function source() {
  const matches = HISTORY_SOURCES.filter((entry) => entry.key === 'customer-credit')
  expect(matches).toHaveLength(1)
  return matches[0]!
}

function credit() {
  return {
    id: 'credit-1',
    receivedAt: new Date('2026-09-25T12:00:00Z'),
    createdAt: new Date('2026-09-26T08:00:00Z'),
    actorKind: 'SYSTEM',
    amount: new Prisma.Decimal('25.30'),
    sourceRentNoticeId: 'notice-september',
    sourceRentNotice: { noticeNumber: 'AVI-2026-0009' },
    applications: [
      {
        id: 'application-1',
        appliedAt: new Date('2026-10-01T12:00:00Z'),
        createdAt: new Date('2026-10-02T08:00:00Z'),
        actorKind: 'AGENT',
        amount: new Prisma.Decimal('10.10'),
        rentNoticeId: 'notice-october',
        rentNotice: { noticeNumber: 'AVI-2026-0010' },
      },
      {
        id: 'application-2',
        appliedAt: new Date('2026-11-01T12:00:00Z'),
        createdAt: new Date('2026-11-02T08:00:00Z'),
        actorKind: 'HUMAN',
        amount: new Prisma.Decimal('15.20'),
        rentNoticeId: 'notice-november',
        rentNotice: { noticeNumber: 'AVI-2026-0011' },
      },
    ],
  }
}

function rig(rows: unknown[] = [credit()]) {
  const findMany = jest.fn().mockResolvedValue(rows)
  const query = {
    prisma: { customerCredit: { findMany } } as never,
    organizationId: 'org-1',
    subject: { kind: 'TENANT' as const, id: 'tenant-1' },
  }
  return { query, findMany }
}

describe('Kundtillgodo i det exporterade historikregistret', () => {
  it('är faktiskt påkopplat för Tenant.customerCredits', () => {
    expect(source()).toMatchObject({
      table: 'CustomerCredit',
      relations: { tenant: 'customerCredits' },
    })
    const tenantSources = HISTORY_SOURCES.filter((entry) => entry.relations.tenant !== undefined)
    expect(tenantSources).toContain(source())
    expect(source().relations.unit).toBeUndefined()
    expect(source().relations.property).toBeUndefined()
  })

  it('scopar både tillgodon och användningar och väljer bara historikens underlag', async () => {
    const { query, findMany } = rig()
    await source().load(query)

    expect(findMany).toHaveBeenCalledWith({
      where: { organizationId: 'org-1', tenantId: 'tenant-1' },
      select: {
        id: true,
        receivedAt: true,
        actorKind: true,
        amount: true,
        sourceRentNoticeId: true,
        sourceRentNotice: { select: { noticeNumber: true } },
        applications: {
          where: {
            organizationId: 'org-1',
            rentNotice: { organizationId: 'org-1', tenantId: 'tenant-1' },
          },
          select: {
            id: true,
            appliedAt: true,
            actorKind: true,
            amount: true,
            rentNoticeId: true,
            rentNotice: { select: { noticeNumber: true } },
          },
        },
      },
    })
  })

  it('visar mottagning och varje användning med respektive belopp, tid, aktör och källa', async () => {
    const row = credit()
    const { query } = rig([row])

    expect(await source().load(query)).toEqual([
      {
        at: row.receivedAt,
        type: 'CUSTOMER_CREDIT_RECEIVED',
        actor: { kind: 'SYSTEM', id: null, label: null },
        subject: { kind: 'RENT_NOTICE', id: 'notice-september', label: 'AVI-2026-0009' },
        description: 'Tillgodo mottaget från hyresavi AVI-2026-0009',
        amount: 25.3,
        severity: 'INFO',
        source: { table: 'CustomerCredit', id: 'credit-1' },
      },
      {
        at: row.applications[0]!.appliedAt,
        type: 'CUSTOMER_CREDIT_APPLIED',
        actor: { kind: 'AGENT', id: null, label: null },
        subject: { kind: 'RENT_NOTICE', id: 'notice-october', label: 'AVI-2026-0010' },
        description: 'Tillgodo använt på hyresavi AVI-2026-0010',
        amount: 10.1,
        severity: 'INFO',
        source: { table: 'CustomerCreditApplication', id: 'application-1' },
      },
      {
        at: row.applications[1]!.appliedAt,
        type: 'CUSTOMER_CREDIT_APPLIED',
        actor: { kind: 'HUMAN', id: null, label: null },
        subject: { kind: 'RENT_NOTICE', id: 'notice-november', label: 'AVI-2026-0011' },
        description: 'Tillgodo använt på hyresavi AVI-2026-0011',
        amount: 15.2,
        severity: 'INFO',
        source: { table: 'CustomerCreditApplication', id: 'application-2' },
      },
    ])
  })

  it('gissar inte aktör när stämpeln saknas på mottagning eller användning', async () => {
    const row = credit()
    const { query } = rig([
      {
        ...row,
        actorKind: null,
        applications: row.applications.map((application) => ({ ...application, actorKind: null })),
      },
    ])
    const events = await source().load(query)

    expect(events).toHaveLength(3)
    expect(events.map((event) => event.actor)).toEqual([
      { kind: 'UNKNOWN', id: null, label: null },
      { kind: 'UNKNOWN', id: null, label: null },
      { kind: 'UNKNOWN', id: null, label: null },
    ])
  })

  it('outnyttjat tillgodo ger endast mottagningshändelsen', async () => {
    const { query } = rig([{ ...credit(), applications: [] }])
    const events = await source().load(query)

    expect(events).toHaveLength(1)
    expect(events[0]!.type).toBe('CUSTOMER_CREDIT_RECEIVED')
    expect(events[0]!.amount).toBe(25.3)
  })

  it('tomt underlag ger inga påhittade ekonomiska händelser', async () => {
    const { query } = rig([])
    expect(await source().load(query)).toEqual([])
  })

  it('avvisar en odeklarerad objektdimension före databasläsningen', async () => {
    const { query, findMany } = rig()
    await expect(
      source().load({ ...query, subject: { kind: 'UNIT', id: 'unit-1' } }),
    ).rejects.toThrow('stödjer inte dimensionen UNIT')
    expect(findMany).not.toHaveBeenCalled()
  })
})
