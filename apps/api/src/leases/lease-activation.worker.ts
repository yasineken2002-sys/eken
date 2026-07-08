import { OnQueueFailed, Process, Processor } from '@nestjs/bull'
import { Injectable, Logger } from '@nestjs/common'
import type { Job } from 'bull'
import { ContractTemplateService } from '../contracts/contract-template.service'
import { TenantAuthService } from '../tenant-portal/tenant-auth.service'
import { NotificationsService } from '../notifications/notifications.service'
import { PrismaService } from '../common/prisma/prisma.service'
import { AviseringService } from '../avisering/avisering.service'
import { LEASE_ACTIVATION_QUEUE, type LeaseActivationJob } from './lease-activation.queue'

/**
 * Worker för lease-activation-kön. Tre jobbtyper:
 *
 * - `generate-contract-pdf` → kör Puppeteer + spara Document. Bull retries
 *   hanterar transienta R2/Puppeteer-fel.
 * - `send-welcome-mail` → utfärda token + enqueue Resend-mejl. Bull retries
 *   hanterar transienta DB- eller Bull-fel; själva mejl-leveransen retras
 *   sedan av mail-kön (Resend dedupar via Idempotency-Key).
 * - `create-initial-notices` → skapar deposition + första hyresavi (delmånad
 *   om relevant) och mejlar hyresgästen. Idempotent via @@unique på
 *   (leaseId, year, month, type) på RentNotice.
 *
 * Vid permanent fail (alla 5 försök slut) loggas felet och en SYSTEM-
 * notification skapas för organisationens admins så att någon kan agera.
 */
@Injectable()
@Processor(LEASE_ACTIVATION_QUEUE)
export class LeaseActivationWorker {
  private readonly logger = new Logger(LeaseActivationWorker.name)

  constructor(
    private readonly contracts: ContractTemplateService,
    private readonly tenantAuth: TenantAuthService,
    private readonly notifications: NotificationsService,
    private readonly prisma: PrismaService,
    private readonly avisering: AviseringService,
  ) {}

  @Process({ concurrency: 3 })
  async handle(job: Job<LeaseActivationJob>): Promise<void> {
    const { data } = job
    const attempt = job.attemptsMade + 1
    this.logger.log(`[lease-activation] attempt=${attempt} jobId=${job.id} type=${data.type}`)

    if (data.type === 'generate-contract-pdf') {
      await this.contracts.generateLeaseContract(
        data.leaseId,
        data.organizationId,
        data.actorUserId, // null tillåts → Document.uploadedById blir null (system-genererat)
        { linkPrevious: true },
      )
      return
    }

    if (data.type === 'send-welcome-mail') {
      await this.tenantAuth.sendWelcomeWithContract(data.tenantId)
      return
    }

    if (data.type === 'create-initial-notices') {
      await this.avisering.createInitialNoticesForLease(data.leaseId, {
        skipDeposit: data.skipDeposit ?? false,
      })
      return
    }
  }

  @OnQueueFailed()
  async onFailed(job: Job<LeaseActivationJob>, err: Error): Promise<void> {
    const attempt = job.attemptsMade
    const maxAttempts = job.opts.attempts ?? 1
    const isPermanent = attempt >= maxAttempts

    this.logger.warn(
      `[lease-activation] failed jobId=${job.id} type=${job.data.type} attempt=${attempt}/${maxAttempts} permanent=${isPermanent} error=${err.message}`,
    )

    if (!isPermanent) return

    // Vid permanent fail — notifiera org-admins så någon kan agera manuellt.
    try {
      const organizationId = await this.resolveOrganizationId(job.data)
      if (!organizationId) return

      const title =
        job.data.type === 'generate-contract-pdf'
          ? 'Kontrakts-PDF kunde inte genereras'
          : job.data.type === 'send-welcome-mail'
            ? 'Välkomstmejl kunde inte skickas'
            : 'Avier kunde inte genereras automatiskt'
      const message =
        job.data.type === 'generate-contract-pdf'
          ? `Auto-generering misslyckades efter ${attempt} försök. Generera manuellt från kontraktssidan. Fel: ${err.message}`
          : job.data.type === 'send-welcome-mail'
            ? `Aktiveringsmejlet kunde inte skickas efter ${attempt} försök. Återskicka från hyresgäst-vyn. Fel: ${err.message}`
            : `Deposition + första hyresavi kunde inte skapas automatiskt efter ${attempt} försök. Skapa manuellt från avisering-sidan. Fel: ${err.message}`

      await this.notifications.createForAllOrgUsers(organizationId, 'SYSTEM', title, message)
    } catch (notifyErr) {
      this.logger.error(
        `[lease-activation] kunde inte skapa fail-notification för jobId=${job.id}: ${String(notifyErr)}`,
      )
    }
  }

  private async resolveOrganizationId(data: LeaseActivationJob): Promise<string | null> {
    if (data.type === 'generate-contract-pdf') return data.organizationId
    if (data.type === 'create-initial-notices') return data.organizationId
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: data.tenantId },
      select: { organizationId: true },
    })
    return tenant?.organizationId ?? null
  }
}
