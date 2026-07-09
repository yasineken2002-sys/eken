/**
 * T1.3 — succession bär följdentiteter + villkor (#42).
 *
 * Bevisar:
 *   A) DMMF-exhaustiveness (fail-closed): VARJE skalärt Lease-fält finns i
 *      exakt EN av LEASE_SUCCESSION_CARRY_FIELDS / LEASE_SUCCESSION_EXCLUDED_
 *      FIELDS. En påhittad ny kolumn utan beslut → testet failar (CI-grind
 *      mot framtida tyst villkorsförlust — samma mönster som edit-låset).
 *   B) renew() bär ALLA villkor via carry-projektionen — inkl. 🔴
 *      monthlyRentExcludingVat (moms, ML 1994:200), consumptionBillingMode
 *      och indexClauseType (fixar indexClause-inkonsekvensen). Explicita
 *      fält (ny hyra, nya datum, nytt kontraktsnummer) skrivs över carry.
 *   C) Deposition re-pekas: ENDAST Deposit.leaseId (org-scopat uppslag),
 *      rentNoticeId/invoiceId rörs ALDRIG (BFL 5:7 + bankmatchning); no-op
 *      när ingen deposition finns.
 *   D) Väntande RentIncrease (DRAFT/NOTICE_SENT/ACCEPTED) → VOIDED med
 *      audit-spår + SYSTEM-notis. Inget repoint-undantag.
 *   E) Validering i renew: sänkt hyra som spränger 3×-depositionstaket nekas
 *      (praxis) — renew saknade tidigare validering helt.
 *   F) autoRenew: compliance-brott → skip + larm, ingen förnyelse.
 *   G) processLifecycle: autoRenew körs HELT före applyDueIncreases
 *      (race-fixen — READ COMMITTED serialiserar inte Promise.all).
 */

jest.mock('../contracts/contract-template.service', () => ({ ContractTemplateService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { Prisma } from '@prisma/client'
import { LEASE_SUCCESSION_CARRY_FIELDS, LEASE_SUCCESSION_EXCLUDED_FIELDS } from '@eken/shared'
import { LeasesService } from './leases.service'

// ── A: DMMF-exhaustiveness (fail-closed) ────────────────────────────────────

// Kastar om ett skalärt fält saknar succession-beslut, om listorna överlappar
// eller om en listpost inte längre finns i schemat (död post).
function assertSuccessionExhaustive(scalarFields: string[]): void {
  const carry = new Set<string>(LEASE_SUCCESSION_CARRY_FIELDS)
  const excluded = new Set<string>(LEASE_SUCCESSION_EXCLUDED_FIELDS)

  const overlap = [...carry].filter((f) => excluded.has(f))
  if (overlap.length > 0) {
    throw new Error(`Fält i BÅDA succession-listorna: ${overlap.join(', ')}`)
  }

  const undecided = scalarFields.filter((f) => !carry.has(f) && !excluded.has(f))
  if (undecided.length > 0) {
    throw new Error(
      `Lease-fält utan succession-beslut: ${undecided.join(', ')}. Lägg fältet i ` +
        'LEASE_SUCCESSION_CARRY_FIELDS (kopieras vid förnyelse) ELLER ' +
        'LEASE_SUCCESSION_EXCLUDED_FIELDS (sätts explicit/utelämnas) i ' +
        '@eken/shared/constants/lease-succession-carry.ts — annars tappas ' +
        'villkoret TYST vid varje förnyelse (jfr moms-fältet, ML 1994:200).',
    )
  }

  const known = new Set(scalarFields)
  const stale = [...carry, ...excluded].filter((f) => !known.has(f))
  if (stale.length > 0) {
    throw new Error(`Döda succession-poster (finns ej i Lease-schemat): ${stale.join(', ')}`)
  }
}

function leaseScalarFieldsFromDmmf(): string[] {
  const model = Prisma.dmmf.datamodel.models.find((m) => m.name === 'Lease')
  if (!model) throw new Error('Lease-modellen hittades inte i DMMF')
  return model.fields.filter((f) => f.kind === 'scalar' || f.kind === 'enum').map((f) => f.name)
}

describe('T1.3 · A: DMMF-exhaustiveness — carry ∪ exclude täcker hela Lease', () => {
  it('verkliga schemat: varje skalärt fält har ett succession-beslut', () => {
    expect(() => assertSuccessionExhaustive(leaseScalarFieldsFromDmmf())).not.toThrow()
  })

  it('carry och exclude är disjunkta och utan döda poster', () => {
    const scalars = leaseScalarFieldsFromDmmf()
    const carry = new Set<string>(LEASE_SUCCESSION_CARRY_FIELDS)
    for (const f of LEASE_SUCCESSION_EXCLUDED_FIELDS) expect(carry.has(f)).toBe(false)
    for (const f of [...LEASE_SUCCESSION_CARRY_FIELDS, ...LEASE_SUCCESSION_EXCLUDED_FIELDS]) {
      expect(scalars).toContain(f)
    }
  })

  it('fail-closed: en påhittad ny kolumn utan beslut → testet failar', () => {
    const withNewColumn = [...leaseScalarFieldsFromDmmf(), 'someBrandNewColumn']
    expect(() => assertSuccessionExhaustive(withNewColumn)).toThrow(
      /someBrandNewColumn.*succession-beslut|utan succession-beslut.*someBrandNewColumn/s,
    )
  })

  it('🔴 moms-fältet och IMD-läget står i carry-listan (regressionslås)', () => {
    expect(LEASE_SUCCESSION_CARRY_FIELDS).toContain('monthlyRentExcludingVat')
    expect(LEASE_SUCCESSION_CARRY_FIELDS).toContain('consumptionBillingMode')
    expect(LEASE_SUCCESSION_CARRY_FIELDS).toContain('indexClauseType')
    expect(LEASE_SUCCESSION_CARRY_FIELDS).toContain('tenancyRegime')
  })
})

// ── Gemensam mock-rigg för renew/autoRenew ──────────────────────────────────

// Ett "gammalt avtal" med distinkta värden på carry-fälten så att en kopiering
// inte kan förväxlas med schema-defaults.
function oldLease(overrides: Record<string, unknown> = {}) {
  return {
    id: 'lease-old',
    organizationId: 'org-1',
    unitId: 'unit-1',
    tenantId: 'tenant-1',
    status: 'ACTIVE',
    leaseType: 'FIXED_TERM',
    renewalPeriodMonths: 12,
    startDate: new Date('2025-07-01'),
    endDate: new Date('2026-06-30'),
    monthlyRent: new Prisma.Decimal(10000),
    monthlyRentExcludingVat: true, // 🔴 momspliktig lokal — får ALDRIG tappas
    depositAmount: new Prisma.Decimal(20000),
    noticePeriodMonths: 9,
    tenancyRegime: 'TENANCY_ACT',
    indexClause: true,
    includesHeating: false, // avviker från default(true)
    includesWater: false,
    includesHotWater: false,
    includesElectricity: true, // avviker från default(false)
    includesInternet: true,
    includesCleaning: false,
    includesParking: true,
    includesStorage: false,
    includesLaundry: false,
    parkingFee: new Prisma.Decimal(750),
    storageFee: null,
    garageFee: null,
    usagePurpose: 'Kontor och lager',
    petsAllowed: 'NOT_ALLOWED',
    petsApprovalNotes: 'Inga husdjur i lokalen',
    sublettingAllowed: true,
    indexClauseType: 'KPI', // fixar inkonsekvensen: typen ska med, inte bara boolen
    indexBaseYear: 2024,
    indexAdjustmentDate: '01-01',
    indexMaxIncrease: new Prisma.Decimal(4),
    indexMinIncrease: new Prisma.Decimal(1),
    indexNotes: 'KPI oktober som bas',
    requiresHomeInsurance: false,
    specialTerms: 'Garageplats 5 ingår',
    contractNumber: 'KONT-2025-00001',
    consumptionBillingMode: 'RENT_NOTICE_LINE',
    activatedAt: new Date('2025-07-01'),
    terminatedAt: null,
    terminationReason: null,
    unit: { type: 'OFFICE', name: 'Lokal 1', property: { name: 'F1' } },
    ...overrides,
  }
}

function makeTx(opts: { deposit?: { id: string } | null; voidedCount?: number } = {}) {
  return {
    lease: {
      update: jest.fn().mockResolvedValue({}),
      create: jest
        .fn()
        .mockResolvedValue({ id: 'lease-new', organizationId: 'org-1', tenantId: 'tenant-1' }),
      count: jest.fn().mockResolvedValue(1),
    },
    unit: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    rentIncrease: {
      updateMany: jest.fn().mockResolvedValue({ count: opts.voidedCount ?? 0 }),
    },
    deposit: {
      findFirst: jest.fn().mockResolvedValue(opts.deposit ?? null),
      update: jest.fn().mockResolvedValue({}),
    },
  }
}

function makeService(args: {
  lease: ReturnType<typeof oldLease>
  tx: ReturnType<typeof makeTx>
  forAutoRenew?: boolean
}) {
  const activationQueue = {
    enqueueGenerateContract: jest.fn().mockResolvedValue('j1'),
    enqueueWelcomeMail: jest.fn().mockResolvedValue('j2'),
    enqueueInitialNotices: jest.fn().mockResolvedValue('j3'),
  }
  const notifications = { createForAllOrgUsers: jest.fn().mockResolvedValue(undefined) }
  const prisma = {
    lease: {
      findFirst: jest.fn().mockResolvedValue(args.lease),
      findMany: jest.fn().mockResolvedValue(args.forAutoRenew ? [args.lease] : []),
    },
    $transaction: jest.fn((cb: (t: unknown) => unknown) => cb(args.tx)),
  }
  const contractNumbers = { allocate: jest.fn().mockResolvedValue('KONT-2026-00002') }
  const noop = {} as never
  const service = new LeasesService(
    prisma as never,
    notifications as never,
    noop, // deposits
    noop, // rentIncreases
    noop, // tenantAuth
    noop, // contracts
    contractNumbers as never,
    activationQueue as never,
  )
  return { service, prisma, notifications, activationQueue }
}

// ── B: carry-projektion i renew ─────────────────────────────────────────────

describe('T1.3 · B: renew() bär ALLA villkor via carry-projektionen', () => {
  it('kopierar moms-flaggan, IMD-läget, indexClauseType + övriga villkor; explicit hyra/datum vinner', async () => {
    const lease = oldLease()
    const tx = makeTx()
    const { service } = makeService({ lease, tx })

    await service.renew('lease-old', { monthlyRent: 11000 } as never, 'org-1')

    const data = tx.lease.create.mock.calls[0]![0].data as Record<string, unknown>

    // 🔴 CRITICAL moms: utan denna slutar en momspliktig lokal tyst ta ut 2611
    expect(data['monthlyRentExcludingVat']).toBe(true)
    // Övriga carry-fält — distinkta värden ≠ schema-defaults
    expect(data['consumptionBillingMode']).toBe('RENT_NOTICE_LINE')
    expect(data['indexClauseType']).toBe('KPI')
    expect(data['indexClause']).toBe(true)
    expect(data['indexBaseYear']).toBe(2024)
    expect(data['includesHeating']).toBe(false)
    expect(data['includesElectricity']).toBe(true)
    expect(data['parkingFee']).toEqual(lease.parkingFee)
    expect(data['usagePurpose']).toBe('Kontor och lager')
    expect(data['specialTerms']).toBe('Garageplats 5 ingår')
    expect(data['tenancyRegime']).toBe('TENANCY_ACT')
    expect(data['noticePeriodMonths']).toBe(9)
    expect(data['depositAmount']).toEqual(lease.depositAmount)
    expect(data['petsApprovalNotes']).toBe('Inga husdjur i lokalen')

    // Explicita fält skrivs EFTER spreaden och vinner
    expect(data['monthlyRent']).toBe(11000)
    expect(data['status']).toBe('ACTIVE')
    expect(data['contractNumber']).toBe('KONT-2026-00002')
    expect((data['startDate'] as Date).toISOString().slice(0, 10)).toBe('2026-07-01')
    // Excluded-fält läcker INTE med från gamla raden
    expect(data['id']).toBeUndefined()
    expect(data['terminatedAt']).toBeUndefined()
    expect(data['createdAt']).toBeUndefined()
  })

  it('varje fält i carry-listan finns med i create-datat (ingen tyst lucka)', async () => {
    const lease = oldLease()
    const tx = makeTx()
    const { service } = makeService({ lease, tx })

    await service.renew('lease-old', {} as never, 'org-1')

    const data = tx.lease.create.mock.calls[0]![0].data as Record<string, unknown>
    for (const field of LEASE_SUCCESSION_CARRY_FIELDS) {
      expect(Object.prototype.hasOwnProperty.call(data, field)).toBe(true)
      expect(data[field]).toEqual((lease as Record<string, unknown>)[field])
    }
  })
})

// ── C: deposition re-pekas ──────────────────────────────────────────────────

describe('T1.3 · C: depositionen re-pekas till det nya avtalet', () => {
  it('org-scopat uppslag; ENDAST leaseId skrivs — aldrig rentNoticeId/invoiceId/amount', async () => {
    const tx = makeTx({ deposit: { id: 'dep-1' } })
    const { service } = makeService({ lease: oldLease(), tx })

    await service.renew('lease-old', {} as never, 'org-1')

    expect(tx.deposit.findFirst).toHaveBeenCalledWith({
      where: { leaseId: 'lease-old', organizationId: 'org-1' },
      select: { id: true },
    })
    expect(tx.deposit.update).toHaveBeenCalledTimes(1)
    const call = tx.deposit.update.mock.calls[0]![0]
    expect(call.where).toEqual({ id: 'dep-1' })
    // BFL 5:7 + bankmatchning: verifikat-underlaget får ALDRIG flyttas
    expect(Object.keys(call.data)).toEqual(['leaseId'])
    expect(call.data.leaseId).toBe('lease-new')
  })

  it('no-op när ingen deposition finns (depositAmount 0 → ingen rad)', async () => {
    const tx = makeTx({ deposit: null })
    const { service } = makeService({ lease: oldLease(), tx })

    await service.renew('lease-old', {} as never, 'org-1')

    expect(tx.deposit.update).not.toHaveBeenCalled()
  })
})

// ── D: väntande hyreshöjningar VOIDas ───────────────────────────────────────

describe('T1.3 · D: väntande RentIncrease → VOIDED + audit + notis', () => {
  it('VOIDar DRAFT/NOTICE_SENT/ACCEPTED på gamla avtalet med voidedAt/voidReason', async () => {
    const tx = makeTx({ voidedCount: 2 })
    const { service, notifications } = makeService({ lease: oldLease(), tx })

    await service.renew('lease-old', {} as never, 'org-1')

    expect(tx.rentIncrease.updateMany).toHaveBeenCalledTimes(1)
    const call = tx.rentIncrease.updateMany.mock.calls[0]![0]
    expect(call.where).toEqual({
      leaseId: 'lease-old',
      organizationId: 'org-1',
      status: { in: ['DRAFT', 'NOTICE_SENT', 'ACCEPTED'] },
    })
    expect(call.data.status).toBe('VOIDED')
    expect(call.data.voidedAt).toBeInstanceOf(Date)
    expect(call.data.voidReason).toMatch(/förnyade|ersatta avtalet/)
    expect(call.data.voidReason).toMatch(/JB 12 kap 19 §/)

    // Post-commit-larm: hyresvärden måste registrera om höjningen
    expect(notifications.createForAllOrgUsers).toHaveBeenCalledWith(
      'org-1',
      'SYSTEM',
      'Hyreshöjning annullerad vid förnyelse',
      expect.stringContaining('2 väntande hyreshöjningar'),
      { relatedEntityType: 'LEASE', relatedEntityId: 'lease-new' },
    )
  })

  it('ingen notis när inga höjningar fanns att VOIDa', async () => {
    const tx = makeTx({ voidedCount: 0 })
    const { service, notifications } = makeService({ lease: oldLease(), tx })

    await service.renew('lease-old', {} as never, 'org-1')

    expect(notifications.createForAllOrgUsers).not.toHaveBeenCalled()
  })
})

// ── E: validering i renew ───────────────────────────────────────────────────

describe('T1.3 · E: renew() återvaliderar tvingande regler', () => {
  it('sänkt hyra som spränger 3×-depositionstaket (bostad) nekas', async () => {
    // Bostad: hyra 10 000, deposition 20 000 (OK: tak 30 000). Ny hyra 5 000
    // → tak 15 000 < 20 000 → praxis-brott.
    const lease = oldLease({
      unit: { type: 'APARTMENT', name: 'A1', property: { name: 'F1' } },
      noticePeriodMonths: 3,
    })
    const tx = makeTx()
    const { service } = makeService({ lease, tx })

    await expect(
      service.renew('lease-old', { monthlyRent: 5000 } as never, 'org-1'),
    ).rejects.toThrow(/3 månadshyror/)
    expect(tx.lease.create).not.toHaveBeenCalled()
  })
})

// ── F: autoRenew compliance-block ───────────────────────────────────────────

describe('T1.3 · F: autoRenew skippar + larmar vid compliance-brott', () => {
  it('lagstridig uppsägningstid → ingen förnyelse, SYSTEM-notis', async () => {
    const lease = oldLease({
      unit: { type: 'APARTMENT', name: 'A1', property: { name: 'F1' } },
      noticePeriodMonths: 1, // < 3 mån-golvet för bostad (JB 12:4)
      endDate: new Date('2026-01-01'),
    })
    const tx = makeTx()
    const { service, prisma, notifications } = makeService({ lease, tx, forAutoRenew: true })

    const renewed = await (
      service as unknown as { autoRenewExpiredFixedTerm: (d: Date) => Promise<number> }
    ).autoRenewExpiredFixedTerm(new Date('2026-06-01'))

    expect(renewed).toBe(0)
    expect(prisma.$transaction).not.toHaveBeenCalled()
    expect(notifications.createForAllOrgUsers).toHaveBeenCalledWith(
      'org-1',
      'SYSTEM',
      'Auto-förnyelse blockerad',
      expect.stringContaining('kunde inte förnyas automatiskt'),
      { relatedEntityType: 'LEASE', relatedEntityId: 'lease-old' },
    )
  })

  it('giltigt avtal förnyas med carry + succession-sideeffects', async () => {
    const lease = oldLease({ endDate: new Date('2026-01-01') })
    const tx = makeTx({ deposit: { id: 'dep-1' }, voidedCount: 1 })
    const { service, notifications } = makeService({ lease, tx, forAutoRenew: true })

    const renewed = await (
      service as unknown as { autoRenewExpiredFixedTerm: (d: Date) => Promise<number> }
    ).autoRenewExpiredFixedTerm(new Date('2026-06-01'))

    expect(renewed).toBe(1)
    const data = tx.lease.create.mock.calls[0]![0].data as Record<string, unknown>
    expect(data['monthlyRentExcludingVat']).toBe(true)
    expect(data['indexClauseType']).toBe('KPI')
    expect(tx.deposit.update).toHaveBeenCalledWith({
      where: { id: 'dep-1' },
      data: { leaseId: 'lease-new' },
    })
    expect(tx.rentIncrease.updateMany).toHaveBeenCalledTimes(1)
    expect(notifications.createForAllOrgUsers).toHaveBeenCalledWith(
      'org-1',
      'SYSTEM',
      'Hyreshöjning annullerad vid förnyelse',
      expect.stringContaining('1 väntande hyreshöjning'),
      expect.anything(),
    )
  })
})

// ── G: processLifecycle serialiserar autoRenew före applyDueIncreases ──────

describe('T1.3 · G: autoRenew körs HELT före applyDueIncreases', () => {
  it('applyDueIncreases startar först när autoRenew är färdig', async () => {
    const sequence: string[] = []
    const noop = {} as never
    const deposits = {
      remindStaleRefundPending: jest.fn().mockResolvedValue(0),
      sweepTerminatedLeasesForRefundPending: jest.fn().mockResolvedValue(0),
    }
    const rentIncreases = {
      applyDueIncreases: jest.fn().mockImplementation(async () => {
        sequence.push('apply:start')
        return 0
      }),
    }
    const service = new LeasesService(
      noop, // prisma — nås inte, alla delsteg spy:as
      noop,
      deposits as never,
      rentIncreases as never,
      noop,
      noop,
      noop,
      noop,
    )
    jest
      .spyOn(
        service as never as { autoRenewExpiredFixedTerm: () => Promise<number> },
        'autoRenewExpiredFixedTerm',
      )
      .mockImplementation(async () => {
        sequence.push('renew:start')
        // Simulera långsam förnyelse — utan serialisering hinner apply före
        await new Promise((r) => setTimeout(r, 20))
        sequence.push('renew:done')
        return 1
      })
    jest
      .spyOn(
        service as never as { sendExpiryReminders: () => Promise<number> },
        'sendExpiryReminders',
      )
      .mockResolvedValue(0)
    jest
      .spyOn(
        service as never as { terminateExpiredNoticeLeases: () => Promise<number> },
        'terminateExpiredNoticeLeases',
      )
      .mockResolvedValue(0)

    await service.processLifecycle()

    expect(sequence).toEqual(['renew:start', 'renew:done', 'apply:start'])
  })
})
