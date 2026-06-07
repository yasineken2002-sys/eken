import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { Prisma, RentNoticeType } from '@prisma/client'
import { PrismaService } from '../common/prisma/prisma.service'
import { AccountingService } from '../accounting/accounting.service'
import { RentNoticeEventsService } from './rent-notice-events.service'
import { RentDebtService } from './rent-debt.service'

interface BadDebtSummary {
  reclassified: number
  manual: number
  skipped: number
  errors: number
}

// Fälten kundförlust-flödet behöver för att avgöra moms-status och belopp.
const BAD_DEBT_SELECT = {
  id: true,
  noticeNumber: true,
  status: true,
  type: true,
  collectionStage: true,
  probableLossAt: true,
  vatAmount: true,
  totalAmount: true,
  consumptionAmount: true,
  reminderFeeAmount: true,
  interestAccruedAmount: true,
  paidAmount: true,
  // Förbrukningsradernas momssats — momsgrinden måste fånga momspliktig
  // FÖRBRUKNING (vatRate>0) även när hyrans vatAmount=0 (momsfri hyra, momspliktig
  // förbrukning). En sådan fordran bär utgående moms (2611) → samma öppna
  // revisorfråga som lokalhyra (docs/legal/46), så den vägras också.
  lines: { select: { vatRate: true } },
} satisfies Prisma.RentNoticeSelect

type BadDebtNotice = Prisma.RentNoticeGetPayload<{ select: typeof BAD_DEBT_SELECT }>

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * Inkasso PR 5 — kundförlust. Sluter skuld-sidans bokföringscykel i två steg:
 *
 *   • BEFARAD (reclassifyToProbableLoss): en obetald, inkasso-redo fordran klassas
 *     som osäker — 1515 D / 1510 K. Balansräkningsomklassning, ingen resultat-
 *     påverkan. Markeras med probableLossAt.
 *   • KONSTATERAD (confirmLoss): den osäkra fordran skrivs av som förlust —
 *     6352 D / 1515 K. Resultatpåverkan. Kravsteget flippas till WRITTEN_OFF.
 *
 * KRITISK JURIDISK AVGRÄNSNING (docs/legal/46 fråga 1): momsåterkravet vid
 * kundförlust på LOKALHYRA (momspliktig under frivillig skattskyldighet) är en
 * ÖPPEN revisorfråga. Tills den är besvarad hanterar PR 5 ENDAST MOMSFRI fordran
 * (bostadshyra m.fl., vatAmount = 0). Momspliktiga avier VÄGRAS (ConflictException
 * "kräver manuell hantering") — ingen egen moms-återkravslogik skrivs på gissning.
 *
 * Ingen kod för förverkande/avhysning (samma gräns som hela serien). Kundförlust
 * är bokföring av en förlorad fordran, inte en hyresgästprocess.
 */
@Injectable()
export class RentBadDebtService {
  private readonly logger = new Logger(RentBadDebtService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly accounting: AccountingService,
    private readonly rentNoticeEvents: RentNoticeEventsService,
    // Bankavstämnings-härdning PR 3a — nedskrivningsbeloppet läses från den
    // allokeringsderiverade sanningskällan i stället för paidAmount-cachen.
    private readonly rentDebt: RentDebtService,
  ) {}

  /**
   * Daglig cron (kl 12:00 — efter inkasso-redo-cronen kl 11:00). Klassar varje
   * inkasso-redo, MOMSFRI fordran som ännu inte befarats till befarad kundförlust.
   * Momspliktiga (lokalhyra) räknas som `manual` och loggas — de väntar revisor.
   *
   * Endast befarad automatiseras: det är en balansräkningsomklassning utan
   * resultatpåverkan. KONSTATERAD bortskrivning (6352, resultatpåverkan) är en
   * mänsklig bedömning och görs ALDRIG av cron — bara via confirmLoss-endpointen.
   */
  @Cron('0 12 * * *')
  async reclassifyProbableLosses(): Promise<BadDebtSummary> {
    const summary: BadDebtSummary = { reclassified: 0, manual: 0, skipped: 0, errors: 0 }

    const candidates = await this.prisma.rentNotice.findMany({
      where: {
        type: RentNoticeType.RENT,
        collectionStage: 'INKASSO_READY',
        probableLossAt: null,
        status: { notIn: ['PAID', 'CANCELLED'] },
        organization: { remindersEnabled: true },
      },
      select: { id: true, organizationId: true, vatAmount: true },
    })

    for (const notice of candidates) {
      try {
        // Momspliktig (lokalhyra) → manuell hantering tills revisorfrågan besvarats.
        if (Number(notice.vatAmount) > 0) {
          summary.manual++
          this.logger.warn(
            `Befarad kundförlust hoppas över för momspliktig avi ${notice.id} ` +
              `(lokalhyra) — kräver manuell hantering, momsåterkrav väntar revisorbeslut`,
          )
          continue
        }
        const res = await this.reclassifyToProbableLoss(notice.id, notice.organizationId, null)
        if (res.booked) summary.reclassified++
        else summary.skipped++
      } catch (err) {
        if (err instanceof ConflictException) {
          summary.skipped++
          continue
        }
        summary.errors++
        this.logger.error(
          `Befarad kundförlust misslyckades för avi ${notice.id}: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }

    this.logger.log(
      `Befarad kundförlust: ${summary.reclassified} omklassade, ${summary.manual} manuella (moms), ` +
        `${summary.skipped} hoppade över, ${summary.errors} fel`,
    )
    return summary
  }

  /**
   * BEFARAD kundförlust — omklassar en inkasso-redo, MOMSFRI fordran 1510 → 1515.
   *
   * INV-A: befarad-markeringen (probableLossAt) och omklassningsverifikatet
   * (1515 D / 1510 K) skapas i SAMMA transaktion. Faller bokföringen kastas felet
   * → allt rullas tillbaka. Idempotent + race-säker via updateMany-claim på
   * (ej PAID/CANCELLED, probableLossAt null) + idempotent verifikat-sourceId.
   */
  async reclassifyToProbableLoss(
    noticeId: string,
    organizationId: string,
    actorId: string | null,
  ): Promise<{ booked: boolean }> {
    const notice = await this.loadNotice(noticeId, organizationId)
    this.assertMomsfri(notice)

    if (notice.collectionStage !== 'INKASSO_READY') {
      throw new ConflictException(
        `Avi ${notice.noticeNumber} kan inte klassas som befarad förlust — endast inkasso-redo avier (kravsteg är ${notice.collectionStage})`,
      )
    }
    if (notice.status === 'PAID' || notice.status === 'CANCELLED') {
      throw new ConflictException(
        `Avi ${notice.noticeNumber} är ${notice.status} — inget att skriva ned`,
      )
    }
    // Idempotent: redan befarad → no-op.
    if (notice.probableLossAt) return { booked: false }

    // PR 3a — nedskrivningsbeloppet = hela 1510-fordran INKL. ränta (outstanding,
    // inte ocrOutstanding). Läses från den allokeringsderivade sanningskällan i
    // stället för paidAmount-cachen; beloppet är oförändrat eftersom invarianten
    // Σ allokeringar == paidAmount håller (PR 1). Ersätter den tidigare privata
    // outstanding()-hjälparen (en sanningskälla, eliminerar namnkrocken).
    const debt = await this.rentDebt.outstanding(noticeId, organizationId)
    const amount = debt.outstanding
    if (amount <= 0) {
      throw new ConflictException(
        `Avi ${notice.noticeNumber} har ingen utestående fordran att skriva ned`,
      )
    }

    const now = new Date()
    return this.prisma.$transaction(async (tx) => {
      const claim = await tx.rentNotice.updateMany({
        where: {
          id: noticeId,
          organizationId,
          probableLossAt: null,
          status: { notIn: ['PAID', 'CANCELLED'] },
        },
        data: { probableLossAt: now },
      })
      if (claim.count === 0) return { booked: false }

      const entry = await this.accounting.bookBadDebtReclassification({
        organizationId,
        source: 'RENT_NOTICE',
        sourceId: `bad-debt-probable:${noticeId}`,
        amount,
        date: now,
        description: `Befarad kundförlust hyresavi ${notice.noticeNumber}`,
        createdById: actorId,
        tx,
      })
      // null = saknat 1510/1515 → INV-A: kasta så hela transaktionen (inkl.
      // markeringen) rullas tillbaka. En fordran får aldrig markeras befarad utan
      // sitt omklassningsverifikat.
      if (!entry) {
        throw new InternalServerErrorException(
          `Befarad kundförlust kunde inte bokföras för avi ${noticeId} — ` +
            'kontrollera att kontoplanen innehåller konto 1510 och 1515.',
        )
      }

      await this.rentNoticeEvents.record(
        noticeId,
        'NOTE_ADDED',
        actorId ? 'USER' : 'SYSTEM',
        actorId,
        { action: 'bad-debt-probable', amount, journalEntryId: entry.id },
        { tx },
      )
      return { booked: true }
    })
  }

  /**
   * KONSTATERAD kundförlust — skriver av den osäkra fordran 1515 → 6352 och flippar
   * kravsteget till WRITTEN_OFF. Manuell åtgärd (mänsklig bedömning att fordran är
   * förlorad). Kräver att avin FÖRST befarats (fordran ligger på 1515).
   *
   * Beloppet tas från befarad-verifikatet (debet på 1515) så att 1515 nettar exakt
   * till noll — robust även om en betalning råkat registreras mellan stegen.
   *
   * INV-A: WRITTEN_OFF-flippen och avskrivningsverifikatet (6352 D / 1515 K) skapas
   * i SAMMA transaktion. Idempotent + race-säker via updateMany-claim (writtenOffAt
   * null) + idempotent verifikat-sourceId.
   */
  async confirmLoss(
    noticeId: string,
    organizationId: string,
    actorId: string | null,
  ): Promise<{ booked: boolean }> {
    const notice = await this.loadNotice(noticeId, organizationId)
    this.assertMomsfri(notice)

    // Idempotent: redan avskriven → no-op.
    if (notice.collectionStage === 'WRITTEN_OFF') return { booked: false }

    // Måste befaras först — konstaterad bortskrivning sker FRÅN 1515.
    if (!notice.probableLossAt) {
      throw new ConflictException(
        `Avi ${notice.noticeNumber} måste klassas som befarad förlust (1515) innan den kan skrivas av som konstaterad`,
      )
    }

    // Avskrivningsbeloppet = exakt det som omklassades till 1515 (befarad-verifikatets
    // debetrad), så 1515 nettar till noll oavsett mellanliggande händelser.
    // Befarad-verifikatet har formen [1515 D belopp, 1510 K belopp] — exakt EN
    // debetrad (1515), så summan av debet är beloppet på 1515.
    const probableEntry = await this.prisma.journalEntry.findFirst({
      where: { organizationId, source: 'RENT_NOTICE', sourceId: `bad-debt-probable:${noticeId}` },
      include: { lines: true },
    })
    const amount = round2(
      probableEntry?.lines.reduce((sum, l) => sum + Number(l.debit ?? 0), 0) ?? 0,
    )
    if (amount <= 0) {
      throw new ConflictException(
        `Avi ${notice.noticeNumber} saknar ett befarad-verifikat att skriva av — kör befarad kundförlust först`,
      )
    }

    const now = new Date()
    return this.prisma.$transaction(async (tx) => {
      // Claim på det SEMANTISKA villkoret "befarad men ej avskriven"
      // (probableLossAt satt, writtenOffAt null) — inte på ett specifikt kravsteg.
      // Befarad ändrar inte collectionStage (den är kvar INKASSO_READY), men att
      // låsa på probableLossAt är robustare mot framtida kravstegsövergångar.
      const claim = await tx.rentNotice.updateMany({
        where: {
          id: noticeId,
          organizationId,
          probableLossAt: { not: null },
          writtenOffAt: null,
        },
        data: { collectionStage: 'WRITTEN_OFF', writtenOffAt: now },
      })
      if (claim.count === 0) return { booked: false }

      const entry = await this.accounting.bookBadDebtWriteOff({
        organizationId,
        source: 'RENT_NOTICE',
        sourceId: `bad-debt-writeoff:${noticeId}`,
        amount,
        date: now,
        description: `Konstaterad kundförlust hyresavi ${notice.noticeNumber}`,
        createdById: actorId,
        tx,
      })
      // null = saknat 1515/6352 → INV-A: kasta så hela transaktionen (inkl. flippen)
      // rullas tillbaka. Ingen avskrivning utan verifikat.
      if (!entry) {
        throw new InternalServerErrorException(
          `Konstaterad kundförlust kunde inte bokföras för avi ${noticeId} — ` +
            'kontrollera att kontoplanen innehåller konto 1515 och 6352.',
        )
      }

      await this.rentNoticeEvents.record(
        noticeId,
        'WRITTEN_OFF',
        actorId ? 'USER' : 'SYSTEM',
        actorId,
        { action: 'bad-debt-writeoff', amount, journalEntryId: entry.id },
        { tx },
      )
      return { booked: true }
    })
  }

  // ── Privata hjälpare ─────────────────────────────────────────────────────

  private async loadNotice(noticeId: string, organizationId: string): Promise<BadDebtNotice> {
    const notice = await this.prisma.rentNotice.findFirst({
      where: { id: noticeId, organizationId },
      select: BAD_DEBT_SELECT,
    })
    if (!notice) throw new NotFoundException('Avi hittades inte')
    return notice
  }

  // Momsavgränsningen (docs/legal/46 fråga 1): endast HELT momsfri fordran hanteras.
  // Fångar både momspliktig HYRA (vatAmount>0, lokalhyra under frivillig
  // skattskyldighet) OCH momspliktig FÖRBRUKNING (en rad med vatRate>0). Båda bär
  // utgående moms (2611) vars återkrav vid kundförlust är den öppna revisorfrågan —
  // ingen egen moms-återkravslogik skrivs på gissning.
  private assertMomsfri(notice: BadDebtNotice): void {
    const hasRentVat = Number(notice.vatAmount) > 0
    const hasConsumptionVat = notice.lines.some((l) => l.vatRate > 0)
    if (hasRentVat || hasConsumptionVat) {
      throw new ConflictException(
        `Avi ${notice.noticeNumber} är momspliktig — kundförlust kräver manuell hantering. ` +
          'Momsåterkravet vid kundförlust på momspliktig hyra/förbrukning är en öppen ' +
          'revisorfråga (docs/legal/46 fråga 1) och får inte bokföras automatiskt.',
      )
    }
  }

  // PR 3a — den tidigare privata outstanding()-hjälparen (fältsumma mot paidAmount-
  // cachen) är BORTTAGEN. Nedskrivningsbeloppet läses nu från RentDebtService
  // (allokeringsderiverad, en sanningskälla) i reclassifyToProbableLoss. Det är den
  // KANONISKA 1510-fordran inkl. ränta; beloppet är oförändrat eftersom invarianten
  // Σ allokeringar == paidAmount håller (PR 1). En ledger-rekonciliering av 1510-
  // saldot per avi (charge-/betalnings-attribuering) kvarstår som noterad följdpunkt.
}
