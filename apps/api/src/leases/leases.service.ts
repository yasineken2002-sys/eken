import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import type { LeaseStatus, LeaseType, UnitType } from '@prisma/client'
import { Cron } from '@nestjs/schedule'
import { PrismaService } from '../common/prisma/prisma.service'
import { NotificationsService } from '../notifications/notifications.service'
import { DepositsService } from '../deposits/deposits.service'
import { RentIncreasesService } from '../rent-increases/rent-increases.service'
import { TenantAuthService } from '../tenant-portal/tenant-auth.service'
import { ContractTemplateService } from '../contracts/contract-template.service'
import { ContractNumberService } from '../contracts/contract-number.service'
import { LeaseActivationQueue } from './lease-activation.queue'
import { normalizeEmail } from '../common/utils/normalize-email'
import { CreateLeaseDto } from './dto/create-lease.dto'
import { UpdateLeaseDto } from './dto/update-lease.dto'
import { CreateLeaseWithTenantDto } from './dto/create-lease-with-tenant.dto'
import { TerminateLeaseDto } from './dto/terminate-lease.dto'
import { RenewLeaseDto } from './dto/renew-lease.dto'
import { SAFE_TENANT_SELECT } from '../tenants/tenants.service'
import {
  minNoticePeriodMonths,
  noticePeriodErrorMessage,
  maxDepositAmount,
  depositErrorMessage,
} from './leases.compliance'

const VALID_TRANSITIONS: Partial<Record<LeaseStatus, LeaseStatus[]>> = {
  DRAFT: ['ACTIVE', 'TERMINATED'],
  ACTIVE: ['EXPIRED', 'TERMINATED'],
}

const INCLUDE = {
  unit: { include: { property: true } },
  tenant: { select: SAFE_TENANT_SELECT },
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

// Plocka ut alla kontraktsfält ur en DTO till ett delobjekt som kan spridas
// in i prisma.lease.create/update. Returnerar bara de fält som faktiskt är
// definierade i DTO:n så vi inte trampar på defaults i schemat.
type ContractTermsDto = {
  includesHeating?: boolean
  includesWater?: boolean
  includesHotWater?: boolean
  includesElectricity?: boolean
  includesInternet?: boolean
  includesCleaning?: boolean
  includesParking?: boolean
  includesStorage?: boolean
  includesLaundry?: boolean
  parkingFee?: number
  storageFee?: number
  garageFee?: number
  usagePurpose?: string
  petsAllowed?: 'ALLOWED' | 'REQUIRES_APPROVAL' | 'NOT_ALLOWED'
  petsApprovalNotes?: string
  sublettingAllowed?: boolean
  requiresHomeInsurance?: boolean
  indexClauseType?: 'NONE' | 'KPI' | 'NEGOTIATED' | 'MARKET_RENT'
  indexBaseYear?: number
  indexAdjustmentDate?: string
  indexMaxIncrease?: number
  indexMinIncrease?: number
  indexNotes?: string
  specialTerms?: string
}

function pickContractTerms(dto: ContractTermsDto): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const bools: Array<keyof ContractTermsDto> = [
    'includesHeating',
    'includesWater',
    'includesHotWater',
    'includesElectricity',
    'includesInternet',
    'includesCleaning',
    'includesParking',
    'includesStorage',
    'includesLaundry',
    'sublettingAllowed',
    'requiresHomeInsurance',
  ]
  for (const k of bools) if (dto[k] !== undefined) out[k] = dto[k]

  if (dto.parkingFee != null) out['parkingFee'] = dto.parkingFee
  if (dto.storageFee != null) out['storageFee'] = dto.storageFee
  if (dto.garageFee != null) out['garageFee'] = dto.garageFee
  if (dto.usagePurpose !== undefined) out['usagePurpose'] = dto.usagePurpose || null
  if (dto.petsAllowed !== undefined) out['petsAllowed'] = dto.petsAllowed
  if (dto.petsApprovalNotes !== undefined) out['petsApprovalNotes'] = dto.petsApprovalNotes || null

  if (dto.indexClauseType !== undefined) {
    out['indexClauseType'] = dto.indexClauseType
    out['indexClause'] = dto.indexClauseType !== 'NONE'
  }
  if (dto.indexBaseYear != null) out['indexBaseYear'] = dto.indexBaseYear
  if (dto.indexAdjustmentDate !== undefined)
    out['indexAdjustmentDate'] = dto.indexAdjustmentDate || null
  if (dto.indexMaxIncrease != null) out['indexMaxIncrease'] = dto.indexMaxIncrease
  if (dto.indexMinIncrease != null) out['indexMinIncrease'] = dto.indexMinIncrease
  if (dto.indexNotes !== undefined) out['indexNotes'] = dto.indexNotes || null
  if (dto.specialTerms !== undefined) out['specialTerms'] = dto.specialTerms?.trim() || null

  return out
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

// Bygg ett visningsbart hyresgästnamn till felmeddelanden. INDIVIDUAL faller
// tillbaka till email om både för- och efternamn saknas; COMPANY på email om
// companyName saknas. Aldrig tomt sträng — minst email används.
function tenantDisplayName(t: {
  type: string
  firstName: string | null
  lastName: string | null
  companyName: string | null
  email: string
}): string {
  if (t.type === 'INDIVIDUAL') {
    const name = `${t.firstName ?? ''} ${t.lastName ?? ''}`.trim()
    return name || t.email
  }
  return t.companyName?.trim() || t.email
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
    private readonly contracts: ContractTemplateService,
    private readonly contractNumbers: ContractNumberService,
    private readonly activationQueue: LeaseActivationQueue,
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

  // Returnerar ett människovänligt felmeddelande om enheten redan har ett
  // ACTIVE-kontrakt (annat än `excludeLeaseId`). Inkluderar hyresgästens namn
  // så administratören vet vilket avtal som måste avslutas först. Returnerar
  // null när enheten är fri.
  private async describeActiveBlocker(
    unitId: string,
    excludeLeaseId?: string,
  ): Promise<string | null> {
    const blocking = await this.prisma.lease.findFirst({
      where: {
        unitId,
        status: 'ACTIVE',
        ...(excludeLeaseId ? { id: { not: excludeLeaseId } } : {}),
      },
      include: { tenant: { select: SAFE_TENANT_SELECT } },
    })
    if (!blocking) return null
    const name = tenantDisplayName(blocking.tenant)
    return `Lägenheten har redan ett aktivt kontrakt med ${name}. Avsluta det först innan du aktiverar ett nytt.`
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
    const blocker = await this.describeActiveBlocker(dto.unitId)
    if (blocker) throw new BadRequestException(blocker)

    const leaseType: LeaseType = dto.leaseType ?? 'INDEFINITE'
    if (leaseType === 'FIXED_TERM' && !dto.endDate) {
      throw new BadRequestException('Tidsbegränsade kontrakt måste ha ett slutdatum')
    }

    // JB 12 kap 4 § — uppsägningstid får inte understiga lagens minimum.
    const minNotice = minNoticePeriodMonths(unit.type)
    const requestedNotice = dto.noticePeriodMonths ?? minNotice
    if (requestedNotice < minNotice) {
      throw new BadRequestException(noticePeriodErrorMessage(unit.type))
    }

    // Praxis (hyresnämnden) — depositionstak för bostad.
    const cap = maxDepositAmount(dto.monthlyRent, unit.type)
    if (cap != null && (dto.depositAmount ?? 0) > cap) {
      throw new BadRequestException(depositErrorMessage(cap))
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
        noticePeriodMonths: requestedNotice,
        ...pickContractTerms(dto),
      },
      include: INCLUDE,
    })
  }

  async update(id: string, dto: UpdateLeaseDto, organizationId: string) {
    const existing = await this.findOne(id, organizationId)

    if (existing.status !== 'DRAFT' && existing.status !== 'ACTIVE') {
      throw new BadRequestException('Kontraktet kan inte redigeras i nuvarande status')
    }

    // Effektiv unit-typ efter ev. byte (för att avgöra bostad/lokal-regelvalet).
    // unitId kan flyttas i update (sällan, men möjligt) — hämta nya typen då.
    let effectiveUnitType: UnitType = existing.unit.type
    if (dto.unitId != null && dto.unitId !== existing.unitId) {
      const newUnit = await this.prisma.unit.findFirst({
        where: { id: dto.unitId, property: { organizationId } },
        select: { type: true },
      })
      if (!newUnit) throw new NotFoundException('Enheten hittades inte')
      effectiveUnitType = newUnit.type
    }

    // JB 12 kap 4 § — uppsägningstid får aldrig sänkas under lagens minimum.
    // Vi validerar både när noticePeriodMonths uttryckligen ändras OCH när
    // unitId byts (bostad→lokal eller tvärtom kan göra befintligt värde ogiltigt).
    const minNotice = minNoticePeriodMonths(effectiveUnitType)
    const effectiveNotice = dto.noticePeriodMonths ?? existing.noticePeriodMonths
    if (effectiveNotice < minNotice) {
      throw new BadRequestException(noticePeriodErrorMessage(effectiveUnitType))
    }

    // Depositionstak (bostad). Validera när belopp eller hyra ändras.
    const effectiveRent = dto.monthlyRent ?? Number(existing.monthlyRent)
    const effectiveDeposit = dto.depositAmount ?? Number(existing.depositAmount)
    const cap = maxDepositAmount(effectiveRent, effectiveUnitType)
    if (cap != null && effectiveDeposit > cap) {
      throw new BadRequestException(depositErrorMessage(cap))
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
        ...pickContractTerms(dto),
      },
      include: INCLUDE,
    })
  }

  async transitionStatus(
    id: string,
    newStatus: LeaseStatus,
    organizationId: string,
    actorUserId?: string | null,
  ) {
    const lease = await this.findOne(id, organizationId)
    const allowed = VALID_TRANSITIONS[lease.status] ?? []

    if (!allowed.includes(newStatus)) {
      throw new BadRequestException('Ogiltig statusövergång')
    }

    // Optimistic check innan DRAFT→ACTIVE; partial unique index fångar race.
    if (newStatus === 'ACTIVE') {
      const blocker = await this.describeActiveBlocker(lease.unitId, id)
      if (blocker) throw new BadRequestException(blocker)
    }

    let updated
    try {
      updated = await this.prisma.$transaction(async (tx) => {
        // DRAFT → ACTIVE tilldelar fortlöpande kontraktsnummer
        // (KONT-{år}-{löpnr}). Om numret redan finns (omaktivering eller
        // backfill) lämnas det orört. Allokeringen sker INOM samma
        // transaktion som status-ändringen så att en abort lämnar inga
        // hängande nummer i sekvenstabellen.
        let contractNumber: string | undefined
        if (newStatus === 'ACTIVE' && !lease.contractNumber) {
          contractNumber = await this.contractNumbers.allocate(lease.organizationId, tx)
        }

        const result = await tx.lease.update({
          where: { id },
          data: {
            status: newStatus,
            ...(newStatus === 'ACTIVE' ? { signedAt: new Date() } : {}),
            ...(newStatus === 'TERMINATED' ? { terminatedAt: new Date() } : {}),
            ...(contractNumber ? { contractNumber } : {}),
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
        // Race: en annan request hann slå mot lease_unit_active_unique mellan
        // vår describeActiveBlocker-check och DB-skrivningen. Bygg om felet
        // med tenant-namn så meddelandet blir lika hjälpsamt som ovan.
        const blocker = await this.describeActiveBlocker(lease.unitId, id)
        throw new BadRequestException(blocker ?? 'Lägenheten har redan ett aktivt kontrakt.')
      }
      throw err
    }

    // När ett kontrakt blir ACTIVE läggs två jobb på lease-activation-kön:
    // PDF-generering + välkomstmejl. Bull retras automatiskt (1m → 2m → 4m
    // → 8m → 16m → permanent fail) och vid permanent fail får org-admins en
    // SYSTEM-notification. Detta ersätter tidigare fire-and-forget som tyst
    // kunde lämna en ACTIVE Lease utan PDF eller mejl.
    //
    // PDF-jobbet enqueueas alltid, även när vi inte vet vem som triggade
    // (cron, system-fix, AI-tool utan user-context). actorUserId blir då
    // null → Document.uploadedById blir null. Tidigare gating på actorUserId
    // gjorde att aktiveringar utan user-context tyst skapade ACTIVE-leases
    // utan PDF — det orsakade Tindra-buggen 2026-05-07.
    if (newStatus === 'ACTIVE') {
      await this.activationQueue
        .enqueueGenerateContract({
          leaseId: id,
          organizationId,
          actorUserId: actorUserId ?? null,
        })
        .catch((err) =>
          this.logger.error(`[Leases] enqueue generate-contract failed: ${String(err)}`),
        )

      await this.activationQueue
        .enqueueWelcomeMail({ tenantId: lease.tenantId })
        .catch((err) => this.logger.error(`[Leases] enqueue welcome-mail failed: ${String(err)}`))

      // Auto-skapa deposition + första hyresavi (delmånad om relevant) och
      // mejla hyresgästen. Bull-kön ger samma retry-policy som de andra
      // aktiverings-jobben — om R2/Resend är nere får vi 5 försök innan en
      // SYSTEM-notification går ut till org-admins.
      await this.activationQueue
        .enqueueInitialNotices({ leaseId: id, organizationId })
        .catch((err: unknown) =>
          this.logger.error(`[Leases] enqueue initial-notices failed: ${String(err)}`),
        )
    }

    return updated
  }

  async createWithTenant(
    dto: CreateLeaseWithTenantDto,
    organizationId: string,
    actorUserId?: string | null,
  ) {
    const unit = await this.prisma.unit.findFirst({
      where: { id: dto.unitId },
      include: { property: true },
    })
    if (!unit || unit.property.organizationId !== organizationId) {
      throw new NotFoundException('Enheten hittades inte')
    }

    // Defensiv check mot drift mellan Unit.status och Lease.status. Normalt
    // hålls de i sync av transitionStatus → tx.unit.update, men om någon har
    // patchat unit-status manuellt vill vi inte tyst skapa ett kontrakt på
    // en uthyrd enhet och få en konflikt först vid aktivering.
    if (unit.status === 'OCCUPIED') {
      const blocker = await this.describeActiveBlocker(dto.unitId)
      throw new BadRequestException(
        blocker ?? 'Lägenheten är markerad som uthyrd och kan inte få ett nytt kontrakt.',
      )
    }

    const blocker = await this.describeActiveBlocker(dto.unitId)
    if (blocker) throw new BadRequestException(blocker)

    const leaseType: LeaseType = dto.leaseType ?? 'INDEFINITE'
    if (leaseType === 'FIXED_TERM' && !dto.endDate) {
      throw new BadRequestException('Tidsbegränsade kontrakt måste ha ett slutdatum')
    }

    // JB 12 kap 4 § — uppsägningstid får inte understiga lagens minimum
    // (3 mån bostad / 9 mån lokal). Validera FÖRE tx så vi inte half-skapar
    // tenant + lease om noticePeriodMonths är lagstridig.
    const minNotice = minNoticePeriodMonths(unit.type)
    const requestedNotice = dto.noticePeriodMonths ?? minNotice
    if (requestedNotice < minNotice) {
      throw new BadRequestException(noticePeriodErrorMessage(unit.type))
    }

    // Praxis (hyresnämnden) — depositionstak för bostad. Lokal: fri deposition.
    const cap = maxDepositAmount(dto.monthlyRent, unit.type)
    if (cap != null && (dto.depositAmount ?? 0) > cap) {
      throw new BadRequestException(depositErrorMessage(cap))
    }

    // Validera nya hyresgästuppgifter och kolla dubblett-email innan transaktionen
    // — felet är då rent en valideringsmiss, inte en halv-skapad situation.
    if (!dto.existingTenantId && dto.newTenant) {
      const { type, firstName, lastName, companyName } = dto.newTenant
      const email = normalizeEmail(dto.newTenant.email)
      // Mutera dto:n så att downstream tx.tenant.create skriver normaliserad
      // email — alla writes ska träffa lowercase.
      dto.newTenant.email = email

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
            noticePeriodMonths: requestedNotice,
            ...pickContractTerms(dto),
          },
          include: INCLUDE,
        })
      })
    } catch (err) {
      if (isActiveUnitConflict(err)) {
        // Race: en annan request hann slå mot lease_unit_active_unique mellan
        // vår describeActiveBlocker-check och DB-skrivningen. Bygg om felet
        // med tenant-namn så meddelandet blir lika hjälpsamt som ovan.
        const blocker = await this.describeActiveBlocker(
          'unitId' in dto && typeof dto.unitId === 'string' ? dto.unitId : '',
        )
        throw new BadRequestException(blocker ?? 'Lägenheten har redan ett aktivt kontrakt.')
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
    //
    // När frontend explicit ber om "skapa & aktivera direkt" (knapp i
    // CreateLeaseModal) gör vi övergången i samma anrop. Det enqueueasr
    // PDF-generering + välkomstmejl precis som vanlig DRAFT→ACTIVE-knapp,
    // så användaren slipper det dolda två-stegs-flödet som ofta missades.
    if (dto.activate) {
      return this.transitionStatus(lease.id, 'ACTIVE', organizationId, actorUserId ?? null)
    }

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
        { relatedEntityType: 'LEASE', relatedEntityId: updated.id },
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

      // Det förnyade kontraktet skapas direkt som ACTIVE (inte via
      // transitionStatus) och måste därför allokera sitt eget kontraktsnummer
      // — annars blir det ett ACTIVE-avtal utan KONT-nummer. Allokeringen sker
      // i samma transaktion så en abort inte lämnar hängande nummer.
      const contractNumber = await this.contractNumbers.allocate(organizationId, tx)

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
          contractNumber,
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

          // Auto-förnyat kontrakt skapas direkt ACTIVE → allokera eget
          // kontraktsnummer i samma transaktion (annars NULL contractNumber).
          const contractNumber = await this.contractNumbers.allocate(lease.organizationId, tx)

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
              contractNumber,
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
            { relatedEntityType: 'LEASE', relatedEntityId: lease.id },
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
