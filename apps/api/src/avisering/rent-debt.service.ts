import { Injectable, NotFoundException } from '@nestjs/common'
import { RentNoticeType } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'
import { PrismaService } from '../common/prisma/prisma.service'

/**
 * Bankavstämnings-härdning PR 1 — strukturerad skuldbild för en hyresavi.
 *
 * outstanding() är den enda auktoritativa läsaren av "hur mycket är obetalt" och
 * bygger den på de GRANULÄRA betalningsallokeringarna (RentNoticePayment), inte
 * på paidAmount-cachen. Returen är medvetet UPPDELAD i sina beståndsdelar så att
 * ett senare eskalerings-/exportbeslut (A/D) kan välja sin grind EXPLICIT — t.ex.
 * "eskalera bara om kapital+förbrukning är obetalt" kontra "räkna in avgift+ränta".
 * Grund-PR:n LÅSER INGEN policy: den exponerar bara siffrorna.
 *
 * PENGANEUTRAL: ren läsning. Inget verifikat, ingen status, inget utskick, inget
 * kravbeslut. Ingen produktionsväg (cron/export/reminder/bad-debt) anropar den
 * ännu — den vaktas av penganeutralitets-testet i PR 1.
 */

export interface RentDebtBreakdown {
  /** Hyran (RentNotice.totalAmount) — bokförs av hyresverifikatet. */
  capital: number
  /** Förbrukning på avi-rader (consumptionAmount, IMD). */
  consumption: number
  /** Övriga debiterbara poster på avi-rader (miscChargeAmount, teknisk förvaltning Spår A). */
  miscCharge: number
  /** Påminnelseavgift (reminderFeeAmount, inkasso PR 2). */
  reminderFee: number
  /** Ackumulerad dröjsmålsränta (interestAccruedAmount, inkasso PR 3). */
  interest: number
  /**
   * RÅ netto-fordran = (kapital + förbrukning + avgift + ränta) − Σ allokeringar.
   * SIGNERAD: kan bli NEGATIV vid överbetalning. Det är råvärdet A/D kan inspektera
   * för att upptäcka över-/underbetalning; `outstanding` är den klampade varianten.
   */
  claim: number
  /**
   * ÖVERBETALT BELOPP = max(0, −claim). Aldrig negativ. (#378)
   *
   * Spegelbilden av `outstanding`; exakt ett av de två kan vara skilt från noll.
   * Finns för att den negativa signalen på `claim` annars bara går att läsa av
   * den som kommer ihåg att titta på tecknet — och över hela kodbasen gjorde
   * exakt EN konsument det.
   *
   * Klampningen på `outstanding`/`ocrOutstanding` står kvar oförändrad: den är
   * det som gör att kravtrappans grindar inte kan eskalera mot någon som
   * betalat för mycket.
   */
  overpaid: number
  /** Σ av betalningsallokeringarna (RentNoticePayment.amount). */
  paid: number
  /** Klampad utestående skuld = max(0, claim). Aldrig negativ. */
  outstanding: number
  /**
   * OCR-reglerbar restskuld = max(0, (kapital + förbrukning + övrig debitering +
   * avgift) − betalt), dvs. den del hyresgästen reglerar via avins OCR — EXKLUSIVE
   * dröjsmålsränta.
   *
   * WATERFALL-REGEL (definieras HÄR, en gång): en betalning antas reglera OCR-delen
   * FÖRE räntan. Eftersom allokeringarna inte är komponent-attribuerade (en betalning
   * är ETT belopp mot avin) tolkar vi `paid` som att den först fyller OCR-bucketen
   * (kapital+förbrukning+övrig debitering+avgift) och först därefter räntan. Det speglar domänen:
   * hyresgästen betalar avins OCR-belopp; dröjsmålsräntan är en separat fordran som
   * regleras vid slutuppgörelse. Konsekvens: betalar man hela OCR-beloppet blir
   * ocrOutstanding 0 även om ränta återstår (outstanding > 0).
   *
   * Detta är kravtrappans FRAMDRIVS-grind (PR 3a): REMINDED/INKASSO_READY-stegen
   * gatar på ocrOutstanding > 0 — ren restränta driver ALDRIG framdrift (D1: nej).
   * `outstanding` (total inkl. ränta) används bara där hela 1510-fordran ska mätas
   * (nedskrivning/befarad kundförlust).
   */
  ocrOutstanding: number
}

/** Indata till den rena beräkningen — frikopplad från Prisma för enhetstestbarhet. */
export interface RentDebtInput {
  type: RentNoticeType
  totalAmount: Decimal | number | string
  consumptionAmount: Decimal | number | string
  miscChargeAmount: Decimal | number | string
  reminderFeeAmount: Decimal | number | string
  interestAccruedAmount: Decimal | number | string
  /** Beloppen från RentNoticePayment-allokeringarna. */
  allocations: Array<Decimal | number | string>
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

const ZERO_DEBT: RentDebtBreakdown = {
  capital: 0,
  consumption: 0,
  miscCharge: 0,
  reminderFee: 0,
  interest: 0,
  claim: 0,
  overpaid: 0,
  paid: 0,
  outstanding: 0,
  ocrOutstanding: 0,
}

/**
 * Ren skuldberäkning. EN enda avrundning (round2) appliceras — på rå netto-
 * fordran (claim). Komponenterna och Σ allokeringar är redan tvådecimaliga
 * (Decimal(10,2)) och summeras exakt i Decimal-rymden innan de exponeras.
 *
 * DEPOSIT är INTE en kravavi: depositioner ägs av deposits-modulens 1510/2890-
 * flöde och ingår aldrig i kravtrappan. Vi returnerar därför nollor — kravtrappan
 * "ser" ingen skuld på en deposition.
 */
export function computeRentDebt(input: RentDebtInput): RentDebtBreakdown {
  if (input.type === RentNoticeType.DEPOSIT) {
    return { ...ZERO_DEBT }
  }

  const capital = new Decimal(input.totalAmount)
  const consumption = new Decimal(input.consumptionAmount)
  const miscCharge = new Decimal(input.miscChargeAmount)
  const reminderFee = new Decimal(input.reminderFeeAmount)
  const interest = new Decimal(input.interestAccruedAmount)

  const paid = input.allocations.reduce<Decimal>(
    (sum, a) => sum.plus(new Decimal(a)),
    new Decimal(0),
  )

  const grossClaim = capital.plus(consumption).plus(miscCharge).plus(reminderFee).plus(interest)
  // EN round2 per härlett netto-belopp. Subtraktionen är det enda stället där
  // avrundning kan behövas; komponenterna är redan exakt tvådecimaliga.
  const claim = round2(grossClaim.minus(paid).toNumber())

  // OCR-reglerbar restskuld (exkl. ränta) — waterfall: betalt fyller OCR-delen
  // (kapital+förbrukning+övrig debitering+avgift) före räntan. Övriga debiterbara
  // poster (skada/nyckel) är kapitalfordran som hyresgästen reglerar via avins OCR,
  // precis som förbrukning. Se RentDebtBreakdown.ocrOutstanding.
  const ocrGross = capital.plus(consumption).plus(miscCharge).plus(reminderFee)
  const ocrOutstanding = Math.max(0, round2(ocrGross.minus(paid).toNumber()))

  return {
    capital: capital.toNumber(),
    consumption: consumption.toNumber(),
    miscCharge: miscCharge.toNumber(),
    reminderFee: reminderFee.toNumber(),
    interest: interest.toNumber(),
    claim,
    overpaid: Math.max(0, round2(-claim)),
    paid: paid.toNumber(),
    outstanding: Math.max(0, claim),
    ocrOutstanding,
  }
}

@Injectable()
export class RentDebtService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Strukturerad skuldbild för en avi, scopad till organisationen. Läser de
   * granulära allokeringarna och delegerar till den rena beräkningen.
   */
  async outstanding(noticeId: string, organizationId: string): Promise<RentDebtBreakdown> {
    const notice = await this.prisma.rentNotice.findFirst({
      where: { id: noticeId, organizationId },
      select: {
        type: true,
        totalAmount: true,
        consumptionAmount: true,
        miscChargeAmount: true,
        reminderFeeAmount: true,
        interestAccruedAmount: true,
        payments: { select: { amount: true } },
      },
    })
    if (!notice) throw new NotFoundException('Hyresavi hittades inte')

    return computeRentDebt({
      type: notice.type,
      totalAmount: notice.totalAmount,
      consumptionAmount: notice.consumptionAmount,
      miscChargeAmount: notice.miscChargeAmount,
      reminderFeeAmount: notice.reminderFeeAmount,
      interestAccruedAmount: notice.interestAccruedAmount,
      allocations: notice.payments.map((p) => p.amount),
    })
  }
}

/**
 * #344 — vad hyresgästen ska betala på en avi som har allokeringar.
 *
 * Speglar `invoiceOutstanding` på fakturasidan (#329/#342). BYGGER INGEN NY
 * BERÄKNING FÖR HYRESAVIER: delegerar till `computeRentDebt`, samma uttryck som
 * kravtrappans eskaleringsgrind redan läser. (DEPOSIT har en egen gren — se
 * kommentaren i funktionskroppen; den typen har ingen grind att glida ifrån.)
 *
 * `ocrOutstanding` — inte `claim` eller `outstanding` — är rätt storhet mot
 * hyresgästen: det är den OCR-REGLERBARA restskulden (kapital + förbrukning +
 * övrig debitering + påminnelseavgift, minus betalt), exklusive dröjsmålsränta.
 * Ränta går inte att betala med avins OCR, så ett krav som räknar in den ber om
 * ett belopp mottagaren inte kan betala på det sätt brevet anvisar.
 *
 * `paid` LÄSES UR ALLOKERINGARNA, aldrig som `brutto − restskuld`. Restskulden
 * är klampad vid 0, så den härledningen gömmer en överbetalning — precis det
 * felet #342 fick rättat i granskning.
 *
 * TYPEN ÄR SPÄRREN: `payments` är obligatorisk, så en query utan
 * `include: { payments: ... }` typcheckar inte. En tom array hade gett
 * bruttobeloppet i ett formellt krav, tyst.
 *
 * RADERNA MÅSTE SUMMERA (FAR, granskning av #344). Kravbrevet specificerar sina
 * poster (lag 1981:739 5 §), så det som visas måste gå ihop:
 *
 *     nominalBeforeFee + fee − paid + overpaid === payable
 *
 * Därför returneras posterna NOMINELLT (som de bokfördes) med betalningen som en
 * egen avdragsrad, i stället för ett per-post klampat restvärde. Första versionen
 * returnerade `payableBeforeFee = max(0, ocrOutstanding − fee)`, och när en
 * betalning täckt hela kapitaldelen men bara en del av avgiften klampades den
 * raden till 0 medan avgiftsraden stod kvar på sitt nominella belopp — brevet
 * visade då `0 + 60` under en total på `10`. Nåbart: avgiften bokförs vid
 * eskaleringen, brevet renderas först i PDF-jobbet, och en bankbetalning kan
 * landa däremellan.
 */
export function rentNoticeOutstanding(notice: {
  type: RentNoticeType
  totalAmount: Decimal | number
  consumptionAmount: Decimal | number
  miscChargeAmount: Decimal | number
  reminderFeeAmount: Decimal | number
  interestAccruedAmount: Decimal | number
  payments: Array<{ amount: Decimal | number }>
}): {
  /** Att betala nu — OCR-reglerbar restskuld, klampad vid 0. */
  payable: number
  /** Avins nominella OCR-belopp inkl. påminnelseavgift. Aldrig klampat. */
  nominalTotal: number
  /** Avins nominella belopp utan påminnelseavgiften (som avin utfärdades). */
  nominalBeforeFee: number
  /** Påminnelseavgiften, nominellt bokförd. */
  fee: number
  /** Σ allokeringar. Läses ur allokeringarna, aldrig `brutto − restskuld`. */
  paid: number
  /** Betalt utöver den nominella fordran. 0 i normalfallet. */
  overpaid: number
} {
  // ── DEPOSITIONSAVIN RÄKNAS UR SINA EGNA FÄLT ─────────────────────────────
  //
  // `computeRentDebt` kortsluter till nollor för DEPOSIT. Den kortslutningen är
  // riktig FÖR SIN GRIND: en deposition ägs av deposits-modulens 1510/2890-flöde
  // och ska aldrig driva kravtrappan. Men den är ett SKULDPÅSTÅENDE, inte ett
  // beloppspåstående — och #344 var den första som ledde en VISNINGSyta genom
  // den. Resultatet: portalen visade `0 kr` på en depositionsavi som hyresgästen
  // faktiskt ska betala. Bevisat mot riktig Postgres (7 400 kr → 0 kr).
  //
  // Före #344 gick portalen via `rentNoticePayableTotal`, som saknar typgren och
  // därför råkade vara rätt här. Grenen nedan återställer det beloppet och
  // drar dessutom av faktiska allokeringar (bankmatchningen skapar en även för
  // depositioner) — aldrig mindre korrekt än det som gällde före.
  //
  // Ingen kravyta påverkas: kravtrappans cron filtrerar på `type: RENT`, så en
  // depositionsavi kan aldrig nå påminnelsebrevet.
  if (notice.type === RentNoticeType.DEPOSIT) {
    const nominalBeforeFee = round2(
      Number(notice.totalAmount) +
        Number(notice.consumptionAmount) +
        Number(notice.miscChargeAmount),
    )
    const fee = round2(Number(notice.reminderFeeAmount))
    const nominalTotal = round2(nominalBeforeFee + fee)
    const paid = round2(notice.payments.reduce((sum, p) => sum + Number(p.amount), 0))
    return {
      payable: Math.max(0, round2(nominalTotal - paid)),
      nominalTotal,
      nominalBeforeFee,
      fee,
      paid,
      overpaid: Math.max(0, round2(paid - nominalTotal)),
    }
  }

  const debt = computeRentDebt({
    type: notice.type,
    totalAmount: notice.totalAmount,
    consumptionAmount: notice.consumptionAmount,
    miscChargeAmount: notice.miscChargeAmount,
    reminderFeeAmount: notice.reminderFeeAmount,
    interestAccruedAmount: notice.interestAccruedAmount,
    allocations: notice.payments.map((p) => p.amount),
  })
  const nominalBeforeFee = round2(debt.capital + debt.consumption + debt.miscCharge)
  const nominalTotal = round2(nominalBeforeFee + debt.reminderFee)
  const paid = round2(debt.paid)
  return {
    payable: debt.ocrOutstanding,
    nominalTotal,
    nominalBeforeFee,
    fee: debt.reminderFee,
    paid,
    overpaid: Math.max(0, round2(paid - nominalTotal)),
  }
}
