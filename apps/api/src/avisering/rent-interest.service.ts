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

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

interface CrystallizeResult {
  delta: number
  total: number
  effectiveRatePercent: number
  days: number
}

/**
 * Inkasso PR 3 — dröjsmålsränta på obetalda hyresavier.
 *
 * Räntan löper från dagen EFTER förfallodagen och beräknas på det obetalda
 * KAPITALET (hyra + förbrukning) med referensräntan (det halvår avin avser) + 8
 * procentenheter. Den kristalliseras (bokförs) vid bestämda punkter — vid
 * påminnelse (PR 3) och vid inkasso-ready (PR 4) — inte som ett dagligt
 * verifikat-regn. Bokförs 1510 D / 8131 K (finansiell intäkt, INTE 3593).
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
   * senare punkt (inkasso-ready) bokför bara räntan som löpt SEDAN förra punkten.
   *
   * Returnerar null om inget bokfördes (betald/avbruten avi, ingen referensränta,
   * 0 dagar, eller inget nytt delta).
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

      // Referensräntan för det halvår avin avser (ankrad på förfallodagen). Läses
      // dynamiskt ur tabellen — aldrig hårdkodad. Saknas den kan räntan inte
      // beräknas → hoppa över (loggas), bokför ingen gissad ränta.
      //
      // MEDVETEN FÖRENKLING (räntelagen 6 §): EN referensränta — den som gäller
      // för förfallodagen — tillämpas på HELA dröjsmålsperioden. Strikt 6 §
      // ("den vid varje tid gällande referensräntan") kräver period-uppdelning
      // vid ett halvårsskifte (9 §) om referensräntan ändrats under dröjsmålet.
      // Accepterat för PR 3 eftersom (1) hyresdröjsmål sällan löper över ett
      // halvårsskifte vid påminnelsepunkten (dag 7), (2) räntestegen är små, och
      // (3) avvikelsen är liten. MÅSTE dock ersättas med per-period-beräkning
      // (segmentera [dueDate, throughDate] vid halvårsgränser) INNAN PR 4
      // exporterar räntekravet till ett inkassobolag — annars kan ett
      // specificerat räntekrav angripas. Granskat av bokföringsexpert + hyresjurist
      // (båda MEDIUM, ej blockerande för PR 3). Se DESIGN_DECISIONS.
      const referenceRate = await this.referenceRatePercentFor(notice.dueDate, tx)
      if (referenceRate == null) {
        this.logger.warn(
          `Ingen referensränta gäller för förfallodatum ${notice.dueDate.toISOString().slice(0, 10)} ` +
            `— dröjsmålsränta beräknades inte för avi ${noticeId}`,
        )
        return null
      }

      // Från dagen EFTER förfallodagen → antal hela dagar sedan förfall.
      const days = this.daysBetween(notice.dueDate, throughDate)
      if (days <= 0) return null

      // Beräkningsbas = obetalt KAPITAL (hyra + förbrukning). Aldrig ränta på
      // ränta, aldrig ränta på påminnelseavgiften (3593).
      const base = Number(notice.totalAmount) + Number(notice.consumptionAmount)
      const effectiveRatePercent = referenceRate + INTEREST_RATE_ADDITION_PP
      const totalInterest = round2(base * (effectiveRatePercent / 100) * (days / DAYS_PER_YEAR))

      const alreadyBooked = Number(notice.interestAccruedAmount)
      const delta = round2(totalInterest - alreadyBooked)
      if (delta <= 0) return null

      const throughKey = throughDate.toISOString().slice(0, 10)
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
          referenceRatePercent: referenceRate,
          effectiveRatePercent,
          days,
          base,
          interestDelta: delta,
          interestTotal: totalInterest,
          journalEntryId: entry.id,
        },
        { tx },
      )

      return { delta, total: totalInterest, effectiveRatePercent, days }
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
    return Math.floor((to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000))
  }
}
