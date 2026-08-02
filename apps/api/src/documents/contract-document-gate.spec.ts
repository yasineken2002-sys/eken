/**
 * A2 — DOKUMENTMODULENS GENVÄG TILL HYRESKONTRAKTET.
 *
 * PR A grindade `GET /contracts/download/:leaseId`. Säkerhetsgranskningen hittade
 * att samma PDF låg kvar oskyddad en dörr bort: kontraktet sparas som ett
 * `Document` med `category: 'CONTRACT'`, och dokumentmodulens två läsvägar
 * saknade rollgrind helt. Kedjan såg ut så här, med två raka GET-anrop:
 *
 *     GET /leases                     → alla leaseId (ogrindad)
 *     GET /documents?leaseId=…        → dokument-id för kontraktet
 *     GET /documents/:id/download     → presignerad URL till PDF:en
 *
 * DÄRFÖR TESTAS KEDJAN, INTE ENDPOINTS VAR FÖR SIG. Ett test per endpoint hade
 * kunnat vara grönt medan kombinationen ändå läckte — det var precis så hålet
 * uppstod: `contracts`-controllern granskades, `documents` fanns inte i bilden.
 *
 * Grinden sitter i TJÄNSTEN (#194-mönstret), så testet kör tjänsten med en
 * attrapp-Prisma i stället för att läsa dekoratorer. Det är avsiktligt: en
 * dekoratorkontroll hade bevisat att HTTP-vägen är stängd, inte att varje
 * anropare är det.
 */

jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { ForbiddenException } from '@nestjs/common'
import { DocumentCategory, UserRole } from '@prisma/client'
import { DocumentsService } from './documents.service'

const KONTRAKT = {
  id: 'doc-kontrakt',
  category: DocumentCategory.CONTRACT,
  storageKey: 'documents/org-1/kontrakt.pdf',
  name: 'Hyreskontrakt',
  mimeType: 'application/pdf',
}
const BESIKTNINGSFOTO = {
  id: 'doc-foto',
  category: DocumentCategory.INSPECTION,
  storageKey: 'documents/org-1/foto.jpg',
  name: 'Besiktning kök',
  mimeType: 'image/jpeg',
}

/** Tjänsten med attrapp-Prisma. `findMany` returnerar det where-klausulen medger. */
function makeService(rader = [KONTRAKT, BESIKTNINGSFOTO]) {
  const senasteWhere: { värde?: Record<string, unknown> } = {}
  const prisma = {
    document: {
      findMany: jest.fn(({ where }: { where: Record<string, unknown> }) => {
        senasteWhere.värde = where
        // Efterliknar databasen: filtrera på category-villkoret om det finns.
        const villkor = where['category'] as { not?: DocumentCategory } | undefined
        return Promise.resolve(
          villkor?.not ? rader.filter((r) => r.category !== villkor.not) : rader,
        )
      }),
      findFirst: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(rader.find((r) => r.id === where.id) ?? null),
      ),
    },
  }
  const storage = { getPresignedUrl: jest.fn().mockResolvedValue('https://r2.example/presigned') }
  const Ctor = DocumentsService as unknown as new (...args: never[]) => DocumentsService
  return {
    service: new Ctor(...([prisma, {}, storage] as never[])),
    prisma,
    storage,
    senasteWhere,
  }
}

const OBEHÖRIGA = [UserRole.VIEWER, UserRole.ACCOUNTANT] as const
const BEHÖRIGA = [UserRole.MANAGER, UserRole.ADMIN, UserRole.OWNER] as const

describe('A2 · hyreskontrakt i dokumentmodulen', () => {
  describe('KEDJAN — /documents?leaseId= → /documents/:id/download', () => {
    it.each(OBEHÖRIGA)('%s får inget hyresavtal någonstans i kedjan', async (roll) => {
      const { service, storage } = makeService()

      // Steg 1: listningen får inte dela ut dokument-id:t.
      const lista = await service.findAll('org-1', { leaseId: 'lease-1' }, roll)
      expect(lista.map((d) => d.id)).not.toContain(KONTRAKT.id)

      // Steg 2: även med id:t i handen (gissat, läckt via annan väg, sparat från
      // tidigare) ska nedladdningen neka.
      await expect(service.getDownloadUrl(KONTRAKT.id, 'org-1', roll)).rejects.toBeInstanceOf(
        ForbiddenException,
      )
      // Och ingen presignerad URL fick skapas — en URL som hunnit genereras är
      // en nyckel som redan lämnat systemet, oavsett vad svaret blir.
      expect(storage.getPresignedUrl).not.toHaveBeenCalled()
    })

    it.each(BEHÖRIGA)('%s når hyresavtalet som förut', async (roll) => {
      const { service } = makeService()
      const lista = await service.findAll('org-1', { leaseId: 'lease-1' }, roll)
      expect(lista.map((d) => d.id)).toContain(KONTRAKT.id)

      const { url } = await service.getDownloadUrl(KONTRAKT.id, 'org-1', roll)
      expect(url).toBe('https://r2.example/presigned')
    })
  })

  describe('ingen regression av R1:s öppna läsning', () => {
    it.each(OBEHÖRIGA)('%s ser fortfarande andra kategorier i listan', async (roll) => {
      const { service } = makeService()
      const lista = await service.findAll('org-1', undefined, roll)
      expect(lista.map((d) => d.id)).toEqual([BESIKTNINGSFOTO.id])
    })

    it.each(OBEHÖRIGA)('%s kan fortfarande ladda ner andra kategorier', async (roll) => {
      const { service, storage } = makeService()
      const { url } = await service.getDownloadUrl(BESIKTNINGSFOTO.id, 'org-1', roll)
      expect(url).toBe('https://r2.example/presigned')
      expect(storage.getPresignedUrl).toHaveBeenCalledWith(BESIKTNINGSFOTO.storageKey, 300)
    })
  })

  describe('grindens form', () => {
    it('CONTRACT utesluts i DATABASFRÅGAN, inte efteråt', async () => {
      // Filtrering i minnet hade betytt att raderna ändå hämtades — och en
      // framtida ändring som råkar returnera rådatan hade läckt igen.
      const { service, senasteWhere } = makeService()
      await service.findAll('org-1', undefined, UserRole.VIEWER)
      expect(senasteWhere.värde?.['category']).toEqual({ not: DocumentCategory.CONTRACT })
    })

    it('behörig roll får ingen kategorifiltrering alls', async () => {
      const { service, senasteWhere } = makeService()
      await service.findAll('org-1', undefined, UserRole.MANAGER)
      expect(senasteWhere.värde?.['category']).toBeUndefined()
    })

    it('explicit ?category=CONTRACT ger tomt för obehörig, inte allt', async () => {
      // Frågar någon uttryckligen efter kontrakt ska svaret vara tomt — inte en
      // lista där filtret tappats bort.
      const { service } = makeService()
      const lista = await service.findAll(
        'org-1',
        { category: DocumentCategory.CONTRACT },
        UserRole.VIEWER,
      )
      expect(lista).toEqual([])
    })

    it('SAKNAD aktörsroll nekas — fail-closed', async () => {
      // Ett internt anrop utan aktörskontext ska inte råka bli den bredaste
      // vägen in. Det var så #114 och R1 uppstod.
      const { service } = makeService()
      await expect(service.getDownloadUrl(KONTRAKT.id, 'org-1', undefined)).rejects.toBeInstanceOf(
        ForbiddenException,
      )
      const lista = await service.findAll('org-1', undefined, undefined)
      expect(lista.map((d) => d.id)).not.toContain(KONTRAKT.id)
    })
  })
})
