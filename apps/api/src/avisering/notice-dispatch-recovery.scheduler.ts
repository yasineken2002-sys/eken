import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import type { Prisma } from '@prisma/client'
import { CronErrorSink } from '../common/cron/cron-error-sink'
import { runCronSafely } from '../common/cron/cron-safety'
import { AUTOMATISKA_KUNDEFFEKTER_ORG_STATUSES } from '../common/org/automation-org-statuses'
import { PrismaService } from '../common/prisma/prisma.service'
import { PdfQueue } from '../pdf-jobs/pdf.queue'

const CRON_NAME = 'notice-dispatch-recovery'
const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
const PREPARED_GRACE_MS = 15 * 60 * 1000
const UNKNOWN_DELIVERY_LIMIT_MS = 23 * HOUR_MS
const RETRY_DELAYS_MS = [HOUR_MS, 4 * HOUR_MS, DAY_MS] as const
export const NOTICE_DISPATCH_RECOVERY_BATCH = 100

/** Endast dessa reserverade avier får köas igen. */
function sendableWhere(): Prisma.RentNoticeSendWhereInput {
  return {
    rentNotice: {
      organization: {
        status: { in: [...AUTOMATISKA_KUNDEFFEKTER_ORG_STATUSES] },
        transactionalEmailsDisabled: false,
      },
      tenant: { anonymizedAt: null },
      status: { notIn: ['CANCELLED', 'OPENING'] },
    },
    OR: [
      { rentNotice: { status: { not: 'PAID' } } },
      { payableAmount: 0, customerCreditAmount: { gt: 0 } },
    ],
  }
}

/** Påbörjade okvitterade utskick måste synas även om utskick nu är spärrat. */
function recoveryWhere(now: Date): Prisma.RentNoticeSendWhereInput {
  return {
    kind: 'NOTICE',
    dispatchKey: { not: null },
    acceptedAt: null,
    preparedAt: { lte: new Date(now.getTime() - PREPARED_GRACE_MS) },
    AND: [
      { OR: [{ recoveryAfter: null }, { recoveryAfter: { lte: now } }] },
      { OR: [{ dispatchStartedAt: { not: null } }, sendableWhere()] },
    ],
  }
}

/**
 * Beständigt skyddsnät efter reservationen. Ett nytt PDF-jobb får ett nytt id,
 * men AviseringService läser samma frysta underlag och MailWorker återanvänder
 * samma leverantörsnyckel. Svepet skapar inga tillgodon och aktiverar ingen policy.
 *
 * recoveryAfter svarar på NÄR vi får försöka återhämta, queuedAt på NÄR första
 * mejljobbet köades. De får inte ersätta varandra. Anspråket skrivs FÖRE Redis:
 * en krasch kan fördröja nästa försök, men kan varken tappa reservationen eller
 * skapa en omedelbar återförsöksloop. Samma paus gäller vid köfel.
 */
@Injectable()
export class NoticeDispatchRecoveryScheduler {
  private readonly logger = new Logger(NoticeDispatchRecoveryScheduler.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly pdfQueue: PdfQueue,
    private readonly cronErrors: CronErrorSink,
  ) {}

  // ── KLASSIFICERING: B — SKYDDAT AV INVARIANT ──
  // RentNoticeSend updateMany(id, recoveryAttempts, recoveryAfter due,
  // acceptedAt=null) flyttar nästa försök atomiskt; endast count=1 får köa.
  @Cron('*/15 * * * *')
  async recoverPreparedNotices(): Promise<void> {
    await runCronSafely(CRON_NAME, () => this.recoverPending(), {
      logger: this.logger,
      sink: this.cronErrors,
    })
  }

  async recoverPending(now = new Date()): Promise<{
    selected: number
    queued: number
    unknown: number
    failed: number
    limitReached: boolean
  }> {
    const where = recoveryWhere(now)
    const sends = await this.prisma.rentNoticeSend.findMany({
      where,
      select: {
        id: true,
        rentNoticeId: true,
        recoveryAttempts: true,
        dispatchStartedAt: true,
        payableAmount: true,
        customerCreditAmount: true,
        rentNotice: {
          select: {
            organizationId: true,
            status: true,
            tenant: { select: { anonymizedAt: true } },
            organization: { select: { status: true, transactionalEmailsDisabled: true } },
          },
        },
      },
      // Obehandlade äldst först, därefter äldsta förfallna återförsök. Varje
      // anspråk lämnar urvalet även vid permanent fel; samma första 100 kan
      // därför inte stänga ute resten av en ändlig backlogg varje kvart.
      orderBy: [
        { recoveryAfter: { sort: 'asc', nulls: 'first' } },
        { preparedAt: 'asc' },
        { id: 'asc' },
      ],
      take: NOTICE_DISPATCH_RECOVERY_BATCH,
    })
    let queued = 0
    let unknown = 0
    let failed = 0

    for (const send of sends) {
      const context = {
        organizationId: send.rentNotice.organizationId,
        detail: { sendId: send.id, rentNoticeId: send.rentNoticeId },
      }
      try {
        const notice = send.rentNotice
        const sendable =
          AUTOMATISKA_KUNDEFFEKTER_ORG_STATUSES.some(
            (status) => status === notice.organization.status,
          ) &&
          !notice.organization.transactionalEmailsDisabled &&
          notice.tenant.anonymizedAt === null &&
          notice.status !== 'CANCELLED' &&
          notice.status !== 'OPENING' &&
          (notice.status !== 'PAID' ||
            (send.payableAmount?.isZero() === true &&
              send.customerCreditAmount?.greaterThan(0) === true))
        const deliveryUnknown =
          send.dispatchStartedAt !== null &&
          (!sendable ||
            now.getTime() - send.dispatchStartedAt.getTime() >= UNKNOWN_DELIVERY_LIMIT_MS)
        const delay = deliveryUnknown
          ? DAY_MS
          : RETRY_DELAYS_MS[Math.min(send.recoveryAttempts, RETRY_DELAYS_MS.length - 1)]!
        const claim = await this.prisma.rentNoticeSend.updateMany({
          where: {
            // Betalning, anonymisering eller strypventil efter läsningen får
            // inte köa ett nytt krav. Nästa pass kan i stället larma om det
            // redan finns ett okvitterat providerförsök.
            AND: deliveryUnknown ? [where] : [where, sendableWhere()],
            id: send.id,
            recoveryAttempts: send.recoveryAttempts,
            // En ny providerstart efter läsningen ska inte bedömas med den
            // gamla raden; nästa pass läser om dess tidsgräns.
            dispatchStartedAt: send.dispatchStartedAt,
          },
          data: {
            recoveryAfter: new Date(now.getTime() + delay),
            recoveryAttempts: { increment: 1 },
          },
        })
        if (claim.count !== 1) continue

        if (deliveryUnknown) {
          unknown++
          await this.cronErrors.report(
            CRON_NAME,
            new Error(
              'Aviutskickets leveransutfall är okänt och ett nytt försök är spärrat eller äldre än 23 timmar; kräver kontroll av leverantörskvittot. Inget nytt utskick köades.',
            ),
            context,
          )
          continue
        }

        if (send.recoveryAttempts >= RETRY_DELAYS_MS.length - 1) {
          await this.cronErrors.report(
            CRON_NAME,
            new Error(
              'Förberett aviutskick saknar fortfarande leverantörskvitto efter upprepade återhämtningsförsök; nästa automatiska försök tidigast om ett dygn.',
            ),
            context,
          )
        }
        await this.pdfQueue.enqueue({
          kind: 'avisering-send',
          organizationId: send.rentNotice.organizationId,
          noticeId: send.rentNoticeId,
        })
        queued++
      } catch (error) {
        failed++
        await this.cronErrors.report(CRON_NAME, error, context)
      }
    }

    const limitReached = sends.length === NOTICE_DISPATCH_RECOVERY_BATCH
    if (limitReached) {
      this.logger.warn(
        `Återhämtning nådde taket ${NOTICE_DISPATCH_RECOVERY_BATCH}; fler förberedda utskick kan vänta till nästa pass.`,
      )
    }
    return { selected: sends.length, queued, unknown, failed, limitReached }
  }
}
