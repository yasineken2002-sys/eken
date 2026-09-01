jest.mock('../../storage/storage.service', () => ({ StorageService: class {} }))

import { deflateSync } from 'node:zlib'
import { BadRequestException, PayloadTooLargeException } from '@nestjs/common'
import {
  AiAttachmentsService,
  ATTACHMENT_REF_BLOCK,
  CONSUMED_RETENTION_DAYS,
  MAX_ATTACHMENT_BUDGET_BYTES,
} from './ai-attachments.service'
import { MAX_AI_PDF_PAGES } from '../../common/utils/file-validation'
import { base64Bytes } from './request-size'

/**
 * B3 — härdningen av bilage-kedjan.
 *
 * Fem saker vaktas:
 *   1. TOTALA byte mot 32 MB — antalet bilagor räcker inte som skydd.
 *   2. Sidräkning: en 601-sidig PDF avvisas vid UPPLADDNING.
 *   3. Retention: konsumerade bilagor i vilande samtal städas; färska behålls.
 *   4. R2-läckan vid raderat samtal är stängd.
 *   5. Klientens Content-Type når aldrig fram — allt härrör ur magiska byten.
 */

function pdfWithPages(pages: number): Buffer {
  const kids = Array.from({ length: pages }, (_, i) => `${3 + i} 0 R`).join(' ')
  const objs = [
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
    `2 0 obj<</Type/Pages/Kids[${kids}]/Count ${pages}>>endobj`,
    ...Array.from({ length: pages }, (_, i) => `${3 + i} 0 obj<</Type/Page>>endobj`),
  ]
  return Buffer.from(`%PDF-1.4\n${objs.join('\n')}\ntrailer<</Root 1 0 R>>\n`, 'latin1')
}

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64),
])

function makeService(rows: Record<string, unknown>[] = []) {
  const prisma = {
    aiAttachment: {
      // Mocken respekterar `consumedAt` i where-satsen: de två städfrågorna är
      // disjunkta i verkligheten, och ett test som bortser från det hade
      // "bevisat" att oanvänd-städningen tar konsumerade rader.
      findMany: jest
        .fn()
        .mockImplementation(
          ({ where }: { where: { id?: { in: string[] }; consumedAt?: unknown } }) => {
            if (where.id?.in) {
              return Promise.resolve(rows.filter((r) => where.id!.in.includes(r['id'] as string)))
            }
            if (where.consumedAt === null) return Promise.resolve([]) // oanvända: inga i dessa test
            return Promise.resolve(rows)
          },
        ),
      create: jest
        .fn()
        .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({ id: 'att-1', ...data }),
        ),
      count: jest.fn().mockResolvedValue(0),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      update: jest.fn().mockResolvedValue({}),
      delete: jest.fn().mockResolvedValue({}),
      findFirst: jest.fn(),
    },
    aiConversation: { findFirst: jest.fn().mockResolvedValue({ id: 'conv-1' }) },
  }
  const storage = {
    uploadFile: jest.fn().mockResolvedValue('https://r2/obj'),
    getFileBuffer: jest.fn().mockResolvedValue(Buffer.from('data')),
    deleteFile: jest.fn().mockResolvedValue(undefined),
  }
  return {
    service: new AiAttachmentsService(
      prisma as never,
      storage as never,
      { report: jest.fn() } as never,
    ),
    prisma,
    storage,
  }
}

describe('1. totala byte mot 32 MB', () => {
  it('AVVISAR fem stora PDF:er vars SUMMA spränger taket — antalet är inom CHAT_MAX_ATTACHMENTS', () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({
      id: `a${i}`,
      storageKey: `k${i}`,
      mimeType: 'application/pdf',
      filename: `f${i}.pdf`,
      sizeBytes: 8 * 1024 * 1024,
      consumedAt: null,
    }))
    const { service, storage } = makeService(rows)
    return service
      .buildContentBlocks(
        rows.map((r) => r.id),
        'org-1',
        'user-1',
      )
      .then(
        () => fail('skulle ha kastat'),
        (error: unknown) => {
          expect(error).toBeInstanceOf(PayloadTooLargeException)
          // Ingen byte får ha lästs ur lagringen innan taket kollades.
          expect(storage.getFileBuffer).not.toHaveBeenCalled()
        },
      )
  })

  it('släpper igenom samma antal filer när summan får plats', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({
      id: `a${i}`,
      storageKey: `k${i}`,
      mimeType: 'application/pdf',
      filename: `f${i}.pdf`,
      sizeBytes: 1024 * 1024,
      consumedAt: null,
    }))
    const { service } = makeService(rows)
    const res = await service.buildContentBlocks(
      rows.map((r) => r.id),
      'org-1',
      'user-1',
    )
    expect(res.contentBlocks).toHaveLength(5)
    expect(res.encodedBytes).toBe(5 * base64Bytes(1024 * 1024))
  })

  it('rapporterar kodade byte så historiken kan få resten av budgeten', async () => {
    const rows = [
      {
        id: 'a',
        storageKey: 'k',
        mimeType: 'application/pdf',
        filename: 'f.pdf',
        sizeBytes: 3 * 1024 * 1024,
        consumedAt: null,
      },
    ]
    const { service } = makeService(rows)
    const { encodedBytes } = await service.buildContentBlocks(['a'], 'org-1', 'user-1')
    // Kodat, inte rått — 3 MB råa blir 4 MB på tråden.
    expect(encodedBytes).toBe(4 * 1024 * 1024)
    expect(MAX_ATTACHMENT_BUDGET_BYTES - encodedBytes).toBeLessThan(MAX_ATTACHMENT_BUDGET_BYTES)
  })
})

describe('2. sidräkning vid uppladdning', () => {
  it(`AVVISAR en PDF med ${MAX_AI_PDF_PAGES + 1} sidor med ett tydligt fel`, async () => {
    const { service, storage } = makeService()
    await expect(
      service.upload(
        { buffer: pdfWithPages(MAX_AI_PDF_PAGES + 1), filename: 'lang.pdf' },
        'o',
        'u',
      ),
    ).rejects.toThrow(new RegExp(`${MAX_AI_PDF_PAGES + 1} sidor`))
    // Avvisad före lagring.
    expect(storage.uploadFile).not.toHaveBeenCalled()
  })

  it(`släpper igenom exakt ${MAX_AI_PDF_PAGES} sidor och sparar antalet`, async () => {
    const { service, prisma } = makeService()
    const res = await service.upload(
      { buffer: pdfWithPages(MAX_AI_PDF_PAGES), filename: 'ok.pdf' },
      'o',
      'u',
    )
    expect(res.pageCount).toBe(MAX_AI_PDF_PAGES)
    const { data } = prisma.aiAttachment.create.mock.calls[0]![0] as {
      data: { pageCount: number | null }
    }
    expect(data.pageCount).toBe(MAX_AI_PDF_PAGES)
  })

  it('räknar även en PDF vars sidträd ligger i en komprimerad objektström', async () => {
    const stream = deflateSync(Buffer.from('<</Type/Pages/Count 9/Kids[]>>', 'latin1'))
    const pdf = Buffer.concat([
      Buffer.from('%PDF-1.5\n4 0 obj<</Type/ObjStm/Filter/FlateDecode>>stream\n', 'latin1'),
      stream,
      Buffer.from('\nendstream endobj\n', 'latin1'),
    ])
    const { service } = makeService()
    const res = await service.upload({ buffer: pdf, filename: 'chrome.pdf' }, 'o', 'u')
    expect(res.pageCount).toBe(9)
  })

  it('släpper fram en oräknelig PDF med pageCount null i stället för att blockera', async () => {
    const { service } = makeService()
    const res = await service.upload(
      { buffer: Buffer.from('%PDF-1.7\nsaknar sidträd\n', 'latin1'), filename: 'udda.pdf' },
      'o',
      'u',
    )
    expect(res.pageCount).toBeNull()
  })

  it('bilder får ingen sidräkning', async () => {
    const { service } = makeService()
    const res = await service.upload({ buffer: PNG, filename: 'bild.png' }, 'o', 'u')
    expect(res.pageCount).toBeNull()
    expect(res.kind).toBe('image')
  })
})

describe('3. retention för konsumerade bilagor', () => {
  it('väljer konsumerade bilagor vars SAMTAL varit stilla längre än fristen', async () => {
    const { service, prisma } = makeService([])
    await service.cleanupExpiredAttachments()

    // Andra findMany-anropet är de konsumerade.
    const consumedWhere = (
      prisma.aiAttachment.findMany.mock.calls[1]![0] as { where: Record<string, unknown> }
    ).where
    expect(consumedWhere['consumedAt']).toEqual({ not: null })
    const conv = consumedWhere['conversation'] as { updatedAt: { lt: Date } }
    const days = (Date.now() - conv.updatedAt.lt.getTime()) / (24 * 60 * 60 * 1000)
    expect(Math.round(days)).toBe(CONSUMED_RETENTION_DAYS)
  })

  it('fristen räknas på SAMTALETS updatedAt, inte på bilagans ålder', async () => {
    const { service, prisma } = makeService([])
    await service.cleanupExpiredAttachments()
    const consumedWhere = (
      prisma.aiAttachment.findMany.mock.calls[1]![0] as { where: Record<string, unknown> }
    ).where
    // Ett aktivt samtal behåller sina bilagor hur gamla de än är.
    expect(consumedWhere['createdAt']).toBeUndefined()
    expect(consumedWhere['expiresAt']).toBeUndefined()
    expect(consumedWhere['conversation']).toBeDefined()
  })

  it('tar bort FILEN men behåller RADEN — historiken ska kunna säga att en bilaga fanns', async () => {
    const { service, prisma, storage } = makeService([{ id: 'gammal', storageKey: 'k-gammal' }])
    await service.cleanupExpiredAttachments()
    expect(storage.deleteFile).toHaveBeenCalledWith('k-gammal')
    const update = prisma.aiAttachment.update.mock.calls[0]![0] as {
      data: { storageKey: string }
    }
    expect(update.data.storageKey).toBe('')
    expect(prisma.aiAttachment.delete).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'gammal' } }),
    )
  })

  it('plockar inte upp en redan städad bilaga igen', async () => {
    const { service, prisma } = makeService([])
    await service.cleanupExpiredAttachments()
    const consumedWhere = (
      prisma.aiAttachment.findMany.mock.calls[1]![0] as { where: Record<string, unknown> }
    ).where
    expect(consumedWhere['storageKey']).toEqual({ not: '' })
  })

  it('rehydreringen hoppar över en städad bilaga och lämnar sin notis', async () => {
    const { service, storage } = makeService([
      { id: 'stadad', storageKey: '', sizeBytes: 100, mimeType: 'application/pdf' },
    ])
    const out = await service.rehydrateHistoryBlocks(
      [
        {
          type: ATTACHMENT_REF_BLOCK,
          attachmentId: 'stadad',
          kind: 'document',
          filename: 'gammal.pdf',
          mimeType: 'application/pdf',
        },
      ],
      { remainingBytes: MAX_ATTACHMENT_BUDGET_BYTES },
    )
    expect(storage.getFileBuffer).not.toHaveBeenCalled()
    expect(out[0]).toMatchObject({ type: 'text' })
    expect((out[0] as { text: string }).text).toContain('gammal.pdf')
  })
})

describe('4. R2-läckan vid raderat samtal', () => {
  it('tar bort samtalets filer ur lagringen', async () => {
    const { service, storage } = makeService([
      { id: 'a', storageKey: 'k-a' },
      { id: 'b', storageKey: 'k-b' },
    ])
    await service.deleteConversationFiles('conv-1')
    expect(storage.deleteFile).toHaveBeenCalledWith('k-a')
    expect(storage.deleteFile).toHaveBeenCalledWith('k-b')
  })

  it('låter en R2-miss inte stoppa raderingen — användaren har bett om det', async () => {
    const { service, storage } = makeService([
      { id: 'a', storageKey: 'trasig' },
      { id: 'b', storageKey: 'k-b' },
    ])
    storage.deleteFile.mockImplementation((k: string) =>
      k === 'trasig' ? Promise.reject(new Error('R2 nere')) : Promise.resolve(undefined),
    )
    await expect(service.deleteConversationFiles('conv-1')).resolves.toBeUndefined()
    expect(storage.deleteFile).toHaveBeenCalledTimes(2)
  })
})

describe('5. klientens Content-Type når aldrig fram', () => {
  it('lagringsnyckelns filändelse kommer från DETEKTERAD typ, inte filnamnet', async () => {
    const { service, storage } = makeService()
    // Klienten påstår .exe; innehållet är en PNG.
    await service.upload({ buffer: PNG, filename: 'trojan.exe' }, 'org-1', 'user-1')
    const [, key, mime] = storage.uploadFile.mock.calls[0] as [Buffer, string, string]
    expect(key.endsWith('.png')).toBe(true)
    expect(key).not.toContain('.exe')
    expect(mime).toBe('image/png')
  })

  it('visningsnamnet behåller användarens original', async () => {
    const { service, prisma } = makeService()
    const res = await service.upload({ buffer: PNG, filename: 'trojan.exe' }, 'o', 'u')
    expect(res.filename).toBe('trojan.exe')
    const { data } = prisma.aiAttachment.create.mock.calls[0]![0] as {
      data: { mimeType: string }
    }
    // …men den lagrade TYPEN är den detekterade, inte den påstådda.
    expect(data.mimeType).toBe('image/png')
  })

  it('media_type SMALNAS AV, kastar hellre än att skicka något ostött vidare', async () => {
    const { service } = makeService([
      {
        id: 'a',
        storageKey: 'k',
        mimeType: 'image/tiff', // kan bara uppstå om allowlisten vidgas slarvigt
        filename: 'x.tiff',
        sizeBytes: 100,
        consumedAt: null,
      },
    ])
    await expect(service.buildContentBlocks(['a'], 'org-1', 'user-1')).rejects.toThrow(
      BadRequestException,
    )
  })
})
