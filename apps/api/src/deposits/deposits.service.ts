import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
} from '@nestjs/common'
import type { Deposit, DepositStatus, Prisma } from '@prisma/client'
import { PrismaService } from '../common/prisma/prisma.service'
import { AccountingService } from '../accounting/accounting.service'
import { allocateInvoiceNumber } from '../invoices/invoice-number'
import { NotificationsService } from '../notifications/notifications.service'
import { CreateDepositDto } from './dto/create-deposit.dto'
import { RefundDepositDto } from './dto/refund-deposit.dto'
import { SAFE_TENANT_SELECT } from '../tenants/tenants.service'

const INCLUDE = {
  lease: { include: { unit: { include: { property: true } } } },
  tenant: { select: SAFE_TENANT_SELECT },
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
      select: {
        id: true,
        tenantId: true,
        depositAmount: true,
        monthlyRent: true,
        unit: { select: { type: true } },
      },
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

    // Praxis (hyresnämnden + Konsumentverket): deposition för bostad får inte
    // överstiga 3 månadshyror. Lokalhyra har fri depositionsbestämning.
    // Validering här fångar fallet då dto.amount överrider lease.depositAmount
    // — leases.service validerar redan vid kontraktsskapande.
    if (lease.unit.type === 'APARTMENT') {
      const monthlyRent = Number(lease.monthlyRent)
      const cap = monthlyRent * 3
      if (amount > cap) {
        throw new BadRequestException(
          `Deposition för bostad får enligt praxis inte överstiga 3 månadshyror (${cap.toLocaleString(
            'sv-SE',
          )} kr). Högre belopp kan ogiltigförklaras som otillåten förskottshyra.`,
        )
      }
    }

    const today = new Date()
    const dueDate = new Date()
    dueDate.setDate(dueDate.getDate() + 30)

    const result = await this.prisma.$transaction(async (tx) => {
      // Delad, race-säker allokering (samma sekvens som InvoicesService) — den
      // gamla count()+1 kolliderade med sekvensen och kraschade manuell
      // fakturering efter en deposition (unique-constraint på invoiceNumber).
      const { invoiceNumber } = await allocateInvoiceNumber(tx, organizationId, today.getFullYear())

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

      // Status-guardad claim på DEPOSITIONEN (sanningskällan för "betald") — race-säker.
      const claim = await tx.deposit.updateMany({
        where: { id, organizationId, status: 'PENDING' },
        data: { status: 'PAID', paidAt: now },
      })
      if (claim.count === 0) {
        throw new ConflictException(
          'Depositionen är redan reglerad — uppdatera sidan och försök igen',
        )
      }

      if (deposit.invoiceId) {
        // Rad-lås deposit-fakturan → serialisera mot bankavstämningens applyMatchToInvoice
        // så samma inbetalning aldrig dubbelbokförs.
        await tx.$queryRaw`SELECT id FROM "Invoice" WHERE id = ${deposit.invoiceId} AND "organizationId" = ${organizationId} FOR UPDATE`
        const inv = await tx.invoice.findFirst({
          where: { id: deposit.invoiceId, organizationId },
          select: { id: true, status: true, invoiceNumber: true },
        })

        // Boka bara om fakturan inte redan reglerats (t.ex. av en bankmatch) — annars
        // står vi kvar med en redan bokförd betalning och ska inte dubbelbokföra.
        if (inv && inv.status !== 'PAID' && inv.status !== 'VOID') {
          await tx.invoice.update({
            where: { id: inv.id },
            data: { status: 'PAID', paidAt: now },
          })
          await tx.invoiceEvent.create({
            data: {
              invoiceId: inv.id,
              type: 'PAYMENT_RECEIVED',
              actorType: 'USER',
              actorId: userId,
              payload: { source: 'deposit', amount: Number(deposit.amount) },
            },
          })

          // Bokför inbetalningen (likvidkonto 1930 D / 1510 K) i SAMMA tx. Reglerar
          // depositionens kundfordran som bokfördes vid create (1510 D / 2890 K).
          // Utan detta stod 1510 kvar öppen trots betald deposition (BFL 5 kap 6 §).
          // Verifikatet uteblir (null) → kasta → hela markPaid rullas tillbaka.
          const entry = await this.accounting.createJournalEntryForInvoiceManualPayment(
            { id: inv.id, invoiceNumber: inv.invoiceNumber },
            Number(deposit.amount),
            now,
            'MANUAL',
            organizationId,
            userId,
            tx,
          )
          if (entry === null) {
            throw new InternalServerErrorException(
              `Betalningsverifikat kunde inte skapas för deposition ${id} — ` +
                'kontrollera att kontoplanen innehåller konto 1930 och 1510.',
            )
          }
        }
      }

      return tx.deposit.findFirstOrThrow({ where: { id, organizationId }, include: INCLUDE })
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
          { relatedEntityType: 'DEPOSIT', relatedEntityId: deposit.id },
        )
        sent++
      } catch (err) {
        this.logger.error(`Reminder failed for deposit ${deposit.id}: ${String(err)}`)
      }
    }
    return sent
  }
}
