import { Injectable, Logger } from '@nestjs/common'
import * as crypto from 'crypto'
import { randomUUID } from 'crypto'
import { PrismaService } from '../common/prisma/prisma.service'
import { StorageService } from '../storage/storage.service'

/**
 * ARKIVERING AV DET UPPLADDADE KONTRAKTET (#473).
 *
 * Före det här fanns den inskannade PDF:en bara transient: batch-vägen lade den
 * i `ContractImportRow.fileData` och nollade den vid `SCANNED`, enkelfilsvägen
 * (`POST /import/scan-contract`) persisterade den aldrig alls. Två följder, båda
 * mätta:
 *
 *  1. GRANSKNINGSSTEGET SAKNADE SIN KÄLLA. Vyn där en människa ska kontrollera
 *     AI:ns avläsning visas EFTER att filen raderats — operatören kunde bara
 *     jämföra AI:ns utdata mot AI:ns utdata.
 *  2. EVENO KUNDE INTE STYRKA ETT AVTAL DET FÖRVALTADE. Databasraden bär
 *     kontraktets data, inte det undertecknade dokumentet. I en tvist är det
 *     underskriften som gäller.
 *
 * ── VI SPEGLAR DEN GENERERADE VÄGEN, OCH UTELÄMNAR MEDVETET TRE SAKER ────────
 *
 * `contract-template.service.ts` arkiverar redan de kontrakt Eveno SJÄLV
 * genererar: R2 + `Document` + SHA-256. Samma mekanik används här. Men den vägen
 * bär fält som en inskannad PDF inte har någon motsvarighet till, och att fylla
 * dem vore att påstå något som inte hänt:
 *
 * | Fält | Varför det utelämnas |
 * |---|---|
 * | `signedAt`, `signedByTenantId`, `signedFromIp`, `signedUserAgent`, `signatureName` | Beskriver en signering som skedde I Eveno. Ett inskannat kontrakt undertecknades på papper, utanför systemet. Att fylla dem vore att påstå att Eveno bevittnat en signering det aldrig sett. |
 * | `previousVersionId`, `locked` | Versionskedjan beskriver Evenos egna omgenereringar av samma avtal. Ett inskannat original är inte en version av något Eveno skapat. |
 * | `templateInputHash` | Hashar mallens indata. Det finns ingen mall. |
 *
 * `contentHash` sätts DÄREMOT: den är en egenskap hos bytena, inte ett påstående
 * om deras ursprung, och den är det som gör arkivet till ett bevis om filen
 * någonsin ifrågasätts.
 *
 * ── FILEN ÄR INTE ALLTID EN PDF ──────────────────────────────────────────────
 * Uppladdningen tillåter PDF, JPG, PNG och WEBP (`ALLOWED_CONTRACT_MIMES`) — en
 * hyresvärd fotograferar ofta ett papperskontrakt. `mimeType` bär det faktiska
 * formatet; filändelsen i lagringsnyckeln likaså.
 */
@Injectable()
export class ContractArchiveService {
  private readonly logger = new Logger(ContractArchiveService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  /**
   * Arkiverar en uppladdad kontraktsfil och returnerar dokumentets id.
   *
   * Anropas FÖRE skanningen. Då finns ännu inget `Lease` — alla kopplingsfält på
   * `Document` är nullable, så raden skapas frikopplad och länkas vid commit via
   * `linkToLease`. Ordningen är med flit: arkivet ska finnas även för en rad som
   * aldrig committas, eftersom hyresvärden laddade upp filen oavsett.
   */
  async archive(input: {
    buffer: Buffer
    fileName: string
    mimeType: string
    organizationId: string
    uploadedById?: string | undefined
  }): Promise<{ documentId: string; contentHash: string }> {
    const { buffer, fileName, mimeType, organizationId, uploadedById } = input

    const contentHash = crypto.createHash('sha256').update(buffer).digest('hex')
    const storageKey = `documents/${organizationId}/${randomUUID()}${extensionFor(mimeType)}`
    const storageUrl = await this.storage.uploadFile(buffer, storageKey, mimeType)

    const doc = await this.prisma.document.create({
      data: {
        organizationId,
        ...(uploadedById ? { uploadedById } : {}),
        name: `Inskannat hyreskontrakt – ${fileName}`,
        description: 'Uppladdat original, AI-avläst. Underskriften skedde utanför Eveno.',
        storageKey,
        storageUrl,
        fileSize: buffer.length,
        mimeType,
        category: 'CONTRACT',
        contentHash,
      },
      select: { id: true },
    })

    return { documentId: doc.id, contentHash }
  }

  /**
   * Kopplar ett arkiverat original till det avtal det gav upphov till.
   *
   * Görs vid commit, när `Lease`/`Tenant` finns. Misslyckas den här kopplingen
   * ska INTE avtalsskapandet rullas tillbaka — dokumentet finns kvar och kan
   * länkas i efterhand, medan ett kastat avtal är en verklig förlust. Felet
   * loggas i stället.
   */
  async linkToLease(
    documentId: string,
    link: {
      leaseId: string
      unitId?: string | null
      propertyId?: string | null
      tenantId?: string | null
    },
  ): Promise<void> {
    try {
      await this.prisma.document.update({
        where: { id: documentId },
        data: {
          leaseId: link.leaseId,
          ...(link.unitId ? { unitId: link.unitId } : {}),
          ...(link.propertyId ? { propertyId: link.propertyId } : {}),
          ...(link.tenantId ? { tenantId: link.tenantId } : {}),
        },
      })
    } catch (err) {
      this.logger.error(
        `[contract-archive] kunde inte länka dokument ${documentId} till avtal ${link.leaseId}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  /**
   * Tar bort arkiverade original för rader som aldrig blev avtal.
   *
   * Speglar `fileData: null` i `cancelBatch`: en avbruten batch har inget
   * operationellt syfte för filen, och den bär personnummer. Att lämna kvar ett
   * frikopplat `Document` hade gjort avbrytningen till en halv radering.
   *
   * R2-objektet tas bort först, sedan raden. Faller R2-anropet loggas det och
   * raden tas bort ändå — ett kvarglömt objekt utan `Document` är oåtkomligt via
   * API:t, medan en kvarlämnad rad pekar på något som kanske inte finns.
   */
  async purge(documentIds: readonly string[]): Promise<void> {
    if (documentIds.length === 0) return
    const docs = await this.prisma.document.findMany({
      where: { id: { in: [...documentIds] } },
      select: { id: true, storageKey: true },
    })
    for (const doc of docs) {
      try {
        await this.storage.deleteFile(doc.storageKey)
      } catch (err) {
        this.logger.error(
          `[contract-archive] kunde inte ta bort R2-objektet för dokument ${doc.id}: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
    await this.prisma.document.deleteMany({ where: { id: { in: docs.map((d) => d.id) } } })
  }
}

/** Filändelse ur mimetype. Okänd typ får ingen ändelse hellre än en påhittad. */
export function extensionFor(mimeType: string): string {
  switch (mimeType) {
    case 'application/pdf':
      return '.pdf'
    case 'image/jpeg':
      return '.jpg'
    case 'image/png':
      return '.png'
    case 'image/webp':
      return '.webp'
    default:
      return ''
  }
}
