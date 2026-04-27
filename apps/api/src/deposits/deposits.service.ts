import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common'
import type { Deposit, DepositStatus, Prisma } from '@prisma/client'
import { PrismaService } from '../common/prisma/prisma.service'
import { AccountingService } from '../accounting/accounting.service'
import { NotificationsService } from '../notifications/notifications.service'
import { CreateDepositDto } from './dto/create-deposit.dto'
import { RefundDepositDto } from './dto/refund-deposit.dto'

const INCLUDE = {
  lease: { include: { unit: { include: { property: true } } } },
  tenant: true,
  invoice: { select: { id: true, invoiceNumber: true, status: true, total: true } },
} as const

interface DepositDeduction {
  reason: string
  amount: number
}

@Injectable()
export class DepositsService {
  private readonly logger = new Logger(DepositsService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly accounting: AccountingService,
    private readonly notifications: NotificationsService,
  ) {}

  async findAll(
    organizationId: string,
    filters?: { status?: DepositStatus; leaseId?: string },
  ): Promise<Deposit[]> {
    return this.prisma.deposit.findMany({
      where: {
        organizationId,
        ...(filters?.status ? { status: filters.status } : {}),
        ...(filters?.leaseId ? { leaseId: filters.leaseId } : {}),
      },
      include: INCLUDE,
      orderBy: { createdAt: 'desc' },
    })
  }

  async findOne(id: string, organizationId: string) {
    const deposit = await this.prisma.deposit.findFirst({
      where: { id, organizationId },
      include: INCLUDE,
    })
    if (!deposit) throw new NotFoundException('Depositionen hittades inte')
    return deposit
  }

  async findByLease(leaseId: string, organizationId: string) {
    return this.prisma.deposit.findFirst({
      where: { leaseId, organizationId },
      include: INCLUDE,
    })
  }

  // ── Skapa deposition (med automatisk faktura + bokföringspost) ──────────────

  async create(dto: CreateDepositDto, organizationId: string, userId: string): Promise<Deposit> {
    const lease = await this.prisma.lease.findFirst({
      where: { id: dto.leaseId, organizationId },
      select: { id: true, tenantId: true, depositAmount: true },
    })
    if (!lease) throw new NotFoundException('Hyresavtalet hittades inte')

    const existing = await this.prisma.deposit.findUnique({ where: { leaseId: dto.leaseId } })
    if (existing) {
      throw new BadRequestException('Kontraktet har redan en deposition')
    }

    const amount = dto.amount ?? Number(lease.depositAmount)
    if (amount <= 0) {
      throw new BadRequestException('Depositionsbelopp måste vara större än 0')
    }

    const today = new Date()
    const dueDate = new Date()
    dueDate.setDate(dueDate.getDate() + 30)

    const result = await this.prisma.$transaction(async (tx) => {
      // Generera fakturanummer (samma mönster som InvoicesService).
      const year = today.getFullYear()
      const count = await tx.invoice.count({ where: { organizationId } })
      const invoiceNumber = `F-${year}-${String(count + 1).padStart(4, '0')}`

      const invoice = await tx.invoice.create({
        data: {
          organizationId,
          invoiceNumber,
          type: 'DEPOSIT',
          status: 'DRAFT',
          tenantId: lease.tenantId,
          leaseId: lease.id,
          subtotal: amount,
          vatTotal: 0,
          total: amount,
          dueDate,
          issueDate: today,
          notes: 'Deposition enligt hyresavtal',
          lines: {
            create: [
              {
                description: 'Deposition',
                quantity: 1,
                unitPrice: amount,
                vatRate: 0,
                total: amount,
              },
            ],
          },
        },
      })

      const deposit = await tx.deposit.create({
        data: {
          organizationId,
          leaseId: lease.id,
          tenantId: lease.tenantId,
          amount,
          status: 'PENDING',
          invoiceId: invoice.id,
          ...(dto.notes ? { notes: dto.notes } : {}),
        },
        include: INCLUDE,
      })

      await tx.invoiceEvent.create({
        data: {
          invoiceId: invoice.id,
          type: 'CREATED',
          actorType: 'USER',
          actorId: userId,
          payload: { invoiceNumber, depositId: deposit.id },
        },
      })

      return { deposit, invoice }
    })

    // Bokföringspost utanför transaktionen — samma mönster som invoices/reconciliation.
    try {
      await this.accounting.createJournalEntryForDepositInvoice(
        result.deposit.id,
        organizationId,
        Number(result.invoice.total),
        result.invoice.invoiceNumber,
        result.invoice.issueDate,
        userId,
      )
    } catch (err) {
      this.logger.error(`Deposit accounting entry failed: ${String(err)}`)
    }

    return result.deposit
  }

  // ── Markera som betald ──────────────────────────────────────────────────────

  async markPaid(id: string, organizationId: string, userId: string): Promise<Deposit> {
    const deposit = await this.findOne(id, organizationId)

    if (deposit.status !== 'PENDING') {
      throw new BadRequestException('Endast väntande depositioner kan markeras som betalda')
    }

    return this.prisma.$transaction(async (tx) => {
      const now = new Date()
      const updated = await tx.deposit.update({
        where: { id },
        data: { status: 'PAID', paidAt: now },
        include: INCLUDE,
      })

      if (deposit.invoiceId) {
        await tx.invoice.update({
          where: { id: deposit.invoiceId },
          data: { status: 'PAID', paidAt: now },
        })
        await tx.invoiceEvent.create({
          data: {
            invoiceId: deposit.invoiceId,
            type: 'PAYMENT_RECEIVED',
            actorType: 'USER',
            actorId: userId,
            payload: { source: 'deposit', amount: Number(deposit.amount) },
          },
        })
      }

      return updated
    })
  }

  // ── Återbetalning ───────────────────────────────────────────────────────────

  async refund(id: string, dto: RefundDepositDto, organizationId: string, userId: string) {
    const deposit = await this.findOne(id, organizationId)

    if (deposit.status !== 'PAID' && deposit.status !== 'REFUND_PENDING') {
      throw new BadRequestException('Bara betalda depositioner kan återbetalas')
    }

    const total = Number(deposit.amount)
    const deductions = (dto.deductions ?? []) as DepositDeduction[]
    const deductionsTotal = deductions.reduce((sum, d) => sum + Number(d.amount), 0)

    if (dto.refundAmount < 0) {
      throw new BadRequestException('Återbetalningsbelopp får inte vara negativt')
    }
    if (deductionsTotal < 0) {
      throw new BadRequestException('Avdrag får inte vara negativa')
    }

    const sum = Number((dto.refundAmount + deductionsTotal).toFixed(2))
    if (Math.abs(sum - total) > 0.01) {
      throw new BadRequestException(
        `Återbetalning + avdrag (${sum.toFixed(2)}) måste matcha depositionsbeloppet (${total.toFixed(2)})`,
      )
    }

    const newStatus: DepositStatus =
      dto.refundAmount === 0
        ? 'FORFEITED'
        : deductionsTotal === 0
          ? 'REFUNDED'
          : 'PARTIALLY_REFUNDED'

    const now = new Date()
    const updated = await this.prisma.deposit.update({
      where: { id },
      data: {
        status: newStatus,
        refundedAt: now,
        refundAmount: dto.refundAmount,
        deductions: deductions as unknown as Prisma.InputJsonValue,
        ...(dto.notes ? { notes: dto.notes } : {}),
      },
      include: INCLUDE,
    })

    try {
      await this.accounting.createJournalEntryForDepositRefund(
        id,
        organizationId,
        dto.refundAmount,
        deductionsTotal,
        now,
        userId,
      )
    } catch (err) {
      this.logger.error(`Deposit refund accounting failed: ${String(err)}`)
    }

    return updated
  }

  // ── Lease-uppsägning sätter REFUND_PENDING ──────────────────────────────────

  async markRefundPendingForLease(leaseId: string, organizationId: string): Promise<void> {
    const deposit = await this.prisma.deposit.findFirst({
      where: { leaseId, organizationId, status: 'PAID' },
      select: { id: true },
    })
    if (!deposit) return

    await this.prisma.deposit.update({
      where: { id: deposit.id },
      data: { status: 'REFUND_PENDING' },
    })
  }

  // ── Cron-hjälpare: påminn om depositioner som väntat >30d på återbetalning ─

  async remindStaleRefundPending(): Promise<number> {
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - 30)

    const stale = await this.prisma.deposit.findMany({
      where: {
        status: 'REFUND_PENDING',
        updatedAt: { lt: cutoff },
      },
      include: { lease: { include: { unit: true } } },
    })

    let sent = 0
    for (const deposit of stale) {
      const days = Math.floor((Date.now() - deposit.updatedAt.getTime()) / 86_400_000)
      try {
        await this.notifications.createForAllOrgUsers(
          deposit.organizationId,
          'SYSTEM',
          'Deposition väntar på återbetalning',
          `Deposition för ${deposit.lease.unit.name} har väntat på återbetalning i ${days} dagar.`,
          '/deposits',
        )
        sent++
      } catch (err) {
        this.logger.error(`Reminder failed for deposit ${deposit.id}: ${String(err)}`)
      }
    }
    return sent
  }
}
