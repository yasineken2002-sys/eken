import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common'
import { Prisma, RentNoticeType, UserRole } from '@prisma/client'
import { PrismaService } from '../common/prisma/prisma.service'
import { vatPeriodLabelsForMonths } from '../avisering/vat-period.util'
import { getClosedPeriods, periodKeyOf, type PeriodKey } from './closed-period'
import { DEFAULT_VER_SERIES, VerifikationsnummerService } from './verifikationsnummer.service'

/**
 * Bokföringsperioder — stängning, förhandskontroll och översikt.
 *
 * VIKTIGT om ansvarsfördelningen (PR1a): den här tjänsten VERKSTÄLLER inget nytt
 * lås. Spärren som faktiskt hindrar en bokföring i en stängd period är och
 * förblir `VerifikationsnummerService.allocate` — den rörs inte. Tjänsten gör den
 * BEFINTLIGA `ClosedAccountingPeriod`-mekanismen nåbar utanför AI-assistenten,
 * och ger operatören ett besked om vad som är ofullständigt innan hen låser.
 *
 * Stängningen skriver samma rad som AI-verktyget `close_period` alltid gjort —
 * verktyget delegerar numera hit, så det finns EN stängningsväg och inte två som
 * kan glida isär.
 *
 * ÅTERÖPPNING ingår INTE här. Den kräver en append-only händelsemodell (annars
 * skrivs den ursprungliga stängningens ögonblicksbild över vid omstängning, och
 * en stängning/återöppning ÄR räkenskapsinformation som ska bevaras 7 år — BFL
 * 1 kap 2 § p.9 + 7 kap 2 §) samt en ändring av allocate. Det är PR1b.
 */

/** En upptäckt som förhandskontrollen gjorde inför en stängning. */
export interface PeriodCheck {
  /** Maskinläsbar kod, t.ex. 'unbalanced-entries'. */
  code: string
  /** 'blocking' = stängning nekas. 'warning' = operatören får avgöra. */
  severity: 'blocking' | 'warning'
  /** Människoläsbar sammanfattning på svenska. */
  message: string
  /** Antal berörda poster (0 när kontrollen inte är antalsbaserad). */
  count: number
}

export interface PeriodPrecheck {
  year: number
  month: number
  alreadyClosed: boolean
  /** Sant om ingen BLOCKERANDE upptäckt finns — varningar hindrar inte. */
  canClose: boolean
  checks: PeriodCheck[]
  /** Momsperioder månaden berör (org:ens redovisningsperiod). Tom om okänt. */
  vatPeriods: string[]
}

export interface PeriodOverviewItem {
  year: number
  month: number
  closed: boolean
  closedAt: Date | null
}

export interface PeriodOverview {
  items: PeriodOverviewItem[]
  /** Senast stängda perioden (högsta år/månad), eller null om ingen stängts. */
  lastClosed: PeriodKey | null
  /** Öppna perioder i intervallet, äldst först — det operatören ska agera på. */
  open: PeriodKey[]
}

const CLOSE_ROLES: UserRole[] = [UserRole.ACCOUNTANT, UserRole.ADMIN, UserRole.OWNER]

@Injectable()
export class AccountingPeriodService {
  private readonly logger = new Logger(AccountingPeriodService.name)

  constructor(private readonly prisma: PrismaService) {}

  // ── Översikt ───────────────────────────────────────────────────────────────
  /**
   * Perioder för de senaste `months` månaderna (inkl. innevarande), nyast först.
   * Passiv synlighet: hyresvärden ska kunna se "senast stängda: mars · öppna:
   * april, maj" utan att någon nagg-mekanism finns.
   */
  async getOverview(organizationId: string, months = 12): Promise<PeriodOverview> {
    const span = Math.min(Math.max(months, 1), 36)
    const now = new Date()
    const keys: PeriodKey[] = []
    let y = now.getUTCFullYear()
    let m = now.getUTCMonth() + 1
    for (let i = 0; i < span; i++) {
      keys.push({ year: y, month: m })
      m--
      if (m < 1) {
        m = 12
        y--
      }
    }

    const rows = await this.prisma.closedAccountingPeriod.findMany({
      where: { organizationId },
      select: { year: true, month: true, closedAt: true },
    })
    const closedByKey = new Map(rows.map((r) => [periodKeyOf(r), r.closedAt]))

    const items: PeriodOverviewItem[] = keys.map((k) => {
      const closedAt = closedByKey.get(periodKeyOf(k))
      return { year: k.year, month: k.month, closed: closedAt != null, closedAt: closedAt ?? null }
    })

    // Senast stängda = högsta år/månad bland ALLA stängda (inte bara i fönstret).
    const lastClosed = rows.reduce<PeriodKey | null>((best, r) => {
      if (!best) return { year: r.year, month: r.month }
      const isLater = r.year > best.year || (r.year === best.year && r.month > best.month)
      return isLater ? { year: r.year, month: r.month } : best
    }, null)

    const open = items
      .filter((i) => !i.closed)
      .map((i) => ({ year: i.year, month: i.month }))
      .reverse() // äldst först — den perioden är mest angelägen att stänga

    return { items, lastClosed, open }
  }

  // ── Förhandskontroll ───────────────────────────────────────────────────────
  /**
   * Vad ser ofullständigt ut i perioden? Kallas både av UI:t (för att visa
   * beskedet innan operatören låser) och av `closePeriod` (som grind).
   *
   * KALIBRERING (FAR): exakt EN kontroll blockerar — obalanserat verifikat. Det
   * är en objektiv korrekthetsfråga; att låsa perioden över ett känt obalanserat
   * verifikat är att lägga lock på ett fel i stället för att åtgärda det. Allt
   * annat är FULLSTÄNDIGHETS-bedömningar som en redovisningskonsult måste kunna
   * väga in och ändå stänga (t.ex. stänga tidigt av rapporteringsskäl medan
   * städning pågår).
   */
  async precheck(organizationId: string, year: number, month: number): Promise<PeriodPrecheck> {
    this.assertValidPeriod(year, month)
    const from = new Date(Date.UTC(year, month - 1, 1))
    const to = new Date(Date.UTC(year, month, 1))

    const closedSet = await getClosedPeriods(this.prisma, organizationId, [{ year, month }])
    const alreadyClosed = closedSet.has(periodKeyOf({ year, month }))

    const checks: PeriodCheck[] = []
    for (const check of [
      await this.checkUnbalancedEntries(organizationId, from, to),
      await this.checkNoticesWithoutEntry(organizationId, year, month),
      await this.checkInvoicesWithoutEntry(organizationId, from, to),
      await this.checkUnbilledLeases(organizationId, year, month),
      await this.checkUnmatchedBankTransactions(organizationId, from, to),
      await this.checkVerificationNumberGaps(organizationId, from),
    ]) {
      if (check) checks.push(check)
    }

    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { vatReportingPeriod: true, fiscalYearStartMonth: true },
    })
    // Återanvänder T1.4 PR3:s etikettering (#195) — bygger ingen egen.
    const vatPeriods = vatPeriodLabelsForMonths(
      [{ year, month }],
      org?.vatReportingPeriod ?? 'QUARTERLY',
      org?.fiscalYearStartMonth ?? 1,
    )
    if (vatPeriods.length > 0 && (org?.vatReportingPeriod ?? 'QUARTERLY') !== 'MONTHLY') {
      checks.push({
        code: 'vat-period-spans-months',
        severity: 'warning',
        message:
          `Månaden ingår i momsperioden ${vatPeriods.join(', ')}, som omfattar fler månader. ` +
          'Kontrollera att hela perioden är avstämd innan du förlitar dig på att den är ' +
          'komplett för momsändamål.',
        count: 0,
      })
    }

    return {
      year,
      month,
      alreadyClosed,
      canClose: !alreadyClosed && !checks.some((c) => c.severity === 'blocking'),
      checks,
      vatPeriods,
    }
  }

  // ── Stängning ──────────────────────────────────────────────────────────────
  /**
   * Stänger perioden. Samma skrivning mot `ClosedAccountingPeriod` som tidigare
   * bara gick att nå via AI-verktyget — ingen ny mekanism.
   *
   * Rollgrinden ligger HÄR (chokepunkten), inte bara i controllern, så att även
   * AI-vägen och framtida interna anropare grindas. Fail-closed: okänd/saknad
   * roll nekas.
   */
  async closePeriod(
    organizationId: string,
    year: number,
    month: number,
    opts: { actorRole?: UserRole; actorUserId?: string | null },
  ): Promise<{ year: number; month: number; summary: PeriodSummary; checks: PeriodCheck[] }> {
    if (!opts.actorRole || !CLOSE_ROLES.includes(opts.actorRole)) {
      throw new ForbiddenException('Du saknar behörighet att stänga en bokföringsperiod')
    }
    this.assertValidPeriod(year, month)

    const pre = await this.precheck(organizationId, year, month)
    if (pre.alreadyClosed) {
      throw new ConflictException(`Perioden ${periodKeyOf({ year, month })} är redan stängd.`)
    }
    const blocking = pre.checks.filter((c) => c.severity === 'blocking')
    if (blocking.length > 0) {
      throw new ConflictException(
        `Perioden kan inte stängas: ${blocking.map((b) => b.message).join(' ')}`,
      )
    }

    const summary = await this.buildSummary(organizationId, year, month)

    // Skrivningen är oförändrad mot AI-verktygets: en rad per period, med
    // resultat-ögonblicksbild. summary är just en ÖGONBLICKSBILD vid
    // stängningstillfället och räknas aldrig om i efterhand (FAR: att uppdatera
    // den retroaktivt vore att påstå att den som stängde såg siffror hen aldrig
    // såg). Vid återöppning + omstängning behövs därför en händelselogg — PR1b.
    try {
      await this.prisma.closedAccountingPeriod.create({
        data: {
          organizationId,
          year,
          month,
          ...(opts.actorUserId ? { closedById: opts.actorUserId } : {}),
          summary: summary as unknown as Prisma.InputJsonValue,
        },
      })
    } catch (err) {
      // Två samtidiga stängningar av samma period: unikt index (org, år, månad).
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException(`Perioden ${periodKeyOf({ year, month })} är redan stängd.`)
      }
      throw err
    }

    this.logger.log(
      `[period] ${periodKeyOf({ year, month })} stängd för org ${organizationId} ` +
        `(${summary.entriesCount} verifikat, resultat ${summary.result})`,
    )

    return { year, month, summary, checks: pre.checks }
  }

  // ── Kontrollerna ───────────────────────────────────────────────────────────

  /**
   * HÅRD SPÄRR: verifikat där debet ≠ kredit. Ska vara strukturellt omöjligt
   * (C1-balansgrinden i createNumberedEntry), men om det ändå finns — datafel,
   * migrerad historik, manuellt DB-ingrepp — får perioden inte låsas över det.
   */
  private async checkUnbalancedEntries(
    organizationId: string,
    from: Date,
    to: Date,
  ): Promise<PeriodCheck | null> {
    const rows = await this.prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::bigint AS count FROM (
        SELECT jel."journalEntryId"
        FROM "JournalEntryLine" jel
        JOIN "JournalEntry" je ON je.id = jel."journalEntryId"
        WHERE je."organizationId" = ${organizationId}
          AND je.date >= ${from} AND je.date < ${to}
        GROUP BY jel."journalEntryId"
        HAVING COALESCE(SUM(jel.debit), 0) <> COALESCE(SUM(jel.credit), 0)
      ) unbalanced
    `
    const count = Number(rows[0]?.count ?? 0)
    if (count === 0) return null
    return {
      code: 'unbalanced-entries',
      severity: 'blocking',
      message: `${count} verifikat i perioden balanserar inte (debet ≠ kredit). Rätta dem innan perioden stängs.`,
      count,
    }
  }

  /** Hyresavier i perioden som saknar sitt intäktsverifikat (A0-konventionen). */
  private async checkNoticesWithoutEntry(
    organizationId: string,
    year: number,
    month: number,
  ): Promise<PeriodCheck | null> {
    const notices = await this.prisma.rentNotice.findMany({
      where: { organizationId, year, month, type: RentNoticeType.RENT },
      select: { id: true },
    })
    if (notices.length === 0) return null
    // Accrual-nyckeln är source='INVOICE' + sourceId='rent-notice:<id>'
    // (konvention fastställd i T5 A0-auditen — INTE source='RENT_NOTICE').
    const booked = await this.prisma.journalEntry.findMany({
      where: {
        organizationId,
        sourceId: { in: notices.map((n) => `rent-notice:${n.id}`) },
      },
      select: { sourceId: true },
    })
    const bookedIds = new Set(booked.map((b) => b.sourceId))
    const missing = notices.filter((n) => !bookedIds.has(`rent-notice:${n.id}`)).length
    if (missing === 0) return null
    return {
      code: 'notices-without-entry',
      severity: 'warning',
      message: `${missing} hyresavi(er) i perioden saknar intäktsverifikat.`,
      count: missing,
    }
  }

  /** Fakturor i perioden utan verifikat — samma princip på fakturasidan. */
  private async checkInvoicesWithoutEntry(
    organizationId: string,
    from: Date,
    to: Date,
  ): Promise<PeriodCheck | null> {
    const invoices = await this.prisma.invoice.findMany({
      where: { organizationId, issueDate: { gte: from, lt: to }, status: { not: 'DRAFT' } },
      select: { id: true },
    })
    if (invoices.length === 0) return null
    const booked = await this.prisma.journalEntry.findMany({
      where: { organizationId, sourceId: { in: invoices.map((i) => i.id) } },
      select: { sourceId: true },
    })
    const bookedIds = new Set(booked.map((b) => b.sourceId))
    const missing = invoices.filter((i) => !bookedIds.has(i.id)).length
    if (missing === 0) return null
    return {
      code: 'invoices-without-entry',
      severity: 'warning',
      message: `${missing} faktura(or) i perioden saknar verifikat.`,
      count: missing,
    }
  }

  /** Aktiva kontrakt som saknar hyresavi för månaden (oaviserat). */
  private async checkUnbilledLeases(
    organizationId: string,
    year: number,
    month: number,
  ): Promise<PeriodCheck | null> {
    const monthStart = new Date(Date.UTC(year, month - 1, 1))
    const monthEnd = new Date(Date.UTC(year, month, 0))
    const leases = await this.prisma.lease.findMany({
      where: {
        organizationId,
        status: 'ACTIVE',
        startDate: { lte: monthEnd },
        OR: [{ endDate: null }, { endDate: { gte: monthStart } }],
      },
      select: { id: true },
    })
    if (leases.length === 0) return null
    const billed = await this.prisma.rentNotice.findMany({
      where: {
        organizationId,
        year,
        month,
        type: RentNoticeType.RENT,
        leaseId: { in: leases.map((l) => l.id) },
      },
      select: { leaseId: true },
    })
    const billedIds = new Set(billed.map((b) => b.leaseId))
    const missing = leases.filter((l) => !billedIds.has(l.id)).length
    if (missing === 0) return null
    return {
      code: 'unbilled-leases',
      severity: 'warning',
      message: `${missing} aktivt kontrakt saknar hyresavi för månaden.`,
      count: missing,
    }
  }

  /** Omatchade banktransaktioner i perioden = möjliga obokförda affärshändelser. */
  private async checkUnmatchedBankTransactions(
    organizationId: string,
    from: Date,
    to: Date,
  ): Promise<PeriodCheck | null> {
    const count = await this.prisma.bankTransaction.count({
      where: { organizationId, date: { gte: from, lt: to }, status: 'UNMATCHED' },
    })
    if (count === 0) return null
    return {
      code: 'unmatched-bank-transactions',
      severity: 'warning',
      message: `${count} banktransaktion(er) i perioden är omatchade — de kan dölja obokförda affärshändelser.`,
      count,
    }
  }

  /**
   * Sanity-check på verifikationsnummer-serien för räkenskapsåret perioden
   * tillhör. Ska aldrig slå (allocate ger en obruten serie), men en lucka vore
   * ett BFL 5:6-problem och är billig att titta efter innan låsning.
   */
  private async checkVerificationNumberGaps(
    organizationId: string,
    periodStart: Date,
  ): Promise<PeriodCheck | null> {
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { fiscalYearStartMonth: true },
    })
    const fiscalYear = VerifikationsnummerService.fiscalYearFor(
      periodStart,
      org?.fiscalYearStartMonth ?? 1,
    )
    const entries = await this.prisma.journalEntry.findMany({
      where: { organizationId, fiscalYear, series: DEFAULT_VER_SERIES },
      select: { verNumber: true },
    })
    if (entries.length === 0) return null
    const numbers = entries
      .map((e) => e.verNumber)
      .filter((n): n is number => typeof n === 'number')
      .sort((a, b) => a - b)
    const expected = numbers[numbers.length - 1]! - numbers[0]! + 1
    const gaps = expected - numbers.length
    if (gaps <= 0) return null
    return {
      code: 'verification-number-gaps',
      severity: 'warning',
      message: `Verifikationsserien för räkenskapsåret ${fiscalYear} har ${gaps} lucka/luckor (BFL 5 kap 6 § kräver obruten nummerföljd).`,
      count: gaps,
    }
  }

  // ── Sammanfattning (ögonblicksbild vid stängning) ──────────────────────────
  private async buildSummary(
    organizationId: string,
    year: number,
    month: number,
  ): Promise<PeriodSummary> {
    const from = new Date(Date.UTC(year, month - 1, 1))
    const to = new Date(Date.UTC(year, month, 1))
    const lines = await this.prisma.journalEntryLine.findMany({
      where: { journalEntry: { organizationId, date: { gte: from, lt: to } } },
      include: { account: true },
    })
    let revenue = 0
    let expenses = 0
    for (const l of lines) {
      const num = l.account.number
      const debit = Number(l.debit ?? 0)
      const credit = Number(l.credit ?? 0)
      if (num >= 3000 && num < 4000) revenue += credit - debit
      else if (num >= 5000 && num < 9000) expenses += debit - credit
    }
    return {
      month,
      year,
      revenue,
      expenses,
      result: revenue - expenses,
      entriesCount: new Set(lines.map((l) => l.journalEntryId)).size,
      generatedAt: new Date().toISOString(),
    }
  }

  private assertValidPeriod(year: number, month: number): void {
    if (!Number.isInteger(month) || month < 1 || month > 12) {
      throw new BadRequestException('Månad måste vara 1–12')
    }
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      throw new BadRequestException('Ogiltigt år')
    }
  }
}

/** Resultat-ögonblicksbild som sparas på den stängda perioden. */
export interface PeriodSummary {
  month: number
  year: number
  revenue: number
  expenses: number
  result: number
  entriesCount: number
  generatedAt: string
}
