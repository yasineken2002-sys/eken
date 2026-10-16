import { Prisma } from '@prisma/client'
import { HISTORY_SOURCES, type HistoryQuery } from './history-sources.registry'

const source = () => {
  const rows = HISTORY_SOURCES.filter((entry) => entry.key === 'customer-credit-refund')
  expect(rows).toHaveLength(1)
  return rows[0]!
}

function rig() {
  const at = new Date('2026-10-16T12:00:00Z')
  const findMany = jest.fn().mockResolvedValue([
    {
      amount: new Prisma.Decimal('25.30'),
      recipientRef: 'HEMLIG-MOTTAGARE',
      bankProofHash: 'HEMLIGT-BEVIS',
      credit: {
        sourceRentNoticeId: 'notice-1',
        sourceRentNotice: { noticeNumber: 'AVI-2026-0001' },
      },
      events: ['RESERVED', 'UNKNOWN', 'BANK_CONFIRMED', 'SETTLED'].map((type, i) => ({
        id: `event-${i}`,
        type,
        occurredAt: new Date(at.getTime() + i * 1000),
        actorKind: i === 0 ? 'HUMAN' : i === 1 ? null : 'SYSTEM',
        reasonCode: 'HEMLIG-BANKTEXT',
        observationHash: 'HEMLIG-OBSERVATION',
      })),
    },
  ])
  const query: HistoryQuery = {
    prisma: { customerCreditRefund: { findMany } } as unknown as HistoryQuery['prisma'],
    organizationId: 'org-1',
    subject: { kind: 'TENANT', id: 'tenant-1' },
  }
  return { query, findMany }
}

describe('Kundtillgodoåterbetalning i historikregistret', () => {
  it('är påkopplad för hyresgästen och läser scope även på tillgodokällan/händelserna', async () => {
    expect(source().relations).toEqual({ tenant: 'customerCreditRefunds' })
    const { query, findMany } = rig()
    await source().load(query)
    expect(findMany).toHaveBeenCalledWith({
      where: {
        organizationId: 'org-1',
        tenantId: 'tenant-1',
        credit: { organizationId: 'org-1', tenantId: 'tenant-1' },
      },
      select: {
        amount: true,
        credit: {
          select: {
            sourceRentNoticeId: true,
            sourceRentNotice: { select: { noticeNumber: true } },
          },
        },
        events: {
          where: { organizationId: 'org-1' },
          orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
          select: { id: true, type: true, occurredAt: true, actorKind: true },
        },
      },
    })
  })

  it('skiljer reservation, okänt bankutfall, bankbekräftelse och bokföring utan bankhemligheter', async () => {
    const { query } = rig()
    const events = await source().load(query)
    expect(events.map((event) => event.type)).toEqual([
      'CUSTOMER_CREDIT_REFUND_RESERVED',
      'CUSTOMER_CREDIT_REFUND_UNKNOWN',
      'CUSTOMER_CREDIT_REFUND_BANK_CONFIRMED',
      'CUSTOMER_CREDIT_REFUND_SETTLED',
    ])
    expect(events[0]?.actor.kind).toBe('HUMAN')
    expect(events[1]?.actor.kind).toBe('UNKNOWN')
    expect(events[1]?.severity).toBe('WARNING')
    expect(events[2]?.description).toContain('bokföring inväntas')
    expect(events[3]?.description).toContain('bokförd')
    expect(events.every((event) => event.amount === 25.3)).toBe(true)
    expect(events.every((event) => event.source.table === 'CustomerCreditRefundEvent')).toBe(true)
    expect(JSON.stringify(events)).not.toContain('HEMLIG')
  })

  it('skapar inga gissade händelser av en status utan händelser', async () => {
    const { query, findMany } = rig()
    findMany.mockResolvedValueOnce([
      { amount: new Prisma.Decimal(25), state: 'SETTLED', events: [] },
    ])
    expect(await source().load(query)).toEqual([])
  })

  it('avvisar objektdimensionen innan personanknutna bevis läses', async () => {
    const { query, findMany } = rig()
    await expect(
      source().load({ ...query, subject: { kind: 'UNIT', id: 'unit-1' } }),
    ).rejects.toThrow('stödjer inte dimensionen UNIT')
    expect(findMany).not.toHaveBeenCalled()
  })
})
