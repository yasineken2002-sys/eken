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
  /** Σ av betalningsallokeringarna (RentNoticePayment.amount). */
  paid: number
  /** Klampad utestående skuld = max(0, claim). Aldrig negativ. */
  outstanding: number
  /**
   * OCR-reglerbar restskuld = max(0, (kapital + förbrukning + avgift) − betalt),
   * dvs. den del hyresgästen reglerar via avins OCR — EXKLUSIVE dröjsmålsränta.
   *
   * WATERFALL-REGEL (definieras HÄR, en gång): en betalning antas reglera OCR-delen
   * FÖRE räntan. Eftersom allokeringarna inte är komponent-attribuerade (en betalning
   * är ETT belopp mot avin) tolkar vi `paid` som att den först fyller OCR-bucketen
   * (kapital+förbrukning+avgift) och först därefter räntan. Det speglar domänen:
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
