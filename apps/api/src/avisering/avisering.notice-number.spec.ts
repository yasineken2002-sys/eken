/**
 * H1 — nextNoticeNumber är scopat till organisationen.
 *
 * Tidigare räknades max-sekvensen över ALLA orgars avier (saknat
 * organizationId-filter), så en ny kunds serie kunde börja på AVI-2026-06-0047.
 * Testet låser fast att findMany-where:n innehåller organizationId och att
 * sekvensen räknas per org.
 */

// Drar in StorageService (aws-sdk, ESM) + PdfService (puppeteer) via importkedjan.
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))

import { AviseringService } from './avisering.service'

interface NoticeNumberAccess {
  nextNoticeNumber(orgId: string, year: number, month: number, offset?: number): Promise<string>
}

function makeService(existing: Array<{ noticeNumber: string }>) {
  const findMany = jest.fn().mockResolvedValue(existing)
  const prisma = { rentNotice: { findMany } }
  const service = new AviseringService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never, // miscCharges
    {} as never, // deposits
  )
  return { service: service as unknown as NoticeNumberAccess, findMany }
}

describe('AviseringService.nextNoticeNumber — org-scope (H1)', () => {
  it('filtrerar findMany på organizationId', async () => {
    const { service, findMany } = makeService([{ noticeNumber: 'AVI-2026-06-0003' }])
    await service.nextNoticeNumber('org-1', 2026, 6)
    expect(findMany.mock.calls[0][0].where).toMatchObject({
      organizationId: 'org-1',
      noticeNumber: { startsWith: 'AVI-2026-06-' },
    })
  })

  it('räknar nästa nummer från orgens egen max-sekvens', async () => {
    const { service } = makeService([
      { noticeNumber: 'AVI-2026-06-0001' },
      { noticeNumber: 'AVI-2026-06-0004' },
    ])
    expect(await service.nextNoticeNumber('org-1', 2026, 6)).toBe('AVI-2026-06-0005')
  })

  it('börjar på 0001 för en org utan tidigare avier (oberoende av andra orgar)', async () => {
    const { service } = makeService([])
    expect(await service.nextNoticeNumber('ny-org', 2026, 6)).toBe('AVI-2026-06-0001')
  })

  it('respekterar offset (deposition + första hyresavi samma månad)', async () => {
    const { service } = makeService([{ noticeNumber: 'AVI-2026-06-0001' }])
    expect(await service.nextNoticeNumber('org-1', 2026, 6, 1)).toBe('AVI-2026-06-0003')
  })
})
