/**
 * Teknisk förvaltning · Spår A PR 3 — MiscChargeService orchestrering.
 *
 * Täcker: confirm (4 utfall), cancel DRAFT (utan verifikat), cancel CONFIRMED
 * (med motverifikat), idempotent dubbel-cancel, create (fryst momssnapshot +
 * ticket-claim), XOR-guard, samt RBAC på controllern.
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import type { ExecutionContext } from '@nestjs/common'
import { RolesGuard } from '../common/guards/roles.guard'
import { MiscChargeService } from './misc-charge.service'
import { MiscChargeController } from './misc-charge.controller'
import { assertRentNoticeLineChargeXor } from './misc-charge.xor'

type Status = 'DRAFT' | 'CONFIRMED' | 'ATTACHED' | 'CANCELLED'

interface ChargeState {
  id: string
  organizationId: string
  status: Status
  netAmount: number
  vatStatus: string
  vatRate: number
  vatAmount: number
  totalAmount: number
}

function makeService(charge: ChargeState | null) {
  const state = charge ? { ...charge } : null

  const miscCharge = {
    // Stateful: speglar villkorad updateMany (status i where).
    findFirst: jest.fn(() => Promise.resolve(state ? { ...state } : null)),
    updateMany: jest.fn(
      ({ where, data }: { where: { status?: Status }; data: { status: Status } }) => {
        if (state && (where.status === undefined || state.status === where.status)) {
          state.status = data.status
          return Promise.resolve({ count: 1 })
        }
        return Promise.resolve({ count: 0 })
      },
    ),
    create: jest.fn(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({ id: 'mc-new', ...data }),
    ),
  }
  const maintenanceTicket = {
    findFirst: jest.fn().mockResolvedValue({ id: 'ticket-1', chargeId: null }),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
  }
  const lease = { findFirst: jest.fn().mockResolvedValue({ id: 'lease-1' }) }
  const tenant = { findFirst: jest.fn().mockResolvedValue({ id: 'tenant-1' }) }

  const prisma: Record<string, unknown> = { miscCharge, maintenanceTicket, lease, tenant }
  prisma.$transaction = jest.fn((cb: (tx: unknown) => unknown) => cb(prisma))

  const accounting = {
    createJournalEntryForMiscCharge: jest.fn(),
    reverseJournalEntryForMiscCharge: jest.fn().mockResolvedValue(undefined),
  }

  const service = new MiscChargeService(prisma as never, accounting as never)
  return { service, prisma, accounting, miscCharge, maintenanceTicket, lease, tenant, state }
}

const baseCharge: ChargeState = {
  id: 'mc-1',
  organizationId: 'org-1',
  status: 'DRAFT',
  netAmount: 800,
  vatStatus: 'EXEMPT',
  vatRate: 0,
  vatAmount: 0,
  totalAmount: 800,
}

const createDto = {
  leaseId: 'lease-1',
  tenantId: 'tenant-1',
  sourceType: 'MAINTENANCE_TICKET' as const,
  sourceRefId: 'ticket-1',
  description: 'Krossad ruta',
  incidentDate: '2026-04-15',
  netAmount: 800,
}

// ── createMiscCharge ─────────────────────────────────────────────────────────

describe('createMiscCharge', () => {
  it('fryser momssnapshot EXEMPT v1 (vat 0, total = netto) och status DRAFT', async () => {
    const { service, miscCharge } = makeService(null)
    await service.createMiscCharge(createDto, 'org-1')
    const data = miscCharge.create.mock.calls[0]![0].data as Record<string, unknown>
    expect(data.vatStatus).toBe('EXEMPT')
    expect(data.vatRate).toBe(0)
    expect(data.vatAmount).toBe(0)
    expect(data.totalAmount).toBe(800)
    expect(data.status).toBe('DRAFT')
    expect(data.incidentDate).toEqual(new Date('2026-04-15'))
  })

  it('claim:ar MaintenanceTicket.chargeId (en debitering per ärende)', async () => {
    const { service, maintenanceTicket } = makeService(null)
    await service.createMiscCharge(createDto, 'org-1')
    expect(maintenanceTicket.updateMany).toHaveBeenCalledWith({
      where: { id: 'ticket-1', organizationId: 'org-1', chargeId: null },
      data: { chargeId: 'mc-new' },
    })
  })

  it('redan debiterat ärende → ConflictException', async () => {
    const { service, maintenanceTicket } = makeService(null)
    maintenanceTicket.findFirst.mockResolvedValueOnce({ id: 'ticket-1', chargeId: 'mc-old' })
    await expect(service.createMiscCharge(createDto, 'org-1')).rejects.toThrow(ConflictException)
  })

  it('okänt lease i org → NotFound', async () => {
    const { service, lease } = makeService(null)
    lease.findFirst.mockResolvedValueOnce(null)
    await expect(service.createMiscCharge(createDto, 'org-1')).rejects.toThrow(NotFoundException)
  })
})

// ── confirmMiscCharge: fyra utfall ───────────────────────────────────────────

describe('confirmMiscCharge — fyra utfall', () => {
  it('entry returneras (ny/idempotent) → bokförd, ingen egen statusflipp', async () => {
    const { service, accounting, miscCharge } = makeService({ ...baseCharge, status: 'CONFIRMED' })
    accounting.createJournalEntryForMiscCharge.mockResolvedValueOnce({ id: 'je-1' })
    const result = await service.confirmMiscCharge('mc-1', 'org-1', 'user-9')
    expect(result.status).toBe('CONFIRMED')
    // confirm flippar ALDRIG status själv (PR 2:s metod äger flippen).
    expect(miscCharge.updateMany).not.toHaveBeenCalled()
  })

  it('accounting kastar NotFound (okänd post) → propageras', async () => {
    const { service, accounting } = makeService(null)
    accounting.createJournalEntryForMiscCharge.mockRejectedValueOnce(new NotFoundException())
    await expect(service.confirmMiscCharge('mc-x', 'org-1', 'user-9')).rejects.toThrow(
      NotFoundException,
    )
  })

  it('accounting kastar BadRequest (CANCELLED) → propageras', async () => {
    const { service, accounting } = makeService({ ...baseCharge, status: 'CANCELLED' })
    accounting.createJournalEntryForMiscCharge.mockRejectedValueOnce(new BadRequestException())
    await expect(service.confirmMiscCharge('mc-1', 'org-1', 'user-9')).rejects.toThrow(
      BadRequestException,
    )
  })

  it('null (saknat konto/total≤0) → UnprocessableEntity, inte tyst', async () => {
    const { service, accounting } = makeService(baseCharge)
    accounting.createJournalEntryForMiscCharge.mockResolvedValueOnce(null)
    await expect(service.confirmMiscCharge('mc-1', 'org-1', 'user-9')).rejects.toThrow(
      UnprocessableEntityException,
    )
  })
})

// ── cancelMiscCharge ─────────────────────────────────────────────────────────

describe('cancelMiscCharge', () => {
  it('DRAFT → CANCELLED utan motverifikat (inget original att backa)', async () => {
    const { service, accounting, miscCharge, state } = makeService({
      ...baseCharge,
      status: 'DRAFT',
    })
    const result = await service.cancelMiscCharge('mc-1', 'org-1', 'user-9')
    expect(accounting.reverseJournalEntryForMiscCharge).not.toHaveBeenCalled()
    expect(miscCharge.updateMany).toHaveBeenCalledWith({
      where: { id: 'mc-1', organizationId: 'org-1', status: 'DRAFT' },
      data: { status: 'CANCELLED' },
    })
    expect(result.status).toBe('CANCELLED')
    expect(state?.status).toBe('CANCELLED')
  })

  it('CONFIRMED → motverifikat FÖRST, sedan status, atomiskt', async () => {
    const { service, accounting, miscCharge } = makeService({ ...baseCharge, status: 'CONFIRMED' })
    const result = await service.cancelMiscCharge('mc-1', 'org-1', 'user-9')
    expect(accounting.reverseJournalEntryForMiscCharge).toHaveBeenCalledWith(
      'mc-1',
      'org-1',
      'user-9',
      expect.anything(), // tx (atomiskt)
    )
    expect(miscCharge.updateMany).toHaveBeenCalledWith({
      where: { id: 'mc-1', organizationId: 'org-1', status: 'CONFIRMED' },
      data: { status: 'CANCELLED' },
    })
    expect(result.status).toBe('CANCELLED')
  })

  it('idempotent: andra cancel på redan CANCELLED → no-op (inget andra motverifikat)', async () => {
    const { service, accounting, miscCharge } = makeService({ ...baseCharge, status: 'CONFIRMED' })
    await service.cancelMiscCharge('mc-1', 'org-1', 'user-9') // CONFIRMED → CANCELLED + reversal
    await service.cancelMiscCharge('mc-1', 'org-1', 'user-9') // redan CANCELLED → no-op
    expect(accounting.reverseJournalEntryForMiscCharge).toHaveBeenCalledTimes(1)
    // Andra anropet flippar inte status igen.
    expect(miscCharge.updateMany).toHaveBeenCalledTimes(1)
  })

  it('ATTACHED → BadRequest (rörs aldrig i PR 3)', async () => {
    const { service, accounting } = makeService({ ...baseCharge, status: 'ATTACHED' })
    await expect(service.cancelMiscCharge('mc-1', 'org-1', 'user-9')).rejects.toThrow(
      BadRequestException,
    )
    expect(accounting.reverseJournalEntryForMiscCharge).not.toHaveBeenCalled()
  })

  it('okänd post → NotFound', async () => {
    const { service } = makeService(null)
    await expect(service.cancelMiscCharge('mc-x', 'org-1', 'user-9')).rejects.toThrow(
      NotFoundException,
    )
  })
})

// ── XOR-guard ────────────────────────────────────────────────────────────────

describe('assertRentNoticeLineChargeXor', () => {
  it('exakt en satt → ok', () => {
    expect(() => assertRentNoticeLineChargeXor('cc-1', null)).not.toThrow()
    expect(() => assertRentNoticeLineChargeXor(null, 'mc-1')).not.toThrow()
  })

  it('båda satta → BadRequest', () => {
    expect(() => assertRentNoticeLineChargeXor('cc-1', 'mc-1')).toThrow(BadRequestException)
  })

  it('ingen satt → BadRequest', () => {
    expect(() => assertRentNoticeLineChargeXor(null, null)).toThrow(BadRequestException)
    expect(() => assertRentNoticeLineChargeXor(undefined, undefined)).toThrow(BadRequestException)
  })
})

// ── RBAC ─────────────────────────────────────────────────────────────────────

describe('MiscChargeController RBAC', () => {
  const guard = new RolesGuard(new Reflector())
  const proto = MiscChargeController.prototype

  function allows(handler: () => unknown, role: string): boolean {
    const ctx = {
      getHandler: () => handler,
      getClass: () => MiscChargeController,
      switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
    } as unknown as ExecutionContext
    try {
      return guard.canActivate(ctx) === true
    } catch (err) {
      if (err instanceof ForbiddenException) return false
      throw err
    }
  }

  it.each(['VIEWER', 'ACCOUNTANT'] as const)(
    'nekar %s på create/confirm/cancel (confirm/cancel får aldrig vara öppna)',
    (role) => {
      expect(allows(proto.create as () => unknown, role)).toBe(false)
      expect(allows(proto.confirm as () => unknown, role)).toBe(false)
      expect(allows(proto.cancel as () => unknown, role)).toBe(false)
    },
  )

  it.each(['MANAGER', 'ADMIN', 'OWNER'] as const)('släpper in %s', (role) => {
    expect(allows(proto.create as () => unknown, role)).toBe(true)
    expect(allows(proto.confirm as () => unknown, role)).toBe(true)
    expect(allows(proto.cancel as () => unknown, role)).toBe(true)
  })
})
