/**
 * ContractNumberService — atomisk allokering av kontraktsnummer per org & år.
 *
 * Verifierar:
 *   • formatContractNumber: KONT-{år}-{löpnr:5}, nollvädring, nytt år.
 *   • allocate: atomisk upsert (create lastNumber:1 / update increment) på den
 *     sammansatta nyckeln (organizationId, year), och formaterar resultatet.
 *   • allocate använder en medskickad transaktionsklient när sådan finns.
 *   • Två olika organisationer allokerar oberoende → båda kan få KONT-{år}-00001
 *     (numret är unikt PER ORG, inte globalt — det var rotorsaken till P2002).
 */

import { ContractNumberService, formatContractNumber } from './contract-number.service'

describe('formatContractNumber', () => {
  it('nollvädrar löpnumret till 5 siffror', () => {
    expect(formatContractNumber(2026, 1)).toBe('KONT-2026-00001')
    expect(formatContractNumber(2026, 42)).toBe('KONT-2026-00042')
    expect(formatContractNumber(2026, 12_345)).toBe('KONT-2026-12345')
  })

  it('använder årtalet som prefix (nytt år → egen serie)', () => {
    expect(formatContractNumber(2025, 7)).toBe('KONT-2025-00007')
    expect(formatContractNumber(2027, 1)).toBe('KONT-2027-00001')
  })
})

describe('ContractNumberService.allocate', () => {
  const year = new Date().getFullYear()

  function makeService(upsertImpl: jest.Mock) {
    const prisma = { contractNumberSequence: { upsert: upsertImpl } }
    const service = new ContractNumberService(prisma as never)
    return { service, prisma }
  }

  it('första allokeringen i en org → KONT-{år}-00001 via atomisk upsert', async () => {
    const upsert = jest.fn().mockResolvedValue({ lastNumber: 1 })
    const { service } = makeService(upsert)

    const result = await service.allocate('org-1')

    expect(result).toBe(formatContractNumber(year, 1))
    const arg = upsert.mock.calls[0][0]
    expect(arg.where).toEqual({ organizationId_year: { organizationId: 'org-1', year } })
    expect(arg.create).toEqual({ organizationId: 'org-1', year, lastNumber: 1 })
    expect(arg.update).toEqual({ lastNumber: { increment: 1 } })
  })

  it('efterföljande allokering → ökat löpnummer', async () => {
    const upsert = jest.fn().mockResolvedValue({ lastNumber: 2 })
    const { service } = makeService(upsert)
    expect(await service.allocate('org-1')).toBe(formatContractNumber(year, 2))
  })

  it('använder den medskickade transaktionsklienten (samma tx som lease-skapandet)', async () => {
    const txUpsert = jest.fn().mockResolvedValue({ lastNumber: 1 })
    const prismaUpsert = jest.fn()
    const { service } = makeService(prismaUpsert)
    const tx = { contractNumberSequence: { upsert: txUpsert } }

    await service.allocate('org-1', tx as never)

    expect(txUpsert).toHaveBeenCalledTimes(1)
    expect(prismaUpsert).not.toHaveBeenCalled()
  })

  it('nytt kalenderår → upsert nycklas på det nya året (egen serie från 1)', async () => {
    const upsert = jest.fn().mockResolvedValue({ lastNumber: 1 })
    const { service } = makeService(upsert)
    jest.useFakeTimers().setSystemTime(new Date('2027-01-02T00:00:00.000Z'))
    try {
      const result = await service.allocate('org-1')
      expect(result).toBe('KONT-2027-00001')
      expect(upsert.mock.calls[0][0].where).toEqual({
        organizationId_year: { organizationId: 'org-1', year: 2027 },
      })
    } finally {
      jest.useRealTimers()
    }
  })

  it('två olika orgs allokerar oberoende → båda kan få KONT-{år}-00001 (unikt per org)', async () => {
    // Varje orgs sekvensrad är separat (sammansatt PK) → båda startar på 1.
    const upsert = jest.fn().mockResolvedValue({ lastNumber: 1 })
    const { service } = makeService(upsert)

    const a = await service.allocate('org-A')
    const b = await service.allocate('org-B')

    expect(a).toBe(formatContractNumber(year, 1))
    expect(b).toBe(formatContractNumber(year, 1))
    expect(a).toBe(b) // identiskt nummer i två orgs — tillåtet av @@unique([org, contractNumber])
  })
})
