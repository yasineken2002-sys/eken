import { OnQueueFailed, Process, Processor } from '@nestjs/bull'
import { Injectable, Logger } from '@nestjs/common'
import { ModuleRef } from '@nestjs/core'
import type { Job } from 'bull'
import { type PdfJobPayload, QUEUE_PDF } from './pdf.types'
import { AviseringService } from '../avisering/avisering.service'
import { RentReminderService } from '../avisering/rent-reminder.service'
import { CollectionExportService } from '../collections/collection-export.service'
import { InvoicesService } from '../invoices/invoices.service'
import { PlatformInvoicesService } from '../platform/invoices/platform-invoices.service'

// Hur många PDF-jobb workern kör parallellt. PdfService har en egen semafor på
// max 5 samtidiga Chromium-pages; 3 här lämnar utrymme för synkrona
// nedladdnings-endpoints som delar samma browser.
const CONCURRENCY = 3

/**
 * Konsument för PDF-kön. Delegerar varje jobb till motsvarande feature-service
 * — samma kod som tidigare körde synkront i HTTP-requesten, nu i bakgrunden
 * med Bull-retry. Servicen hämtas via ModuleRef (strict:false) så att
 * PdfQueueModule slipper importera feature-modulerna och vi undviker cyklar.
 */
@Injectable()
@Processor(QUEUE_PDF)
export class PdfWorker {
  private readonly logger = new Logger(PdfWorker.name)

  constructor(private readonly moduleRef: ModuleRef) {}

  @Process({ concurrency: CONCURRENCY })
  async handle(job: Job<PdfJobPayload>): Promise<void> {
    const data = job.data
    const attempt = job.attemptsMade + 1
    const start = Date.now()
    this.logger.log(`[pdf] attempt=${attempt} jobId=${job.id} kind=${data.kind}`)

    switch (data.kind) {
      case 'avisering-send': {
        const svc = this.moduleRef.get(AviseringService, { strict: false })
        await svc.processNoticeSendJob(data.organizationId, data.noticeId)
        break
      }
      case 'avisering-reminder': {
        const svc = this.moduleRef.get(RentReminderService, { strict: false })
        await svc.processReminderSendJob(data.organizationId, data.noticeId)
        break
      }
      case 'collections-export': {
        const svc = this.moduleRef.get(CollectionExportService, { strict: false })
        await svc.exportForInvoice(data.invoiceId, data.organizationId)
        break
      }
      case 'collections-bulk-export': {
        const svc = this.moduleRef.get(CollectionExportService, { strict: false })
        await svc.exportBulk(data.invoiceIds, data.organizationId)
        break
      }
      case 'invoice-send': {
        const svc = this.moduleRef.get(InvoicesService, { strict: false })
        await svc.processInvoiceSendJob(data.invoiceId, data.organizationId, data.actorId)
        break
      }
      case 'platform-invoice-send': {
        const svc = this.moduleRef.get(PlatformInvoicesService, { strict: false })
        await svc.processSendJob(data.platformInvoiceId)
        break
      }
    }

    this.logger.log(`[pdf] done jobId=${job.id} kind=${data.kind} duration=${Date.now() - start}ms`)
  }

  /**
   * Anropas av Bull vid varje misslyckad attempt. Bull schemalägger retry
   * automatiskt enligt backoff. Entitetsstatusen (RentNotice.status=FAILED,
   * PlatformInvoice.lastSendError) bär det användarvända felet — här loggar vi.
   */
  @OnQueueFailed()
  onFailed(job: Job<PdfJobPayload>, err: Error): void {
    const attempt = job.attemptsMade
    const maxAttempts = job.opts.attempts ?? 1
    const isPermanent = attempt >= maxAttempts
    this.logger.warn(
      `[pdf] failed jobId=${job.id} kind=${job.data.kind} attempt=${attempt}/${maxAttempts} permanent=${isPermanent} error=${err.message}`,
    )
  }
}
