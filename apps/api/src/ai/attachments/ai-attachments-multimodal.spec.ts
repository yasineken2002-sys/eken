jest.mock('../../storage/storage.service', () => ({ StorageService: class {} }))

import { BadRequestException, NotFoundException } from '@nestjs/common'
import {
  AiAttachmentsService,
  ATTACHMENT_REF_BLOCK,
  isAttachmentRefBlock,
  MAX_REHYDRATE_BYTES,
} from './ai-attachments.service'

/**
 * B2 — vägen från bilage-id till Anthropic-innehållsblock.
 *
 * Fyra invarianter vaktas här:
 *   1. TEXT-ONLY ÄR OFÖRÄNDRAT — inga id:n ⇒ inga block, ingen R2-läsning.
 *   2. CROSS-ORG: ett id som inte tillhör (org, user) ger fel, aldrig innehåll.
 *   3. INGA BYTES I DATABASEN — det som persisteras är referenser.
 *   4. ENGÅNGSBRUK: en konsumerad bilaga kan inte skickas igen.
 */

const PDF_ROW = {
  id: 'att-pdf',
  storageKey: 'ai-chat/org-1/a.pdf',
  mimeType: 'application/pdf',
  filename: 'kontoutdrag.pdf',
  sizeBytes: 1024,
  consumedAt: null,
}
const IMG_ROW = {
  id: 'att-img',
  storageKey: 'ai-chat/org-1/b.png',
  mimeType: 'image/png',
  filename: 'matarbild.png',
  sizeBytes: 2048,
  consumedAt: null,
}

function makeService(rows: Record<string, unknown>[]) {
  const prisma = {
    aiAttachment: {
      findMany: jest
        .fn()
        .mockImplementation(({ where }: { where: { id: { in: string[] } } }) =>
          Promise.resolve(rows.filter((r) => where.id.in.includes(r['id'] as string))),
        ),
      updateMany: jest.fn().mockResolvedValue({ count: rows.length }),
      count: jest.fn(),
      create: jest.fn(),
      findFirst: jest.fn(),
      delete: jest.fn(),
    },
    aiConversation: { findFirst: jest.fn() },
  }
  const storage = {
    getFileBuffer: jest.fn().mockResolvedValue(Buffer.from('FILINNEHALL')),
    uploadFile: jest.fn(),
    deleteFile: jest.fn(),
  }
  return { service: new AiAttachmentsService(prisma as never, storage as never), prisma, storage }
}

describe('buildContentBlocks', () => {
  it('utan id:n: inga block och INGEN R2-läsning (text-only oförändrat)', async () => {
    const { service, storage, prisma } = makeService([])
    const res = await service.buildContentBlocks([], 'org-1', 'user-1')
    expect(res).toEqual({ contentBlocks: [], refBlocks: [], ids: [] })
    expect(storage.getFileBuffer).not.toHaveBeenCalled()
    expect(prisma.aiAttachment.findMany).not.toHaveBeenCalled()
  })

  it('PDF blir ett document-block med base64 och detekterad media_type', async () => {
    const { service } = makeService([PDF_ROW])
    const { contentBlocks } = await service.buildContentBlocks(['att-pdf'], 'org-1', 'user-1')
    expect(contentBlocks).toEqual([
      {
        type: 'document',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: Buffer.from('FILINNEHALL').toString('base64'),
        },
      },
    ])
  })

  it('bild blir ett image-block med sin egen media_type', async () => {
    const { service } = makeService([IMG_ROW])
    const { contentBlocks } = await service.buildContentBlocks(['att-img'], 'org-1', 'user-1')
    expect(contentBlocks[0]).toMatchObject({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png' },
    })
  })

  it('persisterar REFERENSER, aldrig bytes', async () => {
    const { service } = makeService([PDF_ROW])
    const { refBlocks } = await service.buildContentBlocks(['att-pdf'], 'org-1', 'user-1')
    expect(refBlocks).toEqual([
      {
        type: ATTACHMENT_REF_BLOCK,
        attachmentId: 'att-pdf',
        kind: 'document',
        filename: 'kontoutdrag.pdf',
        mimeType: 'application/pdf',
      },
    ])
    // Ingen base64 någonstans i det som ska ner i JSONB-kolumnen.
    expect(JSON.stringify(refBlocks)).not.toContain('base64')
    expect(JSON.stringify(refBlocks).length).toBeLessThan(300)
  })

  it('behåller anroparens ordning och deduplicerar id:n', async () => {
    const { service, storage } = makeService([PDF_ROW, IMG_ROW])
    const { contentBlocks, ids } = await service.buildContentBlocks(
      ['att-img', 'att-pdf', 'att-img'],
      'org-1',
      'user-1',
    )
    expect(ids).toEqual(['att-img', 'att-pdf'])
    expect(contentBlocks.map((b) => b.type)).toEqual(['image', 'document'])
    // Deduppad → samma bytes läses inte två gånger.
    expect(storage.getFileBuffer).toHaveBeenCalledTimes(2)
  })

  it('CROSS-ORG: ett id som inte matchar (org, user) ger fel — inget innehåll läses', async () => {
    // findMany filtrerar på org+user i queryn; mocken returnerar inget för
    // ett främmande id, vilket är precis vad databasen gör.
    const { service, storage } = makeService([PDF_ROW])
    await expect(service.buildContentBlocks(['annans-bilaga'], 'org-1', 'user-1')).rejects.toThrow(
      NotFoundException,
    )
    expect(storage.getFileBuffer).not.toHaveBeenCalled()
  })

  it('cross-org: ett giltigt PLUS ett främmande id avvisar HELA anropet', async () => {
    const { service, storage } = makeService([PDF_ROW])
    await expect(
      service.buildContentBlocks(['att-pdf', 'annans-bilaga'], 'org-1', 'user-1'),
    ).rejects.toThrow(/hittades inte/)
    expect(storage.getFileBuffer).not.toHaveBeenCalled()
  })

  it('org-scopningen ligger i queryn, inte i ett filter efteråt', async () => {
    const { service, prisma } = makeService([PDF_ROW])
    await service.buildContentBlocks(['att-pdf'], 'org-1', 'user-1')
    const where = (
      prisma.aiAttachment.findMany.mock.calls[0]![0] as { where: Record<string, unknown> }
    ).where
    expect(where['organizationId']).toBe('org-1')
    expect(where['userId']).toBe('user-1')
  })

  it('vägrar skicka en redan konsumerad bilaga en andra gång', async () => {
    const { service } = makeService([{ ...PDF_ROW, consumedAt: new Date() }])
    await expect(service.buildContentBlocks(['att-pdf'], 'org-1', 'user-1')).rejects.toThrow(
      BadRequestException,
    )
  })
})

describe('markConsumed', () => {
  it('sätter consumedAt och knyter bilagan till samtalet', async () => {
    const { service, prisma } = makeService([PDF_ROW])
    await service.markConsumed(['att-pdf'], 'conv-1')
    const arg = prisma.aiAttachment.updateMany.mock.calls[0]![0] as {
      where: Record<string, unknown>
      data: Record<string, unknown>
    }
    expect(arg.where['consumedAt']).toBeNull() // bara okonsumerade
    expect(arg.data['conversationId']).toBe('conv-1')
    expect(arg.data['consumedAt']).toBeInstanceOf(Date)
  })

  it('gör ingenting utan id:n', async () => {
    const { service, prisma } = makeService([])
    await service.markConsumed([], 'conv-1')
    expect(prisma.aiAttachment.updateMany).not.toHaveBeenCalled()
  })
})

describe('rehydrateHistoryBlocks', () => {
  it('lämnar block utan referenser orörda och läser inget ur R2', async () => {
    const { service, storage } = makeService([])
    const blocks = [{ type: 'text', text: 'hej' }]
    await expect(
      service.rehydrateHistoryBlocks(blocks, { remainingBytes: MAX_REHYDRATE_BYTES }),
    ).resolves.toEqual(blocks)
    expect(storage.getFileBuffer).not.toHaveBeenCalled()
  })

  it('översätter en referens tillbaka till ett riktigt block, textblocket kvar', async () => {
    const { service } = makeService([PDF_ROW])
    const out = await service.rehydrateHistoryBlocks(
      [
        {
          type: ATTACHMENT_REF_BLOCK,
          attachmentId: 'att-pdf',
          kind: 'document',
          filename: 'kontoutdrag.pdf',
          mimeType: 'application/pdf',
        },
        { type: 'text', text: 'Vad står på sista raden?' },
      ],
      { remainingBytes: MAX_REHYDRATE_BYTES },
    )
    expect(out[0]).toMatchObject({ type: 'document' })
    expect(out[1]).toEqual({ type: 'text', text: 'Vad står på sista raden?' })
    // Ingen Eveno-egen blocktyp får läcka vidare till Anthropic.
    expect(out.some(isAttachmentRefBlock)).toBe(false)
  })

  it('drar budgeten och degraderar till en NOTIS när den är slut — inte till tystnad', async () => {
    const { service } = makeService([PDF_ROW])
    const budget = { remainingBytes: 10 } // mindre än radens 1024 byte
    const out = await service.rehydrateHistoryBlocks(
      [
        {
          type: ATTACHMENT_REF_BLOCK,
          attachmentId: 'att-pdf',
          kind: 'document',
          filename: 'kontoutdrag.pdf',
          mimeType: 'application/pdf',
        },
      ],
      budget,
    )
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ type: 'text' })
    expect((out[0] as { text: string }).text).toContain('kontoutdrag.pdf')
    expect(budget.remainingBytes).toBe(10) // orörd — inget lästes
  })

  it('en R2-miss blir också en notis, historiken går fortfarande att läsa', async () => {
    const { service, storage } = makeService([PDF_ROW])
    storage.getFileBuffer.mockRejectedValue(new Error('R2 nere'))
    const out = await service.rehydrateHistoryBlocks(
      [
        {
          type: ATTACHMENT_REF_BLOCK,
          attachmentId: 'att-pdf',
          kind: 'document',
          filename: 'kontoutdrag.pdf',
          mimeType: 'application/pdf',
        },
      ],
      { remainingBytes: MAX_REHYDRATE_BYTES },
    )
    expect(out[0]).toMatchObject({ type: 'text' })
  })

  it('en referens till en raderad bilaga blir en notis, inte en krasch', async () => {
    const { service } = makeService([]) // raden finns inte längre
    const out = await service.rehydrateHistoryBlocks(
      [
        {
          type: ATTACHMENT_REF_BLOCK,
          attachmentId: 'borta',
          kind: 'image',
          filename: 'gammal.png',
          mimeType: 'image/png',
        },
      ],
      { remainingBytes: MAX_REHYDRATE_BYTES },
    )
    expect(out[0]).toMatchObject({ type: 'text' })
    expect((out[0] as { text: string }).text).toContain('gammal.png')
  })

  it('drar av läst storlek ur budgeten så ett långt samtal inte växer obegränsat', async () => {
    const { service } = makeService([PDF_ROW])
    const budget = { remainingBytes: MAX_REHYDRATE_BYTES }
    await service.rehydrateHistoryBlocks(
      [
        {
          type: ATTACHMENT_REF_BLOCK,
          attachmentId: 'att-pdf',
          kind: 'document',
          filename: 'k.pdf',
          mimeType: 'application/pdf',
        },
      ],
      budget,
    )
    expect(budget.remainingBytes).toBe(MAX_REHYDRATE_BYTES - PDF_ROW.sizeBytes)
  })
})
