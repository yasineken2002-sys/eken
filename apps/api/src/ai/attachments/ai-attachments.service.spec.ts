// StorageService drar in @aws-sdk/client-s3, som kedjar vidare till ett
// ESM-paket jest inte transformerar. Vi injicerar ändå en mock i konstruktorn —
// klassen behöver bara existera för DI-metadatan.
jest.mock('../../storage/storage.service', () => ({ StorageService: class {} }))

import { BadRequestException, NotFoundException } from '@nestjs/common'
import {
  AiAttachmentsService,
  attachmentKind,
  MAX_PENDING_ATTACHMENTS_PER_USER,
  MAX_ATTACHMENTS_PER_CONVERSATION,
  ATTACHMENT_TTL_MS,
} from './ai-attachments.service'

/**
 * B1 — uppladdningen av AI-bilagor.
 *
 * Sviten vaktar de fyra saker som gör endpointen ofarlig att ha öppen innan
 * chatten kan använda den:
 *   1. Filens FAKTISKA innehåll avgör typen — inte klientens påstående.
 *   2. Kvoterna hindrar att den blir gratis fillagring.
 *   3. Ingenting hamnar i R2 innan valideringen och kvoten har godkänt.
 *   4. Org-scopning: en bilaga kan inte hängas på ett annat samtal.
 */

const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(64, 0x20)])
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 0x00),
])
// En omdöpt HTML-fil: klienten kan påstå application/pdf hur mycket den vill.
const HTML = Buffer.from('<!doctype html><script>alert(1)</script>')

const ORG = 'org-1'
const USER = 'user-1'

function makeService(
  overrides: {
    pendingCount?: number
    conversationCount?: number
    conversation?: { id: string } | null
  } = {},
) {
  const count = jest
    .fn()
    .mockImplementation((args: { where: { conversationId?: string } }) =>
      Promise.resolve(
        args.where.conversationId !== undefined
          ? (overrides.conversationCount ?? 0)
          : (overrides.pendingCount ?? 0),
      ),
    )
  const create = jest
    .fn()
    .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({ id: 'att-1', ...data }),
    )
  const findFirst = jest
    .fn()
    .mockResolvedValue(
      overrides.conversation === undefined ? { id: 'conv-1' } : overrides.conversation,
    )
  const prisma = {
    aiAttachment: { count, create, findFirst: jest.fn(), delete: jest.fn(), findMany: jest.fn() },
    aiConversation: { findFirst },
  }
  const storage = {
    uploadFile: jest.fn().mockResolvedValue('https://r2/obj'),
    deleteFile: jest.fn().mockResolvedValue(undefined),
  }
  const service = new AiAttachmentsService(prisma as never, storage as never)
  return { service, prisma, storage, count, create }
}

describe('attachmentKind', () => {
  it('härleder bild/dokument ur MIME-typen — ingen egen kolumn att glida isär', () => {
    expect(attachmentKind('image/png')).toBe('image')
    expect(attachmentKind('image/webp')).toBe('image')
    expect(attachmentKind('application/pdf')).toBe('document')
  })
})

describe('AiAttachmentsService.upload', () => {
  it('accepterar PDF och returnerar den DETEKTERADE typen', async () => {
    const { service, storage, create } = makeService()
    const res = await service.upload({ buffer: PDF, filename: 'avtal.pdf' }, ORG, USER)

    expect(res).toMatchObject({
      id: 'att-1',
      kind: 'document',
      filename: 'avtal.pdf',
      mimeType: 'application/pdf',
      sizeBytes: PDF.length,
    })
    expect(storage.uploadFile).toHaveBeenCalledTimes(1)
    // Nyckeln är org-scopad och slumpad — filnamnet styr inte sökvägen.
    const [, key, mime] = storage.uploadFile.mock.calls[0] as [Buffer, string, string]
    expect(key.startsWith(`ai-chat/${ORG}/`)).toBe(true)
    expect(key).not.toContain('avtal')
    expect(mime).toBe('application/pdf')
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('accepterar bild och klassar den som image', async () => {
    const { service } = makeService()
    const res = await service.upload({ buffer: PNG, filename: 'foto.png' }, ORG, USER)
    expect(res.kind).toBe('image')
    expect(res.mimeType).toBe('image/png')
  })

  it('sätter expiresAt så att en oanvänd bilaga kan städas', async () => {
    const { service } = makeService()
    const before = Date.now()
    const res = await service.upload({ buffer: PDF, filename: 'a.pdf' }, ORG, USER)
    const ttl = new Date(res.expiresAt).getTime() - before
    expect(ttl).toBeGreaterThan(ATTACHMENT_TTL_MS - 5_000)
    expect(ttl).toBeLessThanOrEqual(ATTACHMENT_TTL_MS + 5_000)
  })

  it('AVVISAR en omdöpt HTML-fil — magiska byten, inte filändelsen', async () => {
    const { service, storage } = makeService()
    await expect(
      service.upload({ buffer: HTML, filename: 'faktura.pdf' }, ORG, USER),
    ).rejects.toThrow(BadRequestException)
    // Ingenting får ha hunnit till R2.
    expect(storage.uploadFile).not.toHaveBeenCalled()
  })

  it('AVVISAR ett format chatten inte kan skicka vidare (ZIP/Office)', async () => {
    const { service } = makeService()
    const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(32)])
    await expect(service.upload({ buffer: zip, filename: 'bunt.docx' }, ORG, USER)).rejects.toThrow(
      /matchar inte en tillåten filtyp/,
    )
  })

  it('AVVISAR en bild över Anthropics 5 MB-tak, men släpper igenom en lika stor PDF', async () => {
    const big = (head: Buffer) => Buffer.concat([head, Buffer.alloc(6 * 1024 * 1024, 0x20)])
    const { service } = makeService()
    await expect(
      service.upload({ buffer: big(PNG), filename: 'stor.png' }, ORG, USER),
    ).rejects.toThrow(/Bilden är för stor/)
    await expect(
      service.upload({ buffer: big(PDF), filename: 'stor.pdf' }, ORG, USER),
    ).resolves.toMatchObject({ kind: 'document' })
  })

  it('stoppar vid användarkvoten INNAN filen når lagringen', async () => {
    const { service, storage } = makeService({ pendingCount: MAX_PENDING_ATTACHMENTS_PER_USER })
    await expect(service.upload({ buffer: PDF, filename: 'a.pdf' }, ORG, USER)).rejects.toThrow(
      /max 10/,
    )
    expect(storage.uploadFile).not.toHaveBeenCalled()
  })

  it('stoppar vid konversationskvoten när ett samtal angetts', async () => {
    const { service } = makeService({ conversationCount: MAX_ATTACHMENTS_PER_CONVERSATION })
    await expect(
      service.upload({ buffer: PDF, filename: 'a.pdf' }, ORG, USER, 'conv-1'),
    ).rejects.toThrow(/max 20/)
  })

  it('vägrar hänga bilagan på ett samtal som inte tillhör org + användare', async () => {
    const { service, storage } = makeService({ conversation: null })
    await expect(
      service.upload({ buffer: PDF, filename: 'a.pdf' }, ORG, USER, 'annans-konversation'),
    ).rejects.toThrow(NotFoundException)
    expect(storage.uploadFile).not.toHaveBeenCalled()
  })

  it('kastar sökvägsdelar ur filnamnet', async () => {
    const { service, create } = makeService()
    await service.upload({ buffer: PDF, filename: '../../etc/passwd.pdf' }, ORG, USER)
    const { data } = create.mock.calls[0]![0] as { data: { filename: string } }
    expect(data.filename).toBe('passwd.pdf')
  })
})

describe('AiAttachmentsService.remove', () => {
  function makeRemovable(attachment: Record<string, unknown> | null) {
    const prisma = {
      aiAttachment: {
        findFirst: jest.fn().mockResolvedValue(attachment),
        delete: jest.fn().mockResolvedValue(undefined),
        count: jest.fn(),
        create: jest.fn(),
        findMany: jest.fn(),
      },
      aiConversation: { findFirst: jest.fn() },
    }
    const storage = { deleteFile: jest.fn().mockResolvedValue(undefined), uploadFile: jest.fn() }
    return { service: new AiAttachmentsService(prisma as never, storage as never), prisma, storage }
  }

  it('tar bort en oanvänd bilaga ur både R2 och databasen', async () => {
    const { service, prisma, storage } = makeRemovable({
      id: 'att-1',
      storageKey: 'ai-chat/org-1/x.pdf',
      consumedAt: null,
    })
    await service.remove('att-1', ORG, USER)
    expect(storage.deleteFile).toHaveBeenCalledWith('ai-chat/org-1/x.pdf')
    expect(prisma.aiAttachment.delete).toHaveBeenCalled()
  })

  it('vägrar radera en bilaga som redan skickats — historiken skulle bli oläsbar', async () => {
    const { service, storage } = makeRemovable({
      id: 'att-1',
      storageKey: 'k',
      consumedAt: new Date(),
    })
    await expect(service.remove('att-1', ORG, USER)).rejects.toThrow(/redan skickad/)
    expect(storage.deleteFile).not.toHaveBeenCalled()
  })

  it('läcker inte andra organisationers bilagor', async () => {
    const { service } = makeRemovable(null)
    await expect(service.remove('att-1', ORG, USER)).rejects.toThrow(NotFoundException)
  })
})

describe('AiAttachmentsService.cleanupExpiredAttachments', () => {
  function makeCleaner(rows: { id: string; storageKey: string }[], failOn?: string) {
    const prisma = {
      aiAttachment: {
        findMany: jest.fn().mockResolvedValue(rows),
        delete: jest.fn().mockResolvedValue(undefined),
        count: jest.fn(),
        create: jest.fn(),
        findFirst: jest.fn(),
      },
      aiConversation: { findFirst: jest.fn() },
    }
    const storage = {
      uploadFile: jest.fn(),
      deleteFile: jest
        .fn()
        .mockImplementation((key: string) =>
          key === failOn ? Promise.reject(new Error('R2 nere')) : Promise.resolve(undefined),
        ),
    }
    return { service: new AiAttachmentsService(prisma as never, storage as never), prisma, storage }
  }

  it('städar bara OKONSUMERADE och utgångna bilagor', async () => {
    const { service, prisma } = makeCleaner([{ id: 'a', storageKey: 'k-a' }])
    await service.cleanupExpiredAttachments()
    const where = (
      prisma.aiAttachment.findMany.mock.calls[0]![0] as { where: Record<string, unknown> }
    ).where
    expect(where['consumedAt']).toBeNull()
    expect(where['expiresAt']).toHaveProperty('lt')
  })

  it('låter en R2-miss stoppa EN bilaga, inte hela städningen', async () => {
    const { service, prisma } = makeCleaner(
      [
        { id: 'a', storageKey: 'k-a' },
        { id: 'b', storageKey: 'trasig' },
        { id: 'c', storageKey: 'k-c' },
      ],
      'trasig',
    )
    await service.cleanupExpiredAttachments()
    // b föll, a och c städades — raden för b ligger kvar till nästa körning.
    expect(prisma.aiAttachment.delete).toHaveBeenCalledTimes(2)
  })
})
