import { Injectable, Logger } from '@nestjs/common'
import { ConflictException, ForbiddenException, UnprocessableEntityException } from '@nestjs/common'
import { Prisma, RentNoticeType, UserRole } from '@prisma/client'
import {
  BACKFILL_HARD_CAP_MONTHS,
  BACKFILL_WARNING_MONTHS,
  backfillRentDueDate,
  monthsBetween,
} from '@eken/shared'
import type { RentNotice, UnitType } from '@prisma/client'
import { PrismaService } from '../common/prisma/prisma.service'
import { OcrService } from '../common/ocr/ocr.service'
import { NotificationsService } from '../notifications/notifications.service'
import { AviseringService } from './avisering.service'

/**
 * T1.4 / #44 — motor för bakdaterad debitering (efterdebitering av bebodda men
 * aldrig aviserade månader vid bakdaterad aktivering).
 *
 * TVÅ skarpt åtskilda operationer:
 *   • detectGaps(): ren PREVIEW/DETEKTION — skapar ALDRIG en avi eller ett
 *     verifikat. Returnerar vilka månader som saknas, belopp och en status per
 *     månad (debiterbar / stängd period / kräver godkännande / preskriberad).
 *   • createBackfillNotices(): faktiskt skapande, anropas ENBART efter
 *     människo-bekräftelse (PR2 wirear bekräftelsen). Ingen cron/aktivering
 *     anropar den — tyst auto-debitering är strukturellt omöjlig.
 *
 * Billing-ursprung = leasens EGET `startDate` (inte tenancyStartDate): denna
 * lease debiterar bara sina egna månader; föregående avtal i en förnyelsekedja
 * bär sina egna avier.
 */

export type BackfillMonthStatus =
  | 'BILLABLE' // öppen period, inom 12 mån → skapas vid bekräftelse
  | 'BEYOND_WARNING' // 12–36 mån bakåt → skapas ENDAST med uttryckligt godkännande (datafel-grind)
  | 'BEYOND_HARD_CAP' // > 36 mån → skapas ALDRIG (preskription, Preskriptionslagen 3 år)
  | 'CLOSED_PERIOD' // räkenskapsperioden stängd → skapas aldrig (hård spärr, SYSTEM-notis)

export interface BackfillMonthPreview {
  year: number
  month: number
  periodStart: Date
  periodEnd: Date
  daysCharged: number
  totalDays: number
  isProrated: boolean
  amount: number
  vatAmount: number
  totalAmount: number
  ageMonths: number
  status: BackfillMonthStatus
}

export interface BackfillSummary {
  billableCount: number
  billableTotal: number
  beyondWarningCount: number
  beyondWarningTotal: number
  hardCappedCount: number
  closedCount: number
}

export interface BackfillPreview {
  leaseId: string
  months: BackfillMonthPreview[]
  summary: BackfillSummary
  // T1.4 PR2 — momsperiod-disclaimer (bokförings HIGH): en efterdebitering av en
  // frivilligt skattskyldig LOKAL kan falla i en redan deklarerad momsperiod
  // (SFL 26 kap ≠ räkenskapsår). Vi spärrar INTE (deklarationsrättelse = människans
  // beslut) men UI:t MÅSTE varna. Flaggan surfas till bekräftelse-UI:t.
  hasVoluntaryTaxLiability: boolean
}

/** En post i "att efterdebitera"-kön — ett kontrakt med saknade, debiterbara månader. */
export interface BackfillQueueItem {
  leaseId: string
  tenantName: string
  unitLabel: string
  propertyLabel: string
  summary: BackfillSummary
  requiresApproval: boolean // minst en månad ligger i 12–36-grinden (>12 mån)
  maxAgeMonths: number
  hasVoluntaryTaxLiability: boolean
}

export interface BackfillResult {
  created: RentNotice[]
  skippedExisting: number // idempotens: månaden var redan aviserad (P2002)
  skippedClosed: number // stängd räkenskapsperiod → SYSTEM-notis
  skippedBeyondWarning: number // 12–36 mån utan allowBeyondWarning
  blockedHardCap: number // > 36 mån, aldrig
  skippedMissingAccount: number // kontoplanen saknar konto → SYSTEM-notis (bokförings-expert CRITICAL)
}

type BackfillLease = {
  id: string
  organizationId: string
  tenantId: string
  monthlyRent: Prisma.Decimal | number
  monthlyRentExcludingVat: boolean
  startDate: Date
  endDate: Date | null
  status: string
  unit: { type: UnitType; voluntaryTaxLiability: boolean }
}

@Injectable()
export class RentBackfillService {
  private readonly logger = new Logger(RentBackfillService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly avisering: AviseringService,
    private readonly ocr: OcrService,
    private readonly notifications: NotificationsService,
  ) {}

  // ── PREVIEW — skapar INGET ─────────────────────────────────────────────────
  async detectGaps(leaseId: string, organizationId: string): Promise<BackfillPreview> {
    const lease = (await this.prisma.lease.findFirst({
      where: { id: leaseId, organizationId },
      include: { unit: { select: { type: true, voluntaryTaxLiability: true } } },
    })) as BackfillLease | null
    if (!lease)
      return {
        leaseId,
        months: [],
        summary: this.emptySummary(),
        hasVoluntaryTaxLiability: false,
      }

    const months = await this.computeGapMonths(lease)
    const summary = this.summarize(months)
    return {
      leaseId,
      months,
      summary,
      hasVoluntaryTaxLiability: lease.unit.voluntaryTaxLiability === true,
    }
  }

  // ── "Att efterdebitera"-kön — alla kontrakt med debiterbara luckor ──────────
  // Skild från aktiveringen (jurist CRITICAL, beslut B): hyresvärden tar
  // efterdebiterings-beslutet MEDVETET, inte som bieffekt av att aktivera.
  // Enumererar ALLA aktiva kontrakt (inte bara nyss aktiverade) → utgör även den
  // manuella retriggern (#58): gap-detektion kan köras när som helst, inte bara
  // vid aktivering. Skapar INGET (ren detektion).
  async detectQueue(organizationId: string): Promise<BackfillQueueItem[]> {
    const leases = await this.prisma.lease.findMany({
      where: { organizationId, status: 'ACTIVE' },
      include: {
        tenant: {
          select: { type: true, firstName: true, lastName: true, companyName: true },
        },
        unit: {
          select: {
            type: true,
            voluntaryTaxLiability: true,
            name: true,
            unitNumber: true,
            property: { select: { name: true, street: true } },
          },
        },
      },
    })

    const items: BackfillQueueItem[] = []
    for (const lease of leases) {
      const months = await this.computeGapMonths(lease as unknown as BackfillLease)
      // Bara kontrakt med FAKTISKT debiterbara luckor visas i kön — månader som
      // är preskriberade (>36) eller i stängd period är inte en operatörshandling.
      const actionable = months.filter(
        (m) => m.status === 'BILLABLE' || m.status === 'BEYOND_WARNING',
      )
      if (actionable.length === 0) continue

      const t = lease.tenant
      const tenantName =
        t.type === 'INDIVIDUAL'
          ? `${t.firstName ?? ''} ${t.lastName ?? ''}`.trim()
          : (t.companyName ?? '')
      const unitLabel = lease.unit.unitNumber
        ? `${lease.unit.unitNumber} — ${lease.unit.name}`
        : lease.unit.name
      const propertyLabel = lease.unit.property.street ?? lease.unit.property.name

      items.push({
        leaseId: lease.id,
        tenantName,
        unitLabel,
        propertyLabel,
        summary: this.summarize(months),
        requiresApproval: actionable.some((m) => m.status === 'BEYOND_WARNING'),
        maxAgeMonths: actionable.reduce((max, m) => Math.max(max, m.ageMonths), 0),
        hasVoluntaryTaxLiability: lease.unit.voluntaryTaxLiability === true,
      })
    }
    return items
  }

  // ── SKAPANDE — endast efter människo-bekräftelse (PR2) ──────────────────────
  async createBackfillNotices(
    leaseId: string,
    organizationId: string,
    opts: {
      allowBeyondWarning?: boolean
      // Momsdeklarations-bekräftelse (bokförings HIGH). Grindas server-side —
      // en momspliktig lokal får INTE efterdebiteras utan aktivt godkännande.
      vatDeclarationAcknowledged?: boolean
      actorUserId?: string | null
      // Aktörens roll (hyresjurist MEDIUM, kopplat till #20 rollinversion): ett
      // >12-mån-godkännande (allowBeyondWarning) är ett förhöjt beslut och kräver
      // ADMIN/OWNER. Grindas HÄR (money-binding-chokepunkten), inte bara i UI/
      // controller — så ingen framtida anropare (AI-verktyg, ny controller) kan
      // kringgå det. En normal (≤12 mån) efterdebitering påverkas inte.
      actorRole?: UserRole
    } = {},
  ): Promise<BackfillResult> {
    // Behörighetsgrind FÖRE all beräkning: bara ADMIN/OWNER får godkänna den
    // långa bakdateringen (>12 mån = sannolik datafel-signal). MANAGER kan
    // fortfarande bekräfta normala efterdebiteringar — bara inte kringgå grinden.
    if (
      opts.allowBeyondWarning === true &&
      opts.actorRole !== UserRole.OWNER &&
      opts.actorRole !== UserRole.ADMIN
    ) {
      throw new ForbiddenException(
        'Endast administratör eller ägare kan godkänna en efterdebitering äldre än 12 månader ' +
          '(lång bakdatering kräver förhöjd behörighet).',
      )
    }
    const lease = (await this.prisma.lease.findFirst({
      where: { id: leaseId, organizationId },
      include: { unit: { select: { type: true, voluntaryTaxLiability: true } } },
    })) as BackfillLease | null
    if (!lease) {
      return {
        created: [],
        skippedExisting: 0,
        skippedClosed: 0,
        skippedBeyondWarning: 0,
        blockedHardCap: 0,
        skippedMissingAccount: 0,
      }
    }

    // Momsperiod-grind (bokförings HIGH, SFL 26 kap): en frivilligt skattskyldig
    // lokal kan efterdebiteras in i en redan lämnad momsperiod → rättelse­deklaration
    // = människans beslut. Kräv ett AKTIVT, loggbart godkännande (inte bara en
    // passiv UI-ruta). Server-side så ett direkt API-anrop inte kan kringgå det.
    if (lease.unit.voluntaryTaxLiability === true && opts.vatDeclarationAcknowledged !== true) {
      throw new UnprocessableEntityException(
        'Momsdeklarationen måste bekräftas innan en momspliktig lokal efterdebiteras ' +
          '(efterdebiterade perioder kan kräva rättelsedeklaration, SFL 26 kap).',
      )
    }

    const months = await this.computeGapMonths(lease)
    const result: BackfillResult = {
      created: [],
      skippedExisting: 0,
      skippedClosed: 0,
      skippedBeyondWarning: 0,
      blockedHardCap: 0,
      skippedMissingAccount: 0,
    }

    // Förfallodag = SAMMA framåtklampade 30-dagarsdag för hela batchen (från nu).
    const dueDate = backfillRentDueDate(new Date())
    // OCR tilldelas en gång per hyresgäst (idempotent i OcrService).
    const ocrNumber = await this.ocr.assignOcrToTenant(lease.tenantId, organizationId)
    const closedMonths: string[] = []
    const missingAccountMonths: string[] = []

    for (const m of months) {
      if (m.status === 'BEYOND_HARD_CAP') {
        result.blockedHardCap++
        continue
      }
      if (m.status === 'CLOSED_PERIOD') {
        result.skippedClosed++
        closedMonths.push(`${m.year}-${String(m.month).padStart(2, '0')}`)
        continue
      }
      if (m.status === 'BEYOND_WARNING' && !opts.allowBeyondWarning) {
        result.skippedBeyondWarning++
        continue
      }

      // Atomiskt per månad: avi + verifikat i SAMMA tx (PR0). En stängning som
      // hunnit ske mellan detektion och skapande fångas av allocate() → tx
      // rullas tillbaka (ingen orphan-avi), och vi klassar månaden som stängd.
      try {
        const notice = await this.prisma.$transaction((tx) =>
          this.avisering.createBackfillRentNoticeInTx(tx, lease, {
            year: m.year,
            month: m.month,
            ocrNumber,
            dueDate,
            // Audit-spår per skapad avi (hyresjurist MÅSTE) — vem godkände, hur
            // gammal månaden var och om det var ett uttryckligt >12-mån-godkännande.
            audit: {
              actorUserId: opts.actorUserId ?? null,
              ageMonths: m.ageMonths,
              beyondWarning: m.status === 'BEYOND_WARNING',
              allowBeyondWarning: opts.allowBeyondWarning === true,
              hasVoluntaryTaxLiability: lease.unit.voluntaryTaxLiability === true,
              vatDeclarationAcknowledged: opts.vatDeclarationAcknowledged === true,
            },
          }),
        )
        if (notice) result.created.push(notice)
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          // @@unique([leaseId,year,month,type]) → månaden redan aviserad
          // (cron/initial/tidigare backfill). Idempotent no-op.
          result.skippedExisting++
        } else if (err instanceof ConflictException) {
          // Perioden stängdes mellan detektion och skapande.
          result.skippedClosed++
          closedMonths.push(`${m.year}-${String(m.month).padStart(2, '0')}`)
        } else if (err instanceof UnprocessableEntityException) {
          // Kontoplanen saknar ett konto → verifikatet kunde inte skapas →
          // hela månads-tx:en rullades tillbaka (ingen orphan-avi). Synliggör
          // för en människa (bokförings-expert CRITICAL) — inte bara loggen.
          result.skippedMissingAccount++
          missingAccountMonths.push(`${m.year}-${String(m.month).padStart(2, '0')}`)
        } else {
          this.logger.error(
            `[Backfill] Efterdebitering av ${m.year}-${m.month} för lease ${leaseId} misslyckades: ${
              err instanceof Error ? err.message : String(err)
            }`,
          )
          throw err
        }
      }
    }

    if (closedMonths.length > 0) {
      await this.notifications
        .createForAllOrgUsers(
          organizationId,
          'SYSTEM',
          'Efterdebitering kunde inte ske för stängd period',
          `${closedMonths.length} månad(er) (${closedMonths.join(', ')}) kunde inte efterdebiteras ` +
            'eftersom räkenskapsperioden är stängd. Hantera manuellt i öppen period (rättelsepost).',
          { relatedEntityType: 'LEASE', relatedEntityId: leaseId },
        )
        .catch((e) => this.logger.error(`[Backfill] SYSTEM-notis misslyckades: ${String(e)}`))
    }

    if (missingAccountMonths.length > 0) {
      await this.notifications
        .createForAllOrgUsers(
          organizationId,
          'SYSTEM',
          'Efterdebitering blockerad — konto saknas i kontoplanen',
          `${missingAccountMonths.length} månad(er) (${missingAccountMonths.join(', ')}) kunde inte ` +
            'efterdebiteras eftersom ett obligatoriskt konto (1510/intäkts-/momskonto) saknas i ' +
            'kontoplanen. Ingen avi skapades (ingen orphan-avi). Kontakta redovisningskonsult.',
          { relatedEntityType: 'LEASE', relatedEntityId: leaseId },
        )
        .catch((e) => this.logger.error(`[Backfill] SYSTEM-notis misslyckades: ${String(e)}`))
    }

    return result
  }

  // ── Delad kärna: hitta saknade månader + klassa dem ─────────────────────────
  private async computeGapMonths(lease: BackfillLease): Promise<BackfillMonthPreview[]> {
    const now = new Date()
    const curYear = now.getFullYear()
    const curMonth = now.getMonth() + 1
    const startYear = lease.startDate.getFullYear()
    const startMonth = lease.startDate.getMonth() + 1

    // Redan aviserade RENT-månader för denna lease (dubbeldebiterings-förkoll).
    const existing = await this.prisma.rentNotice.findMany({
      where: { leaseId: lease.id, type: RentNoticeType.RENT },
      select: { year: true, month: true },
    })
    const billed = new Set(existing.map((e) => `${e.year}-${e.month}`))

    // Stängda perioder för org:en (per-månad-koll).
    const closed = await this.prisma.closedAccountingPeriod.findMany({
      where: { organizationId: lease.organizationId },
      select: { year: true, month: true },
    })
    const closedSet = new Set(closed.map((c) => `${c.year}-${c.month}`))

    const months: BackfillMonthPreview[] = []
    let y = startYear
    let m = startMonth
    // Iterera [startmånad .. innevarande månad] inklusive — den bakdaterade
    // aktiveringen kan ha missat även innevarande månad (cronen kördes innan
    // aktiveringen). @@unique + idempotens skyddar mot dubbletter.
    while (y < curYear || (y === curYear && m <= curMonth)) {
      const key = `${y}-${m}`
      if (!billed.has(key)) {
        const { proration, vatAmount, totalAmount } = this.avisering.computeRentNoticeAmounts(
          lease,
          y,
          m,
        )
        // Bara månader leasen faktiskt täcker (proration klipper mot start/slut).
        if (proration.daysCharged > 0) {
          const ageMonths = monthsBetween({ year: y, month: m }, { year: curYear, month: curMonth })
          months.push({
            year: y,
            month: m,
            periodStart: proration.periodStart,
            periodEnd: proration.periodEnd,
            daysCharged: proration.daysCharged,
            totalDays: proration.totalDays,
            isProrated: proration.isProrated,
            amount: proration.amount,
            vatAmount,
            totalAmount,
            ageMonths,
            status: this.classify(ageMonths, closedSet.has(key)),
          })
        }
      }
      m++
      if (m > 12) {
        m = 1
        y++
      }
    }
    return months
  }

  // Preskription + datafel-grind + stängd period → status. Ordning: hård
  // preskriptionsspärr FÖRST (får aldrig skapas oavsett annat), sedan stängd
  // period, sedan varnings-grind, annars debiterbar.
  private classify(ageMonths: number, isClosed: boolean): BackfillMonthStatus {
    // Dag-säker preskriptionsspärr (hyresjurist): monthsBetween räknar
    // kalendermånader, inte dagar. En fordran som är EXAKT 36 mån gammal i
    // månadsräkning kan dag-för-dag vara >3 år (Preskriptionslagen 2 § 2 st) →
    // blockera vid 36 OCH uppåt (>=), inte bara >36. Marginalen garanterar att
    // en potentiellt preskriberad fordran aldrig efterdebiteras.
    if (ageMonths >= BACKFILL_HARD_CAP_MONTHS) return 'BEYOND_HARD_CAP'
    if (isClosed) return 'CLOSED_PERIOD'
    if (ageMonths > BACKFILL_WARNING_MONTHS) return 'BEYOND_WARNING'
    return 'BILLABLE'
  }

  private summarize(months: BackfillMonthPreview[]): BackfillPreview['summary'] {
    const s = this.emptySummary()
    for (const m of months) {
      if (m.status === 'BILLABLE') {
        s.billableCount++
        s.billableTotal += m.totalAmount
      } else if (m.status === 'BEYOND_WARNING') {
        s.beyondWarningCount++
        s.beyondWarningTotal += m.totalAmount
      } else if (m.status === 'BEYOND_HARD_CAP') {
        s.hardCappedCount++
      } else if (m.status === 'CLOSED_PERIOD') {
        s.closedCount++
      }
    }
    return s
  }

  private emptySummary(): BackfillPreview['summary'] {
    return {
      billableCount: 0,
      billableTotal: 0,
      beyondWarningCount: 0,
      beyondWarningTotal: 0,
      hardCappedCount: 0,
      closedCount: 0,
    }
  }
}
