import { Injectable, Inject, Logger, BadRequestException, NotFoundException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../common/prisma/prisma.service'
import { AiQuotaService } from '../ai/usage/ai-quota.service'
import {
  validateUploadedFile,
  DETECTED_CONTRACT_TYPES,
  MAX_CONTRACT_BYTES,
} from '../common/utils/file-validation'
import { ContractScanBatchQueue, CONTRACT_SCAN_BATCH_QUEUE } from './contract-scan-batch.queue'
import { enqueueSafely, isEnqueueProblem } from '../common/queue/enqueue-safety'
import { estimateBatchCostSek, MAX_BATCH_FILES_ABSOLUTE } from './contract-scan-cost'
import { ContractArchiveService } from './contract-archive.service'
import { deterministicUnitMatcher } from './unit-matcher'
import { buildLeaseDtoFromScan } from './contract-lease-builder'
import { LEASE_CREATOR, type LeaseCreator } from './lease-creator.token'
import type { ScannedContract } from './contract-scanner.service'

export interface UploadedFile {
  fileName: string
  buffer: Buffer
  /** Faktiskt format — uppladdningen tillåter PDF, JPG, PNG och WEBP (#473). */
  mimeType: string
}

export interface CreateBatchResult {
  id: string
  status: string
  totalRows: number
  estimatedCostSek: number
  /**
   * Antal rader som inte kunde köas för skanning (jobbkön svarade inte). De är
   * markerade FAILED och behöver laddas upp igen. Normalt 0 — surfas så att
   * UI:t kan säga "3 av 5 rader köades" i stället för att tiga.
   */
  failedRows: number
}

// Rad-vy som EXPONERAS via API:t — innehåller ALDRIG den råa PDF:en (fileData).
export interface ContractBatchRowView {
  id: string
  fileName: string
  fileSize: number
  rowStatus: string
  confidence: number | null
  // rawText utelämnas medvetet ur API-svaret (PII-minimering).
  reviewedData: Omit<ScannedContract, 'rawText'> | null
  // Enhetsmatchning (PR2) — ett FÖRSLAG, inget avtal. matchedUnitId sätts bara
  // vid AUTO_MATCHED.
  matchStatus: string | null
  matchedUnitId: string | null
  // Commit (PR3) — satt när raden godkänts och ett avtal skapats.
  createdLeaseId: string | null
  errorMessage: string | null
}

// Operatörens indata vid commit av EN rad. reviewedData är ev. redigeringar som
// om-valideras innan avtalet skapas; unitId krävs för rader som inte är
// AUTO_MATCHED (operatören väljer enhet).
export interface ConfirmRowInput {
  unitId?: string
  reviewedData?: Partial<ScannedContract>
}

export interface ConfirmRowResult {
  rowId: string
  leaseId: string
  alreadyCommitted: boolean
}

export interface BulkConfirmResult {
  committed: Array<{ rowId: string; leaseId: string }>
  failed: Array<{ rowId: string; error: string }>
  skipped: number
}

export interface ContractBatchView {
  id: string
  status: string
  totalRows: number
  scannedRows: number
  failedRows: number
  estimatedCostSek: number
  createdAt: Date
  rows: ContractBatchRowView[]
}

/**
 * Batch-kontraktsskanning — datamodell + skanningskö + batch-tak (PR1) och
 * deterministisk enhetsmatchning (PR2).
 *
 * Tjänsten skapar en batch, tvingar igenom kostnadstaket INNAN något läggs på
 * kön, exponerar batchens status, sätter ett deterministiskt enhets-FÖRSLAG per
 * skannad rad (matchRow, PR2), och låter operatören GODKÄNNA rader → avtal via
 * /leases/with-tenant (confirmRow, PR3). Ett avtal skapas ENDAST efter en
 * explicit operatörsåtgärd — ingen kodväg auto-committar.
 */
@Injectable()
export class ContractScanBatchService {
  private readonly logger = new Logger(ContractScanBatchService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly quota: AiQuotaService,
    private readonly queue: ContractScanBatchQueue,
    @Inject(LEASE_CREATOR) private readonly leases: LeaseCreator,
    private readonly archive: ContractArchiveService,
  ) {}

  // ── Steg 1: skapa batch (med tak), lagra rader, enqueue skanning ──────────
  async createBatch(
    files: UploadedFile[],
    organizationId: string,
    userId: string | null,
  ): Promise<CreateBatchResult> {
    if (files.length === 0) {
      throw new BadRequestException('Inga filer hittades i uppladdningen.')
    }

    // Per-org konfigurerbara tak (speglar maxBankTxAmount-precedensen), klampade
    // till de absoluta kodgränserna.
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { maxContractBatchFiles: true, maxContractBatchCostSek: true },
    })
    if (!org) {
      throw new NotFoundException('Organisationen hittades inte.')
    }
    const fileCap = Math.min(org.maxContractBatchFiles, MAX_BATCH_FILES_ABSOLUTE)
    const costCap = Number(org.maxContractBatchCostSek)

    // TAK 1 — antal filer (hård gräns).
    if (files.length > fileCap) {
      throw new BadRequestException(
        `För många filer i batchen (${files.length}). Taket är ${fileCap} PDF:er per batch.`,
      )
    }

    // Per-fil-validering FÖRE lagring/estimat: verifiera att varje fil faktiskt
    // är en PDF/bild (magiska byten) och inom storleksgränsen. Speglar H3 i
    // ContractScannerService — en trasig/omdöpt fil avvisar hela batchen direkt
    // i stället för att upptäckas först vid skanning.
    files.forEach((f, i) => {
      try {
        validateUploadedFile(f.buffer, {
          allowedDetectedMimes: DETECTED_CONTRACT_TYPES,
          maxBytes: MAX_CONTRACT_BYTES,
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'ogiltig fil'
        throw new BadRequestException(`Fil ${i + 1} (${f.fileName}): ${msg}`)
      }
    })

    // TAK 2 — estimerad kostnad (konservativt förhandsestimat).
    const estimatedCostSek = estimateBatchCostSek(files.map((f) => f.buffer.length))
    if (estimatedCostSek > costCap) {
      throw new BadRequestException(
        `Beräknad skanningskostnad (${estimatedCostSek.toFixed(2)} kr) överstiger taket ` +
          `(${costCap.toFixed(2)} kr) för en batch. Dela upp i mindre batchar eller höj taket.`,
      )
    }

    // TAK 3 — befintlig org-wide daglig kostnadsbroms som backstop. Har orgen
    // redan slagit i dagens AI-budget avvisas batchen innan den startar.
    await this.quota.checkOrgDailyCostCap(organizationId)

    // #473: arkivera originalet FÖRE skanningen. `fileData` är fortfarande
    // transient (workern läser den, den nollas vid SCANNED) — men filen finns nu
    // kvar i R2 + Document, så granskningsvyn har en källa och avtalet har sitt
    // undertecknade underlag. Arkiveras filen inte går raden inte att granska
    // mot något, så ett fel här ska stoppa uppladdningen, inte tigas ihjäl.
    const arkiverade: Array<{ documentId: string }> = []
    for (const f of files) {
      arkiverade.push(
        await this.archive.archive({
          buffer: f.buffer,
          fileName: f.fileName,
          mimeType: f.mimeType,
          organizationId,
          uploadedById: userId ?? undefined,
        }),
      )
    }

    // Skapa batch + rader (rå PDF lagras transient i fileData) i en operation.
    const batch = await this.prisma.contractImportBatch.create({
      data: {
        organizationId,
        uploadedById: userId,
        status: 'PENDING',
        totalRows: files.length,
        estimatedCostSek: new Prisma.Decimal(estimatedCostSek),
        fileCapApplied: fileCap,
        costCapApplied: new Prisma.Decimal(costCap),
        rows: {
          create: files.map((f, i) => ({
            organizationId,
            fileName: f.fileName,
            fileSize: f.buffer.length,
            fileData: f.buffer,
            documentId: arkiverade[i]!.documentId,
            rowStatus: 'PENDING' as const,
          })),
        },
      },
      select: { id: true, status: true, totalRows: true, rows: { select: { id: true } } },
    })

    // Enqueue en skanning per rad, isolerat per rad.
    //
    // T5 C2a: den per-rad-hanteringen fanns tidigare BARA i kommentaren. Utan
    // den kastade rad N:s kö-fel ur hela metoden → anroparen fick 500, raderna
    // efter N köades aldrig, och batchen låg kvar halvköad utan larm.
    //
    // En rad som inte kunde köas markeras FAILED (inte kvarlämnad PENDING):
    // ingen worker kommer någonsin hämta den, och recomputeBatchCompletion
    // räknar PENDING som "återstår" → en enda oköad rad hade annars låst hela
    // batchen utanför COMPLETED för alltid. FAILED är den befintliga terminala
    // banan (jfr recordScanFailure) och syns per rad i granskningsvyn.
    let failedRows = 0
    for (const row of batch.rows) {
      const outcome = await enqueueSafely(
        () => this.queue.enqueueRow({ rowId: row.id, organizationId }),
        {
          queue: CONTRACT_SCAN_BATCH_QUEUE,
          jobType: 'contract-scan-row',
          organizationId,
          logger: this.logger,
        },
      )
      if (!isEnqueueProblem(outcome)) continue

      failedRows++
      // Purgar råfilen som alla andra terminala banor (svällning + GDPR:
      // kontrakten innehåller personnummer). Operatören laddar upp filen igen.
      await this.prisma.contractImportRow
        .update({
          where: { id: row.id },
          data: {
            rowStatus: 'FAILED',
            errorMessage:
              'Kunde inte köas för skanning (jobbkön svarade inte). Ladda upp filen igen.',
            fileData: null,
          },
        })
        .catch((err: unknown) =>
          this.logger.error(
            `Kunde inte markera rad ${row.id} som FAILED efter kö-fel: ${String(err)}`,
          ),
        )
    }

    if (failedRows > 0) {
      this.logger.warn(
        `Contract-batch ${batch.id}: ${failedRows} av ${batch.rows.length} rader kunde inte köas (markerade FAILED)`,
      )
      // Ingen enda rad kom in i kön → inget kommer någonsin flytta batchen från
      // PENDING (bumpBatchToScanning körs av workern). Markera den FAILED direkt
      // så den inte ser ut att pågå för evigt.
      if (failedRows === batch.rows.length) {
        // Räknarna sätts HÄR och inte av recomputeBatch: den anropas bara av
        // workern, och ingen worker rör en rad som aldrig kom in i kön. Dessutom
        // returnerar recomputeBatch tidigt för terminala statusar, så en batch
        // som just satts FAILED kan aldrig självläka räknarna senare — utan
        // detta hade vyn visat "0 misslyckade" på en FAILED batch där ALLA
        // rader misslyckats. (Vid partiellt fel självläker det: de köade
        // radernas recomputeBatch räknar om från faktiskt DB-state.)
        await this.prisma.contractImportBatch
          .update({
            where: { id: batch.id },
            data: { status: 'FAILED', failedRows, scannedRows: 0 },
          })
          .catch((err: unknown) =>
            this.logger.error(`Kunde inte markera batch ${batch.id} som FAILED: ${String(err)}`),
          )
      }
    }

    this.logger.log(
      `Skapade contract-batch id=${batch.id} org=${organizationId} rader=${batch.totalRows} ` +
        `estimat=${estimatedCostSek.toFixed(2)}kr (tak ${costCap.toFixed(2)}kr, filtak ${fileCap})`,
    )

    return {
      id: batch.id,
      status: failedRows === batch.rows.length && failedRows > 0 ? 'FAILED' : batch.status,
      totalRows: batch.totalRows,
      estimatedCostSek,
      failedRows,
    }
  }

  // ── Läsning: batch + rader (ALDRIG rå PDF) ────────────────────────────────
  async getBatch(id: string, organizationId: string): Promise<ContractBatchView> {
    // Lazy backfill (PR2): SCANNADE rader utan matchStatus (t.ex. skannade i PR1,
    // innan matchningen fanns) får sitt förslag vid första granskningshämtningen.
    // Idempotent och avgränsat — bara orörda rader, en gång. Org-scopas på
    // batchId+organizationId så en främmande org aldrig triggar matchning här.
    const unmatched = await this.prisma.contractImportRow.findMany({
      where: { batchId: id, organizationId, rowStatus: 'SCANNED', matchStatus: null },
      select: { id: true },
    })
    for (const r of unmatched) {
      await this.matchRow(r.id)
    }

    const batch = await this.prisma.contractImportBatch.findFirst({
      where: { id, organizationId },
      select: {
        id: true,
        status: true,
        totalRows: true,
        scannedRows: true,
        failedRows: true,
        estimatedCostSek: true,
        createdAt: true,
        rows: {
          orderBy: { createdAt: 'asc' },
          // fileData utelämnas medvetet — den råa PDF:en lämnar aldrig servern.
          select: {
            id: true,
            fileName: true,
            fileSize: true,
            rowStatus: true,
            confidence: true,
            reviewedData: true,
            matchStatus: true,
            matchedUnitId: true,
            createdLeaseId: true,
            errorMessage: true,
            documentId: true,
          },
        },
      },
    })
    if (!batch) {
      throw new NotFoundException('Batchen hittades inte.')
    }

    return {
      id: batch.id,
      status: batch.status,
      totalRows: batch.totalRows,
      scannedRows: batch.scannedRows,
      failedRows: batch.failedRows,
      estimatedCostSek: Number(batch.estimatedCostSek),
      createdAt: batch.createdAt,
      rows: batch.rows.map((r) => ({
        id: r.id,
        fileName: r.fileName,
        fileSize: r.fileSize,
        rowStatus: r.rowStatus,
        confidence: r.confidence,
        // rawText (råt kontraktsutdrag, kan bära ostrukturerad PII) lämnar
        // ALDRIG servern — det behövs bara internt och lagras i originalScanData.
        reviewedData: stripRawText(r.reviewedData as ScannedContract | null),
        matchStatus: r.matchStatus,
        matchedUnitId: r.matchedUnitId,
        createdLeaseId: r.createdLeaseId,
        errorMessage: r.errorMessage,
        // #473: granskningsvyn behöver kunna VISA originalet, inte bara dess
        // filnamn. Ett filnamn utan väg till filen är ett påstående om att
        // dokumentet finns.
        documentId: r.documentId,
      })),
    }
  }

  // ── Avbryt: markera CANCELLED + purgar rå PDF (GDPR) ──────────────────────
  async cancelBatch(id: string, organizationId: string): Promise<{ id: string; status: string }> {
    const batch = await this.prisma.contractImportBatch.findFirst({
      where: { id, organizationId },
      select: { id: true, status: true },
    })
    if (!batch) {
      throw new NotFoundException('Batchen hittades inte.')
    }
    if (batch.status === 'CANCELLED') {
      return { id: batch.id, status: batch.status }
    }

    // Purga rå PDF-bytes OCH tolkningsdata på alla rader — en avbruten batch har
    // inget operationellt syfte för PII:n (personnummer, e-post m.m.).
    // (GDPR-dataminimering.) confirmedData/createdLeaseId finns aldrig på
    // SCANNED/PENDING-rader, så de behöver inte röras.
    // #473: ta bort de arkiverade originalen också. Att nolla fileData men
    // lämna kvar dokumentet i R2 hade gjort avbrytningen till en HALV radering —
    // filen bär personnummer, och en avbruten batch blev aldrig ett avtal.
    const attPurga = await this.prisma.contractImportRow.findMany({
      where: { batchId: id, documentId: { not: null } },
      select: { documentId: true },
    })
    await this.archive.purge(attPurga.map((r) => r.documentId!))

    await this.prisma.$transaction([
      this.prisma.contractImportRow.updateMany({
        where: { batchId: id },
        data: {
          fileData: null,
          documentId: null,
          originalScanData: Prisma.JsonNull,
          reviewedData: Prisma.JsonNull,
        },
      }),
      this.prisma.contractImportBatch.update({
        where: { id },
        data: { status: 'CANCELLED' },
      }),
    ])

    return { id, status: 'CANCELLED' }
  }

  // ── Worker-callbacks ──────────────────────────────────────────────────────

  /**
   * Hämta en rad för skanning och markera den SCANNING. Returnerar `null` om
   * raden redan är terminal (SCANNED/FAILED) eller batchen är avbruten/failad —
   * då hoppar workern över (idempotent vid Bull-retry).
   */
  async claimRowForScan(
    rowId: string,
  ): Promise<{ fileData: Buffer; uploadedById: string | null } | null> {
    const row = await this.prisma.contractImportRow.findUnique({
      where: { id: rowId },
      select: {
        rowStatus: true,
        fileData: true,
        batch: { select: { status: true, uploadedById: true } },
      },
    })
    if (!row) return null
    if (row.rowStatus === 'SCANNED' || row.rowStatus === 'FAILED') return null
    if (row.batch.status === 'CANCELLED' || row.batch.status === 'FAILED') return null
    if (!row.fileData) return null

    await this.prisma.contractImportRow.update({
      where: { id: rowId },
      data: { rowStatus: 'SCANNING' },
    })
    await this.bumpBatchToScanning(rowId)

    return { fileData: Buffer.from(row.fileData), uploadedById: row.batch.uploadedById }
  }

  /**
   * Skanning lyckades: lagra oföränderlig råtolkning + redigerbar kopia, och
   * purga den råa PDF:en DIREKT (GDPR-dataminimering). När originalScanData är
   * sparat behövs inte längre PDF-bytena, och en SCANNAD rad ska inte bära kvar
   * ett kontrakt med personnummer i väntan på commit (PR3). Råa PDF:er finns
   * därmed bara på PENDING/SCANNING-rader.
   */
  async recordScanResult(rowId: string, scan: ScannedContract): Promise<void> {
    const json = scan as unknown as Prisma.InputJsonValue
    await this.prisma.contractImportRow.update({
      where: { id: rowId },
      data: {
        rowStatus: 'SCANNED',
        originalScanData: json,
        reviewedData: json,
        confidence: scan.confidence,
        errorMessage: null,
        fileData: null,
      },
    })
    await this.recomputeBatch(rowId)
  }

  /**
   * PR2: deterministisk enhetsmatchning. Sätter ett FÖRSLAG (matchStatus +
   * eventuellt matchedUnitId) på en skannad rad. REN DB-query + ren matchare —
   * ingen AI, inga nätverksanrop, inget avtal skapas. Kandidat-Units hämtas
   * org-scopat (via Property.organizationId) så matchningen ALDRIG korsar org.
   * No-op för rader som inte är SCANNED eller saknar tolkningsdata.
   */
  async matchRow(rowId: string): Promise<void> {
    const row = await this.prisma.contractImportRow.findUnique({
      where: { id: rowId },
      select: {
        organizationId: true,
        rowStatus: true,
        reviewedData: true,
        confidence: true,
      },
    })
    if (!row || row.rowStatus !== 'SCANNED') return
    const scan = row.reviewedData as ScannedContract | null
    if (!scan) return

    // Org-scoping: enbart Units vars Property tillhör radens organisation.
    const candidates = await this.prisma.unit.findMany({
      where: { property: { organizationId: row.organizationId } },
      select: {
        id: true,
        unitNumber: true,
        property: { select: { street: true, postalCode: true, city: true } },
      },
    })

    const result = deterministicUnitMatcher.match(
      {
        propertyAddress: scan.propertyAddress ?? null,
        unitDescription: scan.unitDescription ?? null,
        confidence: row.confidence ?? scan.confidence ?? 0,
      },
      candidates,
    )

    await this.prisma.contractImportRow.update({
      where: { id: rowId },
      data: { matchStatus: result.status, matchedUnitId: result.unitId },
    })
  }

  /**
   * Skanning misslyckades permanent (alla retries slut): markera raden FAILED.
   * Purgar den råa PDF:en i samma UPDATE (precis som vid lyckad skanning/cancel)
   * — en FAILED-rad behöver aldrig bytena igen, och de ska inte ligga kvar i DB
   * (svällning + GDPR-kvarhållning av personnummer).
   */
  async recordScanFailure(rowId: string, message: string): Promise<void> {
    await this.prisma.contractImportRow.update({
      where: { id: rowId },
      data: { rowStatus: 'FAILED', errorMessage: message.slice(0, 500), fileData: null },
    })
    await this.recomputeBatch(rowId)
  }

  // ── PR3: granskning → commit (avtal skapas FÖRST här) ─────────────────────

  /**
   * Godkänn EN rad → skapa ett avtal via /leases/with-tenant. Detta är den enda
   * vägen som skapar avtal, och den körs ALLTID på en explicit operatörsåtgärd
   * (per-rad-knapp eller bulk). Ingen auto-commit.
   *
   * Spärrar:
   *  • IDEMPOTENS — har raden redan en createdLeaseId committas den aldrig igen.
   *  • OM-VALIDERING — (ev. redigerad) data byggs + valideras via
   *    buildLeaseDtoFromScan innan avtalet skapas (sanitizeEdited-mönstret).
   *  • DUBBLETTSKYDD — createWithTenant kastar om enheten redan har ett aktivt
   *    avtal (describeActiveBlocker) → raden failar, övriga rör den inte.
   *  • ENHETSVAL — rader som inte är AUTO_MATCHED kräver ett operatörsvalt unitId.
   */
  async confirmRow(
    batchId: string,
    rowId: string,
    organizationId: string,
    userId: string | null,
    input: ConfirmRowInput = {},
  ): Promise<ConfirmRowResult> {
    const row = await this.prisma.contractImportRow.findFirst({
      where: { id: rowId, batchId, organizationId },
      select: {
        rowStatus: true,
        matchStatus: true,
        matchedUnitId: true,
        documentId: true,
        reviewedData: true,
        // #471: AI:ns orörda avläsning, enda gången den läses — för att kunna
        // bygga fältnivå-spåret innan den gallras i samma commit.
        originalScanData: true,
        createdLeaseId: true,
      },
    })
    if (!row) {
      throw new NotFoundException('Raden hittades inte.')
    }

    // Idempotens: redan committad → returnera befintligt avtal, skapa aldrig nytt.
    if (row.createdLeaseId) {
      return { rowId, leaseId: row.createdLeaseId, alreadyCommitted: true }
    }
    // Bara en granskningsklar (SCANNED) rad kan committas.
    if (row.rowStatus !== 'SCANNED') {
      throw new BadRequestException(
        `Raden är i status ${row.rowStatus} och kan inte godkännas — bara skannade rader.`,
      )
    }

    // Effektiv skanningsdata = lagrad reviewedData överlagrad med operatörens
    // redigeringar. Hela resultatet om-valideras i buildLeaseDtoFromScan.
    const stored = (row.reviewedData as ScannedContract | null) ?? null
    if (!stored) {
      throw new BadRequestException('Raden saknar tolkningsdata och kan inte godkännas.')
    }
    const effective: ScannedContract = { ...stored, ...(input.reviewedData ?? {}) }

    // Enhet: AUTO_MATCHED får använda förslaget; övriga kräver operatörens val.
    const unitId = input.unitId ?? (row.matchStatus === 'AUTO_MATCHED' ? row.matchedUnitId : null)
    if (!unitId) {
      throw new BadRequestException(
        'Välj en enhet för raden innan du godkänner (ingen säker automatisk matchning).',
      )
    }

    // Validera/bygg DTO:t FÖRE låset, så ett valideringsfel aldrig lämnar
    // raden i transient COMMITTING-läge.
    const dto = buildLeaseDtoFromScan(effective, unitId)

    // Atomiskt lås (RISK: samtidiga godkännanden av SAMMA rad). Endast EN
    // request vinner övergången SCANNED → COMMITTING; förloraren får count=0
    // och skapar därmed aldrig ett andra avtal.
    const claim = await this.prisma.contractImportRow.updateMany({
      where: { id: rowId, batchId, organizationId, rowStatus: 'SCANNED', createdLeaseId: null },
      data: { rowStatus: 'COMMITTING' },
    })
    if (claim.count === 0) {
      const current = await this.prisma.contractImportRow.findFirst({
        where: { id: rowId, batchId, organizationId },
        select: { createdLeaseId: true },
      })
      if (current?.createdLeaseId) {
        return { rowId, leaseId: current.createdLeaseId, alreadyCommitted: true }
      }
      throw new BadRequestException('Raden godkänns redan av en annan begäran — försök igen strax.')
    }

    let lease: { id: string }
    try {
      // Avtalet skapas här. createWithTenant org-scopar enheten, kollar dubblett-
      // e-post OCH kastar vid enhetskonflikt (redan uthyrd enhet) → raden failar.
      lease = await this.leases.createWithTenant(dto, organizationId, userId)
    } catch (err) {
      // Släpp låset så raden kan godkännas på nytt efter att felet åtgärdats.
      await this.prisma.contractImportRow.updateMany({
        where: { id: rowId, rowStatus: 'COMMITTING' },
        data: { rowStatus: 'SCANNED' },
      })
      throw err
    }

    // #471: GALLRING VID COMMIT — symmetriskt med purge-mönstret i samma fil.
    //
    // `fileData` nollas redan vid varje terminalt radtillstånd (och redan vid
    // SCANNED, i recordScanResult), men Json-kolumnerna nollades bara i
    // `cancelBatch`. Efter commit ligger personnumret krypterat på `Tenant`, och
    // `createdLeaseId` pekar till den levande sanningen — stagingkopian har
    // inget operationellt syfte kvar.
    //
    // OBS: `SKIPPED` har SAMMA lucka och stängs INTE här (`skipRow` sätter bara
    // `fileData: null`). Redovisningssvaret i #471 antog att COMMITTED var den
    // enda terminala status som bar kvar Json-datan; mätningen visar att det är
    // fel. Medvetet utanför den här ändringens omfång — se ärendet.
    //
    // Redovisningsgenomgången (#471) svarade att ingen av de tre kolumnerna är
    // räkenskapsinformation — ingen verifikation hänvisar till dem. Gallringen är
    // därför tillåten; se `buildCommitAuditTrail` för vad som bevaras i stället
    // och under vilket villkor svaret skulle ändras.
    //
    // MÄTT före ändringen: `originalScanData` och `confirmedData` har NOLL läsare
    // i hela repot. `reviewedData` läses av `matchRow` och `confirmRow` (båda
    // grindade till SCANNED) samt av granskningsvyn — men `inTab()` i
    // ContractBatchReviewPage returnerar false för varje rad vars status inte är
    // SCANNED, så en COMMITTED rad renderas aldrig där. Gallringen tar alltså
    // inte bort någon vy som fanns.
    await this.prisma.contractImportRow.update({
      where: { id: rowId },
      data: {
        rowStatus: 'COMMITTED',
        createdLeaseId: lease.id,
        matchedUnitId: unitId,
        // Klartext-PII ut. Kvar blir ett spår som bär VAD som ändrades, inte
        // vilka personuppgifter som stod där.
        originalScanData: Prisma.JsonNull,
        reviewedData: Prisma.JsonNull,
        confirmedData: buildCommitAuditTrail(
          row.originalScanData as ScannedContract | null,
          effective,
          {
            committedByUserId: userId,
            unitId,
            committedAt: new Date().toISOString(),
          },
        ) as unknown as Prisma.InputJsonValue,
        fileData: null,
        errorMessage: null,
      },
    })

    // #473: koppla det arkiverade originalet till avtalet det gav upphov till.
    // Efter avtalsskapandet med flit — misslyckas kopplingen är dokumentet kvar
    // och kan länkas i efterhand, medan ett tillbakarullat avtal är en verklig
    // förlust. `linkToLease` loggar och kastar inte.
    if (row.documentId) {
      // Bara leaseId och unitId länkas: LeaseCreator returnerar { id } och
      // exponerar ingen tenantId. Att slå upp den bara för att fylla ett
      // valfritt kopplingsfält är inte värt en extra query — dokumentet hittas
      // via avtalet.
      await this.archive.linkToLease(row.documentId, { leaseId: lease.id, unitId })
    }

    await this.recomputeBatchCompletion(batchId, organizationId)

    return { rowId, leaseId: lease.id, alreadyCommitted: false }
  }

  /**
   * Bulk "Godkänn alla säkra": committar ENDAST AUTO_MATCHED-rader som ännu inte
   * har ett avtal. En människa utlöser detta; varje rad går via samma confirmRow
   * (inkl. dubblett-/valideringsspärrar). Per-rad-isolering: en rad som failar
   * stoppar inte de andra (speglar bankens confirm-loop).
   */
  async bulkConfirmSafe(
    batchId: string,
    organizationId: string,
    userId: string | null,
  ): Promise<BulkConfirmResult> {
    const rows = await this.prisma.contractImportRow.findMany({
      where: {
        batchId,
        organizationId,
        rowStatus: 'SCANNED',
        matchStatus: 'AUTO_MATCHED',
        createdLeaseId: null,
      },
      select: { id: true },
    })

    const committed: Array<{ rowId: string; leaseId: string }> = []
    const failed: Array<{ rowId: string; error: string }> = []

    for (const r of rows) {
      try {
        const res = await this.confirmRow(batchId, r.id, organizationId, userId)
        committed.push({ rowId: r.id, leaseId: res.leaseId })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        failed.push({ rowId: r.id, error: message })
        this.logger.warn(`[contract-batch] bulk-commit row=${r.id} failade: ${message}`)
      }
    }

    return { committed, failed, skipped: 0 }
  }

  /** Operatören väljer att INTE skapa avtal för en rad → SKIPPED + purga PDF. */
  async skipRow(
    batchId: string,
    rowId: string,
    organizationId: string,
  ): Promise<{ rowId: string; rowStatus: string }> {
    const row = await this.prisma.contractImportRow.findFirst({
      where: { id: rowId, batchId, organizationId },
      select: { rowStatus: true, createdLeaseId: true },
    })
    if (!row) {
      throw new NotFoundException('Raden hittades inte.')
    }
    if (row.createdLeaseId) {
      throw new BadRequestException('Raden har redan skapat ett avtal och kan inte hoppas över.')
    }
    if (row.rowStatus !== 'SCANNED') {
      throw new BadRequestException(
        `Raden är i status ${row.rowStatus} och kan inte hoppas över — bara skannade rader.`,
      )
    }

    await this.prisma.contractImportRow.update({
      where: { id: rowId },
      data: { rowStatus: 'SKIPPED', fileData: null },
    })
    await this.recomputeBatchCompletion(batchId, organizationId)

    return { rowId, rowStatus: 'SKIPPED' }
  }

  // Batchen → COMPLETED när inga rader återstår att skanna/granska (alla är
  // COMMITTED/SKIPPED/FAILED). Org-scopad findFirst (defense-in-depth) och rör
  // inte terminala batch-statusar. COMMITTING räknas som "kvar" (transient).
  private async recomputeBatchCompletion(batchId: string, organizationId: string): Promise<void> {
    const [remaining, batch] = await Promise.all([
      this.prisma.contractImportRow.count({
        where: { batchId, rowStatus: { in: ['PENDING', 'SCANNING', 'SCANNED', 'COMMITTING'] } },
      }),
      this.prisma.contractImportBatch.findFirst({
        where: { id: batchId, organizationId },
        select: { status: true },
      }),
    ])
    if (!batch) return
    if (batch.status !== 'SCANNED' && batch.status !== 'SCANNING') return
    if (remaining === 0) {
      await this.prisma.contractImportBatch.update({
        where: { id: batchId },
        data: { status: 'COMPLETED' },
      })
    }
  }

  // Flytta batchen PENDING → SCANNING när första raden börjar skannas (rör inte
  // terminala batchar).
  private async bumpBatchToScanning(rowId: string): Promise<void> {
    const row = await this.prisma.contractImportRow.findUnique({
      where: { id: rowId },
      select: { batchId: true, batch: { select: { status: true } } },
    })
    if (!row) return
    if (row.batch.status === 'PENDING') {
      await this.prisma.contractImportBatch.update({
        where: { id: row.batchId },
        data: { status: 'SCANNING' },
      })
    }
  }

  // Räkna om batchens räknare + status från radernas faktiska tillstånd
  // (race-säkert: härleds från raderna, inte via inkrement). Terminala
  // batch-statusar (CANCELLED/FAILED) lämnas orörda.
  private async recomputeBatch(rowId: string): Promise<void> {
    const row = await this.prisma.contractImportRow.findUnique({
      where: { id: rowId },
      select: { batchId: true },
    })
    if (!row) return

    const [scanned, failed, batch] = await Promise.all([
      this.prisma.contractImportRow.count({
        where: { batchId: row.batchId, rowStatus: 'SCANNED' },
      }),
      this.prisma.contractImportRow.count({
        where: { batchId: row.batchId, rowStatus: 'FAILED' },
      }),
      this.prisma.contractImportBatch.findUnique({
        where: { id: row.batchId },
        select: { totalRows: true, status: true },
      }),
    ])
    if (!batch) return
    if (batch.status === 'CANCELLED' || batch.status === 'FAILED') return

    const allDone = scanned + failed >= batch.totalRows
    await this.prisma.contractImportBatch.update({
      where: { id: row.batchId },
      data: {
        scannedRows: scanned,
        failedRows: failed,
        status: allDone ? 'SCANNED' : 'SCANNING',
      },
    })
  }
}

// Ta bort rawText ur den data som exponeras via API:t. rawText är ett rått
// utdrag ur kontraktstexten (kan innehålla ostrukturerad PII) och behövs bara
// server-side, fram till commit då hela skanningsdatan gallras.
function stripRawText(data: ScannedContract | null): Omit<ScannedContract, 'rawText'> | null {
  if (!data) return null
  const rest: Partial<ScannedContract> = { ...data }
  delete rest.rawText
  return rest as Omit<ScannedContract, 'rawText'>
}

/**
 * Fält som ALDRIG får stå i klartext i spåret.
 *
 * `personalNumber` är hela skälet till #471: det är systemets sista klartext-PII
 * i vila, medan varje annat personnummer ligger AES-256-GCM-krypterat. Att
 * gallra `originalScanData`/`reviewedData` och sedan skriva tillbaka numret i
 * spåret vore att flytta problemet, inte lösa det.
 *
 * `rawText` (de första 500 tecknen av kontraktstexten) utelämnas HELT — inte
 * redigerat utan bortlämnat. Det är ostrukturerad text som med stor sannolikhet
 * bär personnumret i löptext, och ett "ändrades från … till …" på 500 tecken
 * fritext har inget styrningsvärde.
 */
const REDIGERADE_FALT: ReadonlySet<keyof ScannedContract> = new Set(['personalNumber'])
const UTELAMNADE_FALT: ReadonlySet<keyof ScannedContract> = new Set(['rawText'])

/** Markör i stället för värdet. Att fältet ÄNDRADES är signalen, inte till vad. */
const REDIGERAT = '[redigerat]'

export interface CommitAuditTrail {
  version: 1
  committedAt: string
  committedByUserId: string | null
  unitId: string
  /** Bara de fält operatören faktiskt ändrade. Tom lista = AI:ns avläsning gick igenom orörd. */
  changedFields: Array<{ field: string; from: unknown; to: unknown }>
}

/**
 * Fältnivå-spår över vad AI:n läste av kontra vad operatören committade.
 *
 * ── VARFÖR DET HÄR FINNS, OCH VAD DET INTE ÄR ────────────────────────────────
 *
 * Redovisningsgenomgången i #471 svarade NEJ på om `originalScanData`,
 * `reviewedData` och `confirmedData` är räkenskapsinformation: ingen
 * verifikation och ingen bokföringspost hänvisar till dem. Skiljelinjen mot
 * `BankStatementImport.confirmedData` är inte mönstret utan vad nästa steg gör
 * med datan — där blir det en `BankTransaction` som journalförs, här ett
 * `Lease` som är ett avtal, inte en affärshändelse.
 *
 * Spåret av vad AI:n föreslog kontra vad en människa ändrade bedömdes som ett
 * verkligt KVALITETS- OCH STYRNINGSINTRESSE, men INTE en lagstadgad
 * bevarandeplikt. Det här är alltså **rekommenderad praxis, inte lagföljd** —
 * och det är därför spåret får kosta så lite som det gör, och varför
 * personnumret kan redigeras bort utan att något krav bryts.
 *
 * Jämfört mot `originalScanData` (AI:ns orörda avläsning), inte mot
 * `reviewedData`: det är AI-mot-människa som är frågan, och `reviewedData`
 * skrivs om vid commit.
 *
 * VILLKOR SOM ÄNDRAR SVARET (#471): skulle en `JournalEntry` någon gång hänvisa
 * till en `ContractImportRow` ärver just den raden bevarandeplikt, och
 * gallringen nedan blir fel. Det bevakas av vakten i
 * `contract-commit-gallring.spec.ts` — den fäller om en verifikationsskrivare
 * någonsin refererar hit, i stället för att lita på att ingen råkar göra det.
 */
export function buildCommitAuditTrail(
  original: ScannedContract | null,
  effective: ScannedContract,
  meta: { committedByUserId: string | null; unitId: string; committedAt: string },
): CommitAuditTrail {
  const changedFields: CommitAuditTrail['changedFields'] = []

  // Unionen av nycklarna, inte bara originalets — ett fält operatören LADE TILL
  // (AI:n läste null) är precis en sådan ändring spåret finns för.
  const nycklar = new Set<string>([...Object.keys(original ?? {}), ...Object.keys(effective)])

  for (const field of nycklar) {
    if (UTELAMNADE_FALT.has(field as keyof ScannedContract)) continue

    const from = original ? (original as unknown as Record<string, unknown>)[field] : undefined
    const to = (effective as unknown as Record<string, unknown>)[field]
    if (Object.is(from, to)) continue

    changedFields.push(
      REDIGERADE_FALT.has(field as keyof ScannedContract)
        ? { field, from: REDIGERAT, to: REDIGERAT }
        : { field, from: from ?? null, to: to ?? null },
    )
  }

  return {
    version: 1,
    committedAt: meta.committedAt,
    committedByUserId: meta.committedByUserId,
    unitId: meta.unitId,
    changedFields,
  }
}
