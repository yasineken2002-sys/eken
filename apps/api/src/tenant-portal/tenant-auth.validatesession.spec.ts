/**
 * SECURITY (launch-blocker B1) — validateSession() får ALDRIG returnera
 * portal-credentials.
 *
 * Tidigare drog `include: { tenant: true }` med passwordHash + alla
 * *TokenHash/*TokenExpiresAt-kolumner, som sedan läckte rakt ut via
 * GET /tenant-portal/me. Testet låser fast att:
 *   • validateSession använder ett explicit `select` (inte `true`/include-all)
 *   • selecten innehåller INGEN av credential-kolumnerna
 *   • selecten innehåller de icke-känsliga fält portalen behöver
 */

// contract-template.service drar in StorageService (aws-sdk, ESM) + PdfService
// (puppeteer). Mocka bort dem så importen blir lätt i jest.
jest.mock('../contracts/contract-template.service', () => ({
  ContractTemplateService: class {},
}))
jest.mock('../mail/mail.service', () => ({ MailService: class {} }))

import { UnauthorizedException } from '@nestjs/common'
import * as bcrypt from 'bcryptjs'
import { TenantAuthService } from './tenant-auth.service'

const CREDENTIAL_KEYS = [
  'passwordHash',
  'activationTokenHash',
  'activationTokenExpiresAt',
  'passwordResetTokenHash',
  'passwordResetTokenExpiresAt',
]

function makeService(sessionRow: unknown) {
  const findUnique = jest.fn().mockResolvedValue(sessionRow)
  const prisma = { tenantSession: { findUnique } }
  const service = new TenantAuthService(prisma as never, {} as never, {} as never, {} as never)
  return { service, findUnique }
}

describe('TenantAuthService.validateSession — credential-läcka (B1)', () => {
  it('väljer EXPLICIT fält och utesluter alla portal-credentials', async () => {
    const future = new Date(Date.now() + 60_000)
    const tenantRow = {
      id: 't1',
      organizationId: 'o1',
      email: 'a@b.se',
      organization: { id: 'o1', name: 'Org' },
    }
    const { service, findUnique } = makeService({ expiresAt: future, tenant: tenantRow })

    await service.validateSession('rawtoken')

    const arg = findUnique.mock.calls[0][0]
    const select = arg.include.tenant.select as Record<string, unknown>

    // Inte include-all (`true`) — ett konkret select-objekt
    expect(typeof select).toBe('object')
    // Inga credentials
    for (const key of CREDENTIAL_KEYS) {
      expect(select[key]).toBeUndefined()
    }
    // De icke-känsliga fält portalen faktiskt läser finns med
    expect(select['id']).toBe(true)
    expect(select['email']).toBe(true)
    expect(select['organizationId']).toBe(true)
    expect(select['organization']).toBeDefined()
  })

  it('kastar 401 om sessionen gått ut', async () => {
    const past = new Date(Date.now() - 60_000)
    const { service } = makeService({ expiresAt: past, tenant: { id: 't1' } })
    await expect(service.validateSession('rawtoken')).rejects.toBeInstanceOf(UnauthorizedException)
  })

  it('kastar 401 om sessionen saknas', async () => {
    const { service } = makeService(null)
    await expect(service.validateSession('rawtoken')).rejects.toBeInstanceOf(UnauthorizedException)
  })
})

describe('TenantAuthService.createSession — credential-strip (B1 defense-in-depth)', () => {
  it('login() returnerar ett tenant-objekt utan portal-credentials', async () => {
    const passwordHash = bcrypt.hashSync('Secret123!', 4)
    const tenantRow = {
      id: 't1',
      organizationId: 'o1',
      email: 'a@b.se',
      portalActivated: true,
      passwordHash,
      activationTokenHash: 'should-not-leak',
      passwordResetTokenHash: 'should-not-leak',
      organization: { id: 'o1', name: 'Org' },
    }
    const findFirst = jest.fn().mockResolvedValue(tenantRow)
    const create = jest.fn().mockResolvedValue({})
    const prisma = {
      tenant: { findFirst },
      tenantSession: { create },
    }
    const service = new TenantAuthService(prisma as never, {} as never, {} as never, {} as never)

    const result = await service.login('a@b.se', 'Secret123!')

    const t = result.tenant as Record<string, unknown>
    for (const key of CREDENTIAL_KEYS) {
      expect(t[key]).toBeUndefined()
    }
    expect(t['id']).toBe('t1')
    expect(t['email']).toBe('a@b.se')
  })
})
