import { EFFECT_DECLARATIONS } from '../tools/effect-idempotency'

import type { EffectDeclaration } from '../tools/effect-idempotency'

/**
 * FÅR DET HÄR VERKTYGET ALLS BLI ETT UPPDRAG?
 *
 * Ren funktion, ingen databas, inga sidoeffekter. Grinden bor här och inte i
 * tjänsten av samma skäl som återupptagningsmotorns omdöme: den går att pröva
 * ensam mot påhittade deklarationer, utan en halv Nest-graf.
 *
 * ── ORDET "ATOMÄRT" FÖREKOMMER INTE I DEN HÄR KODEN ─────────────────────────
 *
 * Masterplanens Del 12 krävde att ett uppdrag prövar sina förutsättningar
 * "atomärt i samma transaktion som effekten". Mätningen 2026-09-02 mot `b0d72f6`
 * visade vad det kostar:
 *
 *     tool-executor.service.ts   4 407 rader · 56 case-etiketter
 *     $transaction i den filen   2   (create_journal_entry, record_expense)
 *     traceIntegrity=TRANSAKTIONELL  2 av 30
 *
 * De övriga 28 delegerar till domäntjänster som ÄGER sin egen transaktion.
 * Exekveraren kan inte gå med i den, så en förutsättningskontroll skriven i
 * uppdragslagret hamnar per konstruktion i en ANNAN transaktion än effekten.
 * Kravet var alltså inte en mekanism utan 28 refaktoreringar.
 *
 * ── ERSÄTTNINGSREGELN, SOM ÄR STARKARE OCH BYGGBAR ──────────────────────────
 *
 *     Omprövningen sker FÖRE effekten. Skyddet mot en dubblett kommer från
 *     verktygets EGEN nyckel — inte från en transaktionsgräns.
 *
 * Den är starkare därför att en transaktion bara skyddar mot en kapplöpning
 * INOM processen. Verktygets nyckel — ett unikt index, en statusgrind, en
 * innehållshash — skyddar även när effekten redan skedde i går, av en människa,
 * i en helt annan session. Det är den kapplöpning Del 12 faktiskt handlar om.
 *
 * Priset är att ett tidsfönster finns mellan omprövningen och effekten. I det
 * fönstret kan världen flytta sig. Utfallet blir då inte en dubbel effekt utan
 * ett ingenting — nyckeln känner igen sig — och det är precis vad vi vill.
 *
 * ── DÄRFÖR ÄR GRINDEN VID SKAPANDET, INTE VID UTFÖRANDET ────────────────────
 *
 * Ett uppdrag som inte får utföras ska inte kunna SKAPAS. Sitter grinden i
 * utförandet ligger uppdraget och ser giltigt ut i en lista, en människa säger
 * ja, och först då upptäcks att det aldrig var tillåtet. Då har vi flyttat
 * felet till efter godkännandet, vilket är den enda plats där det gör verklig
 * skada: hyresvärden tror att något är på väg att hända.
 */

/**
 * Spårplatser som INTE bär ett fördröjt uppdrag.
 *
 * `INGET` är uppenbar: finns inget spår kan ingen fråga om effekten redan
 * finns.
 *
 * ⚠️ `KÖ_FÖNSTER` FÄLLER INGENTING I DAG — mätt 2026-09-02, och det ska stå
 * här. Enda posten med det värdet är `send_invoice_email`, som redan avvisas av
 * IDEMPOTENT-kravet. Klausulen är alltså INERT: tas den bort ändras inte
 * mängden med ett enda verktyg.
 *
 * Den står kvar därför att den är riktad mot något mätt: `mail.queue.ts` sätter
 * `removeOnComplete: { age: 7 dygn, count: 1000 }`, och COUNT-taket biter före
 * ålderstaket. En organisation som skickar 1000 mejl på två dagar har tappat
 * sina äldsta jobId långt före dag sju. Ett spår i kön överlever alltså inte
 * ett uppdrag som väntar över natten — vilket är hela G3:s premiss.
 *
 * En inert klausul som inte kan fällas är en kommentar i förklädnad, så
 * `assignment-eligibility.spec.ts` matar in en påhittad deklaration som är
 * IDEMPOTENT med `plats: 'KÖ_FÖNSTER'` och kräver att den avvisas. Utan det
 * provet vet ingen om raden gör något den dag den behövs.
 */
const SPÅR_SOM_INTE_BÄR_ETT_UPPDRAG = new Set(['INGET', 'KÖ_FÖNSTER'])

export type Duglighet =
  | { duglig: true }
  | {
      duglig: false
      skäl: 'OKÄNT_VERKTYG' | 'ANDRAEFFEKT_MÖJLIG' | 'SPÅRET_BÄR_INTE'
      text: string
    }

/**
 * Den enda vägen till `duglig: true`, och den ligger sist.
 *
 * Ett nytt okänt tillstånd faller därför ut som ett nej av sig självt — man
 * måste aktivt lägga till ett steg för att öppna en dörr, aldrig glömma ett för
 * att stänga en. Samma konstruktion som `resumption-policy.ts`, och av samma
 * skäl.
 */
export function prövaDuglighet(toolName: string, deklarationer = EFFECT_DECLARATIONS): Duglighet {
  const dekl: EffectDeclaration | undefined = deklarationer[toolName]

  // 1. FINNS EN KLASSIFICERING? Läsverktygen (`get_*`) har ingen — bara de 30
  //    bindande verktygen är klassificerade. Ett okänt namn är alltså antingen
  //    ett läsverktyg, ett stavfel, eller ett nytt verktyg ingen tagit ställning
  //    till. Alla tre ska stoppas, och samma svar duger för alla tre.
  if (!dekl) {
    return {
      duglig: false,
      skäl: 'OKÄNT_VERKTYG',
      text: `Verktyget ${toolName} har ingen effektklassificering och kan inte bli ett uppdrag.`,
    }
  }

  // 2. KAN EN ANDRAEFFEKT UPPSTÅ?
  //
  //    `IDEMPOTENT` betyder att en omkörning ger SAMMA tillstånd, och att något
  //    i koden BÄR det — ett unikt index, en statusgrind, en innehållshash. Det
  //    är garantin regeln kräver.
  //
  //    `DEDUPLICERBAR` duger INTE, och skillnaden är precis den `effect-
  //    idempotency.ts` skriver ut: effekten är envägs, men en post KAN
  //    konsulteras före utförandet — "att den kan betyder inte att den gör det".
  //    Ett "kan" är ingen garanti, och grinden ska vara fail-closed.
  if (dekl.effectIdempotency !== 'IDEMPOTENT') {
    return {
      duglig: false,
      skäl: 'ANDRAEFFEKT_MÖJLIG',
      text:
        `Verktyget ${toolName} är klassificerat ${dekl.effectIdempotency} — ` +
        'en andra effekt kan uppstå om världen hunnit flytta sig. ' +
        'Bara verktyg vars egen nyckel utesluter en dubblett får bli uppdrag.',
    }
  }

  // 3. BÄR SPÅRET ÖVER NATTEN? Se noten över SPÅR_SOM_INTE_BÄR_ETT_UPPDRAG.
  if (SPÅR_SOM_INTE_BÄR_ETT_UPPDRAG.has(dekl.traceDurability.plats)) {
    return {
      duglig: false,
      skäl: 'SPÅRET_BÄR_INTE',
      text:
        `Verktyget ${toolName} har spårplats ${dekl.traceDurability.plats}, ` +
        'som inte överlever ett uppdrag som väntar över natten.',
    }
  }

  return { duglig: true }
}

/**
 * Hela mängden dugliga verktyg — HÄRLEDD, aldrig skriven som en lista.
 *
 * En uppräkning som skrivs för hand blir fel första gången någon lägger till ett
 * verktyg, och felet är tyst åt det farliga hållet: listan släpar efter koden
 * och ingen märker det.
 *
 * ── MÄTT 2026-09-02 MOT b0d72f6 ─────────────────────────────────────────────
 *
 *     ACTION_TOOLS                                        30
 *     dugliga som uppdrag (IDEMPOTENT + bärande spår)     23
 *     avvisade                                             7   alla DEDUPLICERBAR
 *
 * Talen står här som en mätpunkt, inte som ett krav — `assignment-eligibility.
 * spec.ts` härleder dem ur koden och fäller aldrig på ett tal i den här prosan.
 *
 * ── RELATIONEN TILL ÅTERUPPTAGNINGSMOTORN, OCH VARFÖR DEN INTE ÄR SAMMA FRÅGA ─
 *
 * `resumption-policy.ts` släpper igenom 12 verktyg. Alla 12 ligger inuti de 23
 * — mätt, inte antaget. Skillnaden är de 11 som är `KRÄVER_MÄNNISKA`, och den
 * skillnaden är RÄTT:
 *
 *     återupptagning   får en MASKIN köra om detta obevakat efter en krasch?
 *     uppdrag          kan en ANDRAEFFEKT uppstå om det utförs senare?
 *
 * Ett uppdrag har redan en människas ja. `KRÄVER_MÄNNISKA` betyder att en
 * dubblett skulle synas för någon utanför systemet — inte att en människa saknas.
 * Att låna återupptagningens policyfält hit hade svarat på fel fråga och tyst
 * stängt ute elva verktyg som en hyresvärd uttryckligen godkänt.
 *
 * ⚠️ Delmängdsrelationen är en MÄTNING som kan ruttna: ett verktyg som blir
 * `DEDUPLICERBAR` + `AUTOMATISK` med bärande spår vore återupptagbart utan att
 * vara uppdragsdugligt. Ingen sådan post finns i dag. Ingenting i koden vilar på
 * relationen — den står här för att förklara varför fälten inte får blandas ihop.
 */
export function dugligaVerktyg(deklarationer = EFFECT_DECLARATIONS): string[] {
  return Object.keys(deklarationer)
    .filter((namn) => prövaDuglighet(namn, deklarationer).duglig)
    .sort()
}
