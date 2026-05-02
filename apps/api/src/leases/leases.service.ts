import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import type { LeaseStatus, LeaseType } from '@prisma/client'
import { Cron } from '@nestjs/schedule'
import { PrismaService } from '../common/prisma/prisma.service'
import { NotificationsService } from '../notifications/notifications.service'
import { DepositsService } from '../deposits/deposits.service'
import { RentIncreasesService } from '../rent-increases/rent-increases.service'
import { TenantAuthService } from '../tenant-portal/tenant-auth.service'
import { CreateLeaseDto } from './dto/create-lease.dto'
import { UpdateLeaseDto } from './dto/update-lease.dto'
import { CreateLeaseWithTenantDto } from './dto/create-lease-with-tenant.dto'
import { TerminateLeaseDto } from './dto/terminate-lease.dto'
import { RenewLeaseDto } from './dto/renew-lease.dto'

const VALID_TRANSITIONS: Partial<Record<LeaseStatus, LeaseStatus[]>> = {
  DRAFT: ['ACTIVE', 'TERMINATED'],
  ACTIVE: ['EXPIRED', 'TERMINATED'],
}

const INCLUDE = {
  unit: { include: { property: true } },
  tenant: true,
} as const

// Lägg till N månader till ett datum, hantera månadsdrift (31 jan + 1 mån = 28/29 feb).
function addMonths(date: Date, months: number): Date {
  const d = new Date(date)
  const targetMonth = d.getMonth() + months
  d.setMonth(targetMonth)
  // Om dag rullade (t.ex. 31 → 1 jan), backa till sista dagen i föregående månad.
  if (d.getMonth() !== ((targetMonth % 12) + 12) % 12) {
    d.setDate(0)
  }
  return d
}

function startOfDay(date: Date): Date {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  return d
}

// Översätt Postgres unique-konflikt på partial index lease_unit_active_unique
// till svensk BadRequest. Detta är skyddet mot race när två förfrågningar
// samtidigt försöker skapa/aktivera ACTIVE-kontrakt på samma enhet.
function isActiveUnitConflict(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) return false
  if (err.code !== 'P2002') return false
  const target = (err.meta as { target?: unknown } | undefined)?.target
  if (typeof target === 'string') return target.includes('lease_unit_active_unique')
  if (Array.isArray(target)) return target.includes('unitId')
  return false
}

@Injectable()
export class LeasesService {
  private readonly logger = new Logger(LeasesService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly deposits: DepositsService,
    private readonly rentIncreases: RentIncreasesService,
    private readonly tenantAuth: TenantAuthService,
  ) {}

  async findAll(organizationId: string) {
    return this.prisma.lease.findMany({
      where: { organizationId },
      include: INCLUDE,
      orderBy: { createdAt: 'desc' },
    })
  }

  async findOne(id: string, organizationId: string) {
    const lease = await this.prisma.lease.findFirst({
      where: { id, organizationId },
      include: INCLUDE,
    })
    if (!lease) throw new NotFoundException('Kontraktet hittades inte')
    return lease
  }

  async create(dto: CreateLeaseDto, organizationId: string) {
    const unit = await this.prisma.unit.findFirst({
      where: { id: dto.unitId },
      include: { property: true },
    })
    if (!unit || unit.property.organizationId !== organizationId) {
      throw new NotFoundException('Enheten hittades inte')
    }

    const tenant = await this.prisma.tenant.findFirst({
      where: { id: dto.tenantId, organizationId },
    })
    if (!tenant) throw new NotFoundException('Hyresgästen hittades inte')

    // Optimistic check – DB-constraint fångar race
    const existingActive = await this.prisma.lease.count({
      where: { unitId: dto.unitId, status: 'ACTIVE' },
    })
    if (existingActive > 0) {
      throw new BadRequestException('Enheten har redan ett aktivt kontrakt')
    }

    const leaseType: LeaseType = dto.leaseType ?? 'INDEFINITE'
    if (leaseType === 'FIXED_TERM' && !dto.endDate) {
      throw new BadRequestException('Tidsbegränsade kontrakt måste ha ett slutdatum')
    }

    return this.prisma.lease.create({
      data: {
        organizationId,
        unitId: dto.unitId,
        tenantId: dto.tenantId,
        startDate: new Date(dto.startDate),
        ...(dto.endDate != null ? { endDate: new Date(dto.endDate) } : {}),
        monthlyRent: dto.monthlyRent,
        depositAmount: dto.depositAmount ?? 0,
        status: 'DRAFT',
        leaseType,
        ...(dto.renewalPeriodMonths != null
          ? { renewalPeriodMonths: dto.renewalPeriodMonths }
          : {}),
        ...(dto.noticePeriodMonths != null ? { noticePeriodMonths: dto.noticePeriodMonths } : {}),
      },
      include: INCLUDE,
    })
  }

  async update(id: string, dto: UpdateLeaseDto, organizationId: string) {
    const existing = await this.findOne(id, organizationId)

    if (existing.status !== 'DRAFT' && existing.status !== 'ACTIVE') {
      throw new BadRequestException('Kontraktet kan inte redigeras i nuvarande status')
    }

    return this.prisma.lease.update({
      where: { id },
      data: {
        ...(dto.unitId != null ? { unitId: dto.unitId } : {}),
        ...(dto.tenantId != null ? { tenantId: dto.tenantId } : {}),
        ...(dto.startDate != null ? { startDate: new Date(dto.startDate) } : {}),
        ...(dto.endDate != null ? { endDate: new Date(dto.endDate) } : {}),
        ...(dto.monthlyRent != null ? { monthlyRent: dto.monthlyRent } : {}),
        ...(dto.depositAmount != null ? { depositAmount: dto.depositAmount } : {}),
        ...(dto.leaseType != null ? { leaseType: dto.leaseType } : {}),
        ...(dto.renewalPeriodMonths != null
          ? { renewalPeriodMonths: dto.renewalPeriodMonths }
          : {}),
        ...(dto.noticePeriodMonths != null ? { noticePeriodMonths: dto.noticePeriodMonths } : {}),
      },
      include: INCLUDE,
    })
  }

  async transitionStatus(id: string, newStatus: LeaseStatus, organizationId: string) {
    const lease = await this.findOne(id, organizationId)
    const allowed = VALID_TRANSITIONS[lease.status] ?? []

    if (!allowed.includes(newStatus)) {
      throw new BadRequestException('Ogiltig statusövergång')
    }

    // Optimistic check innan DRAFT→ACTIVE; partial unique index fångar race.
    if (newStatus === 'ACTIVE') {
      const existingActive = await this.prisma.lease.count({
        where: { unitId: lease.unitId, status: 'ACTIVE', id: { not: id } },
      })
      if (existingActive > 0) {
        throw new BadRequestException('Enheten har redan ett aktivt kontrakt')
      }
    }

    let updated
    try {
      updated = await this.prisma.$transaction(async (tx) => {
        const result = await tx.lease.update({
          where: { id },
          data: {
            status: newStatus,
            ...(newStatus === 'ACTIVE' ? { signedAt: new Date() } : {}),
            ...(newStatus === 'TERMINATED' ? { terminatedAt: new Date() } : {}),
          },
          include: INCLUDE,
        })

        // Synka enhetens status så att fastighetsöversikten alltid stämmer.
        if (newStatus === 'ACTIVE') {
          await tx.unit.update({ where: { id: lease.unitId }, data: { status: 'OCCUPIED' } })
        } else if (newStatus === 'TERMINATED' || newStatus === 'EXPIRED') {
          // Endast om det inte fortfarande finns ett annat ACTIVE-kontrakt på enheten
          const stillActive = await tx.lease.count({
            where: { unitId: lease.unitId, status: 'ACTIVE', id: { not: id } },
          })
          if (stillActive === 0) {
            await tx.unit.update({ where: { id: lease.unitId }, data: { status: 'VACANT' } })
          }
        }

        return result
      })
    } catch (err) {
      if (isActiveUnitConflict(err)) {
        throw new BadRequestException('Enheten har redan ett aktivt kontrakt')
      }
      throw err
    }

    // När ett kontrakt blir ACTIVE skickas välkomstmejl med aktiveringslänk
    // till hyresgästen så de kan signera kontraktet och välja eget lösenord.
    // Fire-and-forget: ett mejlfel ska inte rulla tillbaka aktiveringen.
    if (newStatus === 'ACTIVE') {
      void this.tenantAuth
        .sendWelcomeWithContract(lease.tenantId)
        .catch((err) =>
          this.logger.error(`[Leases] welcome-with-contract mail failed: ${String(err)}`),
        )
    }

    return updated
  }

  async createWithTenant(dto: CreateLeaseWithTenantDto, organizationId: string) {
    const unit = await this.prisma.unit.findFirst({
      where: { id: dto.unitId },
      include: { property: true },
    })
    if (!unit || unit.property.organizationId !== organizationId) {
      throw new NotFoundException('Enheten hittades inte')
    }

    const existingActive = await this.prisma.lease.count({
      where: { unitId: dto.unitId, status: 'ACTIVE' },
    })
    if (existingActive > 0) {
      throw new BadRequestException('Enheten har redan ett aktivt kontrakt')
    }

    const leaseType: LeaseType = dto.leaseType ?? 'INDEFINITE'
    if (leaseType === 'FIXED_TERM' && !dto.endDate) {
      throw new BadRequestException('Tidsbegränsade kontrakt måste ha ett slutdatum')
    }

    // Validera nya hyresgästuppgifter och kolla dubblett-email innan transaktionen
    // — felet är då rent en valideringsmiss, inte en halv-skapad situation.
    if (!dto.existingTenantId && dto.newTenant) {
      const { type, firstName, lastName, companyName, email } = dto.newTenant

      if (type === 'INDIVIDUAL' && (!firstName?.trim() || !lastName?.trim())) {
        throw new BadRequestException('Förnamn och efternamn krävs för privatperson')
      }
      if (type === 'COMPANY' && !companyName?.trim()) {
        throw new BadRequestException('Företagsnamn krävs för företag')
      }

      const duplicate = await this.prisma.tenant.findFirst({
        where: { organizationId, email },
        select: { id: true },
      })
      if (duplicate) {
        throw new BadRequestException(
          'En hyresgäst med denna e-postadress finns redan i organisationen',
        )
      }
    } else if (!dto.existingTenantId && !dto.newTenant) {
      throw new BadRequestException(
        'Ange antingen en befintlig hyresgäst eller uppgifter för en ny',
      )
    }

    let lease
    try {
      lease = await this.prisma.$transaction(async (tx) => {
        let tenantId: string

        if (dto.existingTenantId) {
          const tenant = await tx.tenant.findFirst({
            where: { id: dto.existingTenantId, organizationId },
          })
          if (!tenant) throw new NotFoundException('Hyresgästen hittades inte')
          tenantId = tenant.id
        } else if (dto.newTenant) {
          const {
            type,
            firstName,
            lastName,
            companyName,
            email,
            phone,
            personalNumber,
            orgNumber,
            street,
            city,
            postalCode,
            country,
          } = dto.newTenant

          const created = await tx.tenant.create({
            data: {
              organizationId,
              type,
              email,
              ...(firstName ? { firstName } : {}),
              ...(lastName ? { lastName } : {}),
              ...(companyName ? { companyName } : {}),
              ...(phone ? { phone } : {}),
              ...(personalNumber ? { personalNumber } : {}),
              ...(orgNumber ? { orgNumber } : {}),
              ...(street ? { street } : {}),
              ...(city ? { city } : {}),
              ...(postalCode ? { postalCode } : {}),
              ...(country ? { country } : {}),
            },
          })
          tenantId = created.id
        } else {
          throw new BadRequestException(
            'Ange antingen en befintlig hyresgäst eller uppgifter för en ny',
          )
        }

        return tx.lease.create({
          data: {
            organizationId,
            unitId: dto.unitId,
            tenantId,
            monthlyRent: dto.monthlyRent,
            depositAmount: dto.depositAmount ?? 0,
            startDate: new Date(dto.startDate),
            ...(dto.endDate ? { endDate: new Date(dto.endDate) } : {}),
            status: 'DRAFT',
            leaseType,
            ...(dto.renewalPeriodMonths != null
              ? { renewalPeriodMonths: dto.renewalPeriodMonths }
              : {}),
            ...(dto.noticePeriodMonths != null
              ? { noticePeriodMonths: dto.noticePeriodMonths }
              : {}),
          },
          include: INCLUDE,
        })
      })
    } catch (err) {
      if (isActiveUnitConflict(err)) {
        throw new BadRequestException('Enheten har redan ett aktivt kontrakt')
      }
      // P2002 på ([organizationId, email]) — race där två förfrågningar samtidigt
      // skapar tenant med samma e-post. Dubblett-checken före tx fångar normalfallet.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002' &&
        Array.isArray((err.meta as { target?: unknown } | undefined)?.target) &&
        ((err.meta as { target?: string[] }).target ?? []).includes('email')
      ) {
        throw new BadRequestException(
          'En hyresgäst med denna e-postadress finns redan i organisationen',
        )
      }
      throw err
    }

    // Inget portalmejl skickas vid kontraktsskapande — välkomstmejlet med
    // aktiveringslänk skickas när kontraktet aktiveras (DRAFT → ACTIVE).
    return lease
  }

  async remove(id: string, organizationId: string): Promise<void> {
    const lease = await this.findOne(id, organizationId)

    if (lease.status !== 'DRAFT') {
      throw new BadRequestException('Endast utkast kan tas bort')
    }

    await this.prisma.lease.delete({ where: { id } })
  }

  // ── Uppsägningsflöde ─────────────────────────────────────────────────────────

  async terminate(id: string, dto: TerminateLeaseDto, organizationId: string) {
    const lease = await this.findOne(id, organizationId)

    if (lease.status !== 'ACTIVE' && lease.status !== 'DRAFT') {
      throw new BadRequestException('Endast aktiva eller utkast-avtal kan sägas upp')
    }
    if (lease.terminatedAt) {
      throw new BadRequestException('Kontraktet är redan uppsagt')
    }

    const today = startOfDay(new Date())
    const effective = dto.effectiveDate
      ? startOfDay(new Date(dto.effectiveDate))
      : addMonths(today, lease.noticePeriodMonths)

    if (effective < today) {
      throw new BadRequestException('Slutdatum kan inte vara i förflutet')
    }

    const updated = await this.prisma.lease.update({
      where: { id },
      data: {
        terminatedAt: today,
        endDate: effective,
        ...(dto.terminationReason ? { terminationReason: dto.terminationReason } : {}),
      },
      include: INCLUDE,
    })

    // Eventuell deposition flyttas till REFUND_PENDING.
    void this.deposits
      .markRefundPendingForLease(id, organizationId)
      .catch((err) => this.logger.error(`Deposit refund-pending failed: ${String(err)}`))

    // Notis till alla användare i organisationen
    void this.notifications
      .createForAllOrgUsers(
        organizationId,
        'LEASE_EXPIRED',
        'Kontrakt uppsagt',
        `Hyresavtal för enhet ${updated.unit.name} sägs upp och avslutas ${effective
          .toISOString()
          .slice(0, 10)}`,
        '/leases',
      )
      .catch((err) => this.logger.error(`Notification error: ${String(err)}`))

    return updated
  }

  // ── Förnyelsebeslut för FIXED_TERM ───────────────────────────────────────────

  async renew(id: string, dto: RenewLeaseDto, organizationId: string) {
    const lease = await this.findOne(id, organizationId)

    if (lease.leaseType !== 'FIXED_TERM') {
      throw new BadRequestException('Bara tidsbegränsade kontrakt kan förnyas')
    }
    if (lease.status !== 'ACTIVE') {
      throw new BadRequestException('Bara aktiva kontrakt kan förnyas')
    }
    if (!lease.endDate) {
      throw new BadRequestException('Kontraktet saknar slutdatum')
    }

    // Nytt kontrakt börjar dagen efter gamla slutdatum
    const oldEnd = startOfDay(lease.endDate)
    const newStart = new Date(oldEnd.getTime() + 86_400_000)

    let newEnd: Date
    if (dto.newEndDate) {
      newEnd = startOfDay(new Date(dto.newEndDate))
    } else if (lease.renewalPeriodMonths != null) {
      newEnd = addMonths(newStart, lease.renewalPeriodMonths)
    } else {
      throw new BadRequestException('Ange newEndDate eller sätt renewalPeriodMonths på kontraktet')
    }

    if (newEnd <= newStart) {
      throw new BadRequestException('Slutdatum måste vara efter startdatum')
    }

    return this.prisma.$transaction(async (tx) => {
      // Markera gamla kontraktet som EXPIRED
      await tx.lease.update({
        where: { id: lease.id },
        data: { status: 'EXPIRED' },
      })

      // Skapa nytt kontrakt — samma villkor men nya datum (och ev. ny hyra)
      const created = await tx.lease.create({
        data: {
          organizationId,
          unitId: lease.unitId,
          tenantId: lease.tenantId,
          startDate: newStart,
          endDate: newEnd,
          monthlyRent: dto.monthlyRent ?? lease.monthlyRent,
          depositAmount: lease.depositAmount,
          status: 'ACTIVE',
          leaseType: 'FIXED_TERM',
          ...(lease.renewalPeriodMonths != null
            ? { renewalPeriodMonths: lease.renewalPeriodMonths }
            : {}),
          noticePeriodMonths: lease.noticePeriodMonths,
          indexClause: lease.indexClause,
          signedAt: new Date(),
        },
        include: INCLUDE,
      })

      // Säkerställ att enhetsstatus förblir OCCUPIED (det nya avtalet är ACTIVE)
      await tx.unit.update({ where: { id: lease.unitId }, data: { status: 'OCCUPIED' } })

      return created
    })
  }

  // ── Cron: livscykel-processering ─────────────────────────────────────────────
  // Körs varje dag 06:00. Tre uppgifter:
  //   a) auto-förläng FIXED_TERM som löpt ut utan uppsägning
  //   b) skicka påminnelser 90/60/30 dagar innan slutdatum
  //   c) avsluta uppsagda avtal som nått slutdatum
  @Cron('0 6 * * *')
  async processLifecycle(): Promise<void> {
    const today = startOfDay(new Date())

    const [renewed, reminders, terminated, depositReminders, rentApplied] = await Promise.all([
      this.autoRenewExpiredFixedTerm(today),
      this.sendExpiryReminders(today),
      this.terminateExpiredNoticeLeases(today),
      this.deposits.remindStaleRefundPending(),
      this.rentIncreases.applyDueIncreases(today),
    ])

    this.logger.log(
      `[Leases] Lifecycle done: ${renewed} renewed, ${reminders} reminders, ${terminated} terminated, ${depositReminders} deposit reminders, ${rentApplied} rent increases applied`,
    )
  }

  // a) Hitta FIXED_TERM ACTIVE där endDate < idag och terminatedAt IS NULL,
  // skapa nytt avtal med samma villkor och markera gamla EXPIRED.
  private async autoRenewExpiredFixedTerm(today: Date): Promise<number> {
    const candidates = await this.prisma.lease.findMany({
      where: {
        status: 'ACTIVE',
        leaseType: 'FIXED_TERM',
        terminatedAt: null,
        endDate: { lt: today, not: null },
      },
      include: INCLUDE,
    })

    let renewed = 0
    for (const lease of candidates) {
      if (!lease.endDate) continue
      // Auto-förläng kräver att renewalPeriodMonths är satt — annars hoppa över.
      if (lease.renewalPeriodMonths == null) continue

      const newStart = new Date(startOfDay(lease.endDate).getTime() + 86_400_000)
      const newEnd = addMonths(newStart, lease.renewalPeriodMonths)

      try {
        await this.prisma.$transaction(async (tx) => {
          await tx.lease.update({
            where: { id: lease.id },
            data: { status: 'EXPIRED' },
          })

          await tx.lease.create({
            data: {
              organizationId: lease.organizationId,
              unitId: lease.unitId,
              tenantId: lease.tenantId,
              startDate: newStart,
              endDate: newEnd,
              monthlyRent: lease.monthlyRent,
              depositAmount: lease.depositAmount,
              status: 'ACTIVE',
              leaseType: 'FIXED_TERM',
              renewalPeriodMonths: lease.renewalPeriodMonths,
              noticePeriodMonths: lease.noticePeriodMonths,
              indexClause: lease.indexClause,
              signedAt: new Date(),
            },
          })
        })
        this.logger.log(`[Leases] Auto-renewed lease ${lease.id} for unit ${lease.unitId}`)
        renewed++
      } catch (err) {
        this.logger.error(`[Leases] Auto-renew failed for ${lease.id}: ${String(err)}`)
      }
    }
    return renewed
  }

  // b) Skicka in-app-notiser för FIXED_TERM ACTIVE där endDate är exakt
  // 90, 60 eller 30 dagar bort.
  private async sendExpiryReminders(today: Date): Promise<number> {
    let sent = 0
    for (const days of [90, 60, 30]) {
      const target = new Date(today.getTime() + days * 86_400_000)
      const targetEnd = new Date(target.getTime() + 86_400_000)

      const expiring = await this.prisma.lease.findMany({
        where: {
          status: 'ACTIVE',
          leaseType: 'FIXED_TERM',
          terminatedAt: null,
          endDate: { gte: target, lt: targetEnd },
        },
        include: INCLUDE,
      })

      for (const lease of expiring) {
        try {
          await this.notifications.createForAllOrgUsers(
            lease.organizationId,
            'LEASE_EXPIRING',
            `Kontrakt löper ut om ${days} dagar`,
            `Hyresavtal för ${lease.unit.name} (${lease.unit.property.name}) löper ut ${lease.endDate
              ?.toISOString()
              .slice(0, 10)}. Förnya eller säg upp.`,
            '/leases',
          )
          sent++
        } catch (err) {
          this.logger.error(`[Leases] Reminder failed for ${lease.id}: ${String(err)}`)
        }
      }
    }
    return sent
  }

  // c) Hitta uppsagda kontrakt där slutdatumet har passerat → markera TERMINATED
  // och frigör enheten.
  private async terminateExpiredNoticeLeases(today: Date): Promise<number> {
    const due = await this.prisma.lease.findMany({
      where: {
        status: 'ACTIVE',
        terminatedAt: { not: null },
        endDate: { lt: today, not: null },
      },
    })

    let terminated = 0
    for (const lease of due) {
      try {
        await this.prisma.$transaction(async (tx) => {
          await tx.lease.update({
            where: { id: lease.id },
            data: { status: 'TERMINATED' },
          })

          // Frigör enheten om inget annat ACTIVE-kontrakt finns
          const stillActive = await tx.lease.count({
            where: { unitId: lease.unitId, status: 'ACTIVE', id: { not: lease.id } },
          })
          if (stillActive === 0) {
            await tx.unit.update({ where: { id: lease.unitId }, data: { status: 'VACANT' } })
          }
        })
        this.logger.log(`[Leases] Terminated expired-notice lease ${lease.id}`)
        terminated++
      } catch (err) {
        this.logger.error(`[Leases] Termination cron failed for ${lease.id}: ${String(err)}`)
      }
    }
    return terminated
  }
}
