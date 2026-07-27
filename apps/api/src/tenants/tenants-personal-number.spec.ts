/**
 * Personnummer genom hela tjänstelagret: vad som SKRIVS till databasen och vad
 * som LÄMNAR API:et.
 *
 * personal-number.spec.ts låser kryptot i sig. Det här testet låser att
 * tjänsterna faktiskt använder det — att ingen skrivväg smiter förbi och lägger
 * klartext i kolumnen, och att svaret bär klartexten men inte chiffertexten
 * eller blind-indexet.
 */

import { TenantsService, SAFE_TENANT_SELECT } from './tenants.service'
import { CustomersService } from '../customers/customers.service'
import { testPersonalNumberService } from '../common/crypto/personal-number.testing'

const PN = '19850101-1234'
const pn = testPersonalNumberService()

/** Läser ut `data`-objektet som tjänsten skickade till Prisma. */
function writtenData(mock: jest.Mock): Record<string, unknown> {
  return mock.mock.calls[0]![0].data as Record<string, unknown>
}

describe('krav 8 — TenantsService skriver chiffertext, aldrig klartext', () => {
  function setup() {
    const create = jest.fn(async (args: { data: Record<string, unknown> }) => ({
      id: 't1',
      ...args.data,
    }))
    const prisma = {
      tenant: {
        findFirst: jest.fn().mockResolvedValue(null),
        create,
        update: jest.fn(async (args: { data: Record<string, unknown> }) => ({
          id: 't1',
          street: null,
          ...args.data,
        })),
      },
      unit: {
        findFirst: jest.fn().mockResolvedValue({ id: 'u1', property: { organizationId: 'org-1' } }),
      },
      $transaction: jest.fn(async (fn: (tx: unknown) => unknown) =>
        fn({ tenant: { create }, lease: { create: jest.fn().mockResolvedValue({ id: 'l1' }) } }),
      ),
    }
    return { prisma, create, service: new TenantsService(prisma as never, pn) }
  }

  it('create: kolumnen får chiffertext + blind-index, INTE personnumret', async () => {
    const { create, service } = setup()

    await service.create(
      {
        type: 'INDIVIDUAL',
        firstName: 'Anna',
        lastName: 'Ek',
        email: 'a@e.se',
        personalNumber: PN,
        lease: { unitId: 'u1', startDate: '2026-01-01', monthlyRent: 10000 },
      } as never,
      'org-1',
    )

    const data = writtenData(create)
    // Det gamla, trasiga beteendet: data.personalNumber === '19850101-1234'.
    expect(data['personalNumber']).toBeUndefined()
    expect(data['personalNumberLegacy']).toBeUndefined()
    expect(data['personalNumberEnc']).toEqual(expect.any(String))
    expect(data['personalNumberEnc']).not.toContain('1985')
    expect(pn.reveal(data['personalNumberEnc'] as string)).toBe(PN)
    expect(data['personalNumberHash']).toBe(pn.index(PN))
  })

  it('update: samma sak på uppdateringsvägen', async () => {
    const { prisma, service } = setup()
    prisma.tenant.findFirst.mockResolvedValue({ id: 't1' })

    await service.update('t1', { personalNumber: PN }, 'org-1')

    const data = writtenData(prisma.tenant.update as jest.Mock)
    expect(data['personalNumber']).toBeUndefined()
    expect(pn.reveal(data['personalNumberEnc'] as string)).toBe(PN)
    expect(data['personalNumberHash']).toBe(pn.index(PN))
  })

  it('update utan personnummer i payloaden rör inte kolumnerna', async () => {
    const { prisma, service } = setup()
    prisma.tenant.findFirst.mockResolvedValue({ id: 't1' })

    await service.update('t1', { phone: '070-1234567' }, 'org-1')

    // En PATCH som inte nämner personnumret får ALDRIG radera det.
    const data = writtenData(prisma.tenant.update as jest.Mock)
    expect(data).not.toHaveProperty('personalNumberEnc')
    expect(data).not.toHaveProperty('personalNumberHash')
  })

  it('tomt personnummer nollar båda kolumnerna', async () => {
    const { prisma, service } = setup()
    prisma.tenant.findFirst.mockResolvedValue({ id: 't1' })

    await service.update('t1', { personalNumber: '' }, 'org-1')

    const data = writtenData(prisma.tenant.update as jest.Mock)
    expect(data['personalNumberEnc']).toBeNull()
    // Blind-indexet måste nollas det med — annars går personen fortfarande att
    // korrelera efter att numret "raderats".
    expect(data['personalNumberHash']).toBeNull()
  })
})

describe('krav 8 — CustomersService skriver chiffertext, aldrig klartext', () => {
  function setup() {
    const prisma = {
      customer: {
        findFirst: jest.fn().mockResolvedValue({ id: 'c1' }),
        create: jest.fn(async (args: { data: Record<string, unknown> }) => ({
          id: 'c1',
          ...args.data,
        })),
        update: jest.fn(async (args: { data: Record<string, unknown> }) => ({
          id: 'c1',
          ...args.data,
        })),
      },
    }
    return { prisma, service: new CustomersService(prisma as never, pn) }
  }

  it('create krypterar', async () => {
    const { prisma, service } = setup()

    await service.create(
      { type: 'INDIVIDUAL', firstName: 'Bo', lastName: 'Ek', personalNumber: PN },
      'org-1',
    )

    const data = writtenData(prisma.customer.create as jest.Mock)
    expect(data['personalNumber']).toBeUndefined()
    expect(pn.reveal(data['personalNumberEnc'] as string)).toBe(PN)
  })

  it('update krypterar', async () => {
    const { prisma, service } = setup()

    await service.update('c1', { personalNumber: PN }, 'org-1')

    const data = writtenData(prisma.customer.update as jest.Mock)
    expect(data['personalNumber']).toBeUndefined()
    expect(pn.reveal(data['personalNumberEnc'] as string)).toBe(PN)
  })

  it('svaret bär klartexten men aldrig chiffertext eller blind-index', async () => {
    const { prisma, service } = setup()
    prisma.customer.findFirst.mockResolvedValue({
      id: 'c1',
      firstName: 'Bo',
      ...pn.protect(PN),
    })

    const result = (await service.findOne('c1', 'org-1')) as Record<string, unknown>

    expect(result['personalNumber']).toBe(PN)
    expect(result).not.toHaveProperty('personalNumberEnc')
    expect(result).not.toHaveProperty('personalNumberHash')
    expect(result).not.toHaveProperty('personalNumberLegacy')
  })
})

describe('krav 3 — personnumret rider inte med i delade selects', () => {
  it('SAFE_TENANT_SELECT bär varken klartext, chiffertext eller index', () => {
    // Selecten används på ~25 ställen (fakturor, depositioner, nycklar,
    // besiktningar, dashboard, avisering …). Ingen av dem behöver personnumret;
    // det åkte bara med. Den som verkligen ska visa det väljer kolumnen själv.
    expect(SAFE_TENANT_SELECT).not.toHaveProperty('personalNumber')
    expect(SAFE_TENANT_SELECT).not.toHaveProperty('personalNumberEnc')
    expect(SAFE_TENANT_SELECT).not.toHaveProperty('personalNumberHash')
    expect(SAFE_TENANT_SELECT).not.toHaveProperty('personalNumberLegacy')
  })

  it('hyresgästsvaret exponerar klartexten men inte kryptokolumnerna', async () => {
    const prisma = {
      tenant: {
        findFirst: jest.fn().mockResolvedValue({
          id: 't1',
          firstName: 'Anna',
          street: null,
          leases: [],
          ...pn.protect(PN),
        }),
      },
    }
    const service = new TenantsService(prisma as never, pn)

    const result = (await service.findOne('t1', 'org-1')) as Record<string, unknown>

    expect(result['personalNumber']).toBe(PN)
    expect(result).not.toHaveProperty('personalNumberEnc')
    expect(result).not.toHaveProperty('personalNumberHash')
    expect(result).not.toHaveProperty('personalNumberLegacy')
  })
})
