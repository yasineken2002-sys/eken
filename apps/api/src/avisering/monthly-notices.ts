import type { Logger } from '@nestjs/common'
import { Prisma, RentNoticeStatus, RentNoticeType } from '@prisma/client'
import type { PrismaClient, RentNotice, UnitType } from '@prisma/client'
import {
  calculateProratedRent,
  rentDueDateForMonth,
  swedishDateKey,
  vatRateForRent,
  type GenerateNoticesPreview,
} from '@eken/shared'
import type { AccountingService } from '../accounting/accounting.service'
import type { OcrService } from '../common/ocr/ocr.service'
import { PRISMA_DEFAULT_TX_LIMITS } from '../common/prisma/transaction-limits'
import type { ConsumptionService } from '../consumption/consumption.service'
import { foreBrytdatumSkal, periodForeBrytdatum } from '../kundstart/cutover'
import {
  assertNoIncompleteOpening,
  IncompleteOpeningException,
  INCOMPLETE_OPENING_REASON,
} from '../kundstart/incomplete-opening'
import type { MiscChargeService } from '../misc-charges/misc-charge.service'
import { SAFE_TENANT_SELECT } from '../tenants/safe-tenant-select'
import { allocateRentNoticeNumber } from './rent-notice-number'
import { rentNoticePeriodDate } from './rent-notice-period-date'

/** Konkreta befintliga instanser; ingen ny DI-provider eller transaktionsadapter. */
export interface MonthlyNoticeDependencies {
  prisma: Pick<PrismaClient, 'organization' | 'lease' | 'rentNotice' | '$transaction'>
  ocrService: Pick<OcrService, 'assignOcrToTenant'>
  accounting: Pick<AccountingService, 'createJournalEntryForRentNotice'>
  consumption: Pick<ConsumptionService, 'attachRentNoticeLineCharges'>
  miscCharges: Pick<MiscChargeService, 'attachMiscChargesToRentNotice'>
  logger: Pick<Logger, 'warn' | 'error'>
}

export type RentNoticeRevenueInput = {
  id: string
  noticeNumber: string
  leaseId: string
  type: RentNoticeType
  amount: Prisma.Decimal | number
  vatAmount: Prisma.Decimal | number
  totalAmount: Prisma.Decimal | number
  year: number
  month: number
}

/** Samma momsregel för månadsavi, initialavi och backfill. Loggerinstansen ägs av anroparen. */
export function calculateRentNoticeVat(
  logger: Pick<Logger, 'warn'>,
  net: number,
  unit: { type: UnitType; voluntaryTaxLiability: boolean },
  lease: { monthlyRentExcludingVat: boolean },
  context?: string,
): { vatAmount: number; totalAmount: number } {
  const rate = vatRateForRent(unit.type, unit.voluntaryTaxLiability)
  if (rate === 0) return { vatAmount: 0, totalAmount: net }
  if (!lease.monthlyRentExcludingVat) {
    logger.warn(
      `[Moms] Enhet ${unit.type} är momspliktig men hyran är inte markerad som ` +
        `exkl. moms — moms läggs ej på${context ? ` (${context})` : ''}. ` +
        `Kontrollera kontraktsregistreringen.`,
    )
    return { vatAmount: 0, totalAmount: net }
  }
  const vatAmount = Math.round(net * rate) / 100
  return { vatAmount, totalAmount: net + vatAmount }
}

/** Med tx bubblar felet; utan tx behålls befintlig best-effort-policy med loggning. */
export async function bookRentNoticeRevenue(
  accounting: MonthlyNoticeDependencies['accounting'],
  logger: Pick<Logger, 'error'>,
  orgId: string,
  notice: RentNoticeRevenueInput,
  tx?: Prisma.TransactionClient,
): Promise<void> {
  if (notice.type === RentNoticeType.DEPOSIT) return
  try {
    await accounting.createJournalEntryForRentNotice(notice, orgId, null, tx)
  } catch (err) {
    // Atomiskt läge (tx angiven): låt felet fälla den yttre transaktionen så
    // ingen avi lämnas utan verifikat.
    if (tx) throw err
    logger.error(
      `[Avisering] Bokföring av hyresavi ${notice.noticeNumber} misslyckades: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
  }
}

async function monthlyNoticePlan(
  prisma: MonthlyNoticeDependencies['prisma'],
  orgId: string,
  month: number,
  year: number,
) {
  // KUNDSTART-001 (C1/G-C1–C3): brytdatum är EN serverregel för cron, HTTP, AI och
  // förhandsvisning — de går alla genom den här planen. En period före brytdatum är
  // fakturerad i tidigare system: inga kandidater, befintliga dokument orörda.
  const orgCutover = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { billingCutoverDate: true },
  })
  const cutover = orgCutover?.billingCutoverDate ?? null
  // En period före brytdatum ger inga kandidater (befintliga dokument rörs inte).
  const foreBryt = periodForeBrytdatum(cutover, year, month)
  const genMonthStart = new Date(year, month - 1, 1)
  const leases = await prisma.lease.findMany({
    where: {
      organizationId: orgId,
      // KUNDSTART: före brytdatum väljs inga avtal alls.
      ...(foreBryt ? { id: { in: [] } } : {}),
      OR: [
        { status: 'ACTIVE' },
        // T1.3: ett EXPIRED avtal som fortfarande täcker dagar i månaden
        // måste få sin sista (prorata-)avi. EXPIRED sätts ENBART av
        // succession (ACTIVE→EXPIRED, statusmaskinen #60) — flippas
        // förnyelsen FÖRE månadsgenereringen tappades annars dagarna
        // 1..gamla endDate tyst (ingen avi, ingen intäkt). Proration
        // klipper mot endDate; nya avtalets avi börjar endDate+1 →
        // glappfritt utan överlapp. TERMINATED ingår INTE: den statusen
        // rymmer även avbrutna utkast som aldrig varit i kraft.
        { status: 'EXPIRED', endDate: { gte: genMonthStart } },
      ],
    },
    include: {
      tenant: { select: SAFE_TENANT_SELECT },
      unit: { include: { property: true } },
    },
  })

  // Idempotens på (lease, year, month, type=RENT) — generering kan köras
  // om utan att dubbla avier skapas (cron-retry, manuell knapptryckning).
  const existing = await prisma.rentNotice.findMany({
    where: { organizationId: orgId, month, year, type: RentNoticeType.RENT },
    select: { leaseId: true, dueDate: true },
  })
  const existingLeaseIds = new Set(existing.map((n) => n.leaseId))

  let skipped = 0
  const candidates: {
    lease: (typeof leases)[number]
    proration: ReturnType<typeof calculateProratedRent>
    dueDate: Date
  }[] = []

  for (const lease of foreBryt ? [] : leases) {
    if (existingLeaseIds.has(lease.id)) {
      skipped++
      continue
    }

    // Kontrakt som inte täcker någon dag i månaden hoppas över. Proration
    // tar hand om delmånader (in-/utflyttning).
    const monthEnd = new Date(year, month, 0)
    const monthStart = new Date(year, month - 1, 1)
    if (lease.startDate > monthEnd) {
      skipped++
      continue
    }
    if (lease.endDate && lease.endDate < monthStart) {
      skipped++
      continue
    }

    const proration = calculateProratedRent({
      monthlyRent: Number(lease.monthlyRent),
      year,
      month,
      leaseStart: lease.startDate,
      leaseEnd: lease.endDate,
    })

    if (proration.daysCharged <= 0) {
      skipped++
      continue
    }

    // Samma befintliga genereringsregel: sista vardagen före hyresmånaden.
    candidates.push({ lease, proration, dueDate: rentDueDateForMonth(year, month) })
  }
  return {
    candidates,
    skipped,
    existing,
    beforeCutover: foreBryt ? foreBrytdatumSkal(cutover!) : null,
  }
}

/** Läsande förhandsbesked: samma urval, proration och datum som skrivvägen. */
export async function previewMonthlyNotices(
  prisma: MonthlyNoticeDependencies['prisma'],
  orgId: string,
  month: number,
  year: number,
): Promise<GenerateNoticesPreview> {
  const plan = await monthlyNoticePlan(prisma, orgId, month, year)
  const groupDates = (rows: { dueDate: Date }[]) => {
    const counts = new Map<string, number>()
    for (const row of rows) {
      const key = swedishDateKey(row.dueDate)
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    return [...counts]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([dueDate, count]) => ({ dueDate, count }))
  }
  return {
    month,
    year,
    toCreate: plan.candidates.length,
    skipped: plan.skipped,
    dueDates: groupDates(plan.candidates),
    existingDueDates: groupDates(plan.existing),
    beforeCutover: plan.beforeCutover,
  }
}

export async function generateMonthlyNotices(
  dependencies: MonthlyNoticeDependencies,
  orgId: string,
  month: number,
  year: number,
) {
  const { prisma, ocrService, accounting, consumption, miscCharges, logger } = dependencies
  const { candidates, skipped, beforeCutover } = await monthlyNoticePlan(prisma, orgId, month, year)
  let created = 0
  // Varje avtal behåller sin egen atomiska avi + intäktsverifikation.
  let failed = 0
  let blockedByOpening = 0
  const notices: RentNotice[] = []
  for (const { lease, proration, dueDate } of candidates) {
    let notice: RentNotice
    try {
      const ocrNumber = await ocrService.assignOcrToTenant(lease.tenantId, orgId)
      // Moms enligt upplåtelsetyp (ML 10 kap. 35 § / 9 kap). Bostad → 0.
      const { vatAmount, totalAmount } = calculateRentNoticeVat(
        logger,
        proration.amount,
        lease.unit,
        lease,
        `avi ${lease.id}`,
      )

      // T5 A1 (BFL 5:6): avi + intäktsverifikat i EN transaktion — antingen båda
      // eller ingendera. Kastar bokföringen (stängd period/DB-fel) rullas avin
      // tillbaka (ingen orphan).
      //
      // Avinumret allokeras INUTI tx:en — inte av bekvämlighet utan för att
      // sekvensradens lås ska serialisera samtidiga genereringar. En rollback
      // rullar tillbaka även ökningen, så inga nummer läcker (mätt mot riktig
      // Postgres — se rent-notice-number.ts).
      notice = await prisma.$transaction(async (tx) => {
        await assertNoIncompleteOpening(tx, orgId)
        const noticeNumber = await allocateRentNoticeNumber(tx, orgId, year, month)
        const n = (await tx.rentNotice.create({
          data: {
            organizationId: orgId,
            tenantId: lease.tenantId,
            leaseId: lease.id,
            noticeNumber,
            ocrNumber,
            month,
            year,
            amount: proration.amount,
            vatAmount,
            totalAmount,
            dueDate,
            status: RentNoticeStatus.PENDING,
            type: RentNoticeType.RENT,
            periodStart: rentNoticePeriodDate(proration.periodStart),
            periodEnd: rentNoticePeriodDate(proration.periodEnd),
            daysCharged: proration.daysCharged,
            totalDays: proration.totalDays,
            isProrated: proration.isProrated,
          },
          include: {
            tenant: { select: SAFE_TENANT_SELECT },
            lease: { include: { unit: { include: { property: true } } } },
          },
        })) as unknown as RentNotice
        // Intäktsverifikation (BFL): 1510 D / 39xx K. Kastar → rullar tillbaka
        // avin. Returnerar null (org saknar kontoplan) → ingen bokföring, ingen
        // rollback (orgen bokför inte alls — utanför A1/audit-scope).
        await bookRentNoticeRevenue(accounting, logger, orgId, n, tx)
        return n
      }, PRISMA_DEFAULT_TX_LIMITS)
    } catch (err) {
      if (err instanceof IncompleteOpeningException) {
        blockedByOpening++
        continue
      }
      // Per-lease-isolering: logga + räkna + fortsätt. Ingen orphan (avin +
      // verifikat rullades tillbaka atomiskt). Avin fångas nästa körning
      // (idempotens) eller via T1.4-backfillen.
      failed++
      logger.error(
        `[Avisering] Avi för lease ${lease.id} (org ${orgId}) misslyckades — hoppar, ` +
          `övriga leases fortsätter: ${err instanceof Error ? err.message : String(err)}`,
      )
      continue
    }

    // IMD (PR 4): koppla lease:ens redan bokförda förbruknings-charges som
    // avi-rader (2-mån-lag). Sätter RentNotice.consumptionAmount; förbrukningen
    // ingår i betalbar total/OCR men har sitt EGNA verifikat (PR 3) — ingen
    // dubbelbokning här. Presentation, ej bokföring.
    try {
      const consumptionAmount = await consumption.attachRentNoticeLineCharges({
        organizationId: orgId,
        leaseId: lease.id,
        rentNoticeId: notice.id,
        aviMonth: month,
        aviYear: year,
      })
      if (consumptionAmount > 0) notice.consumptionAmount = new Prisma.Decimal(consumptionAmount)
    } catch (err) {
      // Misslyckad koppling får inte fälla avi-genereringen — avin (hyra) är
      // skapad och bokförd; charges förblir CONFIRMED och fångas nästa månad.
      logger.error(
        `[Avisering] Koppling av förbrukning till avi ${notice.noticeNumber} misslyckades: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }

    // Teknisk förvaltning (Spår A PR 4b): koppla lease:ens redan bokförda
    // CONFIRMED MiscCharges (skada/nyckel) som avi-rader. Sätter
    // RentNotice.miscChargeAmount; ingår i betalbar total/OCR/skuld men har sitt
    // EGNA verifikat (1510 D / 3990 K). Presentation, ej bokföring — samma
    // best-effort-isolering som förbrukningen ovan.
    try {
      const miscChargeAmount = await miscCharges.attachMiscChargesToRentNotice({
        organizationId: orgId,
        leaseId: lease.id,
        rentNoticeId: notice.id,
      })
      if (miscChargeAmount > 0) notice.miscChargeAmount = new Prisma.Decimal(miscChargeAmount)
    } catch (err) {
      logger.error(
        `[Avisering] Koppling av övriga debiteringar till avi ${notice.noticeNumber} misslyckades: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }

    notices.push(notice as unknown as RentNotice)
    created++
  }

  return {
    created,
    skipped,
    failed,
    notices,
    beforeCutover,
    blockedByOpening,
    blockedReason: blockedByOpening > 0 ? INCOMPLETE_OPENING_REASON : null,
  }
}
