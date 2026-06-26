import { Injectable, Logger, InternalServerErrorException } from '@nestjs/common'
import { Prisma, RentNoticeType } from '@prisma/client'
import { PrismaService } from '../common/prisma/prisma.service'
import { AccountingService } from '../accounting/accounting.service'
import { RentNoticeEventsService } from './rent-notice-events.service'

// Dröjsmålsränta = referensränta + 8 procentenheter (räntelagen 1975:635 6 §).
// 8 är en LAGKONSTANT; referensräntan läses dynamiskt ur ReferenceInterestRate.
const INTEREST_RATE_ADDITION_PP = 8
// Räntelagen räknar dröjsmålsränta på årsbasis; vi proraterar per dag på 365.
const DAYS_PER_YEAR = 365
const DAY_MS = 24 * 60 * 60 * 1000

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10)
}

// En delperiod av dröjsmålet som ligger HELT inom ett kalenderhalvår och därför
// bär en enda referensränta (räntelagen 9 §). Lagras i INTEREST_ACCRUED-eventet
// så PR 4:s inkasso-export kan specificera hur räntan räknats per halvår.
interface InterestSegment {
  from: string // YYYY-MM-DD, första räntedagen i segmentet
  to: string // YYYY-MM-DD, sista räntedagen i segmentet
  days: number
  referenceRatePercent: number
  effectiveRatePercent: number
  // Segmentets ränta i öresavrundad form. Öresavrundningens rest läggs på det
  // SISTA segmentet så att Σ segment.amount === interestTotal exakt — en
  // specificerad räntekalkyl (PR 4b) summerar därmed alltid till det bokförda
  // beloppet (ingen 1-öresdrift mellan specifikation och verifikat/1510-fordran).
  amount: number
}

interface CrystallizeResult {
  delta: number
  total: number
  // Dagviktad effektiv ränta över hela dröjsmålet (= segmentets ränta när
  // dröjsmålet ligger inom ETT halvår). Behålls som skalär för bakåtkompat.
  effectiveRatePercent: number
  days: number
  segments: InterestSegment[]
}

/**
 * Inkasso PR 3 — dröjsmålsränta på obetalda hyresavier.
 *
 * Räntan löper från dagen EFTER förfallodagen och beräknas på det obetalda
 * KAPITALET (hyra + förbrukning) med referensräntan + 8 procentenheter. Den
 * kristalliseras (bokförs) vid bestämda punkter — vid påminnelse (PR 3) och vid
 * inkasso-ready (PR 4) — inte som ett dagligt verifikat-regn. Bokförs 1510 D /
 * 8131 K (finansiell intäkt, INTE 3593).
 *
 * Inkasso PR 4a — PERIOD-UPPDELAD ränta vid halvårsskifte. Dröjsmålsperioden
 * segmenteras vid kalenderhalvårens gränser (1 jan / 1 jul) och varje segment
 * bär SITT halvårs referensränta (räntelagen 6 § "den vid varje tid gällande
 * referensräntan", 9 § "fastställd halvårsvis"). Ett dröjsmål som löper över ett
 * halvårsskifte får alltså aldrig en enda ränta ankrad på förfallodagen — ett
 * specificerat räntekrav som exporteras (PR 4b) ska vara period-korrekt och
 * därmed svårt att angripa.
 */
@Injectable()
export class RentInterestService {
  private readonly logger = new Logger(RentInterestService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly accounting: AccountingService,
    private readonly rentNoticeEvents: RentNoticeEventsService,
  ) {}

  /**
   * Kristalliserar upplupen dröjsmålsränta t.o.m. `throughDate` och bokför det
   * INKREMENTELLA beloppet (delta mot redan bokförd ränta) 1510 D / 8131 K.
   *
   * INV-A: räntemarkeringen (interestAccruedAmount/Through) och verifikatet skapas
   * i SAMMA transaktion. Faller bokföringen kastas felet → allt rullas tillbaka.
   *
   * Idempotent per kristalliseringspunkt via sourceId='interest:{id}:{YYYY-MM-DD}'
   * + delta-kontrollen (en ny kristallisering samma dag ger delta 0 → skip). En
   * senare punkt (inkasso-ready) bokför bara räntan som löpt SEDAN förra punkten —
   * en ren framåtkorrigering, ingen ombokning av historik (append-only, BFL).
   *
   * Returnerar null om inget bokfördes (betald/avbruten avi, ingen referensränta
   * för NÅGOT segment, 0 dagar, eller inget nytt delta).
   */
  async crystallizeInterest(
    noticeId: string,
    organizationId: string,
    throughDate: Date,
  ): Promise<CrystallizeResult | null> {
    return this.prisma.$transaction(async (tx) => {
      const notice = await tx.rentNotice.findFirst({
        where: { id: noticeId, organizationId },
      })
      if (!notice) return null
      // Dröjsmålsränta löper bara på obetald hyra. Deposition har eget flöde.
      if (notice.type !== RentNoticeType.RENT) return null
      if (notice.status === 'PAID' || notice.status === 'CANCELLED') return null

      // Från dagen EFTER förfallodagen → antal hela dagar sedan förfall.
      const days = this.daysBetween(notice.dueDate, throughDate)
      if (days <= 0) return null

      // Beräkningsbas = obetalt KAPITAL (hyra + förbrukning). Aldrig ränta på
      // ränta, aldrig ränta på påminnelseavgiften (3593).
      // TODO (PR 4b-spärr): ska miscChargeAmount (skada/nyckel) ingå i räntebasen?
      // En skadefordran ÄR kapital (som förbrukning) → logiskt ja, men det är ett
      // bokförings-/juridikbeslut som bokförings-experten avgör SEPARAT. Lämnas
      // MEDVETET utanför basen i 4b tills beslut tagits — skadedelen undercountar
      // då räntan, vilket är säkrare än ränta på en oavgjord grund.
      const base = Number(notice.totalAmount) + Number(notice.consumptionAmount)

      // Segmentera dröjsmålet [förfallodag+1, förfallodag+days] vid halvårs-
      // gränserna. Varje segment ligger helt inom ETT halvår och slås upp mot
      // SITT halvårs referensränta (raden vars effectiveFrom ≤ segmentets start).
      // Räknat på kalenderdatum förankrade i förfallodagen (UTC-midnatt) så
      // segmentens dagar alltid summerar till `days`, oberoende av throughDates
      // klockslag.
      const dueMid = utcMidnight(notice.dueDate)
      const periodStart = addDays(dueMid, 1)
      const periodEnd = addDays(dueMid, days)
      const ranges = halfYearRanges(periodStart, periodEnd)

      let rawTotal = 0
      let weightedRefNum = 0
      let weightedEffNum = 0
      const segments: InterestSegment[] = []
      for (const range of ranges) {
        // Referensräntan för DET halvår segmentet ligger i. Ankras på segmentets
        // start (referensräntan ändras bara vid halvårsgränser, så ankaret pekar
        // alltid ut rätt halvårs rad). Saknas raden kan räntan för segmentet inte
        // beräknas → bokför ingen gissad ränta för HELA kravet (ett delvis
        // räntekrav är angripbart). Samma konservativa hållning som PR 3.
        const referenceRate = await this.referenceRatePercentFor(range.start, tx)
        if (referenceRate == null) {
          this.logger.warn(
            `Ingen referensränta gäller för delperioden ${ymd(range.start)}–${ymd(range.end)} ` +
              `— dröjsmålsränta beräknades inte för avi ${noticeId}`,
          )
          return null
        }
        const effectiveRatePercent = referenceRate + INTEREST_RATE_ADDITION_PP
        const rawAmount = base * (effectiveRatePercent / 100) * (range.days / DAYS_PER_YEAR)
        rawTotal += rawAmount
        weightedRefNum += referenceRate * range.days
        weightedEffNum += effectiveRatePercent * range.days
        segments.push({
          from: ymd(range.start),
          to: ymd(range.end),
          days: range.days,
          referenceRatePercent: referenceRate,
          effectiveRatePercent,
          amount: round2(rawAmount),
        })
      }

      // En enda avrundning på den råa summan. För ett dröjsmål inom ETT halvår
      // (ett segment) är detta IDENTISKT med PR 3 → ingen spuriös delta uppstår
      // när räntan inte ändrats. Beloppet ändras bara när en halvårsränta faktiskt
      // skiljer sig över gränsen — exakt den lagstadgade skillnaden.
      const totalInterest = round2(rawTotal)
      const effectiveRatePercent = round2(weightedEffNum / days)
      const referenceRatePercent = round2(weightedRefNum / days)

      // Lägg öresavrundningens rest på sista segmentet → Σ segment.amount blir
      // EXAKT totalInterest. Då kan PR 4b:s export summera segmenten utan att
      // hamna 1 öre fel mot det bokförda beloppet/1510-fordran. För ETT segment
      // är restjusteringen identitet (amount = total).
      if (segments.length > 0) {
        let allocated = 0
        for (let i = 0; i < segments.length - 1; i++) {
          allocated = round2(allocated + segments[i]!.amount)
        }
        segments[segments.length - 1]!.amount = round2(totalInterest - allocated)
      }

      const alreadyBooked = Number(notice.interestAccruedAmount)
      const delta = round2(totalInterest - alreadyBooked)
      if (delta <= 0) return null

      const throughKey = ymd(throughDate)
      const sourceId = `interest:${noticeId}:${throughKey}`

      // Idempotens per kristalliseringspunkt (utöver delta-kontrollen ovan).
      const existing = await tx.journalEntry.findFirst({
        where: { organizationId, source: 'RENT_NOTICE', sourceId },
        select: { id: true },
      })
      if (existing) return null

      const entry = await this.accounting.bookInterest({
        organizationId,
        source: 'RENT_NOTICE',
        sourceId,
        amount: delta,
        date: throughDate,
        description: `Dröjsmålsränta hyresavi ${notice.noticeNumber} t.o.m. ${throughKey}`,
        tx,
      })
      // null = saknat 1510/8131 → bokföring omöjlig. INV-A: kasta så hela
      // transaktionen (inkl. räntemarkeringen) rullas tillbaka.
      if (!entry) {
        throw new InternalServerErrorException(
          `Dröjsmålsränta kunde inte bokföras för avi ${noticeId} — ` +
            'kontrollera att kontoplanen innehåller konto 1510 och 8131.',
        )
      }

      await tx.rentNotice.update({
        where: { id: noticeId },
        data: {
          interestAccruedAmount: new Prisma.Decimal(totalInterest.toFixed(2)),
          interestAccruedThrough: throughDate,
        },
      })

      await this.rentNoticeEvents.record(
        noticeId,
        'INTEREST_ACCRUED',
        'SYSTEM',
        null,
        {
          throughDate: throughKey,
          referenceRatePercent,
          effectiveRatePercent,
          days,
          base,
          interestDelta: delta,
          interestTotal: totalInterest,
          // Period-uppdelningen (räntelagen 9 §) — PR 4b:s export specificerar
          // räntan per halvår utifrån denna.
          segments,
          journalEntryId: entry.id,
        },
        { tx },
      )

      return { delta, total: totalInterest, effectiveRatePercent, days, segments }
    })
  }

  /**
   * Referensräntan (%) som gäller för ett givet datum — den senaste raden vars
   * effectiveFrom ≤ datumet. Halvårsskifte = ny rad, ingen deploy.
   */
  private async referenceRatePercentFor(
    anchorDate: Date,
    tx: Prisma.TransactionClient,
  ): Promise<number | null> {
    const row = await tx.referenceInterestRate.findFirst({
      where: { effectiveFrom: { lte: anchorDate } },
      orderBy: { effectiveFrom: 'desc' },
      select: { ratePercent: true },
    })
    return row ? Number(row.ratePercent) : null
  }

  private daysBetween(from: Date, to: Date): number {
    return Math.floor((to.getTime() - from.getTime()) / DAY_MS)
  }
}

// UTC-midnatt för ett datum — nollställer klockslaget så dagräkningen blir exakt.
function utcMidnight(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * DAY_MS)
}

// Första kalenderhalvårsgränsen (1 jan / 1 jul, UTC) STRIKT efter `d`.
function nextHalfYearBoundary(d: Date): Date {
  const year = d.getUTCFullYear()
  const jul1 = Date.UTC(year, 6, 1)
  if (d.getTime() < jul1) return new Date(jul1)
  return new Date(Date.UTC(year + 1, 0, 1))
}

// Delar ett inklusivt dygnsintervall [start, end] (UTC-midnatt) i delperioder
// som var och en ligger helt inom ETT kalenderhalvår. Summan av delperiodernas
// dagar är alltid antalet dygn i [start, end].
function halfYearRanges(start: Date, end: Date): { start: Date; end: Date; days: number }[] {
  const ranges: { start: Date; end: Date; days: number }[] = []
  let segStart = start
  while (segStart.getTime() <= end.getTime()) {
    const boundary = nextHalfYearBoundary(segStart)
    const lastDayOfHalf = addDays(boundary, -1)
    const segEnd = lastDayOfHalf.getTime() < end.getTime() ? lastDayOfHalf : end
    const days = Math.round((segEnd.getTime() - segStart.getTime()) / DAY_MS) + 1
    ranges.push({ start: segStart, end: segEnd, days })
    segStart = addDays(segEnd, 1)
  }
  return ranges
}
