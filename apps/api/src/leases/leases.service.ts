import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import type { LeaseStatus, LeaseType, TenancyRegime, UnitType } from '@prisma/client'
import { Cron } from '@nestjs/schedule'
import { PrismaService } from '../common/prisma/prisma.service'
import { NotificationsService } from '../notifications/notifications.service'
import { DepositsService } from '../deposits/deposits.service'
import { RentIncreasesService } from '../rent-increases/rent-increases.service'
import { TenantAuthService } from '../tenant-portal/tenant-auth.service'
import { ContractTemplateService } from '../contracts/contract-template.service'
import { ContractNumberService } from '../contracts/contract-number.service'
import { syncUnitStatusFromLeases } from '../units/unit-status.sync'
import { LeaseActivationQueue } from './lease-activation.queue'
import { normalizeEmail } from '../common/utils/normalize-email'
import { CreateLeaseDto } from './dto/create-lease.dto'
import { UpdateLeaseDto } from './dto/update-lease.dto'
import { CreateLeaseWithTenantDto } from './dto/create-lease-with-tenant.dto'
import { TerminateLeaseDto } from './dto/terminate-lease.dto'
import { RenewLeaseDto } from './dto/renew-lease.dto'
import { SAFE_TENANT_SELECT } from '../tenants/tenants.service'
import {
  addMonths,
  endOfNoticePeriod,
  isValidLeaseTransition,
  LEASE_SUCCESSION_CARRY_FIELDS,
} from '@eken/shared'
import type { LeaseSuccessionCarryField } from '@eken/shared'
import {
  minNoticePeriodMonths,
  noticePeriodErrorMessage,
  maxDepositAmount,
  depositErrorMessage,
  assertLeaseLegalLimits,
  terminationNoticeMonths,
  defaultTenancyRegime,
  type TerminationInitiator,
} from './leases.compliance'

const INCLUDE = {
  unit: { include: { property: true } },
  tenant: { select: SAFE_TENANT_SELECT },
} as const

// addMonths (månadsdrift-säker) importeras från @eken/shared — delad sanning
// med terminations + web (#66). renew/autoRenew använder den för FIXED_TERM-
// slutdatum (exakt N månader, ingen månadsskiftesrundning — det gäller bara
// uppsägningstid via endOfNoticePeriod).

function startOfDay(date: Date): Date {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  return d
}

// Bestäm regelverk vid kontraktsskapande (#69). Uttryckligt DTO-val vinner, men
// PRIVATE_RENTAL är bara giltigt för bostad (privatuthyrningslagen omfattar inte
// lokal). Utan val: default privatuthyrning för bostad, hyreslagen för lokal
// (beslut 2026-07-08 — målgruppen är privata hyresvärdar).
function resolveTenancyRegime(
  requested: TenancyRegime | undefined,
  unitType: UnitType,
): TenancyRegime {
  if (requested === 'PRIVATE_RENTAL' && unitType !== 'APARTMENT') {
    throw new BadRequestException(
      'Privatuthyrningslagen gäller bara bostad — en lokal kan inte sättas till privatuthyrning.',
    )
  }
  if (requested) return requested
  // Ingen uttrycklig regim → hyreslagen. PRIVATE_RENTAL kräver ett medvetet val.
  return defaultTenancyRegime()
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

// ── T1.1a: edit-lås på ACTIVE-avtal ────────────────────────────────────────
// Ett aktivt hyresavtal binder bägge parter. Bindande villkor (JB 12:19), hyra
// (kräver hyreshöjningslagens varsel/invändningsrätt), identitet (enhet/gäst =
// succession) och deposition får därför INTE ändras via den generiska edit-vägen
// PATCH /leases/:id — då kringgås rätt domänflöde (RentIncrease / terminate /
// renew / depositionsmodulen). Låset ligger i service-lagret så ALLA anropare
// (framtida AI-verktyg, interna anrop) täcks — samma "gäller alla vägar"-princip
// som transitionStatus→terminate-delegeringen (#65) och endDate-guarden.
//
// DRAFT undantas helt (avtalet är inte i kraft → allt fritt). På ACTIVE nekas en
// FAKTISK ändring; ett oförändrat värde (web-formuläret återsänder hela objektet)
// släpps igenom. Endast rena annotationer (indexNotes, petsApprovalNotes) är fria
// på ACTIVE. `endDate` hanteras av sin egen guard (F2/#65) och ingår inte här.
//
// Fält-tier granskad av hyresjurist 2026-07-08 (specialTerms = operativ avtalstext
// → låst; usagePurpose/subletting/insurance/petsAllowed låses helt nu, lättnad blir
// egen följd-PR). `tenancyRegime` skrivs inte av update() idag (varken i spread
// eller pickContractTerms) → den är redan inert; den läggs INTE i listan, men en
// framtida regim-edit-seam (#69/T1.1c) måste gå via update() så den ärver låset.
type LockRoute = 'RENT' | 'DATE_START' | 'IDENTITY' | 'DEPOSIT' | 'TERMS'

const LOCK_ROUTE_HINT: Record<LockRoute, string> = {
  RENT: 'Ändra hyra och avgifter via hyreshöjningsflödet (en sänkning görs via en separat åtgärd).',
  DATE_START: 'Tillträdesdagen (startdatum) kan inte flyttas på ett aktivt kontrakt.',
  IDENTITY:
    'Byte av enhet eller hyresgäst görs genom att upprätta ett nytt kontrakt (förnyelse), inte genom redigering.',
  DEPOSIT:
    'Depositionsbeloppet kan inte ändras fritt på ett löpande avtal — depositionen hanteras via depositionsflödet.',
  TERMS:
    'Bindande hyresvillkor kan inte ändras på ett löpande avtal — det kräver ett nytt kontrakt eller ett skriftligt tillägg.',
}

// Jämförelse-semantik per fälttyp. `nullMeansSkip` speglar EXAKT motsvarande
// write-sites gate i update()-spread/pickContractTerms: `!= null` (null hoppas
// tyst över, går ej att nolla via denna endpoint) vs `!== undefined`. Utan exakt
// spegling ger komparatorn falskt 400 på helt vanliga oförändrade resubmits.
type Tier1Kind = 'decimal' | 'date' | 'int' | 'enum' | 'string' | 'stringCoalesce' | 'bool'

interface Tier1Spec {
  key: keyof UpdateLeaseDto
  label: string
  route: LockRoute
  kind: Tier1Kind
  nullMeansSkip: boolean
  coalesceTrim?: boolean
}

// Exporterad så en test (leases-edit-lock-t11a.spec.ts) kan asserta att nyckel-
// listan matchar @eken/shared LEASE_ACTIVE_LOCKED_FIELDS exakt (frontend-synk).
export const TIER1_LOCKED_ON_ACTIVE: readonly Tier1Spec[] = [
  // Hyra + avgifter (del av total hyra, JB 12:19) → hyreshöjningsflödet
  { key: 'monthlyRent', label: 'Månadshyra', route: 'RENT', kind: 'decimal', nullMeansSkip: true },
  { key: 'parkingFee', label: 'Parkeringsavgift', route: 'RENT', kind: 'decimal', nullMeansSkip: true }, // prettier-ignore
  {
    key: 'storageFee',
    label: 'Förrådsavgift',
    route: 'RENT',
    kind: 'decimal',
    nullMeansSkip: true,
  },
  { key: 'garageFee', label: 'Garageavgift', route: 'RENT', kind: 'decimal', nullMeansSkip: true },
  // Tillträdesdag
  { key: 'startDate', label: 'Startdatum', route: 'DATE_START', kind: 'date', nullMeansSkip: true },
  // Identitet → succession
  { key: 'unitId', label: 'Enhet', route: 'IDENTITY', kind: 'string', nullMeansSkip: true },
  { key: 'tenantId', label: 'Hyresgäst', route: 'IDENTITY', kind: 'string', nullMeansSkip: true },
  // Deposition
  { key: 'depositAmount', label: 'Deposition', route: 'DEPOSIT', kind: 'decimal', nullMeansSkip: true }, // prettier-ignore
  // Bindande villkor
  { key: 'leaseType', label: 'Avtalstyp', route: 'TERMS', kind: 'enum', nullMeansSkip: true },
  { key: 'noticePeriodMonths', label: 'Uppsägningstid', route: 'TERMS', kind: 'int', nullMeansSkip: true }, // prettier-ignore
  { key: 'renewalPeriodMonths', label: 'Förnyelseperiod', route: 'TERMS', kind: 'int', nullMeansSkip: true }, // prettier-ignore
  {
    key: 'includesHeating',
    label: 'Värme ingår',
    route: 'TERMS',
    kind: 'bool',
    nullMeansSkip: false,
  },
  {
    key: 'includesWater',
    label: 'Vatten ingår',
    route: 'TERMS',
    kind: 'bool',
    nullMeansSkip: false,
  },
  { key: 'includesHotWater', label: 'Varmvatten ingår', route: 'TERMS', kind: 'bool', nullMeansSkip: false }, // prettier-ignore
  {
    key: 'includesElectricity',
    label: 'El ingår',
    route: 'TERMS',
    kind: 'bool',
    nullMeansSkip: false,
  },
  {
    key: 'includesInternet',
    label: 'Internet ingår',
    route: 'TERMS',
    kind: 'bool',
    nullMeansSkip: false,
  },
  {
    key: 'includesCleaning',
    label: 'Städning ingår',
    route: 'TERMS',
    kind: 'bool',
    nullMeansSkip: false,
  },
  {
    key: 'includesParking',
    label: 'Parkering ingår',
    route: 'TERMS',
    kind: 'bool',
    nullMeansSkip: false,
  },
  {
    key: 'includesStorage',
    label: 'Förråd ingår',
    route: 'TERMS',
    kind: 'bool',
    nullMeansSkip: false,
  },
  {
    key: 'includesLaundry',
    label: 'Tvätt ingår',
    route: 'TERMS',
    kind: 'bool',
    nullMeansSkip: false,
  },
  { key: 'usagePurpose', label: 'Användningsändamål', route: 'TERMS', kind: 'stringCoalesce', nullMeansSkip: false }, // prettier-ignore
  { key: 'sublettingAllowed', label: 'Andrahandsuthyrning tillåten', route: 'TERMS', kind: 'bool', nullMeansSkip: false }, // prettier-ignore
  { key: 'requiresHomeInsurance', label: 'Krav på hemförsäkring', route: 'TERMS', kind: 'bool', nullMeansSkip: false }, // prettier-ignore
  {
    key: 'petsAllowed',
    label: 'Husdjurspolicy',
    route: 'TERMS',
    kind: 'enum',
    nullMeansSkip: false,
  },
  { key: 'indexClauseType', label: 'Indexklausul (typ)', route: 'TERMS', kind: 'enum', nullMeansSkip: false }, // prettier-ignore
  { key: 'indexBaseYear', label: 'Index basår', route: 'TERMS', kind: 'int', nullMeansSkip: true },
  { key: 'indexAdjustmentDate', label: 'Index justeringsdatum', route: 'TERMS', kind: 'stringCoalesce', nullMeansSkip: false }, // prettier-ignore
  { key: 'indexMaxIncrease', label: 'Index maxhöjning', route: 'TERMS', kind: 'decimal', nullMeansSkip: true }, // prettier-ignore
  { key: 'indexMinIncrease', label: 'Index minhöjning', route: 'TERMS', kind: 'decimal', nullMeansSkip: true }, // prettier-ignore
  { key: 'specialTerms', label: 'Övriga villkor / särskilda bestämmelser', route: 'TERMS', kind: 'stringCoalesce', nullMeansSkip: false, coalesceTrim: true }, // prettier-ignore
]

// Effektivt normaliserat värde (så '' → null-coalescing, trim etc. speglar write-site).
function coalesceString(v: unknown, trim: boolean): string | null {
  if (v == null) return null
  const s = trim ? String(v).trim() : String(v)
  return s === '' ? null : s
}

// Returnerar true om DTO-fältet är NÄRVARANDE (enligt fältets write-site-gate) OCH
// dess effektiva värde SKILJER SIG från det lagrade. Ett oförändrat värde → false.
function isLockedFieldChanged(spec: Tier1Spec, dtoVal: unknown, current: unknown): boolean {
  const present = spec.nullMeansSkip ? dtoVal != null : dtoVal !== undefined
  if (!present) return false

  switch (spec.kind) {
    case 'decimal': {
      // Alla nuvarande decimal/int-fält har nullMeansSkip:true → `present`-grinden
      // ovan filtrerar redan bort null/undefined och denna gren är i praktiken
      // onåbar idag. Behålls som korrekt hantering ifall ett framtida nullMeansSkip:
      // false-fält tillkommer (då är null = nollning = en faktisk ändring).
      if (dtoVal == null) return current != null // nolla ett satt fält = ändring
      const next = new Prisma.Decimal(String(dtoVal))
      return current == null
        ? true
        : !new Prisma.Decimal(current as Prisma.Decimal.Value).equals(next)
    }
    case 'date': {
      const next = startOfDay(new Date(dtoVal as string)).getTime()
      const cur = current ? startOfDay(new Date(current as Date)).getTime() : null
      return next !== cur
    }
    case 'int': {
      if (dtoVal == null) return current != null
      return current == null ? true : Number(current) !== Number(dtoVal)
    }
    case 'bool':
    case 'enum':
    case 'string':
      return current !== dtoVal
    case 'stringCoalesce': {
      const eff = coalesceString(dtoVal, spec.coalesceTrim === true)
      return (current ?? null) !== eff
    }
  }
}

// Samla ALLA låsta fält som ett ACTIVE-edit försöker ändra (aggregerat, så
// användaren ser hela bilden på en gång i stället för ett fält i taget).
// `existing` är findOne-resultatet (Lease-raden med relationer).
function detectLockedActiveChanges(
  dto: UpdateLeaseDto,
  existing: Record<string, unknown>,
): { fields: string[]; routes: LockRoute[] } {
  const fields: string[] = []
  const routes = new Set<LockRoute>()
  const d = dto as Record<string, unknown>
  for (const spec of TIER1_LOCKED_ON_ACTIVE) {
    if (isLockedFieldChanged(spec, d[spec.key], existing[spec.key])) {
      fields.push(spec.label)
      routes.add(spec.route)
    }
  }
  return { fields, routes: [...routes] }
}

// ── T1.3: succession-carry ──────────────────────────────────────────────────
// Projicera carry-fälten (delad lista i @eken/shared) från det gamla avtalet
// till create-datat för det nya. Före T1.3 kopierades bara ~10 handplockade
// fält — resten föll tyst till schema-defaults, inkl. 🔴 monthlyRentExcludingVat
// (momspliktig lokal slutade tyst ta ut utgående moms 2611, ML 1994:200) och
// consumptionBillingMode. Värdena kopieras rått (Decimal/enum/null) — null på
// nullable kolumn är "samma villkor", inte "hoppa över". Fullständigheten
// garanteras av DMMF-exhaustiveness-testet (leases-succession-t13.spec.ts):
// en ny Lease-kolumn utan uttryckligt carry/exclude-beslut bryter CI.
//
// Returtypen är Pick<LeaseUncheckedCreateInput, carry-fälten> så att create-
// anropen INTE behöver någon blanket-cast — de explicita fälten (identitet,
// datum, hyra, status, nummer) typcheckas fullt ut av tsc; bara den DMMF-
// testade projektionen bär en per-fält-assertion.
type SuccessionCarryData = Pick<Prisma.LeaseUncheckedCreateInput, LeaseSuccessionCarryField>

function pickSuccessionCarryData(lease: Record<string, unknown>): SuccessionCarryData {
  const out: Record<string, unknown> = {}
  for (const field of LEASE_SUCCESSION_CARRY_FIELDS) out[field] = lease[field]
  return out as SuccessionCarryData
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
        tenancyRegime: resolveTenancyRegime(dto.tenancyRegime, unit.type),
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

    // #65/#66: slutdatum får INTE ändras på ett AKTIVT kontrakt via den generiska
    // edit-vägen (PATCH /leases/:id). Att sätta/flytta endDate på ett löpande avtal
    // ÄR en uppsägning (eller förlängning) — görs det här kringgås uppsägningstidens
    // golv + månadsskiftesrundning, terminatedAt-sättningen OCH depositionsflödet
    // (markRefundPendingForLease). Tvinga rätt domänflöde: uppsägning (/terminate)
    // resp. förnyelse (/renew). Samma "golvet gäller ALLA vägar"-princip som
    // transitionStatus-delegeringen — annars vore update() en fjärde bypass.
    // En oförändrad endDate (web-formuläret återsänder befintligt värde vid t.ex.
    // hyresredigering) släpps igenom; bara en FAKTISK ändring blockeras.
    if (existing.status === 'ACTIVE' && dto.endDate != null) {
      const newEnd = startOfDay(new Date(dto.endDate)).getTime()
      const curEnd = existing.endDate ? startOfDay(new Date(existing.endDate)).getTime() : null
      if (newEnd !== curEnd) {
        throw new BadRequestException(
          'Slutdatum kan inte ändras direkt på ett aktivt kontrakt. Använd uppsägning för att ' +
            'avsluta det (uppsägningstiden tillämpas då automatiskt) eller förnyelse för att förlänga.',
        )
      }
    }

    // T1.1a edit-lås: på ACTIVE nekas ändring av bindande fält (hyra/avgifter,
    // identitet, deposition, villkor). Körs FÖRE unit/tenant-uppslagen nedan så en
    // låst identitetsändring nekas direkt utan onödiga DB-frågor. Aggregerat: alla
    // låsta fält användaren försökte ändra listas i ett svar. DRAFT passerar orört.
    if (existing.status === 'ACTIVE') {
      const locked = detectLockedActiveChanges(dto, existing as unknown as Record<string, unknown>)
      if (locked.fields.length > 0) {
        throw new BadRequestException(
          `Följande fält kan inte ändras på ett aktivt kontrakt: ${locked.fields.join(', ')}. ` +
            locked.routes.map((r) => LOCK_ROUTE_HINT[r]).join(' '),
        )
      }
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

    // IDOR-spärr: ett klient-skickat tenantId måste tillhöra den anropande orgen
    // INNAN det appliceras. Annars kan org A peka sitt avtal på org B:s hyresgäst
    // → svaret (INCLUDE → SAFE_TENANT_SELECT) läcker offrets fulla PII (personnr,
    // namn, adress) OCH avtalet korrumperas mot fel org. Speglar unitId-checken
    // ovan + invoices.update. (Launch-readiness #19.)
    if (dto.tenantId != null && dto.tenantId !== existing.tenantId) {
      const newTenant = await this.prisma.tenant.findFirst({
        where: { id: dto.tenantId, organizationId },
        select: { id: true },
      })
      if (!newTenant) throw new NotFoundException('Hyresgästen hittades inte')
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

  // ── T1.2: delad aktiverings-seam (#60) ─────────────────────────────────────
  // Statusmaskin-gate på en BEFINTLIG rads övergång (delad källa i @eken/shared).
  // Ett nytt avtal som skapas direkt ACTIVE (succession) har ingen from-status och
  // gate:as INTE här — bara faktiska övergångar (DRAFT→ACTIVE, ACTIVE→EXPIRED/
  // TERMINATED) passerar denna kontroll.
  private assertLeaseTransition(from: LeaseStatus, to: LeaseStatus): void {
    if (!isValidLeaseTransition(from, to)) {
      throw new BadRequestException('Ogiltig statusövergång')
    }
  }

  // Gemensamt IN-TX-efterled efter att en aktivering skrivits (update ELLER
  // create) — bara enhetsstatus-synken är genuint delad. Callern äger själva
  // status-skrivningen (olika shape: transitionStatus=update, succession=create).
  private async applyActivationEffects(
    tx: Prisma.TransactionClient,
    unitId: string,
  ): Promise<void> {
    await syncUnitStatusFromLeases(tx, unitId)
  }

  // Post-commit-jobb vid aktivering, parametriserade på ursprung:
  //   'manual'     → PDF + välkomstmejl + initial-avier (deposition + första avi)
  //   'succession' → PDF + gap-avi (skipDeposit, ingen ny deposition) + INGEN välkomst
  // Alla enqueue:ar är best-effort (Bull retry + SYSTEM-notis vid permanent fail).
  private async dispatchActivationJobs(
    lease: { id: string; organizationId: string; tenantId: string },
    opts: { origin: 'manual' | 'succession'; actorUserId: string | null },
  ): Promise<void> {
    await this.activationQueue
      .enqueueGenerateContract({
        leaseId: lease.id,
        organizationId: lease.organizationId,
        actorUserId: opts.actorUserId,
      })
      .catch((err) =>
        this.logger.error(`[Leases] enqueue generate-contract failed: ${String(err)}`),
      )

    if (opts.origin === 'manual') {
      await this.activationQueue
        .enqueueWelcomeMail({ tenantId: lease.tenantId })
        .catch((err) => this.logger.error(`[Leases] enqueue welcome-mail failed: ${String(err)}`))
    }

    await this.activationQueue
      .enqueueInitialNotices({
        leaseId: lease.id,
        organizationId: lease.organizationId,
        skipDeposit: opts.origin === 'succession',
        succession: opts.origin === 'succession',
      })
      .catch((err: unknown) =>
        this.logger.error(`[Leases] enqueue initial-notices failed: ${String(err)}`),
      )
  }

  // ── T1.3: succession-följdeffekter (körs INOM avtalsbytets transaktion) ────
  // Två saker som annars strandar på det ersatta (EXPIRED) avtalet:
  //
  // 1) Väntande hyreshöjningar → VOID (beslut 2026-07-08, INGET repoint-
  //    undantag). Säker failure-riktning: en försenad höjning som hyresvärden
  //    registrerar om på nya avtalet — aldrig en felaktig. Repoint kräver att
  //    flera villkor samtidigt stämmer (basbelopp, effektivdatum, aviserings-
  //    frist mot NYA avtalet) = subtil pengabugg-risk. JB 12 kap 19 §: hyran
  //    ska vara till beloppet bestämd i det NYA avtalet. voidedAt/voidReason
  //    är audit-spåret ("varför applicerades den aldrig?").
  //
  // 2) Depositionen re-pekas till det nya avtalet — ENDAST Deposit.leaseId.
  //    rentNoticeId/invoiceId rörs ALDRIG: de pekar på det HISTORISKA
  //    verifikat-underlaget (BFL 5 kap 7 §) och bankmatchningen är keyad på
  //    rentNoticeId — att flytta dem bryter spårbarhet + betalningsmatchning.
  //    Ingen omföring behövs: JournalEntry/JournalEntryLine saknar FK mot
  //    Lease (verifikat keyade på sourceId/accountId) → re-pekningen är ren
  //    metadata. Deposit.amount rörs INTE i v1 (höjd deposition vid förnyelse
  //    = separat framtida flöde, tilläggsavi 1510/2890 på deltat).
  //    Org-scopat uppslag (FIX 2); no-op när ingen deposition finns
  //    (depositAmount 0 → ingen rad skapades). Deposit.leaseId är @unique och
  //    det nyskapade avtalet kan inte ha någon deposition ännu → kollisionsfritt.
  private async applySuccessionSideEffects(
    tx: Prisma.TransactionClient,
    args: { oldLeaseId: string; newLeaseId: string; organizationId: string },
  ): Promise<{ voidedIncreases: number }> {
    const voided = await tx.rentIncrease.updateMany({
      where: {
        leaseId: args.oldLeaseId,
        organizationId: args.organizationId,
        status: { in: ['DRAFT', 'NOTICE_SENT', 'ACCEPTED'] },
      },
      data: {
        status: 'VOIDED',
        voidedAt: new Date(),
        voidReason:
          'Avtalet förnyades innan höjningen hann tillämpas — höjningen hörde till det ' +
          'ersatta avtalet. Registrera en ny hyreshöjning på det förnyade avtalet ' +
          '(JB 12 kap 19 §: hyran bestäms till beloppet i det nya avtalet).',
      },
    })

    const deposit = await tx.deposit.findFirst({
      where: { leaseId: args.oldLeaseId, organizationId: args.organizationId },
      select: { id: true },
    })
    if (deposit) {
      await tx.deposit.update({
        where: { id: deposit.id },
        data: { leaseId: args.newLeaseId },
      })
    }

    return { voidedIncreases: voided.count }
  }

  // Post-commit-notis när succession annullerade väntande hyreshöjningar —
  // hyresvärden måste aktivt registrera om höjningen på det nya avtalet,
  // annars uteblir den tyst. Best-effort (får aldrig fälla förnyelsen).
  private notifyVoidedIncreases(
    organizationId: string,
    newLeaseId: string,
    unitName: string | undefined,
    count: number,
  ): void {
    void this.notifications
      .createForAllOrgUsers(
        organizationId,
        'SYSTEM',
        'Hyreshöjning annullerad vid förnyelse',
        `${count} väntande hyreshöjning${count === 1 ? '' : 'ar'} annullerades när avtalet` +
          `${unitName ? ` för ${unitName}` : ''} förnyades. Registrera höjningen på nytt på ` +
          'det förnyade avtalet om den fortfarande är aktuell.',
        { relatedEntityType: 'LEASE', relatedEntityId: newLeaseId },
      )
      .catch((err) => this.logger.error(`Notification error: ${String(err)}`))
  }

  async transitionStatus(
    id: string,
    newStatus: LeaseStatus,
    organizationId: string,
    actorUserId?: string | null,
  ) {
    const lease = await this.findOne(id, organizationId)
    this.assertLeaseTransition(lease.status, newStatus)

    // En uppsägning av ett AKTIVT kontrakt måste gå via terminate() så att
    // uppsägningstidens golv + månadsskiftesrundning ALLTID tillämpas. Annars
    // kringgår den generiska /status-vägen (AI-verktyget `transition_lease_status`
    // och direkt HTTP PATCH /leases/:id/status) golvet och gör en RÅ flip till
    // TERMINATED med omedelbar verkan — juridiskt ogiltig uppsägning (#65).
    // terminate() sätter terminatedAt + golvat endDate och låter kontraktet
    // löpa som ACTIVE till slutdatum (cron flippar TERMINATED då), exakt som
    // det avsedda uppsägningsflödet. DRAFT→TERMINATED (avbryt utkast) har ingen
    // uppsägningstid och flippar direkt nedan.
    if (newStatus === 'TERMINATED' && lease.status === 'ACTIVE') {
      return this.terminate(id, {}, organizationId)
    }

    // T1.3 (bokförings-grind): ACTIVE→EXPIRED via den generiska status-vägen
    // tillåts BARA när avtalet faktiskt har löpt ut (endDate passerat). Ett
    // EXPIRED med framtida endDate skapas annars UTAN succession-sideeffects
    // (ingen efterträdare, ingen deposition-re-pekning, ingen VOID av väntande
    // höjningar) och skulle — via generateMonthlyNotices EXPIRED-inkludering —
    // fortsätta faktureras och intäktsbokföras varje månad fram till endDate,
    // trots att ingen upplåtelse längre finns registrerad. Förtida avslut =
    // uppsägning (terminate: golv + månadsskiftesrundning); förlängning/nya
    // villkor = förnyelse (renew: succession-seamen). Samma "rätt domänflöde
    // gäller alla vägar"-princip som TERMINATED-delegeringen ovan — täcker
    // även AI-verktyget transition_lease_status.
    if (newStatus === 'EXPIRED' && lease.status === 'ACTIVE') {
      const today = startOfDay(new Date())
      const ended = lease.endDate && startOfDay(lease.endDate).getTime() < today.getTime()
      if (!ended) {
        throw new BadRequestException(
          'Ett aktivt avtal kan markeras som utgånget först när slutdatumet har passerat. ' +
            'Använd uppsägning för att avsluta det i förtid, eller förnyelse för att förlänga.',
        )
      }
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
            ...(newStatus === 'ACTIVE' ? { activatedAt: new Date() } : {}),
            ...(newStatus === 'TERMINATED' ? { terminatedAt: new Date() } : {}),
            ...(contractNumber ? { contractNumber } : {}),
          },
          include: INCLUDE,
        })

        // Synka enhetens status så att fastighetsöversikten alltid stämmer.
        // Körs efter lease.update så count() ser det nya tillståndet — delat
        // in-tx-efterled (I1/#62, T1.2-seam).
        await this.applyActivationEffects(tx, lease.unitId)

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

    // När ett kontrakt blir ACTIVE dispatchas aktiverings-jobben (PDF +
    // välkomstmejl + initial-avier) via den delade seam:en. Bull retras
    // automatiskt (1m → 2m → 4m → 8m → 16m → permanent fail) och vid permanent
    // fail får org-admins en SYSTEM-notification — ersätter tidigare
    // fire-and-forget som tyst kunde lämna en ACTIVE Lease utan PDF eller mejl.
    // actorUserId får vara null (cron/system/AI utan user-context) → Document.
    // uploadedById blir null; gating på actorUserId orsakade Tindra-buggen.
    if (newStatus === 'ACTIVE') {
      await this.dispatchActivationJobs(updated, {
        origin: 'manual',
        actorUserId: actorUserId ?? null,
      })
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
            tenancyRegime: resolveTenancyRegime(dto.tenancyRegime, unit.type),
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

  // `initiator` avgör uppsägningstiden under privatuthyrningslagen (#69):
  // hyresgäst 1 mån / hyresvärd 3 mån. Default LANDLORD — direkt HTTP /terminate,
  // /status och AI-delegeringen är alla hyresvärdsvägar. TerminationsService.approve()
  // (hyresvärd godkänner hyresgästens begäran) skickar 'TENANT'.
  async terminate(
    id: string,
    dto: TerminateLeaseDto,
    organizationId: string,
    initiator: TerminationInitiator = 'LANDLORD',
  ) {
    const lease = await this.findOne(id, organizationId)

    if (lease.status !== 'ACTIVE' && lease.status !== 'DRAFT') {
      throw new BadRequestException('Endast aktiva eller utkast-avtal kan sägas upp')
    }
    if (lease.terminatedAt) {
      throw new BadRequestException('Kontraktet är redan uppsagt')
    }

    const today = startOfDay(new Date())

    // Uppsägningstidens golv är TVINGANDE till hyresgästens förmån (JB 12 kap
    // 1 § 5 st): en uppsägning kan aldrig upphöra före det månadsskifte som
    // infaller närmast efter uppsägningstiden. Ett för kort effectiveDate
    // JUSTERAS UPP till golvet — aldrig ett ogiltigt (för tidigt) avslut (#45),
    // månadsskiftesrundat (#46). Antal månader väljs efter regelverk + vem som
    // säger upp (#69): privatuthyrning ger hyresgästen 1 mån, hyresvärden 3 mån;
    // hyreslagen behåller avtalets noticePeriodMonths (oförändrat F2-beteende).
    // Detta är den ENDA punkt alla uppsägningsvägar passerar (HTTP /terminate,
    // approve(), transitionStatus-delegeringen) → ingen väg kringgår golvet.
    let effective: Date
    if (lease.status === 'ACTIVE') {
      const months = terminationNoticeMonths({
        regime: lease.tenancyRegime,
        initiator,
        unitType: lease.unit.type,
        contractualNoticeMonths: lease.noticePeriodMonths,
      })
      const floor = endOfNoticePeriod(today, months)
      const requested = dto.effectiveDate ? startOfDay(new Date(dto.effectiveDate)) : floor
      effective = requested.getTime() < floor.getTime() ? floor : requested
    } else {
      // DRAFT: kontraktet har aldrig aktiverats → ingen uppsägningstid att
      // skydda. Avsluta direkt (eller vid angivet framtida datum).
      effective = dto.effectiveDate ? startOfDay(new Date(dto.effectiveDate)) : today
      if (effective < today) {
        throw new BadRequestException('Slutdatum kan inte vara i förflutet')
      }
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

    // #73: depositionen flyttas INTE till REFUND_PENDING här (uppsägningsdatum).
    // Depositionen är en säkerhet för HELA hyrestiden inkl. uppsägningstiden — den
    // får inte frisläppas förrän hyresgästen faktiskt flyttat ut. Triggern ligger
    // därför i terminateExpiredNoticeLeases (när endDate passerat → TERMINATED).

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

    // T1.3: förnyelsen ÅTER-validerar tvingande regler — create/update har dem,
    // renew saknade dem helt. Uppsägningstidens golv (JB 12 kap 4 §) på det
    // carry:ade värdet, och depositionstaket mot den EFFEKTIVA hyran: en
    // omförhandlad (sänkt) hyra kan spränga 3×-taket trots att depositions-
    // beloppet är oförändrat från gamla avtalet.
    assertLeaseLegalLimits({
      unitType: lease.unit.type,
      monthlyRent: dto.monthlyRent ?? Number(lease.monthlyRent),
      noticePeriodMonths: lease.noticePeriodMonths,
      depositAmount: Number(lease.depositAmount),
    })

    // Gamla avtalet går ACTIVE→EXPIRED (statusmaskin, #60). Ordning: gammalt→
    // EXPIRED FÖRE nytt→create — lease_unit_active_unique är per-statement (ej
    // deferrable) så ett ACTIVE måste bort innan nästa skapas på samma enhet.
    this.assertLeaseTransition(lease.status, 'EXPIRED')

    const { created, voidedIncreases } = await this.prisma.$transaction(async (tx) => {
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

      // Skapa nytt kontrakt — SAMTLIGA villkor bärs via carry-projektionen
      // (T1.3, delad lista i @eken/shared, DMMF-skyddad); bara identitet,
      // datum, hyra, status och nummer sätts explicit. De explicita fälten
      // ligger EFTER spreaden och är disjunkta från carry-listan (testat).
      const created = await tx.lease.create({
        data: {
          ...pickSuccessionCarryData(lease as unknown as Record<string, unknown>),
          organizationId,
          unitId: lease.unitId,
          tenantId: lease.tenantId,
          startDate: newStart,
          endDate: newEnd,
          monthlyRent: dto.monthlyRent ?? lease.monthlyRent,
          status: 'ACTIVE',
          contractNumber,
          activatedAt: new Date(),
        },
        include: INCLUDE,
      })

      // T1.3: VOIDa väntande hyreshöjningar + re-peka depositionen (efter
      // tx.lease.create — FK:n kräver att nya raden finns).
      const { voidedIncreases } = await this.applySuccessionSideEffects(tx, {
        oldLeaseId: lease.id,
        newLeaseId: created.id,
        organizationId,
      })

      // Säkerställ att enhetsstatus förblir OCCUPIED (det nya avtalet är ACTIVE)
      await this.applyActivationEffects(tx, lease.unitId)

      return { created, voidedIncreases }
    })

    if (voidedIncreases > 0) {
      this.notifyVoidedIncreases(organizationId, created.id, lease.unit.name, voidedIncreases)
    }

    // Succession-aktivering (post-commit): PDF (länkar föregående avtal) + gap-avi
    // (skipDeposit — depositionen re-pekas i T1.3, inte ny). INGEN välkomstmejl —
    // samma hyresgäst. Fixar #48 (ingen PDF) + #43 (gap-avi tappas) för renew-vägen.
    await this.dispatchActivationJobs(created, { origin: 'succession', actorUserId: null })

    return created
  }

  // ── Cron: livscykel-processering ─────────────────────────────────────────────
  // Körs varje dag 06:00. Tre uppgifter:
  //   a) auto-förläng FIXED_TERM som löpt ut utan uppsägning
  //   b) skicka påminnelser 90/60/30 dagar innan slutdatum
  //   c) avsluta uppsagda avtal som nått slutdatum
  @Cron('0 6 * * *')
  async processLifecycle(): Promise<void> {
    const today = startOfDay(new Date())

    // T1.3 race-fix: auto-förnyelsen (inkl. VOID av väntande höjningar) körs
    // HELT FÖRE applyDueIncreases. I samma Promise.all serialiserar READ
    // COMMITTED dem INTE: applyDueIncreases kunde läsa en ACCEPTED höjning
    // vars avtal samtidigt flippades EXPIRED, skriva monthlyRent på det döda
    // avtalet och flippa APPLIED → höjningen konsumerades tyst utan att nya
    // avtalet någonsin fick den. Daglig 06:00-cron — ingen latensbudget.
    const renewed = await this.autoRenewExpiredFixedTerm(today)

    const [reminders, terminated, depositReminders, rentApplied] = await Promise.all([
      this.sendExpiryReminders(today),
      this.terminateExpiredNoticeLeases(today),
      this.deposits.remindStaleRefundPending(),
      this.rentIncreases.applyDueIncreases(today),
    ])

    // #73 catch-up (EFTER termineringssvepet ovan): läk PAID-depositioner på
    // TERMINATED-kontrakt vars inline-flaggning i terminateExpiredNoticeLeases
    // kan ha felat (transient). Idempotent självläkning.
    const refundSwept = await this.deposits.sweepTerminatedLeasesForRefundPending().catch((err) => {
      this.logger.error(`[Leases] Deposit refund-sweep failed: ${String(err)}`)
      return 0
    })

    this.logger.log(
      `[Leases] Lifecycle done: ${renewed} renewed, ${reminders} reminders, ${terminated} terminated, ${depositReminders} deposit reminders, ${refundSwept} refund-sweep, ${rentApplied} rent increases applied`,
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

      // T1.3: samma tvingande återvalidering som manuell renew(). Hyran är
      // oförändrad vid auto-förnyelse, så ett brott betyder att avtalet redan
      // låg fel (eller att reglerna skärpts) — då får förnyelsen INTE tyst
      // återskapa lagstridiga villkor. Skippa + larma org-admins: avtalet
      // ligger kvar ACTIVE förbi endDate och kräver manuell åtgärd.
      let complianceError: string | null = null
      try {
        assertLeaseLegalLimits({
          unitType: lease.unit.type,
          monthlyRent: Number(lease.monthlyRent),
          noticePeriodMonths: lease.noticePeriodMonths,
          depositAmount: Number(lease.depositAmount),
        })
      } catch (err) {
        complianceError = err instanceof BadRequestException ? err.message : String(err)
      }
      if (complianceError) {
        this.logger.error(
          `[Leases] Auto-renew blocked for ${lease.id} (compliance): ${complianceError}`,
        )
        void this.notifications
          .createForAllOrgUsers(
            lease.organizationId,
            'SYSTEM',
            'Auto-förnyelse blockerad',
            `Avtalet för ${lease.unit.name} kunde inte förnyas automatiskt: ${complianceError} ` +
              'Åtgärda villkoren och förnya manuellt.',
            { relatedEntityType: 'LEASE', relatedEntityId: lease.id },
          )
          .catch((err) => this.logger.error(`Notification error: ${String(err)}`))
        continue
      }

      try {
        // Gamla avtalet ACTIVE→EXPIRED (statusmaskin, #60).
        this.assertLeaseTransition(lease.status, 'EXPIRED')
        const { created, voidedIncreases } = await this.prisma.$transaction(async (tx) => {
          await tx.lease.update({
            where: { id: lease.id },
            data: { status: 'EXPIRED' },
          })

          // Auto-förnyat kontrakt skapas direkt ACTIVE → allokera eget
          // kontraktsnummer i samma transaktion (annars NULL contractNumber).
          const contractNumber = await this.contractNumbers.allocate(lease.organizationId, tx)

          // SAMTLIGA villkor bärs via carry-projektionen (T1.3) — samma
          // delade lista som manuell renew(); hyran är alltid oförändrad här.
          const newLease = await tx.lease.create({
            data: {
              ...pickSuccessionCarryData(lease as unknown as Record<string, unknown>),
              organizationId: lease.organizationId,
              unitId: lease.unitId,
              tenantId: lease.tenantId,
              startDate: newStart,
              endDate: newEnd,
              monthlyRent: lease.monthlyRent,
              status: 'ACTIVE',
              contractNumber,
              activatedAt: new Date(),
            },
          })

          // T1.3: VOIDa väntande hyreshöjningar + re-peka depositionen.
          const { voidedIncreases } = await this.applySuccessionSideEffects(tx, {
            oldLeaseId: lease.id,
            newLeaseId: newLease.id,
            organizationId: lease.organizationId,
          })

          // Det nya avtalet är ACTIVE → enheten ska vara OCCUPIED (delat
          // in-tx-efterled, T1.2-seam).
          await this.applyActivationEffects(tx, lease.unitId)
          return { created: newLease, voidedIncreases }
        })

        if (voidedIncreases > 0) {
          this.notifyVoidedIncreases(
            lease.organizationId,
            created.id,
            lease.unit.name,
            voidedIncreases,
          )
        }

        // Succession-aktivering (post-commit): PDF + gap-avi (skipDeposit),
        // ingen välkomstmejl. Fixar #48 + #43 för auto-förnyelse-vägen.
        await this.dispatchActivationJobs(created, { origin: 'succession', actorUserId: null })

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
        this.assertLeaseTransition(lease.status, 'TERMINATED')
        await this.prisma.$transaction(async (tx) => {
          await tx.lease.update({
            where: { id: lease.id },
            data: { status: 'TERMINATED' },
          })

          // Frigör enheten om inget annat ACTIVE-kontrakt finns (synk-punkt).
          await syncUnitStatusFromLeases(tx, lease.unitId)
        })

        // #73: NU (hyresgästen har flyttat ut, endDate passerat) flyttas en
        // betald deposition till REFUND_PENDING — inte vid uppsägningsdatum.
        // Säkerheten hålls kvar under hela uppsägningstiden. Best-effort: ett fel
        // här får inte fälla cron-svepet. Självläkning finns: en PAID-deposition
        // på ett TERMINATED-kontrakt som missas här fångas av den dagliga
        // sweepTerminatedLeasesForRefundPending() i processLifecycle.
        await this.deposits
          .markRefundPendingForLease(lease.id, lease.organizationId)
          .catch((err) =>
            this.logger.error(
              `[Leases] Deposit refund-pending failed for ${lease.id}: ${String(err)}`,
            ),
          )

        this.logger.log(`[Leases] Terminated expired-notice lease ${lease.id}`)
        terminated++
      } catch (err) {
        this.logger.error(`[Leases] Termination cron failed for ${lease.id}: ${String(err)}`)
      }
    }
    return terminated
  }
}
