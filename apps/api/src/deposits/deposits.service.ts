import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
  type OnApplicationBootstrap,
} from '@nestjs/common'
import { Prisma } from '@prisma/client'
import type { Deposit, DepositStatus } from '@prisma/client'
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
export class DepositsService implements OnApplicationBootstrap {
  private readonly logger = new Logger(DepositsService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly accounting: AccountingService,
    private readonly notifications: NotificationsService,
  ) {}

  // #41: kör backfillen EN gång vid uppstart (efter migrate deploy) så befintliga
  // orphan-deposition-avier får sin Deposit-rad + 1510 D/2890 K medan ingen
  // räkenskapsperiod ännu stängts. Idempotent (0 orphans efter första körningen)
  // + best-effort (får aldrig blockera app-start). Hoppas i testmiljö.
  async onApplicationBootstrap(): Promise<void> {
    if (process.env.NODE_ENV === 'test') return
    try {
      await this.backfillOrphanDepositNotices()
    } catch (err) {
      this.logger.error(`[deposit-backfill] uppstarts-backfill misslyckades: ${String(err)}`)
    }
  }

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

      // T5 A1: boka 1510 D / 2890 K i SAMMA transaktion som Invoice+Deposit
      // (speglar ensureDepositForNotice). En Deposit får ALDRIG existera utan sin
      // 1510-debet — annars blir bankmatchningens 1930 D/1510 K en ogrundad
      // kreditering (F1-fällan). Kastar (eller null → kontoplan saknar 1510/2890)
      // rullas HELA depositionen tillbaka. Tidigare låg bokföringen utanför tx och
      // sväljdes, så en obokförd deposition kunde bli kvar.
      const entry = await this.accounting.createJournalEntryForDepositInvoice(
        deposit.id,
        organizationId,
        Number(invoice.total),
        invoice.invoiceNumber,
        invoice.issueDate,
        userId,
        tx,
      )
      if (entry === null) {
        throw new InternalServerErrorException(
          `Depositionens bokföringspost (1510 D / 2890 K) kunde inte skapas för faktura ` +
            `${invoice.invoiceNumber} — kontoplanen saknar konto 1510 eller 2890.`,
        )
      }

      return { deposit, invoice }
    })

    return result.deposit
  }

  // ── #41: Deposit-rad för aktiverings-avin (skapa + boka atomiskt) ───────────
  //
  // Aktiveringen skapar en RentNotice{DEPOSIT} men historiskt ingen Deposit-rad
  // → depositionen bokfördes aldrig (1510/2890) och kunde aldrig återbetalas.
  // Denna metod skapar Deposit-raden OCH bokför 1510 D/2890 K i SAMMA transaktion
  // (Deposit finns ⇔ accrual bokförd). Delad av aktiveringen (avisering) och
  // backfillen så konteringen blir identisk. Idempotent: en deposition per lease
  // (leaseId @unique) — hoppar om den redan finns (manuell eller redan skapad).
  // Kastar om accrual-verifikatet uteblir (saknad kontoplan) så en Deposit ALDRIG
  // existerar utan bokförd 1510-debet (annars vore bankmatchningens 1930 D/1510 K
  // en ogrundad kreditering — F1-fällan).
  async ensureDepositForNotice(params: {
    organizationId: string
    leaseId: string
    tenantId: string
    rentNoticeId: string
    noticeNumber: string
    amount: number
    date: Date
  }): Promise<{ created: boolean }> {
    const amount = Number(params.amount)
    if (!(amount > 0)) return { created: false }

    const existing = await this.prisma.deposit.findUnique({
      where: { leaseId: params.leaseId },
      select: { id: true },
    })
    if (existing) return { created: false }

    try {
      await this.prisma.$transaction(async (tx) => {
        const deposit = await tx.deposit.create({
          data: {
            organizationId: params.organizationId,
            leaseId: params.leaseId,
            tenantId: params.tenantId,
            rentNoticeId: params.rentNoticeId,
            amount,
            status: 'PENDING',
          },
        })
        const entry = await this.accounting.createJournalEntryForDepositInvoice(
          deposit.id,
          params.organizationId,
          amount,
          params.noticeNumber,
          params.date,
          null,
          tx,
        )
        if (entry === null) {
          throw new InternalServerErrorException(
            `Depositionens bokföringspost (1510 D / 2890 K) kunde inte skapas för avi ` +
              `${params.noticeNumber} — kontoplanen saknar konto 1510 eller 2890.`,
          )
        }
      })
      return { created: true }
    } catch (err) {
      // Race: en samtidig aktivering/backfill hann skapa Deposit (leaseId @unique).
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return { created: false }
      }
      throw err
    }
  }

  // #41-backfill: skapa Deposit + boka 1510 D/2890 K för befintliga deposition-avier
  // utan länkad Deposit (skapade före #41). Idempotent (ensureDepositForNotice
  // hoppar redan skapade). Körs vid uppstart — MÅSTE köras medan ingen räkenskaps-
  // period är stängd (VerifikationsnummerService blockerar annars gamla datum).
  // Best-effort per avi så en enskild felkontoplan inte stoppar hela svepet.
  async backfillOrphanDepositNotices(): Promise<{ scanned: number; created: number }> {
    const orphans = await this.prisma.rentNotice.findMany({
      where: { type: 'DEPOSIT', deposit: { is: null } },
      select: {
        id: true,
        organizationId: true,
        leaseId: true,
        tenantId: true,
        noticeNumber: true,
        totalAmount: true,
        createdAt: true,
      },
    })
    let created = 0
    for (const n of orphans) {
      try {
        const r = await this.ensureDepositForNotice({
          organizationId: n.organizationId,
          leaseId: n.leaseId,
          tenantId: n.tenantId,
          rentNoticeId: n.id,
          noticeNumber: n.noticeNumber,
          amount: Number(n.totalAmount),
          date: n.createdAt,
        })
        if (r.created) created++
      } catch (err) {
        this.logger.error(
          `[deposit-backfill] avi ${n.noticeNumber} (lease ${n.leaseId}) misslyckades: ${String(err)}`,
        )
      }
    }
    if (orphans.length > 0) {
      this.logger.log(
        `[deposit-backfill] ${created}/${orphans.length} orphan-deposition-avier bakåtfyllda (Deposit + 1510 D/2890 K)`,
      )
    }
    return { scanned: orphans.length, created }
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
      } else if (deposit.rentNoticeId) {
        // #41/T2.2: avi-länkad deposition utan Invoice → boka manuell betalning
        // 1930 D / 1510 K keyat på depositId, och flippa den länkade avin → PAID.
        // Deposit-status-claimen ovan (PENDING→PAID) serialiserar mot bankmatchningen
        // (som kräver Deposit=PENDING) → bara EN väg bokför, ingen dubbelbokning.
        const entry = await this.accounting.createJournalEntryForDepositManualPayment(
          id,
          organizationId,
          Number(deposit.amount),
          now,
          'MANUAL',
          userId,
          tx,
        )
        if (entry === null) {
          throw new InternalServerErrorException(
            `Betalningsverifikat kunde inte skapas för deposition ${id} — ` +
              'kontoplanen saknar konto 1930 eller 1510.',
          )
        }
        // Flippa den länkade depositionsavin → PAID (status-guardad) så den inte
        // ligger kvar som obetald/bankmatchbar.
        await tx.rentNotice.updateMany({
          where: {
            id: deposit.rentNoticeId,
            organizationId,
            status: { in: ['SENT', 'PENDING', 'OVERDUE'] },
          },
          data: { status: 'PAID', paidAt: now },
        })
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
    // #25/T2.2: statusbytet OCH återbetalningsverifikatet i SAMMA transaktion.
    // Uteblir verifikatet (t.ex. saknat konto 3040 för skadeavdrag efter att
    // 1510-fallbacken tagits bort) kastar vi → hela återbetalningen rullas
    // tillbaka. Tidigare loggades bokföringsfel bara → depositionen kunde stå
    // som REFUNDED/FORFEITED medan 2890-skulden aldrig reverserades (BFL 5:6).
    return this.prisma.$transaction(async (tx) => {
      // Status-gardad claim (samma mönster som markPaid) — race-säker mot ett
      // samtidigt refund-anrop. Utan den kan en andra samtidig transaktion skriva
      // över refundAmount/deductions/status EFTER att den första committat, medan
      // idempotensnyckeln (deposit-refund:<id>) bara låter ETT verifikat skapas →
      // Deposit-fälten skulle divergera från det faktiskt bokförda verifikatet.
      const claim = await tx.deposit.updateMany({
        where: { id, organizationId, status: { in: ['PAID', 'REFUND_PENDING'] } },
        data: {
          status: newStatus,
          refundedAt: now,
          refundAmount: dto.refundAmount,
          deductions: deductions as unknown as Prisma.InputJsonValue,
          ...(dto.notes ? { notes: dto.notes } : {}),
        },
      })
      if (claim.count === 0) {
        throw new ConflictException(
          'Depositionen är redan reglerad — uppdatera sidan och försök igen',
        )
      }

      const entry = await this.accounting.createJournalEntryForDepositRefund(
        id,
        organizationId,
        dto.refundAmount,
        deductionsTotal,
        now,
        userId,
        tx,
      )
      if (entry === null) {
        throw new InternalServerErrorException(
          `Återbetalningsverifikat kunde inte skapas för deposition ${id} — ` +
            'kontrollera att kontoplanen innehåller konto 2890 och 1930, samt konto 3040 ' +
            'om avdrag för skada anges.',
        )
      }

      return tx.deposit.findFirstOrThrow({ where: { id, organizationId }, include: INCLUDE })
    })
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

  // #73 catch-up: läker en PAID-deposition på ett redan TERMINATED-kontrakt som av
  // någon anledning (transient DB-fel i terminateExpiredNoticeLeases best-effort-
  // anropet) aldrig flaggades REFUND_PENDING vid utflytt. Utan denna dagliga sweep
  // fanns ingen självläkning — depositionen kunde hänga permanent i PAID efter
  // avflytt (hyresjurist-fynd). Idempotent (updateMany med statusfilter).
  async sweepTerminatedLeasesForRefundPending(): Promise<number> {
    const res = await this.prisma.deposit.updateMany({
      where: { status: 'PAID', lease: { status: 'TERMINATED' } },
      data: { status: 'REFUND_PENDING' },
    })
    if (res.count > 0) {
      this.logger.log(
        `[deposit-refund-sweep] ${res.count} deposition(er) på TERMINATED-kontrakt flaggade REFUND_PENDING`,
      )
    }
    return res.count
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
