import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../common/prisma/prisma.service'
import { AiQuotaService } from '../ai/usage/ai-quota.service'
import {
  validateUploadedFile,
  DETECTED_CONTRACT_TYPES,
  MAX_CONTRACT_BYTES,
} from '../common/utils/file-validation'
import { ContractScanBatchQueue } from './contract-scan-batch.queue'
import { estimateBatchCostSek, MAX_BATCH_FILES_ABSOLUTE } from './contract-scan-cost'
import type { ScannedContract } from './contract-scanner.service'

export interface UploadedFile {
  fileName: string
  buffer: Buffer
}

export interface CreateBatchResult {
  id: string
  status: string
  totalRows: number
  estimatedCostSek: number
}

// Rad-vy som EXPONERAS via API:t — innehåller ALDRIG den råa PDF:en (fileData).
export interface ContractBatchRowView {
  id: string
  fileName: string
  fileSize: number
  rowStatus: string
  confidence: number | null
  reviewedData: ScannedContract | null
  errorMessage: string | null
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
 * PR1: batch-kontraktsskanning — datamodell + skanningskö + batch-tak.
 *
 * Tjänsten skapar en batch, tvingar igenom kostnadstaket INNAN något läggs på
 * kön, och exponerar batchens status. Den HÄRDADE ContractScannerService (#79)
 * är motorn; matchning (PR2) och commit till avtal (PR3) finns INTE här — det
 * går alltså inte att skapa ett hyresavtal via detta flöde.
 */
@Injectable()
export class ContractScanBatchService {
  private readonly logger = new Logger(ContractScanBatchService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly quota: AiQuotaService,
    private readonly queue: ContractScanBatchQueue,
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
          create: files.map((f) => ({
            organizationId,
            fileName: f.fileName,
            fileSize: f.buffer.length,
            fileData: f.buffer,
            rowStatus: 'PENDING' as const,
          })),
        },
      },
      select: { id: true, status: true, totalRows: true, rows: { select: { id: true } } },
    })

    // Enqueue en skanning per rad. Om enqueue mot Redis fallerar fångar vi det
    // per rad — batchen finns redan (raderna står PENDING och kan re-enqueueas).
    for (const row of batch.rows) {
      await this.queue.enqueueRow({ rowId: row.id, organizationId })
    }

    this.logger.log(
      `Skapade contract-batch id=${batch.id} org=${organizationId} rader=${batch.totalRows} ` +
        `estimat=${estimatedCostSek.toFixed(2)}kr (tak ${costCap.toFixed(2)}kr, filtak ${fileCap})`,
    )

    return {
      id: batch.id,
      status: batch.status,
      totalRows: batch.totalRows,
      estimatedCostSek,
    }
  }

  // ── Läsning: batch + rader (ALDRIG rå PDF) ────────────────────────────────
  async getBatch(id: string, organizationId: string): Promise<ContractBatchView> {
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
            errorMessage: true,
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
        reviewedData: (r.reviewedData as ScannedContract | null) ?? null,
        errorMessage: r.errorMessage,
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

    // Purga rå PDF-bytes på alla rader — kontrakt innehåller personnummer och
    // ska inte ligga kvar i DB efter att batchen avbrutits.
    await this.prisma.$transaction([
      this.prisma.contractImportRow.updateMany({
        where: { batchId: id },
        data: { fileData: null },
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

  /** Skanning misslyckades permanent (alla retries slut): markera raden FAILED. */
  async recordScanFailure(rowId: string, message: string): Promise<void> {
    await this.prisma.contractImportRow.update({
      where: { id: rowId },
      data: { rowStatus: 'FAILED', errorMessage: message.slice(0, 500) },
    })
    await this.recomputeBatch(rowId)
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
