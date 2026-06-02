/**
 * Massinbjudan till hyresgästportalen — urvals- och statuslogik.
 *
 * Fokus (per krav):
 *  • Urval "Bjud in alla aktiva" frågar bara hyresgäster med ≥1 ACTIVE-lease.
 *  • Klassificering: aktiverade hoppas över, nyligen inbjudna (<24 h) hoppas
 *    över utan force, och endast (aktiv + ej aktiverad + giltig mejl) får mejl.
 *  • "Saknar mejl" YTAS i svaret (noEmailTenants) — får ALDRIG tyst hoppas över.
 *  • force kringgår 24 h-skyddet; resend(onlyNotActivated) riktar rätt.
 *  • listStatus härleder status + räknare korrekt.
 */

// TenantInvitationsService → TenantAuthService → ContractTemplateService →
// PdfService → StorageService drar in @aws-sdk/client-s3 (ESM som jest inte
// transformerar). Mocka leaf-modulerna så importen blir lätt (samma mönster
// som invoices-specarna).
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { BadRequestException } from '@nestjs/common'
import { TenantInvitationsService } from './tenant-invitations.service'

interface TenantOverride {
  id?: string
  type?: 'INDIVIDUAL' | 'COMPANY'
  firstName?: string | null
  lastName?: string | null
  companyName?: string | null
  email?: string
  portalActivated?: boolean
  portalActivatedAt?: Date | null
  invitedAt?: Date | null
  inviteCount?: number
}

function tenant(over: TenantOverride = {}) {
  return {
    id: 'tenant-1',
    type: 'INDIVIDUAL' as const,
    firstName: 'Anna',
    lastName: 'Svensson',
    companyName: null,
    email: 'anna@example.se',
    portalActivated: false,
    portalActivatedAt: null,
    invitedAt: null,
    inviteCount: 0,
    ...over,
  }
}

function makeService(findManyReturns: ReturnType<typeof tenant>[]) {
  const prisma = {
    organization: {
      findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'org-1', name: 'Eken Fastigheter' }),
    },
    tenant: {
      findMany: jest.fn().mockResolvedValue(findManyReturns),
      update: jest.fn().mockResolvedValue({}),
    },
  }
  const mail = { sendTenantPortalInvite: jest.fn().mockResolvedValue('mail-job-1') }
  const tenantAuth = {
    issueActivationToken: jest.fn().mockResolvedValue('tok_abcdef1234567890'),
    buildActivationUrl: jest.fn((t: string) => `https://portal.test/activate?token=${t}`),
  }
  const service = new TenantInvitationsService(prisma as never, mail as never, tenantAuth as never)
  return { service, prisma, mail, tenantAuth }
}

describe('TenantInvitationsService — urval + saknar-mejl', () => {
  it('"bjud in alla" frågar BARA hyresgäster med ≥1 ACTIVE-lease', async () => {
    const { service, prisma } = makeService([])
    await service.invite('org-1', { all: true })
    expect(prisma.tenant.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: 'org-1', leases: { some: { status: 'ACTIVE' } } },
      }),
    )
  })

  it('klassificerar korrekt: bara (ej aktiverad + giltig mejl + ej nyligen) får mejl', async () => {
    const eligible = tenant({ id: 'ok', email: 'ok@example.se' })
    const activated = tenant({ id: 'act', email: 'act@example.se', portalActivated: true })
    const noEmail = tenant({ id: 'noem', email: '' })
    const recent = tenant({ id: 'rec', email: 'rec@example.se', invitedAt: new Date() })

    const { service, mail, prisma, tenantAuth } = makeService([
      eligible,
      activated,
      noEmail,
      recent,
    ])
    const res = await service.invite('org-1', { all: true })

    expect(res.invited).toBe(1)
    expect(res.alreadyActivated).toBe(1)
    expect(res.skippedRecent).toBe(1)
    expect(res.skippedNoEmail).toBe(1)
    expect(res.failed).toBe(0)

    // Endast den behöriga fick ett mejl.
    expect(mail.sendTenantPortalInvite).toHaveBeenCalledTimes(1)
    expect(mail.sendTenantPortalInvite).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'ok@example.se', organizationName: 'Eken Fastigheter' }),
    )
    // Token utfärdades + invitedAt/inviteCount uppdaterades för den behöriga.
    expect(tenantAuth.issueActivationToken).toHaveBeenCalledTimes(1)
    expect(tenantAuth.issueActivationToken).toHaveBeenCalledWith('ok')
    expect(prisma.tenant.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'ok' },
        data: expect.objectContaining({
          inviteCount: { increment: 1 },
          lastInviteMessageId: 'mail-job-1',
        }),
      }),
    )
  })

  it('"saknar mejl" YTAS i svaret och får ALDRIG ett mejl (ingen tyst skip)', async () => {
    const noEmail = tenant({ id: 'noem', firstName: 'Bo', lastName: 'Ek', email: '   ' })
    const { service, mail } = makeService([noEmail])

    const res = await service.invite('org-1', { all: true })

    expect(res.invited).toBe(0)
    expect(res.skippedNoEmail).toBe(1)
    expect(res.noEmailTenants).toEqual([{ tenantId: 'noem', name: 'Bo Ek', email: '   ' }])
    expect(mail.sendTenantPortalInvite).not.toHaveBeenCalled()
  })

  it.each(['', '   ', 'notanemail', 'foo@bar', 'a@b@c.se'])(
    'behandlar ogiltig mejl "%s" som NO_EMAIL',
    async (bad) => {
      const { service, mail } = makeService([tenant({ id: 'x', email: bad })])
      const res = await service.invite('org-1', { all: true })
      expect(res.skippedNoEmail).toBe(1)
      expect(res.invited).toBe(0)
      expect(mail.sendTenantPortalInvite).not.toHaveBeenCalled()
    },
  )

  it('force=true kringgår 24 h-dubbelklicks-skyddet', async () => {
    const recent = tenant({ id: 'rec', email: 'rec@example.se', invitedAt: new Date() })
    const { service, mail } = makeService([recent])

    const res = await service.invite('org-1', { tenantIds: ['rec'], force: true })

    expect(res.invited).toBe(1)
    expect(res.skippedRecent).toBe(0)
    expect(mail.sendTenantPortalInvite).toHaveBeenCalledTimes(1)
  })

  it('en gammal inbjudan (>24 h) får ny inbjudan utan force', async () => {
    const old = tenant({ id: 'old', email: 'old@example.se', invitedAt: new Date('2020-01-01') })
    const { service, mail } = makeService([old])
    const res = await service.invite('org-1', { all: true })
    expect(res.invited).toBe(1)
    expect(mail.sendTenantPortalInvite).toHaveBeenCalledTimes(1)
  })

  it('invite utan all eller tenantIds kastar BadRequest', async () => {
    const { service } = makeService([])
    await expect(service.invite('org-1', {})).rejects.toBeInstanceOf(BadRequestException)
  })

  it('resend(onlyNotActivated) riktar mot inbjudna men ej aktiverade och forcear', async () => {
    const notActivated = tenant({ id: 'na', email: 'na@example.se', invitedAt: new Date() })
    const { service, prisma, mail } = makeService([notActivated])

    const res = await service.resend('org-1', { onlyNotActivated: true })

    expect(prisma.tenant.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: 'org-1', portalActivated: false, invitedAt: { not: null } },
      }),
    )
    // force kringgår 24 h även om invitedAt är nyligen.
    expect(res.invited).toBe(1)
    expect(mail.sendTenantPortalInvite).toHaveBeenCalledTimes(1)
  })

  it('listStatus härleder status + räknare', async () => {
    const rows = [
      tenant({ id: 'a', portalActivated: true, portalActivatedAt: new Date() }),
      tenant({ id: 'b', email: '' }),
      tenant({ id: 'c', invitedAt: new Date(), inviteCount: 2 }),
      tenant({ id: 'd' }),
    ]
    const { service } = makeService(rows)

    const list = await service.listStatus('org-1', {})

    expect(list.counts).toEqual({ ACTIVATED: 1, NO_EMAIL: 1, INVITED: 1, NOT_INVITED: 1 })
    expect(list.total).toBe(4)
    const byId = Object.fromEntries(list.items.map((i) => [i.tenantId, i.status]))
    expect(byId).toEqual({ a: 'ACTIVATED', b: 'NO_EMAIL', c: 'INVITED', d: 'NOT_INVITED' })
  })

  it('listStatus filtrerar på status', async () => {
    const rows = [
      tenant({ id: 'a', portalActivated: true }),
      tenant({ id: 'b', email: '' }),
      tenant({ id: 'd' }),
    ]
    const { service } = makeService(rows)
    const list = await service.listStatus('org-1', { status: 'NO_EMAIL' })
    expect(list.total).toBe(1)
    expect(list.items.map((i) => i.tenantId)).toEqual(['b'])
  })
})
