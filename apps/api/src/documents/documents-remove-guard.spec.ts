/**
 * remove()-spärr (Item 4, S1): ett låst eller signerat kontrakt är juridiskt
 * bevisunderlag och får ALDRIG hårdraderas — annars förstörs beviskedjan bakom
 * en BankID-signatur.
 */

jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { ForbiddenException } from '@nestjs/common'
import { DocumentsService } from './documents.service'

function makeService(doc: Record<string, unknown> | null) {
  const prisma = {
    document: {
      findFirst: jest.fn().mockResolvedValue(doc),
      delete: jest.fn().mockResolvedValue({}),
    },
  }
  const storage = { deleteFile: jest.fn().mockResolvedValue(undefined) }
  const service = new DocumentsService(prisma as never, {} as never, storage as never)
  return { service, prisma, storage }
}

const base = {
  id: 'doc-1',
  organizationId: 'org-1',
  storageKey: 'k',
  category: 'OTHER',
  locked: false,
  signedAt: null,
}

describe('DocumentsService.remove — skydd av signerade/låsta kontrakt', () => {
  it('vägrar radera ett LÅST dokument', async () => {
    const { service, prisma, storage } = makeService({ ...base, locked: true })
    await expect(service.remove('doc-1', 'org-1')).rejects.toBeInstanceOf(ForbiddenException)
    expect(prisma.document.delete).not.toHaveBeenCalled()
    expect(storage.deleteFile).not.toHaveBeenCalled()
  })

  it('vägrar radera ett SIGNERAT CONTRACT (signedAt satt)', async () => {
    const { service, prisma } = makeService({
      ...base,
      category: 'CONTRACT',
      signedAt: new Date(),
    })
    await expect(service.remove('doc-1', 'org-1')).rejects.toBeInstanceOf(ForbiddenException)
    expect(prisma.document.delete).not.toHaveBeenCalled()
  })

  it('tillåter radering av ett olåst, osignerat dokument (befintligt beteende)', async () => {
    const { service, prisma, storage } = makeService({ ...base })
    await service.remove('doc-1', 'org-1')
    expect(storage.deleteFile).toHaveBeenCalledWith('k')
    expect(prisma.document.delete).toHaveBeenCalledWith({ where: { id: 'doc-1' } })
  })
})
