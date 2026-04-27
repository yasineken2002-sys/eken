import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common'
import type { RentIncreaseStatus } from '@prisma/client'
import { PrismaService } from '../common/prisma/prisma.service'
import { MailService } from '../mail/mail.service'
import { NotificationsService } from '../notifications/notifications.service'
import { CreateRentIncreaseDto } from './dto/create-rent-increase.dto'
import { RejectRentIncreaseDto } from './dto/reject-rent-increase.dto'

const INCLUDE = {
  lease: {
    include: {
      unit: { include: { property: true } },
      tenant: true,
    },
  },
} as const

function startOfDay(d: Date): Date {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}

function addMonths(date: Date, months: number): Date {
  const d = new Date(date)
  const target = d.getMonth() + months
  d.setMonth(target)
  if (d.getMonth() !== ((target % 12) + 12) % 12) d.setDate(0)
  return d
}

@Injectable()
export class RentIncreasesService {
  private readonly logger = new Logger(RentIncreasesService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly notifications: NotificationsService,
  ) {}

  async findAll(
    organizationId: string,
    filters?: { status?: RentIncreaseStatus; leaseId?: string },
  ) {
    return this.prisma.rentIncrease.findMany({
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
    const ri = await this.prisma.rentIncrease.findFirst({
      where: { id, organizationId },
      include: INCLUDE,
    })
    if (!ri) throw new NotFoundException('Hyreshöjningen hittades inte')
    return ri
  }

  // ── Skapa ─────────────────────────────────────────────────────────────────

  async create(dto: CreateRentIncreaseDto, organizationId: string) {
    const lease = await this.prisma.lease.findFirst({
      where: { id: dto.leaseId, organizationId },
      select: { id: true, monthlyRent: true, status: true },
    })
    if (!lease) throw new NotFoundException('Hyresavtalet hittades inte')
    if (lease.status !== 'ACTIVE' && lease.status !== 'DRAFT') {
      throw new BadRequestException('Bara aktiva eller utkast-avtal kan höjas')
    }

    const today = startOfDay(new Date())
    const effective = startOfDay(new Date(dto.effectiveDate))
    const minDate = addMonths(today, 3)

    if (effective < minDate) {
      throw new BadRequestException('Slutdatum måste vara minst 3 månader fram (svensk hyresrätt)')
    }

    const currentRent = Number(lease.monthlyRent)
    if (dto.newRent <= currentRent) {
      throw new BadRequestException('Ny hyra måste vara högre än nuvarande')
    }

    const increasePercent = ((dto.newRent - currentRent) / currentRent) * 100

    return this.prisma.rentIncrease.create({
      data: {
        organizationId,
        leaseId: lease.id,
        currentRent,
        newRent: dto.newRent,
        increasePercent: Number(increasePercent.toFixed(2)),
        reason: dto.reason,
        effectiveDate: effective,
        status: 'DRAFT',
      },
      include: INCLUDE,
    })
  }

  // ── Skicka avisering ──────────────────────────────────────────────────────

  async sendNotice(id: string, organizationId: string) {
    const ri = await this.findOne(id, organizationId)
    if (ri.status !== 'DRAFT') {
      throw new BadRequestException('Avisering kan bara skickas för utkast')
    }

    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { name: true, billingEmail: true, phone: true, invoiceColor: true },
    })

    const tenantName =
      ri.lease.tenant.type === 'INDIVIDUAL'
        ? [ri.lease.tenant.firstName, ri.lease.tenant.lastName].filter(Boolean).join(' ')
        : (ri.lease.tenant.companyName ?? ri.lease.tenant.email)

    const unitAddress = `${ri.lease.unit.property.name} · ${ri.lease.unit.name}`

    if (!ri.lease.tenant.email) {
      throw new BadRequestException('Hyresgästen saknar e-postadress')
    }

    try {
      await this.mail.sendRentIncreaseNotice({
        to: ri.lease.tenant.email,
        tenantName,
        currentRent: Number(ri.currentRent),
        newRent: Number(ri.newRent),
        increasePercent: Number(ri.increasePercent),
        effectiveDate: ri.effectiveDate.toISOString().slice(0, 10),
        reason: ri.reason,
        organizationName: org?.name ?? 'Hyresvärd',
        unitAddress,
        ...(org?.billingEmail ? { contactEmail: org.billingEmail } : {}),
        ...(org?.phone ? { contactPhone: org.phone } : {}),
      })
    } catch (err) {
      this.logger.error(`Mail enqueue failed: ${String(err)}`)
      throw new BadRequestException('Kunde inte skicka aviseringen')
    }

    const updated = await this.prisma.rentIncrease.update({
      where: { id },
      data: { status: 'NOTICE_SENT', noticeDate: new Date() },
      include: INCLUDE,
    })

    void this.notifications
      .createForAllOrgUsers(
        organizationId,
        'SYSTEM',
        'Hyreshöjning aviserad',
        `${tenantName} har aviserats om hyreshöjning från ${updated.effectiveDate
          .toISOString()
          .slice(0, 10)}.`,
        '/rent-increases',
      )
      .catch((err) => this.logger.error(`Notification error: ${String(err)}`))

    return updated
  }

  // ── Status-övergångar ─────────────────────────────────────────────────────

  async accept(id: string, organizationId: string) {
    const ri = await this.findOne(id, organizationId)
    if (ri.status !== 'NOTICE_SENT') {
      throw new BadRequestException('Bara aviserade höjningar kan godkännas')
    }
    return this.prisma.rentIncrease.update({
      where: { id },
      data: { status: 'ACCEPTED', respondedAt: new Date() },
      include: INCLUDE,
    })
  }

  async reject(id: string, dto: RejectRentIncreaseDto, organizationId: string) {
    const ri = await this.findOne(id, organizationId)
    if (ri.status !== 'NOTICE_SENT') {
      throw new BadRequestException('Bara aviserade höjningar kan nekas')
    }
    return this.prisma.rentIncrease.update({
      where: { id },
      data: {
        status: 'REJECTED',
        respondedAt: new Date(),
        rejectionReason: dto.rejectionReason,
      },
      include: INCLUDE,
    })
  }

  async withdraw(id: string, organizationId: string) {
    const ri = await this.findOne(id, organizationId)
    if (ri.status !== 'DRAFT' && ri.status !== 'NOTICE_SENT') {
      throw new BadRequestException('Bara utkast eller aviserade kan återkallas')
    }
    return this.prisma.rentIncrease.update({
      where: { id },
      data: { status: 'WITHDRAWN' },
      include: INCLUDE,
    })
  }

  // ── Cron-hjälpare: applicera ACCEPTED som nått effective date ─────────────

  async applyDueIncreases(today: Date): Promise<number> {
    const due = await this.prisma.rentIncrease.findMany({
      where: {
        status: 'ACCEPTED',
        effectiveDate: { lte: today },
      },
      select: { id: true, leaseId: true, newRent: true },
    })

    let applied = 0
    for (const ri of due) {
      try {
        await this.prisma.$transaction(async (tx) => {
          await tx.lease.update({
            where: { id: ri.leaseId },
            data: { monthlyRent: ri.newRent },
          })
          await tx.rentIncrease.update({
            where: { id: ri.id },
            data: { status: 'APPLIED' },
          })
        })
        this.logger.log(`[RentIncrease] Applied rent increase for lease ${ri.leaseId}`)
        applied++
      } catch (err) {
        this.logger.error(`[RentIncrease] Apply failed for ${ri.id}: ${String(err)}`)
      }
    }
    return applied
  }
}
