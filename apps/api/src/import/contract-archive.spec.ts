// AWS-SDK:n går inte att ladda under jest (ESM-parsning i @aws-sdk/xml-builder).
// Samma mock som resten av kodbasen använder — tjänsten injiceras ändå som stubb
// i testerna, så bara klassidentiteten behövs.
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { Logger } from '@nestjs/common'
import * as crypto from 'crypto'
import { ContractArchiveService, extensionFor } from './contract-archive.service'
import type { PrismaService } from '../common/prisma/prisma.service'
import type { StorageService } from '../storage/storage.service'

const BYTES = Buffer.from('%PDF-1.7 ett kontrakt')

function rigg(overrides?: { uploadFail?: boolean; deleteFail?: boolean; updateFail?: boolean }) {
  const created: Array<Record<string, unknown>> = []
  const prisma = {
    document: {
      create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        created.push(data)
        return Promise.resolve({ id: 'doc-1' })
      }),
      update: overrides?.updateFail
        ? jest.fn().mockRejectedValue(new Error('rad borta'))
        : jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([
        { id: 'doc-1', storageKey: 'documents/org-1/a.pdf' },
        { id: 'doc-2', storageKey: 'documents/org-1/b.pdf' },
      ]),
      deleteMany: jest.fn().mockResolvedValue({ count: 2 }),
    },
  }
  const storage = {
    uploadFile: overrides?.uploadFail
      ? jest.fn().mockRejectedValue(new Error('R2 nere'))
      : jest.fn().mockResolvedValue('https://r2/x'),
    deleteFile: overrides?.deleteFail
      ? jest.fn().mockRejectedValue(new Error('R2 nere'))
      : jest.fn().mockResolvedValue(undefined),
  }
  const service = new ContractArchiveService(
    prisma as unknown as PrismaService,
    storage as unknown as StorageService,
  )
  return { service, prisma, storage, created }
}

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
})
afterEach(() => jest.restoreAllMocks())

describe('ContractArchiveService.archive', () => {
  it('laddar upp till R2 och skapar en Document-rad', async () => {
    const { service, storage, prisma } = rigg()
    const res = await service.archive({
      buffer: BYTES,
      fileName: 'anna.pdf',
      mimeType: 'application/pdf',
      organizationId: 'org-1',
      uploadedById: 'user-1',
    })
    expect(res.documentId).toBe('doc-1')
    expect(storage.uploadFile).toHaveBeenCalledTimes(1)
    expect(prisma.document.create).toHaveBeenCalledTimes(1)
  })

  it('contentHash är SHA-256 över de faktiska bytena', async () => {
    const { service, created } = rigg()
    const res = await service.archive({
      buffer: BYTES,
      fileName: 'a.pdf',
      mimeType: 'application/pdf',
      organizationId: 'org-1',
    })
    const väntad = crypto.createHash('sha256').update(BYTES).digest('hex')
    expect(res.contentHash).toBe(väntad)
    expect(created[0]!['contentHash']).toBe(väntad)
    // Diskriminerande: andra bytes ger en annan hash.
    const annan = crypto.createHash('sha256').update(Buffer.from('annat')).digest('hex')
    expect(res.contentHash).not.toBe(annan)
  })

  it('KANARIEFÅGEL: signaturmetadata och versionskedja fylls ALDRIG', async () => {
    // Att fylla dem vore att påstå att Eveno bevittnat en signering det aldrig
    // sett. Utan det här testet kan en framtida "förbättring" spegla den
    // genererade vägen för fullständigt och göra arkivet till ett falskt intyg.
    const { service, created } = rigg()
    await service.archive({
      buffer: BYTES,
      fileName: 'a.pdf',
      mimeType: 'application/pdf',
      organizationId: 'org-1',
    })
    for (const fält of [
      'signedAt',
      'signedByTenantId',
      'signedFromIp',
      'signedUserAgent',
      'signatureName',
      'previousVersionId',
      'locked',
      'templateInputHash',
    ]) {
      expect(created[0]).not.toHaveProperty(fält)
    }
  })

  it('kategoriseras som CONTRACT och bär det faktiska formatet', async () => {
    const { service, created } = rigg()
    await service.archive({
      buffer: BYTES,
      fileName: 'foto.jpg',
      mimeType: 'image/jpeg',
      organizationId: 'org-1',
    })
    expect(created[0]!['category']).toBe('CONTRACT')
    // Uppladdningen tillåter bild — arkivet får inte påstå att allt är PDF.
    expect(created[0]!['mimeType']).toBe('image/jpeg')
    expect(created[0]!['fileSize']).toBe(BYTES.length)
  })

  it('lagringsnyckeln är org-scopad och slumpad (filnamnet återanvänds inte)', async () => {
    const { service, created } = rigg()
    await service.archive({
      buffer: BYTES,
      fileName: '../../etc/passwd',
      mimeType: 'application/pdf',
      organizationId: 'org-1',
    })
    const key = String(created[0]!['storageKey'])
    expect(key.startsWith('documents/org-1/')).toBe(true)
    expect(key).not.toContain('passwd')
    expect(key).not.toContain('..')
  })

  it('utan uploadedById utelämnas fältet helt (ingen länk till obefintlig User)', async () => {
    const { service, created } = rigg()
    await service.archive({
      buffer: BYTES,
      fileName: 'a.pdf',
      mimeType: 'application/pdf',
      organizationId: 'org-1',
    })
    expect(created[0]).not.toHaveProperty('uploadedById')
  })

  it('kastar om R2 failar — ingen Document-rad utan fil bakom sig', async () => {
    const { service, prisma } = rigg({ uploadFail: true })
    await expect(
      service.archive({
        buffer: BYTES,
        fileName: 'a.pdf',
        mimeType: 'application/pdf',
        organizationId: 'org-1',
      }),
    ).rejects.toThrow()
    expect(prisma.document.create).not.toHaveBeenCalled()
  })
})

describe('ContractArchiveService.linkToLease', () => {
  it('kopplar dokumentet till avtalet', async () => {
    const { service, prisma } = rigg()
    await service.linkToLease('doc-1', { leaseId: 'lease-1', unitId: 'unit-1' })
    expect(prisma.document.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ leaseId: 'lease-1' }) }),
    )
  })

  it('kastar INTE om kopplingen failar — avtalet får inte rullas tillbaka', async () => {
    const { service } = rigg({ updateFail: true })
    await expect(service.linkToLease('doc-1', { leaseId: 'lease-1' })).resolves.toBeUndefined()
  })
})

describe('ContractArchiveService.purge', () => {
  it('tar bort både R2-objektet och raden', async () => {
    const { service, storage, prisma } = rigg()
    await service.purge(['doc-1', 'doc-2'])
    expect(storage.deleteFile).toHaveBeenCalledTimes(2)
    expect(prisma.document.deleteMany).toHaveBeenCalledTimes(1)
  })

  it('tar bort raden även om R2-anropet failar', async () => {
    // En kvarglömd fil utan Document är oåtkomlig via API:t; en kvarlämnad rad
    // pekar på något som kanske inte finns.
    const { service, prisma } = rigg({ deleteFail: true })
    await service.purge(['doc-1'])
    expect(prisma.document.deleteMany).toHaveBeenCalledTimes(1)
  })

  it('tom lista rör ingenting', async () => {
    const { service, storage, prisma } = rigg()
    await service.purge([])
    expect(storage.deleteFile).not.toHaveBeenCalled()
    expect(prisma.document.findMany).not.toHaveBeenCalled()
  })
})

describe('extensionFor', () => {
  it('mappar de tillåtna formaten', () => {
    expect(extensionFor('application/pdf')).toBe('.pdf')
    expect(extensionFor('image/jpeg')).toBe('.jpg')
    expect(extensionFor('image/png')).toBe('.png')
    expect(extensionFor('image/webp')).toBe('.webp')
  })

  it('okänd typ får INGEN påhittad ändelse', () => {
    expect(extensionFor('application/x-msdownload')).toBe('')
    expect(extensionFor('')).toBe('')
  })
})
