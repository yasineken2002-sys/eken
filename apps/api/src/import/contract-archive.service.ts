import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common'
import * as crypto from 'crypto'
import { randomUUID } from 'crypto'
import { PrismaService } from '../common/prisma/prisma.service'
import { StorageService } from '../storage/storage.service'
import {
  DETECTED_CONTRACT_TYPES,
  MAX_CONTRACT_BYTES,
  extensionForDetectedMime,
  validateUploadedFile,
} from '../common/utils/file-validation'

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
 * Uppladdningen tillåter PDF, JPG, PNG och WEBP — en hyresvärd fotograferar ofta
 * ett papperskontrakt.
 *
 * ── TYPEN HÄRLEDS HÄR, UR BYTENA — INTE AV ANROPAREN (#476) ──────────────────
 *
 * Metoden tog tidigare emot en `mimeType` från anroparen. Båda anroparna skickade
 * klientens `part.mimetype` ur multipart-headern, alltså ett fält uppladdaren
 * själv sätter. Det blev `Document.mimeType`, lagringsnyckelns filändelse OCH
 * objektets `Content-Type` i R2.
 *
 * Två defekter föll ur det. Enkelvägen arkiverade innan någon kontrollerat vad
 * bytena var, så godtyckligt innehåll kunde hamna i arkivet som `CONTRACT`.
 * Batch-vägen validerade visserligen bytena, men hade INGEN allowlist på den
 * DEKLARERADE typen — en äkta PDF kunde deklareras som `text/html` och lagras
 * med den `Content-Type`:n. Presignerade URL:er saknar `Content-Disposition`, så
 * ett sådant objekt hade serverats för rendering.
 *
 * Fixen ligger HÄR och inte hos anroparna, med flit: så länge typen är ett
 * argument kan nästa anropare skicka en lögn igen. Nu finns inget argument att
 * skicka — `archive()` läser bytena, avvisar det som inte är ett kontrakt, och
 * använder den DETEKTERADE typen till alla tre ställena. Samma grepp som
 * `inspections` och AI-bilagorna redan använder.
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
    organizationId: string
    uploadedById?: string | undefined
  }): Promise<{ documentId: string; contentHash: string }> {
    const { buffer, fileName, organizationId, uploadedById } = input

    // Innehållet avgör typen. Kastar på tomt, för stort och på binärsignaturer
    // utanför DETECTED_CONTRACT_TYPES — alltså FÖRE någon skrivning till R2
    // eller Document, vilket är det enkelvägen saknade.
    const detected = validateUploadedFile(buffer, {
      allowedDetectedMimes: DETECTED_CONTRACT_TYPES,
      maxBytes: MAX_CONTRACT_BYTES,
    })
    // `validateUploadedFile` returnerar `string | null`, men null kan inte nå
    // hit: en allowlist utan `allowTextWithoutSignature` kastar på okänd
    // signatur. Fallbacken finns för typen, inte för verkligheten.
    const mimeType = detected ?? 'application/pdf'

    // Avvisa DIREKT om lagringen saknas. Utan arkiv har granskningssteget ingen
    // källa att jämföra AI:ns avläsning mot, och avtalet får inget underlag — att
    // låta uppladdningen "lyckas" utan arkiv återinför precis den defekt #473
    // handlar om. Felet namnger konsekvensen, inte bara variabeln: den som får
    // veta VARFÖR åtgärdar rätt sak (jfr #454).
    if (!this.storage.configured) {
      throw new ServiceUnavailableException(
        'Fillagringen (R2) är inte konfigurerad. Kontraktet kan inte arkiveras, och utan ' +
          'arkiverat original går skanningen inte att granska mot källan. Kontakta administratören.',
      )
    }

    const contentHash = crypto.createHash('sha256').update(buffer).digest('hex')
    const storageKey = `documents/${organizationId}/${randomUUID()}.${extensionForDetectedMime(mimeType)}`
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
