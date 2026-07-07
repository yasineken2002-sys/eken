/**
 * IDOR-svep (#5/#19-klassen): documents.upload applicerade klient-skickade
 * relations-id (propertyId/unitId/leaseId/tenantId) RÅTT → org A kunde koppla ett
 * dokument till org B:s fastighet/enhet/avtal/hyresgäst. Fix: org-scopad validering
 * INNAN R2-uppladdning + skrivning.
 *
 * Bevisar: främmande orgs id → 404 + varken R2-upload eller document.create; egen
 * orgs id → funkar.
 */

jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../common/utils/file-validation', () => ({
  validateUploadedFile: jest.fn(),
  DETECTED_DOCUMENT_TYPES: [],
  MAX_DOCUMENT_BYTES: 20_000_000,
}))

import { NotFoundException } from '@nestjs/common'
import { DocumentsService } from './documents.service'

const FILE = {
  buffer: Buffer.from('%PDF-1.4'),
  filename: 'x.pdf',
  mimetype: 'application/pdf',
  size: 100,
}

function make() {
  const prisma = {
    property: { findFirst: jest.fn() },
    unit: { findFirst: jest.fn() },
    lease: { findFirst: jest.fn() },
    tenant: { findFirst: jest.fn() },
    document: { create: jest.fn().mockResolvedValue({ id: 'd1' }) },
  }
  const storage = { uploadFile: jest.fn().mockResolvedValue('https://r2/x') }
  const service = new DocumentsService(prisma as never, {} as never, storage as never)
  return { service, prisma, storage }
}

describe('DocumentsService.upload — org-isolation av relations-id (#5)', () => {
  it('främmande orgs tenantId → 404, varken R2-upload eller document.create', async () => {
    const { service, prisma, storage } = make()
    prisma.tenant.findFirst.mockResolvedValue(null)
    await expect(
      service.upload(FILE, { name: 'x', tenantId: 't-B' } as never, 'org-A', 'u1'),
    ).rejects.toBeInstanceOf(NotFoundException)
    expect(storage.uploadFile).not.toHaveBeenCalled()
    expect(prisma.document.create).not.toHaveBeenCalled()
  })

  it('främmande orgs leaseId → 404 (org-scopat via organizationId)', async () => {
    const { service, prisma } = make()
    prisma.lease.findFirst.mockResolvedValue(null)
    await expect(
      service.upload(FILE, { name: 'x', leaseId: 'l-B' } as never, 'org-A', 'u1'),
    ).rejects.toBeInstanceOf(NotFoundException)
    expect(prisma.document.create).not.toHaveBeenCalled()
  })

  it('egen orgs id → dokument skapas', async () => {
    const { service, prisma, storage } = make()
    prisma.property.findFirst.mockResolvedValue({ id: 'p-A' })
    prisma.tenant.findFirst.mockResolvedValue({ id: 't-A' })
    await service.upload(
      FILE,
      { name: 'x', propertyId: 'p-A', tenantId: 't-A' } as never,
      'org-A',
      'u1',
    )
    expect(storage.uploadFile).toHaveBeenCalledTimes(1)
    expect(prisma.document.create).toHaveBeenCalledTimes(1)
  })
})
