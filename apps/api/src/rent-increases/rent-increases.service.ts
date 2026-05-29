import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common'
import type { RentIncreaseStatus } from '@prisma/client'
import { PrismaService } from '../common/prisma/prisma.service'
import { MailService } from '../mail/mail.service'
import { NotificationsService } from '../notifications/notifications.service'
import { CreateRentIncreaseDto } from './dto/create-rent-increase.dto'
import { RejectRentIncreaseDto } from './dto/reject-rent-increase.dto'
import { SAFE_TENANT_SELECT } from '../tenants/tenants.service'

const INCLUDE = {
  lease: {
    include: {
      unit: { include: { property: true } },
      tenant: { select: SAFE_TENANT_SELECT },
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

function addDays(date: Date, days: number): Date {
  const d = new Date(date)
  d.setDate(d.getDate() + days)
  return d
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

// JB 12 kap 54 a § 2 st — sista dag att motsätta sig får aldrig vara
// tidigare än 2 månader efter att meddelandet lämnats. Vi använder en exakt
// 2-månadersfrist baserat på meddelandedatumet (samma kalenderdag två
// månader senare; addMonths-hjälparen hanterar månadsdrift 31 jan → 28/29 feb).
export function computeObjectionDeadline(noticeDate: Date): Date {
  return addMonths(noticeDate, 2)
}

// Centraliserad text för "så här begär du prövning hos hyresnämnden". Skickas
// med i varje hyreshöjningsmeddelande enligt 54 a § 2 st kravet på upplysning
// om prövningsförfarandet. Hyresnämnden har åtta avdelningar — tenant hänvisas
// till den i sin region via domstol.se där den exakta adressen för respektive
// nämnd alltid är aktuell.
function buildHyresnamndContact(): string {
  return [
    'Hyresnämnden – kontaktuppgifter:',
    'Sök upp din region på www.domstol.se/hyresnamnden',
    'Telefon (huvudväxel): 0771-71 32 00',
    '',
    'Så här begär du prövning:',
    '1. Skriv en ansökan där du anger varför du motsätter dig hyreshöjningen.',
    '2. Bifoga detta meddelande och ditt hyresavtal.',
    '3. Skicka ansökan till hyresnämnden i den region där lägenheten är belägen.',
    '4. Du måste skicka in ansökan innan invändningsfristen ovan löper ut.',
  ].join('\n')
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
    // JB 12 kap 54 a § 2 st kräver minst 2 mån invändningsfrist + 1 dag innan
    // höjningen får träda i kraft. Vi använder 3 mån som buffert vid create
    // för att ge tid mellan registrering och faktiskt utskick av meddelandet
    // (noticeDate sätts när sendNotice() körs, inte vid create). Strikt
    // 54 a §-kontroll mot noticeDate görs i sendNotice().
    const minDate = addMonths(today, 3)

    if (effective < minDate) {
      throw new BadRequestException(
        'Ny hyra måste börja gälla tidigast 3 månader fram. ' +
          'JB 12 kap 54 a § kräver minst 2 mån invändningsfrist från meddelandedatumet ' +
          '— bufferten gör det möjligt att skicka meddelandet inom rimlig tid efter att ' +
          'höjningen registrerats.',
      )
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
      select: {
        name: true,
        billingEmail: true,
        phone: true,
        email: true,
        street: true,
        city: true,
        postalCode: true,
        country: true,
        invoiceColor: true,
      },
    })

    // JB 12 kap 54 a § 2 st — meddelandet ska innehålla hyresvärdens adress.
    // Utan formell postadress kan hyresgästen inte skicka sin invändning
    // på rättssäker väg → tystnaden får ingen bindande verkan.
    if (!org?.street || !org.city || !org.postalCode) {
      throw new BadRequestException(
        'Organisationens postadress (gata, ort, postnummer) måste vara komplett innan ' +
          'hyreshöjningsmeddelande kan skickas (JB 12 kap 54 a § 2 st kräver att hyresvärdens adress anges).',
      )
    }

    const today = startOfDay(new Date())
    // JB 12 kap 54 a § 2 st — invändningsdag minst 2 månader efter
    // meddelandedag. Vi sätter noticeDate till idag och beräknar deadline
    // utifrån det. Detta måste ske FÖRE mejl-enqueue så att payloaden är
    // korrekt och idempotent vid retry.
    const noticeDate = today
    const objectionDeadline = computeObjectionDeadline(noticeDate)

    // Effective date måste vara minst 1 dag EFTER invändningsfristen — annars
    // kan höjningen träda i kraft innan hyresgästen hunnit svara, vilket
    // strider mot tystnadsverkans-konstruktionen i 54 a § 3 st.
    const minEffective = addDays(objectionDeadline, 1)
    if (ri.effectiveDate < minEffective) {
      throw new BadRequestException(
        `Ny hyra får tidigast börja gälla ${isoDate(minEffective)} — det är dagen efter ` +
          `invändningsfristen (${isoDate(objectionDeadline)}) som beräknas från dagens ` +
          'meddelandedag. JB 12 kap 54 a § kräver minst 2 månaders invändningsfrist + 1 dag ' +
          'innan höjningen kan träda i kraft. Justera startdatum för hyreshöjningen.',
      )
    }

    const tenantName =
      ri.lease.tenant.type === 'INDIVIDUAL'
        ? [ri.lease.tenant.firstName, ri.lease.tenant.lastName].filter(Boolean).join(' ')
        : (ri.lease.tenant.companyName ?? ri.lease.tenant.email)

    const unitAddress = `${ri.lease.unit.property.name} · ${ri.lease.unit.name}`

    if (!ri.lease.tenant.email) {
      throw new BadRequestException('Hyresgästen saknar e-postadress')
    }

    const landlordAddress = `${org.street}\n${org.postalCode} ${org.city}`
    const hyresnamndContact = buildHyresnamndContact()

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
        objectionDeadline: isoDate(objectionDeadline),
        landlordAddress,
        hyresnamndContact,
        ...(org?.billingEmail ? { contactEmail: org.billingEmail } : {}),
        ...(org?.phone ? { contactPhone: org.phone } : {}),
      })
    } catch (err) {
      this.logger.error(`Mail enqueue failed: ${String(err)}`)
      throw new BadRequestException('Kunde inte skicka aviseringen')
    }

    const updated = await this.prisma.rentIncrease.update({
      where: { id },
      data: { status: 'NOTICE_SENT', noticeDate },
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
        { relatedEntityType: 'RENT_INCREASE', relatedEntityId: updated.id },
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
