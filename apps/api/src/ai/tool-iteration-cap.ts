/**
 * TURTAKET — ETT värde, EN betydelse, och ett SYNLIGT avbrott.
 *
 * ── DEN VÄRSTA FELMODEN ──────────────────────────────────────────────────────
 *
 * Taket låg som `= 3` på tre ställen. När det nåddes föll loopen ur, det sista
 * textblocket skrevs ut, inget fel kastades och ingen markering gjordes. AI:n
 * kunde alltså SE UT att ha utfört en uppgift när den stannade halvvägs.
 *
 * I ett system som rör pengar är det den värsta felmoden som finns: den ser ut
 * som framgång, så ingen letar efter den. Kommentaren i koden sa till och med
 * `// end_turn or max iterations reached` — de två fallen behandlades likadant
 * trots att det ena är ett färdigt svar och det andra ett avbrutet arbete.
 *
 * ── SAMMA TAL, TVÅ OLIKA BETYDELSER (mätt) ───────────────────────────────────
 *
 * De tre konstanterna hade redan glidit isär — inte i värde, utan i BETYDELSE:
 *
 *   Tjänstevägen  modellanropet ligger FÖRE loopen, och ett till i slutet av
 *                 varje varv. Med taket 3 gjordes 4 modellanrop och 3
 *                 verktygsomgångar, och modellen fick SE resultatet av den
 *                 tredje omgången innan den svarade.
 *
 *   SSE-vägen     modellanropet ligger FÖRST I varvet. Med taket 3 gjordes 3
 *                 modellanrop och 3 verktygsomgångar — och den TREDJE omgångens
 *                 resultat skickades ALDRIG till modellen. Arbetet utfördes och
 *                 kastades bort. Effektivt fick modellen 2 användbara omgångar,
 *                 inte 3.
 *
 * Ett tal som betyder olika saker på olika vägar är inte ett gemensamt tak. Båda
 * looparna är därför omskrivna till samma form, och taket har numera EN
 * definition:
 *
 *   **N = antalet verktygsomgångar modellen får ANVÄNDA.**
 *   Modellen anropas upp till N+1 gånger; verktyg körs upp till N gånger; det
 *   (N+1):a anropets text är svaret.
 *
 * ── ÄR 3 RÄTT TAL? (mätt, inte gissat) ───────────────────────────────────────
 *
 * Frågan ställs ofta om ACTION_TOOLS, och det är fel mängd att titta på:
 *
 *   ACTION_TOOLS   30 st — BINDANDE. De stoppar loopen omedelbart (turen går
 *                  till bekräftelse) och förbrukar därför NOLL turer.
 *   Läsverktyg     26 st — det är DE som förbrukar turbudgeten.
 *
 * (Talet stod som 29 fram till 2026-08-28. Det var EFFECT_PRODUCING_TOOLS-
 * antalet, alltså ACTION_TOOLS minus `export_sie4` som inte rör data. Härlett ur
 * koden: TOOLS 56, ACTION_TOOLS 30, EFFECT_PRODUCING_TOOLS 29, läsverktyg 26.
 * Samma tal som #573 mätte när effektvakten läste 29 av 30 verktyg — en siffra i
 * en kommentar som motsäger vakten bredvid får nästa läsare att tro fel.)
 *
 * Av de 26 läsverktygen tar **17** ett id (`tenantId`, `invoiceId`, `propertyId`,
 * `leaseId`, `unitId`, `noticeId`, `transactionId`) som bara ett ANNAT verktyg
 * kan ge. De tvingar alltså fram en SEKVENS, inte parallella anrop.
 *
 * Golvet blir därmed:
 *
 *   ett hopp   "visa fastigheterna"                       1 omgång
 *   två hopp   "obetalda avier för hyresgäst X"           2 omgångar
 *   tre hopp   "hyresgäster i fastighet X med obetalt"    3 omgångar
 *
 * Tre omgångar räcker alltså för en trehoppsfråga — MEN bara med den rättade
 * semantiken ovan. Med den gamla SSE-loopen fick en sådan fråga aldrig sitt svar.
 *
 * TALET HÖJS DÄRFÖR INTE. Fyndet var att den ena vägen slösade bort sin sista
 * omgång, inte att budgeten var för liten; att höja hade dolt det. Ett tak som
 * höjs på känsla är samma sorts gissning som resten av veckan gått åt till att
 * rätta. När `AiUsageLog.capReached` samlat data går frågan att avgöra på
 * frekvens i stället för på resonemang — vilket är hela poängen med att logga den.
 */

/**
 * Antalet verktygsomgångar modellen får ANVÄNDA. Se filens huvud för semantiken.
 *
 * ENDA definitionen. `check-tool-iteration-cap.mjs` fäller om en fjärde konstant
 * med ett eget tal införs, eller om någon loop slutar läsa den här.
 */
export const MAX_TOOL_ROUNDS = 3

/**
 * Markeringen användaren får när taket nås.
 *
 * ── VARFÖR ORDALYDELSEN ÄR SOM DEN ÄR ────────────────────────────────────────
 *
 * Den ska INTE gå att läsa som ett vanligt svar. Därför: inget "kanske", ingen
 * ursäkt som glider över i en avslutning, och ett uttryckligt påstående om att
 * uppgiften INTE slutfördes — placerat efter modellens egen text, som ofta är en
 * inledning ("Jag ska bara kolla ...") och därför i sig låter som att arbete
 * pågår.
 *
 * Raden om att inget ska antas utfört är inte överdrift: den avbrutna turen kan
 * ha hunnit köra LÄSVERKTYG, men aldrig ett bindande verktyg — de går alltid via
 * bekräftelse. Användaren ska ändå inte behöva känna till den skillnaden för att
 * veta att svaret är ofullständigt.
 */
export const TOOL_ITERATION_CAP_NOTICE =
  `\n\n⚠️ **Uppgiften slutfördes inte.** Jag nådde gränsen på ${MAX_TOOL_ROUNDS} ` +
  'verktygsomgångar och avbröts mitt i arbetet. Svaret ovan är ofullständigt — ' +
  'utgå inte från att något som nämns är utfört. Dela upp frågan i mindre steg ' +
  'och fråga igen.'

/**
 * Vill modellen ha ännu en verktygsomgång?
 *
 * `stop_reason === 'tool_use'` betyder att turen inte är färdig. Ett avslutat
 * svar har `end_turn` (eller `max_tokens`/`stop_sequence`), aldrig `tool_use`.
 */
export function wantsAnotherToolRound(stopReason: string | null | undefined): boolean {
  return stopReason === 'tool_use'
}

/**
 * Nåddes taket? — ENDA definitionen, delad av alla tre looparna.
 *
 * BÅDA villkoren krävs. Att grinda enbart på räknaren (`roundsUsed >= N`) hade
 * gett ett falskt larm i det vanligaste fallet av alla: modellen blev klar på
 * precis sista varvet, alltså ett FULLSTÄNDIGT svar. Ett larm som larmar för
 * ofta läses snart inte alls — och då är markeringen värdelös just när den
 * behövs. Att grinda enbart på `stop_reason` hade omvänt varit fel i SSE-loopen,
 * där kontrollen sker mitt i varvet.
 */
export function reachedToolIterationCap(
  stopReason: string | null | undefined,
  roundsUsed: number,
): boolean {
  return wantsAnotherToolRound(stopReason) && roundsUsed >= MAX_TOOL_ROUNDS
}
