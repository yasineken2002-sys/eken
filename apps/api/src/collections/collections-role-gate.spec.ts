/**
 * R1 — BEHÖRIGHETSGRÄNSEN MOT INKASSO.
 *
 * Problemet som stängdes: `RolesGuard` VAR hierarkisk när R1 skrevs, så
 * `@Roles('OWNER','ADMIN','ACCOUNTANT')` betydde "ACCOUNTANT och uppåt" — och
 * MANAGER (nivå 3) låg ÖVER ACCOUNTANT (nivå 2). Dekoratorn kunde alltså aldrig
 * utesluta MANAGER, och tjänsterna hade ingen egen kontroll. En förvaltare kunde
 * lämna över en hyresgästs skuld till inkasso.
 *
 * R2 steg 2 tog bort hierarkin — en lista kan numera utesluta MANAGER på egen
 * hand. Det gör INTE testerna nedan överflödiga: de går på tjänsten, som är den
 * enda punkt varje anropare passerar.
 *
 * Testerna nedan går därför på TJÄNSTEN, inte på controllern — det är där
 * gränsen ligger, och det är den vägen en framtida intern anropare eller ett
 * AI-verktyg tar. Ett test som bara verifierat dekoratorn hade missat hela felet.
 *
 * Gränsen: LÄSA och PAUSA är förvaltning (reversibelt, hyresgästkontakt).
 * EXPORTERA och MARKERA SKICKAD är ekonomi (bindande, oåterkalleligt).
 */

// StorageService drar in @aws-sdk (ESM) som ts-jest inte transformerar — stubba,
// samma mönster som övriga collections-specar.
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))

import { ForbiddenException } from '@nestjs/common'
import { UserRole } from '@prisma/client'
import { CollectionExportService } from './collection-export.service'
import { RentCollectionExportService } from './rent-collection-export.service'
import {
  COLLECTION_ACTION_ROLES,
  assertMayActOnCollections,
} from '../common/authz/collections-authz'

/** Roller som SKA släppas igenom — ekonomi. */
const ALLOWED = [UserRole.ACCOUNTANT, UserRole.ADMIN, UserRole.OWNER]
/** Roller som SKA nekas — förvaltning och observatör. */
const DENIED = [UserRole.MANAGER, UserRole.VIEWER]

function makeInvoiceService() {
  const enqueue = jest.fn().mockResolvedValue('job-1')
  // #315: markSentToCollection kör numera ALLT i en transaktion — radlås,
  // läsning, skuldberäkning, status-guardad claim och händelse. Attrappen
  // speglar det: `tx` är ett EGET objekt, skilt från `prisma` (läxan från #288),
  // så ett test inte kan råka hävda en skrivning som gick vid sidan av
  // transaktionen.
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: 'inv-1' }]),
    invoice: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'inv-1',
        invoiceNumber: 'F-2026-0001',
        status: 'OVERDUE',
        total: 10_000,
      }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    // #307 PR3: markSentToCollection grindar numera på restskuld > 0. Utan
    // betalningar är restskulden hela totalen → grinden släpper igenom, och
    // testerna nedan mäter det de alltid mätt (spårbarheten).
    invoicePayment: { findMany: jest.fn().mockResolvedValue([]) },
    invoiceEvent: { create: jest.fn() },
  }
  const prisma = {
    invoice: { findFirst: jest.fn(), update: jest.fn() },
    invoiceEvent: { create: jest.fn() },
    $transaction: jest.fn((cb: (t: unknown) => unknown) => cb(tx)),
  }
  // (prisma, personalNumber, pdf, storage, pdfQueue)
  const svc = new CollectionExportService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    { enqueue } as never,
  )
  return { svc, enqueue, prisma, tx }
}

function makeNoticeService() {
  const enqueue = jest.fn().mockResolvedValue('job-1')
  // (prisma, personalNumber, pdf, storage, pdfQueue, rentDebt)
  const svc = new RentCollectionExportService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { enqueue } as never,
    {} as never,
  )
  return { svc, enqueue }
}

describe('R1 · behörighetsgränsen mot inkasso', () => {
  beforeEach(() => jest.clearAllMocks())

  describe('Grinden i sig', () => {
    it('släpper igenom exakt ekonomirollerna', () => {
      for (const role of ALLOWED) {
        expect(() =>
          assertMayActOnCollections(role, 'exportera underlag till inkasso'),
        ).not.toThrow()
      }
    })

    it.each(DENIED)('nekar %s', (role) => {
      expect(() => assertMayActOnCollections(role, 'exportera underlag till inkasso')).toThrow(
        ForbiddenException,
      )
    })

    it('nekar saknad roll (fail-closed)', () => {
      expect(() => assertMayActOnCollections(undefined, 'exportera underlag till inkasso')).toThrow(
        ForbiddenException,
      )
    })

    it('MANAGER ingår INTE i rolluppsättningen — den punkt hierarkin inte kan uttrycka', () => {
      expect(COLLECTION_ACTION_ROLES).not.toContain(UserRole.MANAGER)
      expect([...COLLECTION_ACTION_ROLES].sort()).toEqual(
        [UserRole.ACCOUNTANT, UserRole.ADMIN, UserRole.OWNER].sort(),
      )
    })
  })

  describe('Fakturaflödet — grinden ligger i TJÄNSTEN', () => {
    it.each(DENIED)('%s nekas export och INGET jobb köas', async (role) => {
      const { svc, enqueue } = makeInvoiceService()
      await expect(svc.enqueueExportForInvoice('inv-1', 'org-1', role)).rejects.toBeInstanceOf(
        ForbiddenException,
      )
      expect(enqueue).not.toHaveBeenCalled()
    })

    it.each(DENIED)('%s nekas bulk-export och INGET jobb köas', async (role) => {
      const { svc, enqueue } = makeInvoiceService()
      await expect(svc.enqueueBulkExport(['inv-1', 'inv-2'], 'org-1', role)).rejects.toBeInstanceOf(
        ForbiddenException,
      )
      expect(enqueue).not.toHaveBeenCalled()
    })

    it.each(DENIED)('%s nekas markera-skickad och fakturan rörs INTE', async (role) => {
      const { svc, prisma, tx } = makeInvoiceService()
      await expect(
        svc.markSentToCollection('inv-1', 'org-1', undefined, role),
      ).rejects.toBeInstanceOf(ForbiddenException)
      // #315 flyttade skrivningen från `prisma.invoice.update` till en
      // status-guardad `updateMany` inuti en transaktion. Assertionen följde
      // med — hade den stått kvar på den gamla metoden hade den varit sann av
      // en olycka (metoden anropas inte längre av någon kodväg alls) och testet
      // hade slutat mäta rollgrinden. Transaktionen ska inte ens öppnas.
      expect(prisma.$transaction).not.toHaveBeenCalled()
      expect(tx.invoice.updateMany).not.toHaveBeenCalled()
      expect(tx.invoiceEvent.create).not.toHaveBeenCalled()
    })

    it('saknad roll nekas (fail-closed) — även om anroparen glömt tråda den', async () => {
      const { svc, enqueue } = makeInvoiceService()
      await expect(svc.enqueueExportForInvoice('inv-1', 'org-1')).rejects.toBeInstanceOf(
        ForbiddenException,
      )
      expect(enqueue).not.toHaveBeenCalled()
    })

    it.each(ALLOWED)('%s släpps igenom oförändrat (ingen regression)', async (role) => {
      const { svc, enqueue } = makeInvoiceService()
      await expect(svc.enqueueExportForInvoice('inv-1', 'org-1', role)).resolves.toEqual({
        jobId: 'job-1',
      })
      expect(enqueue).toHaveBeenCalledTimes(1)
    })
  })

  describe('Hyresaviflödet — samma gräns', () => {
    it.each(DENIED)('%s nekas export och INGET jobb köas', async (role) => {
      const { svc, enqueue } = makeNoticeService()
      await expect(svc.enqueueExportForNotice('rn-1', 'org-1', role)).rejects.toBeInstanceOf(
        ForbiddenException,
      )
      expect(enqueue).not.toHaveBeenCalled()
    })

    it.each(DENIED)('%s nekas bulk-export och INGET jobb köas', async (role) => {
      const { svc, enqueue } = makeNoticeService()
      await expect(svc.enqueueBulkExport(['rn-1'], 'org-1', role)).rejects.toBeInstanceOf(
        ForbiddenException,
      )
      expect(enqueue).not.toHaveBeenCalled()
    })

    it.each(ALLOWED)('%s släpps igenom oförändrat', async (role) => {
      const { svc, enqueue } = makeNoticeService()
      await expect(svc.enqueueExportForNotice('rn-1', 'org-1', role)).resolves.toEqual({
        jobId: 'job-1',
      })
      expect(enqueue).toHaveBeenCalledTimes(1)
    })
  })

  describe('Spårbarheten: VEM lämnade över skulden (FAR HIGH)', () => {
    it('markSentToCollection skriver actorId, inte bara "en människa"', async () => {
      const { svc, prisma, tx } = makeInvoiceService()
      await svc.markSentToCollection('inv-1', 'org-1', 'note', UserRole.ACCOUNTANT, 'user-42')

      const event = tx.invoiceEvent.create.mock.calls[0]![0] as {
        data: Record<string, unknown>
      }
      expect(event.data).toMatchObject({
        type: 'DEBT_COLLECTION',
        actorType: 'USER',
        actorId: 'user-42',
      })
      // …och den skrevs på TRANSAKTIONSKLIENTEN, inte vid sidan av den (#288).
      expect(prisma.invoiceEvent.create).not.toHaveBeenCalled()
    })

    it('utan känd aktör sätts INGEN actorId — vi hittar inte på en', async () => {
      const { svc, tx } = makeInvoiceService()
      await svc.markSentToCollection('inv-1', 'org-1', undefined, UserRole.OWNER)

      const event = tx.invoiceEvent.create.mock.calls[0]![0] as {
        data: Record<string, unknown>
      }
      expect(event.data).not.toHaveProperty('actorId')
    })
  })

  describe('Render-vägarna tar ingen roll — och VARFÖR det är säkert', () => {
    it('exportForInvoice/exportForNotice har ingen rollparameter', () => {
      // De anropas av PdfWorker efter att jobbet köats. Där finns ingen aktör,
      // och grinden passerades redan vid köandet — en grind här hade brutit
      // workern utan att skydda något.
      //
      // MEN: PdfWorker är inte enda anroparen. AI-verktyget
      // `export_for_collection` anropar exportForInvoice SYNKRONT, förbi kön och
      // därmed förbi enqueue-grinden (FAR-fynd). Där FINNS en aktör, så den
      // vägen grindas vid sitt eget anropsställe i tool-executor.service.ts med
      // samma delade assertMayActOnCollections. Påståendet "ingen aktör finns"
      // gäller alltså PdfWorker, inte render-metoderna i allmänhet.
      expect(CollectionExportService.prototype.exportForInvoice.length).toBeLessThanOrEqual(3)
      expect(RentCollectionExportService.prototype.exportForNotice.length).toBeLessThanOrEqual(3)
    })
  })
})
