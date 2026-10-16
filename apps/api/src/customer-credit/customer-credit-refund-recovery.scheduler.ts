import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import type { Prisma } from '@prisma/client'
import { CronErrorSink } from '../common/cron/cron-error-sink'
import { runCronSafely } from '../common/cron/cron-safety'
import { PrismaService } from '../common/prisma/prisma.service'
import { CustomerCreditRefundService } from './customer-credit-refund.service'

const CRON_NAME = 'customer-credit-refund-recovery'
const HOUR_MS = 60 * 60 * 1000
const GRACE_MS = 15 * 60 * 1000
const RETRY_DELAYS_MS = [HOUR_MS, 4 * HOUR_MS, 24 * HOUR_MS] as const
export const CUSTOMER_CREDIT_REFUND_RECOVERY_BATCH = 100

function recoveryWhere(now: Date): Prisma.CustomerCreditRefundWhereInput {
  return {
    state: { in: ['SUBMITTING', 'UNKNOWN', 'BANK_CONFIRMED'] },
    submissionStartedAt: { lte: new Date(now.getTime() - GRACE_MS) },
    OR: [{ recoveryAfter: null }, { recoveryAfter: { lte: now } }],
  }
}

/**
 * Följer redan påbörjade utbetalningar; gör aldrig en ny submit. Ett okänt
 * bankutfall måste följas även när org/policy/tenant senare har spärrats.
 * Endast bankens definitiva besked eller lokal annullering före start kan
 * frigöra saldot. RESERVED inväntar den uttryckliga startvägen.
 */
@Injectable()
export class CustomerCreditRefundRecoveryScheduler {
  private readonly logger = new Logger(CustomerCreditRefundRecoveryScheduler.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly refunds: CustomerCreditRefundService,
    private readonly cronErrors: CronErrorSink,
  ) {}

  // ── KLASSIFICERING: B — SKYDDAT AV INVARIANT ──
  // updateMany(id, organizationId, state, submissionStartedAt, recoveryAttempts,
  // recoveryAfter due) flyttar nästa försök atomiskt. Bara count=1 får läsa banken.
  @Cron('*/15 * * * *')
  async recoverStartedRefunds(): Promise<void> {
    await runCronSafely(CRON_NAME, () => this.recoverPending(), {
      logger: this.logger,
      sink: this.cronErrors,
    })
  }

  async recoverPending(now = new Date()): Promise<{
    selected: number
    recovered: number
    pending: number
    failed: number
    limitReached: boolean
  }> {
    const where = recoveryWhere(now)
    const refunds = await this.prisma.customerCreditRefund.findMany({
      where,
      select: {
        id: true,
        organizationId: true,
        state: true,
        submissionStartedAt: true,
        recoveryAttempts: true,
      },
      orderBy: [
        { recoveryAfter: { sort: 'asc', nulls: 'first' } },
        { submissionStartedAt: 'asc' },
        { id: 'asc' },
      ],
      take: CUSTOMER_CREDIT_REFUND_RECOVERY_BATCH,
    })
    let recovered = 0
    let pending = 0
    let failed = 0
    for (const refund of refunds) {
      const context = {
        organizationId: refund.organizationId,
        detail: { refundId: refund.id },
      }
      try {
        const delay =
          RETRY_DELAYS_MS[Math.min(refund.recoveryAttempts, RETRY_DELAYS_MS.length - 1)]!
        const claim = await this.prisma.customerCreditRefund.updateMany({
          where: {
            AND: [where],
            id: refund.id,
            organizationId: refund.organizationId,
            state: refund.state,
            submissionStartedAt: refund.submissionStartedAt,
            recoveryAttempts: refund.recoveryAttempts,
          },
          data: {
            recoveryAfter: new Date(now.getTime() + delay),
            recoveryAttempts: { increment: 1 },
          },
        })
        if (claim.count !== 1) continue
        // Pausen är beständig före portanropet. En krasch förlorar inte ordern
        // och ger inte en omedelbar ny bankförfrågan från nästa instans.
        const result = await this.refunds.recoverRefund({
          organizationId: refund.organizationId,
          refundId: refund.id,
        })
        if (result.state === 'SETTLED' || result.state === 'REJECTED') {
          recovered++
        } else {
          pending++
          if (refund.recoveryAttempts >= RETRY_DELAYS_MS.length - 1) {
            await this.cronErrors.report(
              CRON_NAME,
              new Error(
                'Återbetalningen saknar slutligt verifierat bankbesked efter upprepade kontroller. Beloppet är fortsatt reserverat; ingen ny utbetalning har startats.',
              ),
              context,
            )
          }
        }
      } catch (error) {
        failed++
        // Bankadapterns råa fel maskeras vid portgränsen i domäntjänsten.
        // Interna diagnostikfel går till projektets befintliga varaktiga sänka.
        await this.cronErrors.report(CRON_NAME, error, context)
      }
    }
    const limitReached = refunds.length === CUSTOMER_CREDIT_REFUND_RECOVERY_BATCH
    if (limitReached) {
      this.logger.warn(
        `Återbetalningskontrollen nådde taket ${CUSTOMER_CREDIT_REFUND_RECOVERY_BATCH}; fler påbörjade återbetalningar kan vänta till nästa pass.`,
      )
    }
    return { selected: refunds.length, recovered, pending, failed, limitReached }
  }
}
