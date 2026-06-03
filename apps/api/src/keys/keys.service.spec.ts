/**
 * KeysService — nyckelkvittens (ren förvaltningsfunktion).
 *
 * Fokus (per krav):
 *  • issue(): bulk-utlämning skapar N rader i EN transaktion, med unit/tenant
 *    denormaliserat från avtalet och issuedById = aktuell användare.
 *  • returnKey(): append-only — sätter returnedAt + RETURNED, raderar aldrig;
 *    bara ISSUED kan återlämnas; retur före utlämning nekas.
 *  • update(): statusbyte begränsat till LOST/REPLACED; en RETURNED nyckel är låst.
 *  • countOpenForLease(): härleder antal ej återlämnade (status ISSUED).
 *  • org-scoping: findOne kräver matchande organizationId.
 *  • RBAC: utlämning/retur/statusbyte kräver MANAGER/ADMIN/OWNER; läsning öppen.
 */
jest.mock('../tenants/tenants.service', () => ({ SAFE_TENANT_SELECT: {} }))

import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common'
import type { ExecutionContext } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { RolesGuard } from '../common/guards/roles.guard'
import { KeysService } from './keys.service'
import { KeysController } from './keys.controller'

function keyRow(over: Record<string, unknown> = {}) {
  return {
    id: 'key-1',
    organizationId: 'org-1',
    leaseId: 'lease-1',
    unitId: 'unit-1',
    tenantId: 'ten-1',
    type: 'APARTMENT',
    label: null,
    status: 'ISSUED',
    issuedAt: new Date('2026-01-10'),
    issuedToName: null,
    issuedById: 'user-9',
    returnedAt: null,
    receivedById: null,
    notes: null,
    createdAt: new Date('2026-01-10'),
    updatedAt: new Date('2026-01-10'),
    ...over,
  }
}

function makeService(firstRow: Record<string, unknown> | null = keyRow()) {
  const prisma: Record<string, unknown> = {
    lease: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'lease-1',
        unitId: 'unit-1',
        tenantId: 'ten-1',
      }),
    },
    keyHandover: {
      findFirst: jest.fn().mockResolvedValue(firstRow),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockImplementation(({ data }) => Promise.resolve(keyRow(data))),
      update: jest.fn().mockImplementation(({ data }) => Promise.resolve({ ...keyRow(), ...data })),
    },
  }
  // $transaction kör callbacken med prisma-klienten som "tx" (createMany saknas
  // medvetet — issue() använder individuella create-anrop för att få id tillbaka).
  prisma.$transaction = jest.fn((cb: (tx: unknown) => unknown) => cb(prisma))
  const service = new KeysService(prisma as never)
  return { service, prisma: prisma as never }
}

describe('KeysService.issue (bulk-utlämning)', () => {
  it('skapar N rader i EN transaktion med denormaliserat unit/tenant och issuedById', async () => {
    const { service, prisma } = makeService()

    const created = await service.issue(
      { leaseId: 'lease-1', type: 'APARTMENT' as never, quantity: 3 },
      'org-1',
      'user-9',
    )

    expect((prisma as never as { $transaction: jest.Mock }).$transaction).toHaveBeenCalledTimes(1)
    const createMock = (prisma as never as { keyHandover: { create: jest.Mock } }).keyHandover
      .create
    expect(createMock).toHaveBeenCalledTimes(3)
    const data = createMock.mock.calls[0][0].data
    expect(data).toMatchObject({
      organizationId: 'org-1',
      leaseId: 'lease-1',
      unitId: 'unit-1',
      tenantId: 'ten-1',
      type: 'APARTMENT',
      status: 'ISSUED',
      issuedById: 'user-9',
    })
    expect(created).toHaveLength(3)
  })

  it('skickar med label/issuedToName/notes när de anges', async () => {
    const { service, prisma } = makeService()
    await service.issue(
      {
        leaseId: 'lease-1',
        type: 'FOB_TAG' as never,
        quantity: 1,
        label: 'Bricka 7',
        issuedToName: 'Sambo Anna',
        notes: 'Märkt gul',
      },
      'org-1',
      'user-9',
    )
    const data = (prisma as never as { keyHandover: { create: jest.Mock } }).keyHandover.create.mock
      .calls[0][0].data
    expect(data).toMatchObject({
      label: 'Bricka 7',
      issuedToName: 'Sambo Anna',
      notes: 'Märkt gul',
    })
  })

  it('kastar NotFound när avtalet inte finns i organisationen', async () => {
    const { service, prisma } = makeService()
    ;(prisma as never as { lease: { findFirst: jest.Mock } }).lease.findFirst.mockResolvedValue(
      null,
    )
    await expect(
      service.issue({ leaseId: 'x', type: 'APARTMENT' as never, quantity: 1 }, 'org-1', 'user-9'),
    ).rejects.toBeInstanceOf(NotFoundException)
  })
})

describe('KeysService.returnKey (append-only)', () => {
  it('sätter RETURNED + returnedAt + receivedById utan att radera', async () => {
    const { service, prisma } = makeService()
    await service.returnKey('key-1', {}, 'org-1', 'user-5')
    const updateMock = (prisma as never as { keyHandover: { update: jest.Mock } }).keyHandover
      .update
    expect(updateMock).toHaveBeenCalledTimes(1)
    const arg = updateMock.mock.calls[0][0]
    expect(arg.where).toEqual({ id: 'key-1' })
    expect(arg.data).toMatchObject({ status: 'RETURNED', receivedById: 'user-5' })
    expect(arg.data.returnedAt).toBeInstanceOf(Date)
    // Aldrig delete.
    expect(prisma as never as Record<string, unknown>).not.toHaveProperty('delete')
  })

  it('nekar återlämning av en redan återlämnad nyckel', async () => {
    const { service } = makeService(keyRow({ status: 'RETURNED' }))
    await expect(service.returnKey('key-1', {}, 'org-1', 'user-5')).rejects.toBeInstanceOf(
      BadRequestException,
    )
  })

  it('nekar återlämning av en förlorad nyckel', async () => {
    const { service } = makeService(keyRow({ status: 'LOST' }))
    await expect(service.returnKey('key-1', {}, 'org-1', 'user-5')).rejects.toBeInstanceOf(
      BadRequestException,
    )
  })

  it('nekar returdatum före utlämningsdatum', async () => {
    const { service } = makeService(keyRow({ issuedAt: new Date('2026-05-01') }))
    await expect(
      service.returnKey('key-1', { returnedAt: '2026-01-01' }, 'org-1', 'user-5'),
    ).rejects.toBeInstanceOf(BadRequestException)
  })

  it('kastar NotFound (org-scoping) när nyckeln inte finns i organisationen', async () => {
    const { service } = makeService(null)
    await expect(service.returnKey('key-1', {}, 'org-1', 'user-5')).rejects.toBeInstanceOf(
      NotFoundException,
    )
  })
})

describe('KeysService.update (status LOST/REPLACED + metadata)', () => {
  it('tillåter ISSUED → LOST', async () => {
    const { service, prisma } = makeService()
    await service.update('key-1', { status: 'LOST' }, 'org-1')
    const data = (prisma as never as { keyHandover: { update: jest.Mock } }).keyHandover.update.mock
      .calls[0][0].data
    expect(data).toMatchObject({ status: 'LOST' })
  })

  it('låser en RETURNED nyckel mot statusbyte', async () => {
    const { service } = makeService(keyRow({ status: 'RETURNED' }))
    await expect(service.update('key-1', { status: 'LOST' }, 'org-1')).rejects.toBeInstanceOf(
      BadRequestException,
    )
  })

  it('tillåter metadata-redigering (label/notes) utan statusbyte', async () => {
    const { service, prisma } = makeService()
    await service.update('key-1', { label: 'Ny märkning', notes: 'flytt' }, 'org-1')
    const data = (prisma as never as { keyHandover: { update: jest.Mock } }).keyHandover.update.mock
      .calls[0][0].data
    expect(data).toMatchObject({ label: 'Ny märkning', notes: 'flytt' })
    expect(data.status).toBeUndefined()
  })
})

describe('KeysService.countOpenForLease', () => {
  it('räknar bara ISSUED för avtalet inom organisationen', async () => {
    const { service, prisma } = makeService()
    ;(prisma as never as { keyHandover: { count: jest.Mock } }).keyHandover.count.mockResolvedValue(
      4,
    )
    const n = await service.countOpenForLease('lease-1', 'org-1')
    expect(n).toBe(4)
    expect(
      (prisma as never as { keyHandover: { count: jest.Mock } }).keyHandover.count,
    ).toHaveBeenCalledWith({
      where: { leaseId: 'lease-1', organizationId: 'org-1', status: 'ISSUED' },
    })
  })
})

describe('KeysController RBAC', () => {
  const guard = new RolesGuard(new Reflector())
  const proto = KeysController.prototype

  function allows(handler: () => unknown, role: string): boolean {
    const ctx = {
      getHandler: () => handler,
      getClass: () => KeysController,
      switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
    } as unknown as ExecutionContext
    try {
      return guard.canActivate(ctx) === true
    } catch (err) {
      if (err instanceof ForbiddenException) return false
      throw err
    }
  }

  it.each(['VIEWER', 'ACCOUNTANT'] as const)('nekar %s på issue/return/update', (role) => {
    expect(allows(proto.issue as () => unknown, role)).toBe(false)
    expect(allows(proto.returnKey as () => unknown, role)).toBe(false)
    expect(allows(proto.update as () => unknown, role)).toBe(false)
  })

  it.each(['MANAGER', 'ADMIN', 'OWNER'] as const)(
    'släpper in %s på issue/return/update',
    (role) => {
      expect(allows(proto.issue as () => unknown, role)).toBe(true)
      expect(allows(proto.returnKey as () => unknown, role)).toBe(true)
      expect(allows(proto.update as () => unknown, role)).toBe(true)
    },
  )

  it.each(['VIEWER', 'MANAGER', 'ADMIN'] as const)('tillåter %s att läsa listan', (role) => {
    expect(allows(proto.findAll as () => unknown, role)).toBe(true)
  })
})
