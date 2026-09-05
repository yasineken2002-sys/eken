/**
 * SKICKA DOKUMENT TILL HYRESGÄST — org-scopingen och att leveransen går genom
 * SAMMA primitiv som AI-verktyget.
 *
 * ── VARFÖR 404 OCH INTE 403 ─────────────────────────────────────────────────
 *
 * Ett 403 på ett dokument i en annan organisation svarar på frågan "finns det?"
 * — och den frågan går att ställa i tusental. Skillnaden mellan 403 och 404 är
 * hela läckan: den ena bekräftar existens, den andra gör det inte.
 *
 * ── VAD PROVET INTE KAN SE ──────────────────────────────────────────────────
 *
 * Att controllern har `@Roles('MANAGER','ADMIN','OWNER')`. Det ägs av
 * `authz-surface.golden.txt`, som räknar upp varje rollgrindad rutt och fäller
 * på en ändrad mängd.
 */

// aws-sdk:s ESM-utgåva går inte att parsa i jest — samma mock som övriga specar
// som råkar dra in StorageService via importkedjan.
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))

import { NotFoundException } from '@nestjs/common'
import { DocumentsService } from './documents.service'

const DOKUMENT = {
  id: 'doc-1',
  organizationId: 'org-1',
  name: 'Trivselregler',
  mimeType: 'application/pdf',
  storageKey: 'documents/org-1/abc_trivselregler.pdf',
  category: 'HOUSE_RULES',
}

function makeService(dokument: typeof DOKUMENT | null) {
  const prisma = {
    document: { findFirst: jest.fn().mockResolvedValue(dokument) },
  }
  const storage = {
    getFileBuffer: jest.fn().mockResolvedValue(Buffer.from('PDF-innehåll')),
  }
  const delivery = {
    deliverToTenant: jest.fn().mockResolvedValue({ documentId: 'levererat-1' }),
  }
  const service = new DocumentsService(
    prisma as never,
    {} as never,
    storage as never,
    delivery as never,
  )
  return { service, prisma, storage, delivery }
}

describe('DocumentsService.sendToTenant', () => {
  it('levererar genom deliverToTenant — samma primitiv som verktyget', async () => {
    const { service, delivery } = makeService(DOKUMENT)

    const res = await service.sendToTenant({
      documentId: 'doc-1',
      tenantId: 'tenant-1',
      organizationId: 'org-1',
      notify: true,
    })

    expect(delivery.deliverToTenant).toHaveBeenCalledTimes(1)
    expect(res).toEqual({ documentId: 'levererat-1' })
  })

  it('skickar dokumentets EGNA uppgifter vidare, inte klientens', async () => {
    // Filnamn, visningsnamn, mimetyp och kategori kommer ur den lagrade raden.
    // Klienten skickar bara `tenantId` och `notify` — det finns ingen väg att
    // låta ett dokument utge sig för att vara ett annat.
    const { service, delivery } = makeService(DOKUMENT)
    await service.sendToTenant({
      documentId: 'doc-1',
      tenantId: 'tenant-1',
      organizationId: 'org-1',
    })
    const arg = delivery.deliverToTenant.mock.calls[0]?.[0] as Record<string, unknown>
    expect(arg.organizationId).toBe('org-1')
    expect(arg.tenantId).toBe('tenant-1')
    // `fileName` bär VISNINGSNAMNET, inte ett filnamn: Document har ingen
    // fileName-kolumn, och deliverToTenant läser aldrig fältet (uppmätt: en
    // förekomst i filen, i typdeklarationen). Provet fastnaglar det så att
    // nästa läsare inte tror att ett filnamn styr något.
    expect(arg.fileName).toBe('Trivselregler')
    expect(arg.name).toBe('Trivselregler')
    expect(arg.mimeType).toBe('application/pdf')
    expect(arg.category).toBe('HOUSE_RULES')
    expect(Buffer.isBuffer(arg.content)).toBe(true)
  })

  it('ORG-SCOPING: uppslaget bär organizationId — en annan orgs dokument hittas inte', async () => {
    const { service, prisma } = makeService(DOKUMENT)
    await service.sendToTenant({
      documentId: 'doc-1',
      tenantId: 'tenant-1',
      organizationId: 'org-1',
    })
    expect(prisma.document.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'doc-1', organizationId: 'org-1' }),
      }),
    )
  })

  it('en ANNAN orgs dokument ger 404 — aldrig 403 som avslöjar att det finns', async () => {
    const { service, storage, delivery } = makeService(null)

    await expect(
      service.sendToTenant({
        documentId: 'doc-i-annan-org',
        tenantId: 'tenant-1',
        organizationId: 'org-1',
      }),
    ).rejects.toBeInstanceOf(NotFoundException)

    // Och ingenting hann hända: varken filen lästes eller något levererades.
    // Ett prov på enbart felkoden hade inte sett en läsning som skedde ändå.
    expect(storage.getFileBuffer).not.toHaveBeenCalled()
    expect(delivery.deliverToTenant).not.toHaveBeenCalled()
  })

  it('MOTPROV: samma anrop med rätt org lyckas — annars mäter provet ovan ingenting', () => {
    // Utan den här raden är "404 för fel org" lika förenligt med "metoden
    // kastar alltid".
    const { service } = makeService(DOKUMENT)
    return expect(
      service.sendToTenant({
        documentId: 'doc-1',
        tenantId: 'tenant-1',
        organizationId: 'org-1',
      }),
    ).resolves.toEqual({ documentId: 'levererat-1' })
  })

  it('notify utelämnas i tjänsten — controllern äger defaulten', async () => {
    // Tjänsten skickar bara vidare det den fått. Att UTELÄMNAD betyder JA
    // avgörs i controllern (`dto.notify !== false`), som normaliserar till
    // AI-verktygets default. Delas den regeln på två ställen glider de isär.
    const { service, delivery } = makeService(DOKUMENT)
    await service.sendToTenant({
      documentId: 'doc-1',
      tenantId: 'tenant-1',
      organizationId: 'org-1',
    })
    expect(delivery.deliverToTenant.mock.calls[0]?.[0]).not.toHaveProperty('notify')
  })

  it('notify: false skickas vidare — hyresvärden kan välja att inte mejla', async () => {
    const { service, delivery } = makeService(DOKUMENT)
    await service.sendToTenant({
      documentId: 'doc-1',
      tenantId: 'tenant-1',
      organizationId: 'org-1',
      notify: false,
    })
    expect(delivery.deliverToTenant.mock.calls[0]?.[0]).toMatchObject({ notify: false })
  })
})

/**
 * CONTROLLERN ÄGER `notify`-DEFAULTEN, och det provas här för att skillnaden
 * annars bara syns för en hyresgäst som undrar varför hen inte fick ett mejl.
 *
 * `deliverToTenant` gör `if (input.notify && …)` — utelämnad betyder NEJ där.
 * AI-verktyget sätter `notifyTenant !== false` — utelämnad betyder JA. Samma
 * fält, motsatt innebörd. Controllern normaliserar till verktygets default så
 * att de två vägarna gör samma sak.
 */
describe('DocumentsController.sendToTenant — utelämnad notify betyder JA', () => {
  function makeController() {
    const service = { sendToTenant: jest.fn().mockResolvedValue({ documentId: 'd-1' }) }
    // Controllern konstrueras direkt; den har inget annat beroende.
    const { DocumentsController } = jest.requireActual<{
      DocumentsController: new (s: unknown) => {
        sendToTenant: (
          id: string,
          orgId: string,
          dto: { tenantId: string; notify?: boolean },
        ) => Promise<unknown>
      }
    }>('./documents.controller')
    return { controller: new DocumentsController(service), service }
  }

  it('utelämnad → true (samma som verktygets notifyTenant !== false)', async () => {
    const { controller, service } = makeController()
    await controller.sendToTenant('doc-1', 'org-1', { tenantId: 't-1' })
    expect(service.sendToTenant.mock.calls[0]?.[0]).toMatchObject({ notify: true })
  })

  it('explicit false → false', async () => {
    const { controller, service } = makeController()
    await controller.sendToTenant('doc-1', 'org-1', { tenantId: 't-1', notify: false })
    expect(service.sendToTenant.mock.calls[0]?.[0]).toMatchObject({ notify: false })
  })

  it('explicit true → true', async () => {
    const { controller, service } = makeController()
    await controller.sendToTenant('doc-1', 'org-1', { tenantId: 't-1', notify: true })
    expect(service.sendToTenant.mock.calls[0]?.[0]).toMatchObject({ notify: true })
  })
})
