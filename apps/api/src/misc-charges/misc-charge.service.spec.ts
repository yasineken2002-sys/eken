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
  sourceType: 'MAINTENANCE_TICKET' | 'INSPECTION_ITEM' | 'KEY_LOSS'
  sourceRefId: string
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
    findMany: jest.fn().mockResolvedValue(state ? [{ ...state }] : []),
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
  sourceType: 'MAINTENANCE_TICKET',
  sourceRefId: 'ticket-1',
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

  it('okänd tenant i org → NotFound (oberoende felväg från lease)', async () => {
    const { service, tenant } = makeService(null)
    tenant.findFirst.mockResolvedValueOnce(null)
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

  it('DRAFT-cancel rensar MaintenanceTicket.chargeId (frigör ärendet för om-debitering)', async () => {
    const { service, maintenanceTicket } = makeService({ ...baseCharge, status: 'DRAFT' })
    await service.cancelMiscCharge('mc-1', 'org-1', 'user-9')
    // Speglar claim:et omvänt — bara DEN ticket som pekar på denna charge nollas.
    expect(maintenanceTicket.updateMany).toHaveBeenCalledWith({
      where: { id: 'ticket-1', organizationId: 'org-1', chargeId: 'mc-1' },
      data: { chargeId: null },
    })
  })

  it('frigjort DRAFT-ärende kan om-debiteras (ny charge på samma ticket lyckas)', async () => {
    const { service, maintenanceTicket } = makeService({ ...baseCharge, status: 'DRAFT' })
    await service.cancelMiscCharge('mc-1', 'org-1', 'user-9')
    // Efter clear ser createMiscCharge ett fritt ärende (chargeId null) → claim går igenom.
    maintenanceTicket.findFirst.mockResolvedValueOnce({ id: 'ticket-1', chargeId: null })
    const next = await service.createMiscCharge(createDto, 'org-1')
    expect(next).toBeDefined()
    // Andra updateMany-anropet är det nya claim:et (det första var clearen).
    expect(maintenanceTicket.updateMany).toHaveBeenLastCalledWith({
      where: { id: 'ticket-1', organizationId: 'org-1', chargeId: null },
      data: { chargeId: 'mc-new' },
    })
  })

  it('parallellt confirm vinner racet → ingen ticket-clear (rullas tillbaka med statusflippen)', async () => {
    const { service, maintenanceTicket, miscCharge } = makeService({
      ...baseCharge,
      status: 'DRAFT',
    })
    miscCharge.updateMany.mockResolvedValueOnce({ count: 0 })
    await expect(service.cancelMiscCharge('mc-1', 'org-1', 'user-9')).rejects.toThrow(
      ConflictException,
    )
    // Statusflippen blev count===0 → clearen körs aldrig (ärendet förblir debiterat).
    expect(maintenanceTicket.updateMany).not.toHaveBeenCalled()
  })

  it('parallellt confirm vinner racet (DRAFT→CONFIRMED) → ConflictException, ingen tyst 200', async () => {
    const { service, accounting, miscCharge } = makeService({ ...baseCharge, status: 'DRAFT' })
    // Simulera att confirm hann före: villkorad updateMany matchar inga DRAFT-rader.
    // (Status-läsningen dessförinnan ser fortfarande DRAFT → DRAFT-grenen.)
    miscCharge.updateMany.mockResolvedValueOnce({ count: 0 })
    await expect(service.cancelMiscCharge('mc-1', 'org-1', 'user-9')).rejects.toThrow(
      ConflictException,
    )
    // Ingen reversal — det fanns inget bokfört original (posten var DRAFT vid läsning).
    expect(accounting.reverseJournalEntryForMiscCharge).not.toHaveBeenCalled()
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

  it('CONFIRMED-cancel: motverifikat OCH ticket-clear i SAMMA transaktion', async () => {
    const { service, accounting, maintenanceTicket, prisma } = makeService({
      ...baseCharge,
      status: 'CONFIRMED',
    })
    await service.cancelMiscCharge('mc-1', 'org-1', 'user-9')
    // Allt i en enda $transaction (atomiskt: charge→CANCELLED + ticket→fri + motverifikat).
    expect(prisma.$transaction as jest.Mock).toHaveBeenCalledTimes(1)
    expect(accounting.reverseJournalEntryForMiscCharge).toHaveBeenCalledTimes(1)
    expect(maintenanceTicket.updateMany).toHaveBeenCalledWith({
      where: { id: 'ticket-1', organizationId: 'org-1', chargeId: 'mc-1' },
      data: { chargeId: null },
    })
  })

  it('CONFIRMED-cancel: samtidigt attach vinner racet (count 0) → ingen ticket-clear', async () => {
    // Posten lästes som CONFIRMED men hann flippas CONFIRMED→ATTACHED av ett parallellt
    // attach innan statusflippen → updateMany count===0. Då FÅR ticket.chargeId inte
    // nollas: charge:en lever kvar på en avi och ärendet skulle annars se fritt ut.
    const { service, miscCharge, maintenanceTicket } = makeService({
      ...baseCharge,
      status: 'CONFIRMED',
    })
    miscCharge.updateMany.mockResolvedValueOnce({ count: 0 })
    await service.cancelMiscCharge('mc-1', 'org-1', 'user-9')
    expect(maintenanceTicket.updateMany).not.toHaveBeenCalled()
  })

  it('idempotent: andra cancel på redan CANCELLED → no-op (inget andra motverifikat)', async () => {
    const { service, accounting, miscCharge } = makeService({ ...baseCharge, status: 'CONFIRMED' })
    await service.cancelMiscCharge('mc-1', 'org-1', 'user-9') // CONFIRMED → CANCELLED + reversal
    await service.cancelMiscCharge('mc-1', 'org-1', 'user-9') // redan CANCELLED → no-op
    expect(accounting.reverseJournalEntryForMiscCharge).toHaveBeenCalledTimes(1)
    // Andra anropet flippar inte status igen.
    expect(miscCharge.updateMany).toHaveBeenCalledTimes(1)
  })

  it('idempotent: dubbel-cancel rensar ticket EN gång (andra anropet är ren no-op)', async () => {
    const { service, maintenanceTicket } = makeService({ ...baseCharge, status: 'DRAFT' })
    await service.cancelMiscCharge('mc-1', 'org-1', 'user-9') // DRAFT → CANCELLED + clear
    await service.cancelMiscCharge('mc-1', 'org-1', 'user-9') // redan CANCELLED → no-op
    // Clearen körs bara i den faktiska annulleringen — inte i no-op:en.
    expect(maintenanceTicket.updateMany).toHaveBeenCalledTimes(1)
  })

  it('charge utan ticket-källa (INSPECTION_ITEM) → cancel fungerar, ingen ticket-clear', async () => {
    const { service, maintenanceTicket } = makeService({
      ...baseCharge,
      status: 'DRAFT',
      sourceType: 'INSPECTION_ITEM',
      sourceRefId: 'insp-row-1',
    })
    const result = await service.cancelMiscCharge('mc-1', 'org-1', 'user-9')
    expect(result.status).toBe('CANCELLED')
    // Andra källor har ingen ticket.chargeId att rensa → hoppas säkert över (ingen krasch).
    expect(maintenanceTicket.updateMany).not.toHaveBeenCalled()
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

// ── Läsning (PR 4) ───────────────────────────────────────────────────────────

describe('findMiscCharges / findMiscCharge', () => {
  it('findMiscCharges trådar org + filter till prisma', async () => {
    const { service, miscCharge } = makeService(baseCharge)
    await service.findMiscCharges('org-1', { status: 'CONFIRMED', sourceRefId: 'ticket-1' })
    expect(miscCharge.findMany).toHaveBeenCalledWith({
      where: { organizationId: 'org-1', status: 'CONFIRMED', sourceRefId: 'ticket-1' },
      orderBy: { createdAt: 'desc' },
      take: 500,
    })
  })

  it('findMiscCharge okänd post → NotFound', async () => {
    const { service } = makeService(null)
    await expect(service.findMiscCharge('mc-x', 'org-1')).rejects.toThrow(NotFoundException)
  })
})

// ── Attach till hyresavi (PR 4b) ─────────────────────────────────────────────

function makeAttach(charges: Array<Record<string, unknown>>) {
  const lineCreate = jest.fn().mockResolvedValue({ id: 'rnl-1' })
  const noticeUpdate = jest.fn().mockResolvedValue({ count: 1 })
  const chargeUpdateMany = jest.fn().mockResolvedValue({ count: 1 })
  const prisma: Record<string, unknown> = {
    miscCharge: {
      findMany: jest.fn().mockResolvedValue(charges),
      updateMany: chargeUpdateMany,
    },
    rentNoticeLine: { create: lineCreate },
    rentNotice: { updateMany: noticeUpdate },
  }
  prisma.$transaction = jest.fn((cb: (tx: unknown) => unknown) => cb(prisma))
  const accounting = {
    createJournalEntryForMiscCharge: jest.fn(),
    reverseJournalEntryForMiscCharge: jest.fn(),
  }
  const service = new MiscChargeService(prisma as never, accounting as never)
  return { service, lineCreate, noticeUpdate, chargeUpdateMany }
}

const confirmedCharge = (id: string, total: number) => ({
  id,
  status: 'CONFIRMED',
  description: `Skada ${id}`,
  netAmount: total,
  vatRate: 0,
  totalAmount: total,
})

describe('attachMiscChargesToRentNotice', () => {
  it('claim:ar CONFIRMED→ATTACHED, skapar RentNoticeLine.miscChargeId, summerar miscChargeAmount', async () => {
    const { service, lineCreate, noticeUpdate, chargeUpdateMany } = makeAttach([
      confirmedCharge('mc-1', 1500),
      confirmedCharge('mc-2', 300),
    ])
    const sum = await service.attachMiscChargesToRentNotice({
      organizationId: 'org-1',
      leaseId: 'lease-1',
      rentNoticeId: 'rn-1',
    })
    expect(sum).toBe(1800)
    // Race-säkert claim per post.
    expect(chargeUpdateMany).toHaveBeenCalledWith({
      where: { id: 'mc-1', organizationId: 'org-1', status: 'CONFIRMED' },
      data: { status: 'ATTACHED' },
    })
    // Avi-rad med miscChargeId (XOR uppfylld: ingen consumptionChargeId).
    expect(lineCreate).toHaveBeenCalledTimes(2)
    expect(lineCreate.mock.calls[0]![0].data).toMatchObject({
      rentNoticeId: 'rn-1',
      miscChargeId: 'mc-1',
      total: 1500,
    })
    // miscChargeAmount summerad på avin — org-scopad write.
    expect(noticeUpdate).toHaveBeenCalledWith({
      where: { id: 'rn-1', organizationId: 'org-1' },
      data: { miscChargeAmount: 1800 },
    })
  })

  it('race-förlorare (claim count 0) hoppas över — ingen rad, ingen summa', async () => {
    const { service, lineCreate, chargeUpdateMany } = makeAttach([confirmedCharge('mc-1', 1500)])
    chargeUpdateMany.mockResolvedValueOnce({ count: 0 })
    const sum = await service.attachMiscChargesToRentNotice({
      organizationId: 'org-1',
      leaseId: 'lease-1',
      rentNoticeId: 'rn-1',
    })
    expect(sum).toBe(0)
    expect(lineCreate).not.toHaveBeenCalled()
  })

  it('inga CONFIRMED-poster → returnerar 0, ingen transaktion', async () => {
    const { service, noticeUpdate } = makeAttach([])
    const sum = await service.attachMiscChargesToRentNotice({
      organizationId: 'org-1',
      leaseId: 'lease-1',
      rentNoticeId: 'rn-1',
    })
    expect(sum).toBe(0)
    expect(noticeUpdate).not.toHaveBeenCalled()
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
    'nekar %s på alla endpoints (list/detail/create/confirm/cancel — inget öppet)',
    (role) => {
      expect(allows(proto.list as () => unknown, role)).toBe(false)
      expect(allows(proto.detail as () => unknown, role)).toBe(false)
      expect(allows(proto.create as () => unknown, role)).toBe(false)
      expect(allows(proto.confirm as () => unknown, role)).toBe(false)
      expect(allows(proto.cancel as () => unknown, role)).toBe(false)
    },
  )

  it.each(['MANAGER', 'ADMIN', 'OWNER'] as const)('släpper in %s', (role) => {
    expect(allows(proto.list as () => unknown, role)).toBe(true)
    expect(allows(proto.detail as () => unknown, role)).toBe(true)
    expect(allows(proto.create as () => unknown, role)).toBe(true)
    expect(allows(proto.confirm as () => unknown, role)).toBe(true)
    expect(allows(proto.cancel as () => unknown, role)).toBe(true)
  })
})
