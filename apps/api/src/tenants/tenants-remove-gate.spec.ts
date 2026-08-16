/**
 * Hårdraderingens grind: mäter EXISTENS, inte status.
 *
 * Bakgrunden är mätt, inte resonerad. Den gamla grinden räknade avtal med
 * `status IN ('ACTIVE','DRAFT')` och fakturor med `status NOT IN ('VOID','DRAFT')`.
 * Mot riktig Postgres, med ett avslutat avtal och betalda avier:
 *
 *     grind1_avtal = 0, grind2_fakturor = 0        ← båda släppte igenom
 *     ERROR: violates foreign key constraint "Lease_tenantId_fkey"
 *
 * `P2003` hanteras ingenstans, så användaren fick **500**. 527 av 532
 * hyresgäster i dev (99,1 %) låg i det läget.
 */

import { BadRequestException, NotFoundException } from '@nestjs/common'
import { TenantsService } from './tenants.service'
import { testPersonalNumberService } from '../common/crypto/personal-number.testing'

const TENANT = 'tenant-1'
const ORG = 'org-1'

/**
 * Bygger en prisma-attrapp där varje historik-tabell svarar 0 om inget annat
 * sägs. `counts` anger vilka delegater som ska hitta något.
 */
function setup(opts: { anonymizedAt?: Date | null; counts?: Record<string, number> } = {}) {
  const del = jest.fn().mockResolvedValue({ id: TENANT })
  const counts = opts.counts ?? {}
  /**
   * Attrappen RESPEKTERAR where-klausulen, och det är hela poängen.
   *
   * En attrapp som svarar likadant oavsett filter kan inte skilja "räknar på
   * status" från "räknar på existens" — uppmätt: negativkontrollen som återförde
   * den gamla statusgrinden lämnade testet "ett AVSLUTAT avtal blockerar" GRÖNT
   * innan den här raden fanns. Testet mätte då inte det dess namn påstod.
   *
   * Modellen: hyresgästens historik består av AVSLUTADE poster. En fråga som
   * filtrerar på `status` hittar därför noll — precis som mot riktig Postgres,
   * där grinden gav 0 och FK-villkoret ändå fällde raderingen.
   */
  const delegate = (name: string) => ({
    count: jest.fn(async (args?: { where?: Record<string, unknown> }) => {
      const where = args?.where ?? {}
      if ('status' in where) return 0
      return counts[name] ?? 0
    }),
  })
  const prisma = {
    tenant: {
      findFirst: jest.fn().mockResolvedValue({
        id: TENANT,
        anonymizedAt: opts.anonymizedAt ?? null,
      }),
      delete: del,
    },
    lease: delegate('lease'),
    invoice: delegate('invoice'),
    document: delegate('document'),
    maintenanceTicket: delegate('maintenanceTicket'),
    rentNotice: delegate('rentNotice'),
    inspection: delegate('inspection'),
    sentMessage: delegate('sentMessage'),
    deposit: delegate('deposit'),
    keyHandover: delegate('keyHandover'),
    consumptionCharge: delegate('consumptionCharge'),
    miscCharge: delegate('miscCharge'),
    tenantAnonymizationLog: delegate('tenantAnonymizationLog'),
  }
  const service = new TenantsService(prisma as never, testPersonalNumberService() as never)
  return { service, prisma, del }
}

describe('remove — grinden mäter existens', () => {
  it('ett AVSLUTAT avtal blockerar, precis som FK-villkoret gör', async () => {
    // Kärnfallet. Den gamla grinden såg `status = TERMINATED` och släppte igenom.
    const { service, del } = setup({ counts: { lease: 1 } })

    await expect(service.remove(TENANT, ORG)).rejects.toThrow(BadRequestException)
    expect(del).not.toHaveBeenCalled()
  })

  it('BETALDA avier blockerar — de kontrollerades inte alls tidigare', async () => {
    const { service, del } = setup({ counts: { rentNotice: 3 } })

    await expect(service.remove(TENANT, ORG)).rejects.toThrow(BadRequestException)
    expect(del).not.toHaveBeenCalled()
  })

  it('felet är 400 med orsak och hänvisning — inte 500 med ett FK-fel', async () => {
    const { service } = setup({ counts: { lease: 1, rentNotice: 2 } })

    const err = await service.remove(TENANT, ORG).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(BadRequestException)
    const msg = (err as BadRequestException).message
    // Säger VAD som blockerar …
    expect(msg).toContain('hyresavtal')
    expect(msg).toContain('hyresavier')
    // … och VAD man ska göra i stället. Det är så operatörsvägen blir upptäckt
    // i exakt det ögonblick någon behöver den.
    expect(msg).toContain('avidentifiering')
  })

  it('en redan avidentifierad hyresgäst raderas inte', async () => {
    const { service, del } = setup({ anonymizedAt: new Date('2026-08-16') })

    const err = await service.remove(TENANT, ORG).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(BadRequestException)
    expect((err as BadRequestException).message).toContain('redan avidentifierad')
    expect(del).not.toHaveBeenCalled()
  })

  it('okänd hyresgäst ger 404, inte 400', async () => {
    const { service, prisma } = setup()
    prisma.tenant.findFirst.mockResolvedValue(null)

    await expect(service.remove(TENANT, ORG)).rejects.toThrow(NotFoundException)
  })
})

describe('KANARIEFÅGEL — den legitima raderingen fungerar fortfarande', () => {
  it('en hyresgäst UTAN historik raderas', async () => {
    // Utan det här testet skulle en grind som blockerar allt se helt korrekt ut.
    // Uppmätt: 5 av 532 hyresgäster i dev är i det här läget.
    const { service, del } = setup()

    await expect(service.remove(TENANT, ORG)).resolves.toBeUndefined()
    expect(del).toHaveBeenCalledWith({ where: { id: TENANT } })
  })

  it('varje historik-tabell frågas — ingen hoppas över', async () => {
    const { service, prisma } = setup()
    await service.remove(TENANT, ORG)

    for (const name of [
      'lease',
      'invoice',
      'document',
      'maintenanceTicket',
      'rentNotice',
      'inspection',
      'sentMessage',
      'deposit',
      'keyHandover',
      'consumptionCharge',
      'miscCharge',
    ] as const) {
      expect(prisma[name].count).toHaveBeenCalled()
    }
  })
})
