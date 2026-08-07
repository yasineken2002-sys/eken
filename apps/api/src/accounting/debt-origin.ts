/**
 * SKULDENS UPPKOMST — en regel, ett ställe.
 *
 * Påminnelseavgift får inte debiteras utan avtalsvillkor, och villkoret binder
 * bara framåt: avgift får inte tas ut på hyra vars skuld uppkom innan villkoret
 * trädde i kraft (2 § och 4 § lagen 1981:739). Grinden i `bookReminderFee`
 * jämför villkorsdatumet mot den tidpunkt som returneras härifrån.
 *
 * ── VARFÖR EN BRANDAD TYP ─────────────────────────────────────────────────
 *
 * En krävd parameter av typen `Date` hindrar att man GLÖMMER datumet. Den
 * hindrar inte att någon skickar `notice.dueDate` rakt av och därmed kringgår
 * regeln nedan utan att märka det — och just den regeln är inte självklar (se
 * efterdebiteringsfallet). `DebtOriginDate` går bara att få ur funktionerna i
 * den här filen, så regeln kan inte uttryckas någon annanstans.
 *
 * ÄRLIGT OM VAD BRANDET GÖR: det är en kompileringstidskonstruktion och
 * försvinner i runtime. En `as DebtOriginDate` tvingar fram vilket datum som
 * helst. Det är en MEDVETEN handling, inte ett förbiseende — och det är
 * skillnaden brandet finns för. Det skyddar mot misstaget, inte mot uppsåtet.
 */

declare const debtOriginBrand: unique symbol

export type DebtOriginDate = Date & { readonly [debtOriginBrand]: true }

/**
 * HYRESAVI — den tidigaste av `periodStart` och `dueDate`.
 *
 * Ingetdera fältet är strikt i båda riktningarna, och det är mätt:
 *
 *   NORMAL FÖRSKOTTSAVI. `dueDate` = sista vardagen i månaden FÖRE hyresmånaden
 *     (12 kap. 20 § JB), alltså tidigare än `periodStart`. Aprilhyran förfaller
 *     31 mars; perioden börjar 1 april. Här är `dueDate` det tidigaste.
 *
 *   EFTERDEBITERING (backfill). Perioden är historisk medan `dueDate` sätts till
 *     en framtida betalningsdag: period 2025-01-01, dueDate 2026-08-10. Här är
 *     `periodStart` det tidigaste — och det ärliga. Ginge grinden på `dueDate`
 *     skulle ett villkorsdatum från 2026 släppa igenom en avgift på en skuld
 *     från 2025. Mätt i eken_dev: 140 av 283 avier har den formen.
 *
 * Den tidigaste av de två är strikt i BÅDA fallen, och strikt är den riktning
 * som gäller: en avgift för mycket är ett olagligt krav, en för lite är en
 * utebliven sextiolapp.
 *
 * ── NULL NÄR `periodStart` SAKNAS ─────────────────────────────────────────
 *
 * Vägrar hellre än gissar. `dueDate` ensamt vore den TILLÅTANDE riktningen för
 * en efterdebiterad avi utan periodfält — precis det fallet regeln finns för.
 *
 * Det kostar ingenting, och det är mätt: samtliga tre skapandevägar för en
 * RENT-avi (`avisering.service.ts:285`, `:467`, `:769`) sätter `periodStart`
 * från `calculateProratedRent`, vars returtyp deklarerar `periodStart: Date` —
 * icke-nullbar. Den enda vägen som utelämnar fältet skapar en DEPOSIT-avi
 * (`:687`), och en deposition har ingen hyresperiod. Depositionsavier kan
 * dessutom aldrig få avgift: cronens urval filtrerar `type: RENT`.
 *
 * Rader utan `periodStart` i dagens data (9 RENT av 260) skapades inte av de
 * vägarna — de föregår proration-migreringen eller är handgjorda testrader.
 */
export function resolveNoticeDebtOrigin(notice: {
  periodStart: Date | null
  dueDate: Date
}): DebtOriginDate | null {
  if (notice.periodStart == null) return null
  const tidigast =
    notice.periodStart.getTime() <= notice.dueDate.getTime() ? notice.periodStart : notice.dueDate
  return tidigast as DebtOriginDate
}

/**
 * FAKTURA — `issueDate`.
 *
 * Fakturan har inga periodfält alls; kandidaterna är `issueDate` och `dueDate`.
 * `issueDate` är den tidigare och den enda som beskriver när fordran ställdes
 * ut. Mätt i eken_dev: `issueDate <= dueDate` i 143 av 143 fall, noll undantag.
 *
 * Returnerar aldrig null — `issueDate` är icke-nullbar i schemat.
 */
export function resolveInvoiceDebtOrigin(invoice: { issueDate: Date }): DebtOriginDate {
  return invoice.issueDate as DebtOriginDate
}

/**
 * Är avgiften avtalsgrundad? Regeln, en gång.
 *
 * Grinden i `bookReminderFee` använder den för att vägra bokföra. Anroparna
 * använder den FÖRE sitt anspråk för att veta om avgiften alls ska tas ut —
 * och det är inte en dubblering av regeln, utan samma funktion på två ställen.
 *
 * ── VARFÖR ANROPARNA MÅSTE FRÅGA FÖRST ────────────────────────────────────
 *
 * Avgiften tas på TVÅ ställen: ett verifikat OCH en markering i reskontran
 * (`RentNotice.reminderFeeAmount` respektive fakturans `total` + avgiftsrad).
 * Reskontramarkeringen skrivs i samma anspråk som statusflippen, alltså INNAN
 * bokföringen. Vägrade grinden först i bokföringen skulle reskontran påstå
 * 60 kr som huvudboken inte bär — exakt den divergens #357 stängde, med omvänt
 * tecken. Anroparen måste därför veta före anspråket och klampa avgiften till 0.
 *
 * Grinden i `bookReminderFee` blir då aldrig den som faktiskt fäller i
 * produktion — den är sista försvarslinjen mot en framtida anropare som glömmer
 * fråga. Det är avsiktligt: en spärr som bara finns hos anroparen är ingen
 * spärr mot nästa anropare.
 */
export function isReminderFeeContractuallyAllowed(
  debtOrigin: DebtOriginDate | null,
  termsFrom: Date | null,
): boolean {
  if (debtOrigin == null) return false
  if (termsFrom == null) return false
  return termsFrom.getTime() <= debtOrigin.getTime()
}
