/**
 * REGELN: en delbetalning kräver en IDENTITET, inte ett belopp.
 *
 * ── VAD SOM SAKNADES (M1) ────────────────────────────────────────────────────
 *
 * En hyresgäst som betalade halva sin faktura fick INGENTING matchat. Pengarna
 * låg kvar som en omatchad banktransaktion, fakturan stod kvar som obetald i sin
 * HELHET, och den skuld kravtrappan räknar på var fel åt fel håll — den påstod
 * en större fordran än den verkliga. Samma betalning hade matchats om den avsett
 * en HYRESAVI: avi-vägens deterministiska OCR-gren har släppt igenom
 * delbetalningar sedan bank-härdningens PR 3b.
 *
 * Asymmetrin gick inte att försvara för den som drabbades av den, och den var
 * inte ett medvetet val: maskineriet fanns redan hela vägen. `applyMatchToInvoice`
 * har en fullständig trevägsklassificerare (full / delbetalning / överbetalning)
 * innanför radlåset, en `allowPartial`-parameter, en statusmaskinshärledd
 * PARTIAL-övergång och en `PAYMENT_PARTIAL`-händelse. Det enda som stod i vägen
 * var en förkontroll ute i `matchTransaction` som krävde att beloppet låg inom en
 * krona från fakturans TOTAL — alltså innan klassificeraren ens fick se fallet.
 *
 * ── VARFÖR FÖRKONTROLLEN VAR FEL, INTE BARA I VÄGEN ──────────────────────────
 *
 * Den mätte mot `invoice.total`, inte mot RESTSKULDEN. Följden var att även en
 * SLUTBETALNING inte matchade: en faktura på 10 000 kr med 4 000 kr redan
 * allokerad, som får sina sista 6 000 kr, föll på `10 000 − 6 000 = 4 000 > 1`.
 * Uppslaget hämtade uttryckligen status `PARTIAL` — och kunde sedan aldrig
 * reglera den. Klassificeraren innanför räknar mot `remaining` (krediteringar
 * inräknade, #517) och har alltid gjort det.
 *
 * ── DEN AVGÖRANDE SÄKERHETSREGELN ────────────────────────────────────────────
 *
 * **Ett belopp som är MINDRE än fakturan är inte ett svagare bevis för samma
 * faktura.** Det kan lika gärna vara FULL betalning av en annan, mindre faktura.
 * Utan en identifierare som pekar ut dokumentet entydigt är "delbetalning" bara
 * en gissning med ett vänligare namn — och till skillnad från en utebliven
 * matchning ser den ut som ett svar.
 *
 * Därför får `allowPartial` vara sant BARA på de grenar där identiteten redan är
 * fastställd innan beloppet ens vägs in:
 *
 *   ENTYDIGT   `Invoice.ocrNumber`      systemtilldelat, unikt per organisation
 *                                       (`@@unique([organizationId, ocrNumber])`, #553)
 *              `Invoice.invoiceNumber`  systemtilldelat dokumentnummer, unikt per
 *                                       organisation — samma slag som avins
 *                                       `noticeNumber`, som redan tillåter partial
 *              `RentNotice.ocrNumber` / `noticeNumber`   samma resonemang
 *              operatörens manuella val  en människa har pekat ut dokumentet
 *
 *   GISSNING   fuzzy (belopp + 90-dagarsfönster, exakt en kandidat)
 *              `Invoice.reference`      FRITEXT från klienten. #554 slog fast att
 *                                       det är en FÖRHOPPNING och inte en identitet:
 *                                       ingen formkontroll, ändringsbar via PATCH,
 *                                       och betalaren uppmanas aldrig att betala med
 *                                       det. Att den grenen får reglera en faktura
 *                                       FULLT är en bekvämlighet som redan fanns;
 *                                       att låta den dessutom skapa en DELBETALNING
 *                                       vore att bygga vidare på förhoppningen.
 *
 * Gränsen går alltså inte mellan "deterministisk" och "fuzzy", utan mellan
 * IDENTITET och FÖRHOPPNING — samma gräns som ocr-identity.ts drar, av samma skäl.
 *
 * ── ÖVERBETALNING: DEN OMVÄNDA RIKTNINGEN ────────────────────────────────────
 *
 * Att öppna en ny väg in till samma allokering väcker H4 igen (#483: en
 * överbetalning som skapar NEGATIV kundfordran). Bankvägen skyddas INTE av
 * `assertPaymentWithinDebt` — och det är avsiktligt, dokumenterat i
 * `common/payments/payment-within-debt.ts`: ett bankbelopp är ett MÄTT FAKTUM med
 * en kronas tolerans för öresavrundning, ett manuellt inskrivet belopp är ett
 * PÅSTÅENDE en människa kan rätta. Bankvägens motsvarighet är klassificerarens
 * tredje gren, som returnerar utan att allokera.
 *
 * Den nya vägen ärver det skyddet i sin helhet, därför att den går genom SAMMA
 * klassificerare — den lägger inte till någon egen gren. Se
 * `check-partial-match-identity.mjs` R5: varje ny ALLOKERINGSSKRIVARE måste
 * registreras, så en framtida dörr in till allokeringen inte kan öppnas tyst.
 */

/**
 * `allowPartial` när identiteten är fastställd. Skickas BARA från de vägar som
 * står i `ENTYDIGA_MATCHNINGSVAGAR`.
 */
export const PARTIAL_VID_ENTYDIG_IDENTITET = true

/**
 * `allowPartial` när matchningen vilar på ett belopp eller på fritext. Ett
 * delbelopp avvisas då av klassificeraren och transaktionen lämnas omatchad för
 * en människa — samma fail-closed-hållning som M2:s tidiga retur.
 */
export const PARTIAL_ALDRIG_VID_GISSNING = false

/**
 * De anropsställen som får skicka `PARTIAL_VID_ENTYDIG_IDENTITET`.
 *
 * Listan läses av `check-partial-match-identity.mjs` (R4): dyker konstanten upp
 * på ett ställe som inte står här, fäller guarden. Att lägga till en rad är
 * därför ett MEDVETET beslut om att just den grenen bär en identitet — inte
 * något som glider igenom i en refaktorering.
 */
export const ENTYDIGA_MATCHNINGSVAGAR = [
  'matchTransaction:notice-ocr',
  'matchTransaction:invoice-number',
  'matchTransaction:notice-number',
  'manualMatch:invoice',
  'manualMatch:notice',
] as const

/**
 * De anropsställen som måste skicka ett VILLKORAT uttryck — alltså ett uttryck
 * som nämner BÅDA konstanterna.
 *
 * Ett sådant ställe kan nås med identiteten fastställd ELLER inte, och måste
 * därför avgöra saken vid anropet. I dag finns exakt ett: fakturans OCR-gren,
 * vars uppslag träffar antingen `Invoice.ocrNumber` (identitet) eller
 * `Invoice.reference` (fritext, en förhoppning — #554).
 *
 * ── VARFÖR REGISTRET FINNS ───────────────────────────────────────────────────
 *
 * Uppmätt i den här PR:ens negativkontroll 2. Guarden räknade först bara HUR
 * MÅNGA ställen som nämner identitetskonstanten. Byter man då
 *
 *     fakturaViaIdentitet ? PARTIAL_VID_ENTYDIG_IDENTITET : PARTIAL_ALDRIG_VID_GISSNING
 *
 * mot ett bart `PARTIAL_VID_ENTYDIG_IDENTITET` är antalet OFÖRÄNDRAT — och
 * guarden rapporterade GRÖNT om exakt den gissningsmaskin den byggts för att
 * fånga. Formen måste alltså räknas, inte bara förekomsten.
 */
export const VILLKORADE_MATCHNINGSVAGAR = ['matchTransaction:invoice-ocr'] as const

/**
 * De funktioner som får SKRIVA en betalningsallokering i reconciliation.service.ts.
 *
 * Varje `invoicePayment.create` / `rentNoticePayment.create` måste ligga i en av
 * dem (R5). Poängen är inte att de fyra är bevisat korrekta — det är att en
 * FEMTE inte kan tillkomma tyst. Ett nytt allokeringsställe är en ny dörr in till
 * pengarna, och H4 uppstod just för att en sådan dörr saknade den spärr som den
 * andra vägen hade.
 *
 * ⚠️ GUARDENS GRÄNS, UTSKRIVEN: R5 mäter att dörren är REGISTRERAD, inte att den
 * avvisar överbetalning. Den egenskapen mäts beteendemässigt i
 * `invoice-partial-auto-match.spec.ts` (negativkontroll 3). En guard som påstod
 * sig mäta båda hade varit den sortens kontroll som inte kan falla.
 */
export const ALLOKERINGSSKRIVARE = [
  'applyMatchToInvoice',
  'applyMatchToRentNotice',
  'applyWaterfallToRentNotices',
] as const
