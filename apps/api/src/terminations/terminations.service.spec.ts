/**
 * TerminationsService — godkänn/avslå + skapande, samt RBAC på controllern.
 *
 * Fokus (per krav):
 *  • approve() kör den befintliga lease-termineringen och sätter APPROVED + reviewer.
 *  • Slutdatum: bekräftat datum från dialogen används; utan datum beräknas
 *    förslaget (senare av önskat datum och idag+uppsägningstid) — hyresgästens
 *    önskade datum auto-appliceras aldrig rakt av om det är för tidigt.
 *  • Status-guards: bara PENDING kan godkännas/avslås.
 *  • createFromTenant: saknat avtal kastar, dubblett ger null, lyckad notifierar.
 *  • RBAC: approve/reject kräver ADMIN/OWNER (MANAGER/VIEWER nekas).
 */
// Mocka leaf-tjänsterna så importen av TerminationsService/-Controller inte drar
// in tunga kedjor (leases→pdf/storage, notifications→ai→Anthropic).
jest.mock('../leases/leases.service', () => ({ LeasesService: class {} }))
jest.mock('../tenants/tenants.service', () => ({ SAFE_TENANT_SELECT: {} }))
jest.mock('../mail/mail.service', () => ({ MailService: class {} }))
jest.mock('../notifications/notifications.service', () => ({ NotificationsService: class {} }))

import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common'
import type { ExecutionContext } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { RolesGuard } from '../common/guards/roles.guard'
import { TerminationsService } from './terminations.service'
import { TerminationsController } from './terminations.controller'

function req(over: Record<string, unknown> = {}) {
  return {
    id: 'tr-1',
    organizationId: 'org-1',
    tenantId: 'ten-1',
    leaseId: 'lease-1',
    requestedEndDate: new Date('2030-06-01'),
    reason: 'Flyttar utomlands',
    status: 'PENDING',
    organization: { name: 'Eken Fastigheter' },
    tenant: {
      type: 'INDIVIDUAL',
      firstName: 'Anna',
      lastName: 'Svensson',
      email: 'anna@example.se',
    },
    lease: {
      id: 'lease-1',
      noticePeriodMonths: 3,
      tenancyRegime: 'PRIVATE_RENTAL',
      unit: { type: 'APARTMENT', name: 'Lgh 1001', property: { name: 'Eken 1' } },
    },
    ...over,
  }
}

function makeService(reqRow: Record<string, unknown> | null = req()) {
  const prisma = {
    terminationRequest: {
      findFirst: jest.fn().mockResolvedValue(reqRow),
      update: jest.fn().mockImplementation(({ data }) => Promise.resolve({ ...req(), ...data })),
      create: jest.fn().mockResolvedValue({ id: 'tr-new' }),
    },
    lease: { findFirst: jest.fn() },
  }
  const mail = { sendCustomEmail: jest.fn().mockResolvedValue(undefined) }
  const notifications = { createForAllOrgUsers: jest.fn().mockResolvedValue(undefined) }
  const leases = { terminate: jest.fn().mockResolvedValue({}) }
  const service = new TerminationsService(
    prisma as never,
    mail as never,
    notifications as never,
    leases as never,
  )
  return { service, prisma, mail, notifications, leases }
}

describe('TerminationsService.approve', () => {
  it('kör lease-terminering med BEKRÄFTAT datum och sätter APPROVED + reviewer', async () => {
    const { service, prisma, leases, mail } = makeService()

    await service.approve('tr-1', 'org-1', 'user-9', { effectiveDate: '2030-07-15' })

    expect(leases.terminate).toHaveBeenCalledTimes(1)
    const [leaseId, dto, org, initiator] = leases.terminate.mock.calls[0]
    expect(leaseId).toBe('lease-1')
    expect(org).toBe('org-1')
    expect(dto.effectiveDate).toMatch(/^2030-07-15/)
    // #69: hyresvärden godkänner hyresgästens begäran → hyresgästens uppsägningstid.
    expect(initiator).toBe('TENANT')
    expect(prisma.terminationRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'tr-1' },
        data: expect.objectContaining({ status: 'APPROVED', reviewedById: 'user-9' }),
      }),
    )
    expect(mail.sendCustomEmail).toHaveBeenCalledTimes(1)
  })

  it('utan datum: använder hyresgästens önskade datum när det ligger efter uppsägningsgolvet', async () => {
    const { service, leases } = makeService(req({ requestedEndDate: new Date('2030-06-01') }))
    await service.approve('tr-1', 'org-1', 'user-9', {})
    expect(leases.terminate.mock.calls[0][1].effectiveDate).toMatch(/^2030-06-01/)
  })

  it('utan datum: önskat datum i det förflutna höjs till idag + uppsägningstid (auto-appliceras ej)', async () => {
    const { service, leases } = makeService(req({ requestedEndDate: new Date('2020-01-01') }))
    await service.approve('tr-1', 'org-1', 'user-9', {})
    const used = leases.terminate.mock.calls[0][1].effectiveDate as string
    expect(used.startsWith('2020-01-01')).toBe(false)
    expect(new Date(used).getTime()).toBeGreaterThan(Date.now())
  })

  it('#69 privatuthyrning: utan datum + snart önskat datum → 1-månadersgolv (inte 3)', async () => {
    // Fast systemtid för deterministiskt golv.
    jest.useFakeTimers().setSystemTime(new Date('2026-08-12T09:00:00Z'))
    try {
      // Hyresgäst vill flytta snabbt (önskat datum före 1-mån-golvet) → golvas till
      // 30 sep (endOfNoticePeriod(2026-08-12, 1)), INTE 30 nov (3 mån).
      const { service, leases } = makeService(req({ requestedEndDate: new Date('2026-08-20') }))
      await service.approve('tr-1', 'org-1', 'user-9', {})
      expect(leases.terminate.mock.calls[0][1].effectiveDate).toMatch(/^2026-09-30/)
      expect(leases.terminate.mock.calls[0][3]).toBe('TENANT')
    } finally {
      jest.useRealTimers()
    }
  })

  it('kör INTE lease-terminering om status inte är PENDING', async () => {
    const { service, leases } = makeService(req({ status: 'APPROVED' }))
    await expect(service.approve('tr-1', 'org-1', 'user-9', {})).rejects.toBeInstanceOf(
      BadRequestException,
    )
    expect(leases.terminate).not.toHaveBeenCalled()
  })

  it('kastar NotFound om begäran saknas', async () => {
    const { service } = makeService(null)
    await expect(service.approve('x', 'org-1', 'user-9', {})).rejects.toBeInstanceOf(
      NotFoundException,
    )
  })
})

describe('TerminationsService.reject', () => {
  it('sätter REJECTED + reviewer och mejlar hyresgästen', async () => {
    const { service, prisma, mail, leases } = makeService()
    await service.reject('tr-1', 'org-1', 'user-9', { reason: 'Saknar grund' })
    expect(leases.terminate).not.toHaveBeenCalled()
    expect(prisma.terminationRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'REJECTED', reviewedById: 'user-9' }),
      }),
    )
    expect(mail.sendCustomEmail).toHaveBeenCalledTimes(1)
  })

  it('endast PENDING kan avslås', async () => {
    const { service } = makeService(req({ status: 'REJECTED' }))
    await expect(service.reject('tr-1', 'org-1', 'user-9', {})).rejects.toBeInstanceOf(
      BadRequestException,
    )
  })
})

describe('TerminationsService.createFromTenant', () => {
  it('kastar om hyresgästen saknar aktivt avtal', async () => {
    const { service, prisma } = makeService()
    prisma.lease.findFirst.mockResolvedValue(null)
    await expect(
      service.createFromTenant('org-1', 'ten-1', new Date('2030-01-01')),
    ).rejects.toBeInstanceOf(BadRequestException)
  })

  it('returnerar null vid pågående dubblett (ingen ny rad)', async () => {
    const { service, prisma } = makeService()
    prisma.lease.findFirst.mockResolvedValue({ id: 'lease-1', tenant: {} })
    prisma.terminationRequest.findFirst.mockResolvedValueOnce({ id: 'existing' })
    const res = await service.createFromTenant('org-1', 'ten-1', new Date('2030-01-01'))
    expect(res).toBeNull()
    expect(prisma.terminationRequest.create).not.toHaveBeenCalled()
  })

  it('skapar + notifierar personalen vid lyckad begäran', async () => {
    const { service, prisma, notifications } = makeService()
    prisma.lease.findFirst.mockResolvedValue({
      id: 'lease-1',
      tenant: { type: 'INDIVIDUAL', firstName: 'Bo', lastName: 'Ek', email: 'bo@x.se' },
    })
    prisma.terminationRequest.findFirst.mockResolvedValueOnce(null)
    const res = await service.createFromTenant('org-1', 'ten-1', new Date('2030-01-01'), 'skäl')
    expect(res).toEqual({ id: 'tr-new', requestedEndDate: new Date('2030-01-01') })
    expect(notifications.createForAllOrgUsers).toHaveBeenCalledWith(
      'org-1',
      'SYSTEM',
      expect.stringContaining('Uppsägning'),
      expect.any(String),
      expect.objectContaining({
        relatedEntityType: 'TERMINATION_REQUEST',
        relatedEntityId: 'tr-new',
      }),
    )
  })
})

describe('TerminationsController RBAC — approve/reject kräver ADMIN/OWNER', () => {
  const guard = new RolesGuard(new Reflector())
  const proto = TerminationsController.prototype

  function allows(handler: () => unknown, role: string): boolean {
    const ctx = {
      getHandler: () => handler,
      getClass: () => TerminationsController,
      switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
    } as unknown as ExecutionContext
    try {
      return guard.canActivate(ctx) === true
    } catch (err) {
      if (err instanceof ForbiddenException) return false
      throw err
    }
  }

  it.each(['VIEWER', 'ACCOUNTANT', 'MANAGER'] as const)('nekar %s på approve & reject', (role) => {
    expect(allows(proto.approve as () => unknown, role)).toBe(false)
    expect(allows(proto.reject as () => unknown, role)).toBe(false)
  })

  it.each(['ADMIN', 'OWNER'] as const)('släpper in %s på approve & reject', (role) => {
    expect(allows(proto.approve as () => unknown, role)).toBe(true)
    expect(allows(proto.reject as () => unknown, role)).toBe(true)
  })

  it.each(['VIEWER', 'MANAGER', 'ADMIN'] as const)('tillåter %s att läsa listan', (role) => {
    expect(allows(proto.findAll as () => unknown, role)).toBe(true)
  })
})
