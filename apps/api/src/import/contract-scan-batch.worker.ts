import { OnQueueFailed, Process, Processor } from '@nestjs/bull'
import { Injectable, Logger } from '@nestjs/common'
import type { Job } from 'bull'
import { AiQuotaService } from '../ai/usage/ai-quota.service'
import { ContractScannerService } from './contract-scanner.service'
import { ContractScanBatchService } from './contract-scan-batch.service'
import { CONTRACT_SCAN_BATCH_QUEUE, type ContractScanRowJob } from './contract-scan-batch.queue'

// Hur många kontrakts-PDF:er som skannas parallellt. Vision-anrop är tunga och
// vi vill inte spamma Anthropic — 2 samtidiga räcker för en batch och lämnar
// utrymme för den synkrona en-i-taget-skannern som delar samma API-nyckel.
const CONCURRENCY = 2

/**
 * Worker för kontraktsskannings-kön. Ett jobb = en rad. Workern hämtar den råa
 * PDF:en från DB, kör den HÄRDADE ContractScannerService, lagrar resultatet och
 * (PR2) sätter ett deterministiskt enhets-FÖRSLAG. Ingen avtalsskapande — det
 * kräver mänskligt godkännande i PR3.
 *
 * Idempotent: `claimRowForScan` returnerar null om raden redan är terminal
 * eller batchen avbruten, så en Bull-retry aldrig dubbel-skannar.
 *
 * Kostnadsbroms: före varje skanning kontrolleras den org-wide dagliga
 * kostnadscapen. Eftersom motorn loggar varje skanning till AiUsageLog stiger
 * dagssumman allteftersom batchen körs — slår den i taket fallerar resten av
 * raderna snabbt i stället för att fortsätta spendera.
 */
@Injectable()
@Processor(CONTRACT_SCAN_BATCH_QUEUE)
export class ContractScanBatchWorker {
  private readonly logger = new Logger(ContractScanBatchWorker.name)

  constructor(
    private readonly batch: ContractScanBatchService,
    private readonly scanner: ContractScannerService,
    private readonly quota: AiQuotaService,
  ) {}

  @Process({ concurrency: CONCURRENCY })
  async handle(job: Job<ContractScanRowJob>): Promise<void> {
    const { rowId, organizationId } = job.data
    const attempt = job.attemptsMade + 1
    const start = Date.now()
    this.logger.log(`[contract-scan] attempt=${attempt} jobId=${job.id} row=${rowId}`)

    const claimed = await this.batch.claimRowForScan(rowId)
    if (!claimed) {
      this.logger.log(`[contract-scan] row=${rowId} redan klar/avbruten — hoppar över`)
      return
    }

    // Kostnadsbroms innan ett nytt (dyrt) vision-anrop.
    await this.quota.checkOrgDailyCostCap(organizationId)

    const scan = await this.scanner.scanContract(
      claimed.fileData,
      organizationId,
      claimed.uploadedById ?? undefined,
    )
    await this.batch.recordScanResult(rowId, scan)

    // PR2: deterministisk enhetsmatchning inline efter lyckad skanning (ren
    // DB-query, ingen AI). Matchningen är bara ett FÖRSLAG — inget avtal skapas.
    // Den får ALDRIG fälla jobbet: skanningen är redan sparad. Misslyckas den
    // ligger raden kvar med matchStatus=null och backfillas vid nästa
    // getBatch-hämtning.
    try {
      await this.batch.matchRow(rowId)
    } catch (matchErr) {
      this.logger.warn(
        `[contract-scan] matchning misslyckades för row=${rowId} (skanning OK, ` +
          `backfillas senare): ${String(matchErr)}`,
      )
    }

    this.logger.log(
      `[contract-scan] done jobId=${job.id} row=${rowId} confidence=${scan.confidence} ` +
        `duration=${Date.now() - start}ms`,
    )
  }

  /**
   * Anropas vid varje misslyckad attempt. Bull schemalägger retry enligt
   * backoff; först vid PERMANENT fail (alla försök slut) markerar vi raden
   * FAILED — och purgar då den råa PDF:en (recordScanFailure), eftersom den
   * inte längre behövs och inte ska ligga kvar i DB.
   */
  @OnQueueFailed()
  async onFailed(job: Job<ContractScanRowJob>, err: Error): Promise<void> {
    const attempt = job.attemptsMade
    const maxAttempts = job.opts.attempts ?? 1
    const isPermanent = attempt >= maxAttempts
    this.logger.warn(
      `[contract-scan] failed jobId=${job.id} row=${job.data.rowId} ` +
        `attempt=${attempt}/${maxAttempts} permanent=${isPermanent} error=${err.message}`,
    )
    if (!isPermanent) return

    try {
      await this.batch.recordScanFailure(job.data.rowId, err.message)
    } catch (recordErr) {
      this.logger.error(
        `[contract-scan] kunde inte markera row=${job.data.rowId} som FAILED: ${String(recordErr)}`,
      )
    }
  }
}
