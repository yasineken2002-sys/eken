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
   * Σ av krediteringarna (#518) — `RentNoticeCredit.amount`.
   *
   * SEPARAT FRÅN `paid` MED FLIT, samma val som `computeInvoiceDebt` gjorde i
   * #528. En kreditering är inte en betalning: inga pengar har kommit in, och
   * bankavstämningen ska aldrig kunna hitta en allokering som ingen
   * banktransaktion motsvarar. Att skriva krediteringen som en
   * `RentNoticePayment` hade varit den enkla vägen och hade förgiftat både
   * betalningshistoriken och avstämningen.
   *
   * Båda drar ned samma `claim`, men av olika skäl, och den skillnaden ska synas
   * i varje yta som visar varför en fordran krympt.
   */
  credited: number
  /**
   * DET SOM ÅTERSTÅR ÄR REN RÄNTA, OCH KAPITALET ÄR BORTKREDITERAT (#518, #535 fråga 3).
   *
   * Sant när en kreditering finns, den OCR-reglerbara delen är nere på noll, och
   * `outstanding` ändå är positiv — alltså när det enda som står kvar av kravet
   * är dröjsmålsränta som löpt på ett kapital som sedan visade sig felaktigt.
   *
   * VARFÖR FLAGGAN FINNS I STÄLLET FÖR ATT RÄNTAN BARA NOLLAS: om en kreditering
   * av kapitalet utsläcker den upplupna räntan är en JURIDISK fråga som ligger
   * öppen hos revisor och hyresjurist (#535 fråga 3). Att nolla räntan här vore
   * att besvara den i tysthet, och att låta den stå kvar utan markering vore
   * värre: kravtrappans två sista steg (inkasso-export och kundförlust) mäter
   * `outstanding` INKLUSIVE ränta, så avin hade exporterats till inkasso och
   * skrivits ned på ett belopp vars grund just krediterats bort.
   *
   * Flaggan är alltså det säkra mellanläget: maskinen slutar agera automatiskt
   * och lämnar beslutet till en människa. Konsumenterna är
   * `RentCollectionExportService.exportBlockReason` (spärrar exporten) och
   * `RentBadDebtService.reclassifyProbableLosses` (hoppar över avin).
   */
  interestOnlyAfterCredit: boolean
  /**
   * RÅ netto-fordran = (kapital + förbrukning + avgift + ränta) − Σ allokeringar
   * − Σ krediteringar.
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
  /**
   * Krediteringarnas belopp (#518) — `RentNoticeCredit.amount`.
   *
   * OBLIGATORISK, SAMMA SPÄRR SOM `allocations`. En valfri parameter med default
   * `[]` hade gjort varje befintlig anropare tyst blind för krediteringar:
   * kravtrappan, inkassoexporten och hyresgästportalen hade fortsatt räkna full
   * skuld på en krediterad avi, och ingenting hade blivit rött. Att göra fältet
   * obligatoriskt tvingar TypeScript att peka ut varje ställe som fattar ett
   * skuldbeslut, en gång, vid införandet.
   *
   * Tom array är ett giltigt och vanligt värde — de allra flesta avier har inga
   * krediteringar. Skillnaden mot en default är att den som skriver `[]` har
   * SETT frågan.
   */
  credits: Array<Decimal | number | string>
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
  credited: 0,
  interestOnlyAfterCredit: false,
  claim: 0,
  overpaid: 0,
  paid: 0,
  outstanding: 0,
  ocrOutstanding: 0,
}

/**
 * ── AVINS OCR-BÄRANDE POSTER. EN (1) DEFINITION I HELA KODBASEN. ────────────
 *
 * Det här uttrycket fanns på TRE ställen innan #518, och den tredje var en
 * inline-dubblett i bankavstämningens fuzzy-matchning
 * (`reconciliation.service.ts`). Det är inte en stilfråga: missar en av dem
 * krediteringen matchar en KORREKT inbetalning inte längre mot avin, och
 * pengarna blir liggande omatchade medan avin ser reglerad ut. Samma klass av
 * divergens som #329/#342/#344 arbetade bort på skuldsidan.
 *
 * `rentNoticePayableTotal` och `computeRentDebt` anropar båda den här; en fjärde
 * summeringsplats fälls av `rent-notice-credit-guard.spec.ts`.
 *
 * VAD SOM INGÅR: hyra + förbrukning (IMD) + övrig debitering (skada/nyckel) +
 * påminnelseavgift. Alltså precis de poster hyresgästen reglerar via avins OCR.
 * Dröjsmålsräntan står UTANFÖR — den är inte OCR-reglerbar utan en separat
 * fordran som regleras vid slutuppgörelse.
 *
 * `net` ÄR SIGNERAD OCH KLAMPAS INTE HÄR. Klampningen hör hemma där talet
 * tolkas: ett negativt netto betyder överkreditering, och den signalen ska inte
 * försvinna på vägen. Skrivvägen spärrar överkreditering, så i praktiken är
 * `net` aldrig negativ — men en beräkning som förlitar sig på att en spärr
 * någon annanstans håller är exakt den sortens antagande som brukar sluta gälla.
 */
export function rentNoticeOcrComponents(input: {
  totalAmount: Decimal | number | string
  consumptionAmount: Decimal | number | string
  miscChargeAmount?: Decimal | number | string
  reminderFeeAmount?: Decimal | number | string
  credits: Array<Decimal | number | string>
}): { gross: Decimal; credited: Decimal; net: Decimal } {
  const gross = new Decimal(input.totalAmount)
    .plus(new Decimal(input.consumptionAmount))
    .plus(new Decimal(input.miscChargeAmount ?? 0))
    .plus(new Decimal(input.reminderFeeAmount ?? 0))
  const credited = input.credits.reduce<Decimal>(
    (sum, c) => sum.plus(new Decimal(c)),
    new Decimal(0),
  )
  return { gross, credited, net: gross.minus(credited) }
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

  // OCR-reglerbar del (exkl. ränta) ur den ENDA summeringen. Krediteringen dras
  // av här och inte någon annanstans: en krediterad avi ÄR en mindre fordran.
  // Låg avdraget utanför skulle avin fortsätta bära en skuld hyresgästen inte
  // har, och eskalera in i kravtrappan — precis det #518 finns för att stoppa.
  const ocr = rentNoticeOcrComponents({
    totalAmount: capital,
    consumptionAmount: consumption,
    miscChargeAmount: miscCharge,
    reminderFeeAmount: reminderFee,
    credits: input.credits,
  })

  const grossClaim = ocr.net.plus(interest)
  // EN round2 per härlett netto-belopp. Subtraktionen är det enda stället där
  // avrundning kan behövas; komponenterna är redan exakt tvådecimaliga.
  const claim = round2(grossClaim.minus(paid).toNumber())

  // Waterfall: betalt fyller OCR-delen (kapital+förbrukning+övrig debitering+
  // avgift, minus kreditering) före räntan. Övriga debiterbara poster
  // (skada/nyckel) är kapitalfordran som hyresgästen reglerar via avins OCR,
  // precis som förbrukning. Se RentDebtBreakdown.ocrOutstanding.
  const ocrOutstanding = Math.max(0, round2(ocr.net.minus(paid).toNumber()))
  const outstanding = Math.max(0, claim)

  return {
    capital: capital.toNumber(),
    consumption: consumption.toNumber(),
    miscCharge: miscCharge.toNumber(),
    reminderFee: reminderFee.toNumber(),
    interest: interest.toNumber(),
    credited: ocr.credited.toNumber(),
    // Se fältets docblock: kapitalet bortkrediterat, bara ränta kvar → ingen
    // automatisk eskalering. Kräver att en kreditering FAKTISKT finns — en avi
    // som betalats ned till ren restränta är ett annat fall och rörs inte.
    interestOnlyAfterCredit: ocr.credited.greaterThan(0) && ocrOutstanding <= 0 && outstanding > 0,
    claim,
    overpaid: Math.max(0, round2(-claim)),
    paid: paid.toNumber(),
    outstanding,
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
        // #518 — utan krediteringarna räknar varje grind som läser den här
        // metoden (påminnelse, inkasso-redo, export, kundförlust, dashboard)
        // full skuld på en krediterad avi.
        credits: { select: { amount: true } },
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
      credits: notice.credits.map((c) => c.amount),
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
 *     nominalBeforeFee + fee − credited − paid + overpaid === payable
 *
 * `credited` (#518) är en EGEN avdragsrad i den kedjan, inte hopslagen med
 * `paid`: en nedsättning och en betalning säger olika saker till mottagaren.
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
  /**
   * #518 — krediteringarna. OBLIGATORISK av samma skäl som `payments`: en
   * `findMany` utan `include: { credits: … }` typcheckar inte, och en tom array
   * hade gett det OKREDITERADE beloppet i ett formellt krav till en hyresgäst,
   * tyst. Det är exakt den defekt #329/#342 fick rättad för betalningar.
   */
  credits: Array<{ amount: Decimal | number }>
}): {
  /** Att betala nu — OCR-reglerbar restskuld, klampad vid 0. */
  payable: number
  /** Avins OCR-belopp inkl. påminnelseavgift, efter kreditering. Aldrig klampat. */
  nominalTotal: number
  /** Avins belopp utan påminnelseavgiften (som avin utfärdades). */
  nominalBeforeFee: number
  /** Påminnelseavgiften, nominellt bokförd. */
  fee: number
  /**
   * Σ krediteringar (#518) — EGEN AVDRAGSRAD, inte hopslagen med `paid`.
   *
   * Kravbrevet specificerar sina poster (lag 1981:739 5 §), och en nedsättning
   * och en betalning är olika saker för mottagaren: den ena säger "du var aldrig
   * skyldig detta", den andra "du har redan betalat detta". Att summera ihop dem
   * hade gjort brevet formellt rätt men sakligt missvisande.
   */
  credited: number
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
    // Genom den ENDA summeringen, inte en fjärde kopia av de fyra kolumnerna.
    // Depositioner kan inte krediteras (spärrat i RentNoticeCreditService), så
    // `credited` är i praktiken alltid 0 här — men uttrycket ska ändå vara det
    // gemensamma, annars är det en summeringsplats till som kan glida.
    const ocr = rentNoticeOcrComponents({
      ...notice,
      credits: notice.credits.map((c) => c.amount),
    })
    const fee = round2(Number(notice.reminderFeeAmount))
    const nominalTotal = round2(ocr.net.toNumber())
    const nominalBeforeFee = round2(nominalTotal - fee)
    const credited = round2(ocr.credited.toNumber())
    const paid = round2(notice.payments.reduce((sum, p) => sum + Number(p.amount), 0))
    return {
      payable: Math.max(0, round2(nominalTotal - paid)),
      nominalTotal,
      nominalBeforeFee,
      fee,
      credited,
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
    credits: notice.credits.map((c) => c.amount),
  })
  // Ur den ENDA summeringen — inte genom att addera ihop komponenterna en gång
  // till. `net` är brutto minus kreditering, alltså vad avin kräver EFTER
  // nedsättningen; posterna nedan redovisas nominellt med krediteringen som en
  // egen avdragsrad, så att raderna summerar (FAR, #344).
  const ocr = rentNoticeOcrComponents({
    totalAmount: notice.totalAmount,
    consumptionAmount: notice.consumptionAmount,
    miscChargeAmount: notice.miscChargeAmount,
    reminderFeeAmount: notice.reminderFeeAmount,
    credits: [],
  })
  const nominalTotal = round2(ocr.gross.toNumber())
  const nominalBeforeFee = round2(nominalTotal - debt.reminderFee)
  const paid = round2(debt.paid)
  return {
    payable: debt.ocrOutstanding,
    nominalTotal,
    nominalBeforeFee,
    fee: debt.reminderFee,
    credited: debt.credited,
    paid,
    // ── INTE `debt.overpaid`, OCH SKILLNADEN ÄR RÄNTAN ────────────────────
    //
    // `debt.overpaid` mäter mot HELA kravet (inkl. dröjsmålsränta), medan det
    // här brevet redovisar den OCR-reglerbara delen. Betalar hyresgästen mer än
    // OCR-beloppet men mindre än kravet inklusive ränta är `debt.overpaid` noll
    // medan brevets rader ändå inte går ihop. Måttet här måste därför vara
    // överskottet mot samma nämnare som brevet visar: nettot efter kreditering.
    overpaid: Math.max(0, round2(paid - (nominalTotal - debt.credited))),
  }
}
