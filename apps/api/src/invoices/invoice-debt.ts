import { Prisma } from '@prisma/client'

/**
 * Fakturans utestående skuld som BERÄKNAT TILLSTÅND.
 *
 * Speglar `computeRentDebt` för hyresavier (rent-debt.service.ts): skulden är
 * aldrig ett lagrat gissningsvärde utan alltid härledd ur totalen minus
 * summan av faktiskt registrerade betalningsallokeringar.
 *
 * Före InvoicePayment fanns ingen allokeringsmodell alls för fakturor — båda
 * betalvägarna bokförde `invoice.total` oavsett mottaget belopp och flippade
 * statusen till PAID. En delbetalning på 500 kr mot en faktura på 10 000 kr
 * debiterade 1930 med 10 000 och påstod att fakturan var reglerad.
 *
 * All aritmetik i Decimal — belopp är Decimal(10,2) i databasen och får aldrig
 * passera genom float på vägen till ett bokföringsbeslut.
 */
export interface InvoiceDebt {
  /** Fakturans totalbelopp (fordran). */
  total: Prisma.Decimal
  /** Σ av registrerade betalningsallokeringar. */
  paid: Prisma.Decimal
  /**
   * Σ av krediteringar (#517). Kreditnotornas totalbelopp.
   *
   * SEPARAT FRÅN `paid` MED FLIT. En kreditering är inte en betalning: inga
   * pengar har kommit in, och bankavstämningen ska aldrig kunna hitta en
   * allokering som ingen transaktion motsvarar. Att skriva krediteringen som
   * en `InvoicePayment` hade varit den enkla vägen och hade förgiftat både
   * betalningshistoriken och avstämningen.
   *
   * Båda drar ned samma `claim`, men av olika skäl, och den skillnaden ska
   * synas i varje yta som visar varför en fordran krympt.
   */
  credited: Prisma.Decimal
  /**
   * RÅ restfordran = total − paid − credited. Kan bli NEGATIV vid
   * överbetalning; den signalen behövs för att kunna upptäcka och avvisa
   * överbetalning i stället för att tyst svälja den.
   *
   * Krediteringen ingår här och inte någon annanstans: en krediterad faktura
   * ÄR en mindre fordran. Låg den utanför skulle fakturan fortsätta bära en
   * skuld hyresgästen inte har, och eskalera in i kravtrappan — vilket är
   * exakt vad #517 finns för att förhindra.
   */
  claim: Prisma.Decimal
  /** Klampad utestående skuld = max(0, claim). Aldrig negativ. */
  outstanding: Prisma.Decimal
  /**
   * ÖVERBETALT BELOPP = max(0, −claim). Aldrig negativ. (#378/#482)
   *
   * Spegelbilden av `outstanding`. Exakt ett av de två kan vara skilt från noll.
   *
   * VARFÖR ETT EGET, ICKE-NEGATIVT FÄLT och inte råa `claim` på tråden: en
   * konsument som får ett negativt "restbelopp" frestas att räkna med det som
   * om det vore en skuld — summera det i en KPI, skicka det i ett krav. Två
   * icke-negativa tal med varsin entydig betydelse går inte att blanda ihop.
   * Samma form som avi-sidan redan valt i `rentNoticeOutstanding`, som
   * returnerar `payable` och `overpaid` sida vid sida.
   *
   * `claim` finns kvar oförändrad för den som behöver tecknet — i dag
   * inkassogrinden (`collection-export.service.ts:531`).
   */
  overpaid: Prisma.Decimal
  /** true när fakturan är helt reglerad (outstanding = 0). */
  isSettled: boolean
}

/**
 * En kreditnotas belopp, i den form skuldberäkningen behöver den (#517).
 *
 * BARA `total`, INGEN STATUS — och det är ett medvetet val som hänger ihop med
 * en regel på ett annat ställe: en kreditnota kan inte makuleras.
 * `InvoicesService.transitionStatus` avvisar VOID på en rad med
 * `isCreditNote = true`, eftersom VOID-vägens reversering letar på
 * `sourceId = <invoiceId>` och aldrig skulle hitta kreditnotans verifikat (som
 * ligger under `credit-note:<id>`) — makuleringen hade lämnat verifikatet kvar
 * och tyst gjort skulden fel åt andra hållet.
 *
 * Kopplingen är avsiktligt uttalad på båda ställena och bevakad av
 * `credit-note-guard.spec.ts`: tas spärren i transitionStatus bort utan att
 * den här filtreringen införs, faller vakten.
 */
export interface CreditNoteAmount {
  total: Prisma.Decimal
}

export function computeInvoiceDebt(input: {
  total: Prisma.Decimal | number | string
  allocations: Array<Prisma.Decimal | number | string>
  /**
   * Kreditnotornas totalbelopp (#517). OBLIGATORISK — samma spärr som
   * `allocations`.
   *
   * VARFÖR INTE VALFRI MED DEFAULT `[]`: en valfri parameter hade gjort varje
   * befintlig anropare tyst blind för krediteringar. Kravtrappan, inkasso-
   * exporten och hyresgästportalen hade fortsatt räkna full skuld på en
   * krediterad faktura, och ingenting hade blivit rött. Att göra fältet
   * obligatoriskt tvingar TypeScript att peka ut varje ställe som fattar ett
   * skuldbeslut, en gång, vid införandet.
   *
   * Tom array är ett giltigt och vanligt värde: de allra flesta fakturor har
   * inga kreditnotor. Skillnaden mot en default är att den som skriver `[]`
   * har SETT frågan.
   */
  credits: Array<Prisma.Decimal | number | string>
}): InvoiceDebt {
  const total = new Prisma.Decimal(input.total)
  const paid = input.allocations.reduce<Prisma.Decimal>(
    (sum, a) => sum.plus(new Prisma.Decimal(a)),
    new Prisma.Decimal(0),
  )
  const credited = input.credits.reduce<Prisma.Decimal>(
    (sum, c) => sum.plus(new Prisma.Decimal(c)),
    new Prisma.Decimal(0),
  )
  const claim = total.minus(paid).minus(credited)
  // Klampningen STÅR KVAR. Den är inte defekten — den är det som gör att
  // kravtrappans grindar (`ocrOutstanding <= 0`, `outstanding > 0`) inte kan
  // eskalera mot någon som betalat för mycket. Defekten var att signalen
  // FÖRSVANN; nu ligger den bredvid i stället.
  const outstanding = claim.isNegative() ? new Prisma.Decimal(0) : claim
  const overpaid = claim.isNegative() ? claim.negated() : new Prisma.Decimal(0)

  return {
    total,
    paid,
    credited,
    claim,
    outstanding,
    overpaid,
    isSettled: outstanding.isZero(),
  }
}

/**
 * #329 — restskulden för en faktura vars allokeringar laddats.
 *
 * Samma uttryck som `computeInvoiceDebt`, men i den form de tre brevvägarna
 * behöver: en Prisma-rad med `payments` inkluderat, ut ett tal.
 *
 * LIGGER HÄR, INTE I EN AV BREVVÄGARNA. Först stod den lokalt i
 * `payment-reminder.service.ts` medan de två andra vägarna upprepade uttrycket
 * för hand — och det var precis den sortens spretande beräkning #329 finns för
 * att ta bort. En källa, tre anropare.
 *
 * TYPEN ÄR SPÄRREN. `payments` är obligatorisk, så en `findMany` utan
 * `include: { payments: ... }` typcheckar inte. Det skyddet är inte kosmetiskt:
 * en tom array hade gett ursprungsbeloppet i ett BREV till en hyresgäst, tyst.
 */
export function invoiceOutstanding(invoice: {
  total: Prisma.Decimal
  payments: Array<{ amount: Prisma.Decimal }>
  creditNotes: CreditNoteAmount[]
}): number {
  return computeInvoiceDebt({
    total: invoice.total,
    allocations: invoice.payments.map((p) => p.amount),
    credits: invoice.creditNotes.map((c) => c.total),
  }).outstanding.toNumber()
}

/**
 * #378 — överbetalt belopp för en faktura vars allokeringar laddats.
 *
 * Syskon till `invoiceOutstanding`, med samma typspärr: `payments` är
 * obligatorisk, så en `findMany` utan `include` typcheckar inte.
 *
 * Finns för att svarsytorna ska kunna visa överbetalningen utan att någon av
 * dem räknar ut den själv. En andra kopia av uttrycket är precis det spretande
 * #329 tog bort — och här vore det värre, eftersom en kopia som glömmer
 * klampningen kan visa ett negativt tal som om det vore en skuld.
 */
export function invoiceOverpaid(invoice: {
  total: Prisma.Decimal
  payments: Array<{ amount: Prisma.Decimal }>
  creditNotes: CreditNoteAmount[]
}): number {
  return computeInvoiceDebt({
    total: invoice.total,
    allocations: invoice.payments.map((p) => p.amount),
    credits: invoice.creditNotes.map((c) => c.total),
  }).overpaid.toNumber()
}
