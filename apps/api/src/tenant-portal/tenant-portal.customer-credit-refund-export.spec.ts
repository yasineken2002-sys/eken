jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { Prisma } from '@prisma/client'
import { testPersonalNumberService } from '../common/crypto/personal-number.testing'
import {
  mapExportCustomerCreditRefund,
  PORTAL_CUSTOMER_CREDIT_REFUND_SELECT,
  TenantPortalService,
} from './tenant-portal.service'

type Dependencies = ConstructorParameters<typeof TenantPortalService>
function unused<T extends object>(): T {
  return new Proxy({} as T, {
    get: () => {
      throw new Error('Exporten får inte anropa externa tjänster')
    },
  })
}

function bankConfirmed() {
  return {
    id: 'own-refund',
    amount: new Prisma.Decimal('25.30'),
    currency: 'SEK',
    state: 'BANK_CONFIRMED' as const,
    preparedAt: new Date('2026-10-16T10:00:00Z'),
    bankBookedAt: new Date('2026-10-16T10:10:00Z'),
    bankConfirmedAt: new Date('2026-10-16T10:12:00Z'),
    settledAt: null,
    cancelledAt: null,
    rejectedAt: null,
    events: [{ type: 'BANK_CONFIRMED', occurredAt: new Date('2026-10-16T10:12:00Z') }],
    // En för bred framtida SELECT ska fortfarande inte läcka via mappningen.
    provider: 'HEMLIG-LEVERANTOR',
    providerAccountRef: 'HEMLIGT-BANKKONTO',
    recipientRef: 'HEMLIG-MOTTAGARE',
    recipientProofHash: 'HEMLIGT-MOTTAGARBEVIS',
    bankProofKey: 'HEMLIG-BANKNYCKEL',
    bankProofHash: 'HEMLIGT-BANKBEVIS',
    bankTransactionId: 'HEMLIG-BANKTRANSAKTION',
    instructionHash: 'HEMLIG-INSTRUKTION',
    requestId: 'HEMLIG-REQUEST',
  }
}

describe('GDPR-export av kundtillgodoåterbetalning', () => {
  it('skiljer bankens faktum från bokföringen och släpper inte ut bank-/mottagarbevis', () => {
    const row = bankConfirmed()
    const exported = mapExportCustomerCreditRefund(row)
    expect(exported).toEqual({
      id: row.id,
      amount: 25.3,
      currency: 'SEK',
      state: 'BANK_CONFIRMED',
      reservedAt: row.preparedAt,
      bankBookedAt: row.bankBookedAt,
      bankConfirmedAt: row.bankConfirmedAt,
      accountedAt: null,
      cancelledAt: null,
      rejectedAt: null,
      events: row.events,
    })
    expect(JSON.stringify(exported)).not.toContain('HEMLIG')
    expect(Object.keys(PORTAL_CUSTOMER_CREDIT_REFUND_SELECT).sort()).toEqual([
      'amount',
      'bankBookedAt',
      'bankConfirmedAt',
      'cancelledAt',
      'currency',
      'events',
      'id',
      'preparedAt',
      'rejectedAt',
      'settledAt',
      'state',
    ])
    expect(PORTAL_CUSTOMER_CREDIT_REFUND_SELECT.events.select).toEqual({
      type: true,
      occurredAt: true,
    })
  })

  it('visar bokföringstid först för den faktiskt bokförda återbetalningen', () => {
    const settledAt = new Date('2026-10-16T10:13:00Z')
    expect(
      mapExportCustomerCreditRefund({ ...bankConfirmed(), state: 'SETTLED', settledAt })
        .accountedAt,
    ).toEqual(settledAt)
  })

  it('läser endast den inloggade hyresgästens relation med explicit fältlista', async () => {
    const prisma = {
      tenant: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'own-tenant',
          organization: { id: 'own-org', name: 'Testbolag' },
          leases: [],
          invoices: [],
          rentNotices: [],
          maintenanceTickets: [],
          documents: [],
          customerCreditRefunds: [bankConfirmed()],
        }),
      },
    }
    const portal = new TenantPortalService(
      prisma as unknown as Dependencies[0],
      testPersonalNumberService(),
      unused<Dependencies[2]>(),
      unused<Dependencies[3]>(),
      unused<Dependencies[4]>(),
      unused<Dependencies[5]>(),
      unused<Dependencies[6]>(),
    )
    const result = await portal.exportTenantData('own-tenant')
    expect(prisma.tenant.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'own-tenant' },
        include: expect.objectContaining({
          customerCreditRefunds: {
            orderBy: [{ preparedAt: 'asc' }, { id: 'asc' }],
            select: PORTAL_CUSTOMER_CREDIT_REFUND_SELECT,
          },
        }),
      }),
    )
    expect(result.customerCreditRefunds).toHaveLength(1)
    expect(result.customerCreditRefunds[0]?.id).toBe('own-refund')
    expect(JSON.stringify(result)).not.toContain('HEMLIG')
  })
})
