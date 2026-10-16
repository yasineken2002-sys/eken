/** Hyresgästens dokumentkopia får inte bli en export av interna outboxfält. */
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { testPersonalNumberService } from '../common/crypto/personal-number.testing'
import {
  mapExportNoticeDocument,
  PORTAL_NOTICE_DOCUMENT_SELECT,
  TenantPortalService,
} from './tenant-portal.service'

type PortalDependencies = ConstructorParameters<typeof TenantPortalService>

/** Exporten får inte anropa dessa tjänster; fel väg ska kasta direkt. */
function unusedDependency<T extends object>(name: string): T {
  return new Proxy({} as T, {
    get: (_target, property) => {
      throw new Error(`Exportprovet får inte anropa ${name}.${String(property)}`)
    },
  })
}

const preparedAt = new Date('2026-10-15T10:00:00.000Z')
function savedDocument() {
  return {
    snapshot: {
      version: 1,
      html: '<html><body>Syntetisk hyresgäst, 975 kr att betala</body></html>',
      to: 'tenant@example.invalid',
      tenantName: 'Syntetisk hyresgäst',
      organizationName: 'Syntetiskt fastighetsbolag',
      noticeNumber: 'AVI-2026-10-0001',
      ocrNumber: '1234567890',
      dueDate: '2026-10-31T00:00:00.000Z',
      accentColor: null,
      payableAmount: 975,
      customerCreditAmount: 25,
    },
    preparedAt,
    queuedAt: new Date('2026-10-15T10:01:00.000Z'),
    acceptedAt: new Date('2026-10-15T10:02:00.000Z'),
    // Sentineler från en alltför bred DB-fråga får inte nå exporten.
    messageId: 'PROVIDER-INTERNAL',
    dispatchKey: 'INTERNAL-KEY',
    jobId: 'INTERNAL-JOB',
    mailPayload: { unrelatedSecret: 'OTHER-TENANT-DATA' },
  }
}

describe('GDPR-export av sparat aviunderlag', () => {
  it('lämnar eget dokument, mottagare och acceptanstid men aldrig outboxfält', () => {
    const saved = savedDocument()
    const result = mapExportNoticeDocument('own-notice', saved)
    expect(result).toEqual({
      noticeId: 'own-notice',
      noticeNumber: 'AVI-2026-10-0001',
      preparedAt,
      queuedAt: saved.queuedAt,
      providerAcceptedAt: saved.acceptedAt,
      recipient: { name: 'Syntetisk hyresgäst', email: 'tenant@example.invalid' },
      payableAmount: 975,
      customerCreditAmount: 25,
      originalDocument: { format: 'html', content: saved.snapshot.html },
    })
    expect(JSON.stringify(result)).not.toMatch(
      /PROVIDER-INTERNAL|INTERNAL-KEY|INTERNAL-JOB|OTHER-TENANT-DATA/,
    )
    expect(result).not.toHaveProperty('deliveredAt')
    expect(Object.keys(PORTAL_NOTICE_DOCUMENT_SELECT).sort()).toEqual([
      'acceptedAt',
      'preparedAt',
      'queuedAt',
      'snapshot',
    ])
  })

  it('vägrar exportera ett snapshot som inte följer den kända formen', () => {
    const saved = savedDocument()
    expect(() =>
      mapExportNoticeDocument('own-notice', {
        ...saved,
        snapshot: { ...saved.snapshot, internalSecret: 'UNKNOWN-DATA' },
      }),
    ).toThrow('inte läsas för export')
  })

  it('läser dokumenten genom den inloggade hyresgästens egna avier och mappar dem separat', async () => {
    const prisma = {
      tenant: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'own-tenant',
          organization: { id: 'own-organization', name: 'Syntetiskt bolag' },
          customerCreditRefunds: [],
          leases: [],
          invoices: [],
          maintenanceTickets: [],
          documents: [],
          rentNotices: [
            { id: 'own-notice', noticeNumber: 'AVI-2026-10-0001', sends: [savedDocument()] },
          ],
        }),
      },
    }
    const service = new TenantPortalService(
      prisma as unknown as PortalDependencies[0],
      testPersonalNumberService(),
      unusedDependency<PortalDependencies[2]>('MaintenanceService'),
      unusedDependency<PortalDependencies[3]>('NotificationsService'),
      unusedDependency<PortalDependencies[4]>('StorageService'),
      unusedDependency<PortalDependencies[5]>('InspectionsService'),
      unusedDependency<PortalDependencies[6]>('InspectionImageIntegrityService'),
    )
    const result = await service.exportTenantData('own-tenant')
    expect(prisma.tenant.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'own-tenant' } }),
    )
    const sends = prisma.tenant.findUnique.mock.calls[0]![0].include.rentNotices.select.sends
    expect(sends).toEqual({
      where: { kind: 'NOTICE', dispatchKey: { not: null } },
      orderBy: { createdAt: 'asc' },
      select: PORTAL_NOTICE_DOCUMENT_SELECT,
    })
    expect(result.rentNotices).toEqual([{ id: 'own-notice', noticeNumber: 'AVI-2026-10-0001' }])
    expect(result.rentNoticeDocuments).toHaveLength(1)
    expect(result.rentNoticeDocuments[0]?.noticeId).toBe('own-notice')
    expect(JSON.stringify(result)).not.toMatch(
      /PROVIDER-INTERNAL|INTERNAL-KEY|INTERNAL-JOB|OTHER-TENANT-DATA/,
    )
  })
})
