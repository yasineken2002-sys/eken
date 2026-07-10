/**
 * T1.1a — edit-lås på ACTIVE-avtal (leases.service.update).
 *
 * Rotmönster (Svep 3, #40/#49/#57/#52a): PATCH /leases/:id lät en administratör
 * ändra bindande fält på ett LÖPANDE avtal utan att gå via rätt domänflöde —
 * #40: fri monthlyRent-edit kringgår hela hyreshöjningslagen (varsel + invändning).
 *
 * Låset ligger i service-lagret (alla anropare täcks) och nekar en FAKTISK ändring
 * av ett Tier-1-fält när status === ACTIVE. DRAFT är helt undantaget.
 *
 * Bevisar:
 *   A) Per Tier-1-fält: ändrad på ACTIVE → nekas (400, ingen skrivning);
 *      samma fält ändrad på DRAFT → tillåts (skrivning sker).
 *   B) KOMPARATORN (största regressionsrisken): oförändrat värde på ACTIVE släpps
 *      igenom — inkl. Decimal-echo (number vs Prisma.Decimal), datum-echo,
 *      tom-sträng/null-coalescing, full web-resubmit av hela objektet.
 *   C) null-to-clear-semantik speglar write-site (nullbar avgift: null ignoreras
 *      tyst → ingen falsk 400; specialTerms: null nollar → ÄR en ändring → nekas).
 *   D) Aggregering: flera låsta fält i ett anrop → ETT svar som listar ALLA.
 *   E) Fria annotationer (indexNotes, petsApprovalNotes) redigerbara på ACTIVE.
 *   F) Identitetslås körs FÖRE IDOR-uppslaget (ingen unit/tenant-findFirst när nekat).
 *   G) tenancyRegime är inert (skrivs inte av update() idag).
 */

jest.mock('../contracts/contract-template.service', () => ({ ContractTemplateService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { Decimal } from '@prisma/client/runtime/library'
import { LEASE_ACTIVE_LOCKED_FIELDS, LEASE_LOCK_FIELD_ROUTE } from '@eken/shared'
import { LeasesService, TIER1_LOCKED_ON_ACTIVE } from './leases.service'

function baseLease(overrides: Record<string, unknown> = {}) {
  return {
    id: 'lease-1',
    status: 'ACTIVE',
    organizationId: 'org-1',
    unitId: 'unit-1',
    tenantId: 'tenant-1',
    leaseType: 'INDEFINITE',
    noticePeriodMonths: 3,
    renewalPeriodMonths: null,
    startDate: new Date('2026-01-01'),
    endDate: new Date('2027-01-01'),
    monthlyRent: new Decimal('10000.00'),
    depositAmount: new Decimal('20000.00'),
    parkingFee: new Decimal('500.00'),
    storageFee: null,
    garageFee: null,
    includesHeating: true,
    includesWater: true,
    includesHotWater: true,
    includesElectricity: false,
    includesInternet: false,
    includesCleaning: false,
    includesParking: false,
    includesStorage: false,
    includesLaundry: true,
    usagePurpose: 'Bostad',
    petsAllowed: 'REQUIRES_APPROVAL',
    petsApprovalNotes: null,
    sublettingAllowed: false,
    requiresHomeInsurance: true,
    indexClauseType: 'NONE',
    indexBaseYear: null,
    indexAdjustmentDate: null,
    indexMaxIncrease: null,
    indexMinIncrease: null,
    indexNotes: null,
    specialTerms: null,
    tenancyRegime: 'TENANCY_ACT',
    unit: { type: 'APARTMENT', name: 'A1', property: { name: 'Fastighet 1' } },
    ...overrides,
  }
}

function makeService(overrides: Record<string, unknown> = {}) {
  const lease = baseLease(overrides)
  const prisma = {
    lease: {
      findFirst: jest.fn().mockResolvedValue(lease),
      update: jest.fn().mockResolvedValue({ id: 'lease-1', unit: lease.unit }),
    },
    // IDOR-uppslag (bara relevanta på DRAFT där identitet får ändras)
    unit: { findFirst: jest.fn().mockResolvedValue({ type: 'APARTMENT' }) },
    tenant: { findFirst: jest.fn().mockResolvedValue({ id: 'tenant-2' }) },
  }
  const noop = {} as never
  const service = new LeasesService(
    prisma as never,
    noop, // notifications
    noop, // deposits
    noop, // rentIncreases
    noop, // tenantAuth
    noop, // contracts
    noop, // contractNumbers
    noop, // activationQueue
  )
  return { service, prisma }
}

// Tier-1-fält + ett ÄNDRAT värde (nedströms-giltigt på DRAFT: notis>=3, deposit<cap,
// unit/tenant finns). Varje rad testas: nekad på ACTIVE, tillåten på DRAFT.
const TIER1_CHANGES: Array<[field: string, value: unknown]> = [
  ['monthlyRent', 11000],
  ['parkingFee', 600],
  ['storageFee', 100], // null → satt
  ['garageFee', 100],
  ['startDate', '2026-02-01'],
  ['unitId', 'unit-2'],
  ['tenantId', 'tenant-2'],
  ['depositAmount', 25000], // < 3× hyra (30000)
  ['leaseType', 'FIXED_TERM'],
  ['noticePeriodMonths', 6], // >= min 3
  ['renewalPeriodMonths', 12], // null → satt
  ['includesHeating', false],
  ['includesWater', false],
  ['includesHotWater', false],
  ['includesElectricity', true],
  ['includesInternet', true],
  ['includesCleaning', true],
  ['includesParking', true],
  ['includesStorage', true],
  ['includesLaundry', false],
  ['usagePurpose', 'Kontor'],
  ['sublettingAllowed', true],
  ['requiresHomeInsurance', false],
  ['petsAllowed', 'ALLOWED'],
  ['indexClauseType', 'KPI'],
  ['indexBaseYear', 2026],
  ['indexAdjustmentDate', '01-01'],
  ['indexMaxIncrease', 5],
  ['indexMinIncrease', 1],
  ['specialTerms', 'Ny särskild bestämmelse'],
]

// Synk-kontrakt mot @eken/shared (frontend-låset, T1.1d). Om backend-arrayen och
// den delade listan glider isär → 400-vägg eller falskt låst fält i UI. Bryt CI.
describe('T1.1a · backend↔@eken/shared synk (frontend-lås)', () => {
  it('TIER1_LOCKED_ON_ACTIVE-nycklarna == LEASE_ACTIVE_LOCKED_FIELDS', () => {
    const backend = [...TIER1_LOCKED_ON_ACTIVE].map((s) => s.key as string).sort()
    const shared = [...LEASE_ACTIVE_LOCKED_FIELDS].sort()
    expect(backend).toEqual(shared)
  })

  it('per-fält-route matchar mellan backend och @eken/shared', () => {
    for (const spec of TIER1_LOCKED_ON_ACTIVE) {
      expect(LEASE_LOCK_FIELD_ROUTE[spec.key as string]).toBe(spec.route)
    }
  })
})

describe('T1.1a · Tier-1-fält nekas på ACTIVE, tillåts på DRAFT', () => {
  it.each(TIER1_CHANGES)(
    'ACTIVE + ändrat %s → NEKAS (400), ingen skrivning',
    async (field, value) => {
      const { service, prisma } = makeService()
      await expect(service.update('lease-1', { [field]: value } as never, 'org-1')).rejects.toThrow(
        /kan inte ändras på ett aktivt kontrakt/,
      )
      expect(prisma.lease.update).not.toHaveBeenCalled()
    },
  )

  it.each(TIER1_CHANGES)('DRAFT + ändrat %s → TILLÅTS (skrivning sker)', async (field, value) => {
    const { service, prisma } = makeService({ status: 'DRAFT' })
    await service.update('lease-1', { [field]: value } as never, 'org-1')
    expect(prisma.lease.update).toHaveBeenCalledTimes(1)
  })
})

// T1.3b: på DRAFT (ett original — successors skapas direkt ACTIVE) speglar
// startDate-ändringen kontinuitetsmarkören så ett oförnyat avtals förhållande
// alltid börjar exakt vid dess startDate. På ACTIVE är startDate låst → markören
// kan aldrig krympas via update().
describe('T1.3b · update() speglar tenancyStartDate med startDate på DRAFT', () => {
  it('DRAFT + ändrat startDate → tenancyStartDate skrivs till SAMMA datum', async () => {
    const { service, prisma } = makeService({ status: 'DRAFT' })
    await service.update('lease-1', { startDate: '2026-02-01' } as never, 'org-1')
    const data = prisma.lease.update.mock.calls[0]![0].data as Record<string, unknown>
    expect(data['startDate']).toEqual(new Date('2026-02-01'))
    expect(data['tenancyStartDate']).toEqual(new Date('2026-02-01'))
  })

  it('DRAFT utan startDate i payloaden → tenancyStartDate rörs inte', async () => {
    const { service, prisma } = makeService({ status: 'DRAFT' })
    await service.update('lease-1', { monthlyRent: 11000 } as never, 'org-1')
    const data = prisma.lease.update.mock.calls[0]![0].data as Record<string, unknown>
    expect(Object.prototype.hasOwnProperty.call(data, 'tenancyStartDate')).toBe(false)
  })
})

describe('T1.1a · komparatorn — oförändrat värde på ACTIVE släpps igenom', () => {
  it('Decimal-echo: oförändrad monthlyRent (10000, number vs Prisma.Decimal) → 200', async () => {
    const { service, prisma } = makeService()
    await service.update('lease-1', { monthlyRent: 10000 } as never, 'org-1')
    expect(prisma.lease.update).toHaveBeenCalledTimes(1)
  })

  it('Decimal-echo: oförändrad parkingFee (500) → 200', async () => {
    const { service, prisma } = makeService()
    await service.update('lease-1', { parkingFee: 500 } as never, 'org-1')
    expect(prisma.lease.update).toHaveBeenCalledTimes(1)
  })

  it('datum-echo: oförändrat startDate (2026-01-01) → 200', async () => {
    const { service, prisma } = makeService()
    await service.update('lease-1', { startDate: '2026-01-01' } as never, 'org-1')
    expect(prisma.lease.update).toHaveBeenCalledTimes(1)
  })

  it('enum/bool/int-echo: oförändrade leaseType/includesHeating/noticePeriodMonths → 200', async () => {
    const { service, prisma } = makeService()
    await service.update(
      'lease-1',
      { leaseType: 'INDEFINITE', includesHeating: true, noticePeriodMonths: 3 } as never,
      'org-1',
    )
    expect(prisma.lease.update).toHaveBeenCalledTimes(1)
  })

  it('full web-resubmit av HELA det oförändrade objektet på ACTIVE → 200 (ingen falsk 400)', async () => {
    const { service, prisma } = makeService()
    // Efterliknar web-formuläret: skickar tillbaka varje fält med nuvarande värde
    // (Decimals som number, datum som YYYY-MM-DD). Får INTE blockeras.
    await service.update(
      'lease-1',
      {
        monthlyRent: 10000,
        parkingFee: 500,
        depositAmount: 20000,
        startDate: '2026-01-01',
        unitId: 'unit-1',
        tenantId: 'tenant-1',
        leaseType: 'INDEFINITE',
        noticePeriodMonths: 3,
        includesHeating: true,
        includesWater: true,
        includesLaundry: true,
        usagePurpose: 'Bostad',
        petsAllowed: 'REQUIRES_APPROVAL',
        sublettingAllowed: false,
        requiresHomeInsurance: true,
        indexClauseType: 'NONE',
      } as never,
      'org-1',
    )
    expect(prisma.lease.update).toHaveBeenCalledTimes(1)
  })
})

describe('T1.1a · coalescing + null-to-clear (speglar write-site-gates)', () => {
  it('tom sträng indexAdjustmentDate mot lagrad null → 200 (|| null-coalescing, ingen falsk 400)', async () => {
    const { service, prisma } = makeService() // existing.indexAdjustmentDate = null
    await service.update('lease-1', { indexAdjustmentDate: '' } as never, 'org-1')
    expect(prisma.lease.update).toHaveBeenCalledTimes(1)
  })

  it('tom sträng usagePurpose mot lagrat "Bostad" → NEKAS (nollar ett satt fält = ändring)', async () => {
    const { service, prisma } = makeService()
    await expect(service.update('lease-1', { usagePurpose: '' } as never, 'org-1')).rejects.toThrow(
      /kan inte ändras/,
    )
    expect(prisma.lease.update).not.toHaveBeenCalled()
  })

  it('null parkingFee (nullbar avgift, satt till 500) → 200 (write-site !=null ignorerar null tyst)', async () => {
    const { service, prisma } = makeService()
    // pickContractTerms skriver bara parkingFee när != null → ett null är en no-op,
    // alltså ingen faktisk ändring → låset ska INTE ge falsk 400.
    await service.update('lease-1', { parkingFee: null } as never, 'org-1')
    expect(prisma.lease.update).toHaveBeenCalledTimes(1)
  })

  it('specialTerms: null mot lagrad text → NEKAS (nollar operativ avtalstext = ändring)', async () => {
    const { service, prisma } = makeService({ specialTerms: 'Befintlig klausul' })
    await expect(
      service.update('lease-1', { specialTerms: null } as never, 'org-1'),
    ).rejects.toThrow(/kan inte ändras/)
    expect(prisma.lease.update).not.toHaveBeenCalled()
  })

  it('specialTerms: whitespace-only mot lagrad null → 200 (trim → null, ingen ändring)', async () => {
    const { service, prisma } = makeService() // existing.specialTerms = null
    await service.update('lease-1', { specialTerms: '   ' } as never, 'org-1')
    expect(prisma.lease.update).toHaveBeenCalledTimes(1)
  })
})

describe('T1.1a · aggregering, fria fält, IDOR-ordning, inerta fält', () => {
  it('flera låsta fält i ett anrop → ETT svar som listar ALLA (aggregerat)', async () => {
    const { service } = makeService()
    let msg = ''
    try {
      await service.update(
        'lease-1',
        { monthlyRent: 12000, noticePeriodMonths: 6, sublettingAllowed: true } as never,
        'org-1',
      )
    } catch (e) {
      msg = (e as Error).message
    }
    expect(msg).toMatch(/Månadshyra/)
    expect(msg).toMatch(/Uppsägningstid/)
    expect(msg).toMatch(/Andrahandsuthyrning/)
    // Både hyresväg- och villkors-hänvisning finns med i samma svar
    expect(msg).toMatch(/hyreshöjningsflödet/)
    expect(msg).toMatch(/skriftligt tillägg/)
  })

  it('hyre-hänvisning: monthlyRent-ändring pekar mot hyreshöjningsflödet', async () => {
    const { service } = makeService()
    await expect(
      service.update('lease-1', { monthlyRent: 12000 } as never, 'org-1'),
    ).rejects.toThrow(/hyreshöjningsflödet/)
  })

  it('identitets-hänvisning: unitId-byte pekar mot nytt kontrakt (förnyelse)', async () => {
    const { service } = makeService()
    await expect(service.update('lease-1', { unitId: 'unit-9' } as never, 'org-1')).rejects.toThrow(
      /nytt kontrakt/,
    )
  })

  it('fria annotationer (indexNotes, petsApprovalNotes) redigerbara på ACTIVE → 200', async () => {
    const { service, prisma } = makeService()
    await service.update(
      'lease-1',
      { indexNotes: 'Notering om index', petsApprovalNotes: 'Katt godkänd' } as never,
      'org-1',
    )
    expect(prisma.lease.update).toHaveBeenCalledTimes(1)
  })

  it('identitetslås körs FÖRE IDOR-uppslaget: nekat tenantId-byte på ACTIVE → ingen tenant.findFirst', async () => {
    const { service, prisma } = makeService()
    await expect(
      service.update('lease-1', { tenantId: 'tenant-2' } as never, 'org-1'),
    ).rejects.toThrow(/kan inte ändras/)
    expect(prisma.tenant.findFirst).not.toHaveBeenCalled()
    expect(prisma.unit.findFirst).not.toHaveBeenCalled()
  })

  it('tenancyRegime är inert: ändring på ACTIVE ger varken 400 eller regim-skrivning', async () => {
    const { service, prisma } = makeService()
    // Fältet skrivs inte av update() idag (ej i spread/pickContractTerms) → varken
    // låst (ej i Tier-1-listan) eller applicerat. En framtida regim-edit-seam (#69)
    // måste gå via update() och läggas i låset då.
    await service.update('lease-1', { tenancyRegime: 'PRIVATE_RENTAL' } as never, 'org-1')
    expect(prisma.lease.update).toHaveBeenCalledTimes(1)
    const data = (prisma.lease.update.mock.calls[0]![0] as { data: Record<string, unknown> }).data
    expect(data.tenancyRegime).toBeUndefined()
  })
})
