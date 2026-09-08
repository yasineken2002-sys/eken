/**
 * DE DETERMINISTISKA REGLERNA FÖR AGENT 2 — FÖRE MODELLEN, ALLTID.
 *
 * ── LÄRDOMEN SOM GÖR DEN HÄR FILEN TILL DEN VIKTIGA ─────────────────────────
 *
 * Agent 1:s prioritet mättes till att vara HELT deterministisk i praktiken:
 * registrerad + regler gav 50/54, och modellen bidrog noll åt båda hållen.
 * Modellens inflytande togs då bort STRUKTURELLT (`triage-rules.ts`), inte
 * genom en instruktion i prompten. Samma hållning här: modellen får aldrig
 * peka ut en avi som reglerna inte redan tagit fram, och den får aldrig svara
 * med fritext. Kan den bara välja bland kandidater och avstå, går det inte att
 * få ut ett svar som inte redan var möjligt.
 *
 * ── FILEN SKRIVER ALDRIG PENGAR, OCH DÄRFÖR RÄCKER `number` ─────────────────
 *
 * Belopp bärs som kronor i `number` här. Det vore fel i en bokföringsväg och är
 * rätt i den här: modulen RANGORDNAR kandidater, den beräknar aldrig ett belopp
 * som bokförs. Det faktiska beloppet tas av `ReconciliationService` ur
 * `BankTransaction.amount` (`Decimal`) när en människa godkänt. En avrundning
 * här kan i värsta fall släppa in eller utesluta en kandidat — den kan inte
 * flytta en krona.
 *
 * ── VARFÖR TRÖSKLARNA INTE ÄR IMPORTERADE FRÅN AVSTÄMNINGEN ─────────────────
 *
 * `reconciliation.service.ts` har `new Decimal('1.00')` och ett 90-dagarsfönster.
 * De ser identiska ut och svarar på en ANNAN fråga:
 *
 *     avstämningens tolerans   får det här bokföras AUTOMATISKT?
 *     kandidatfiltrets         är det här värt att VISA för en människa?
 *
 * Kandidatfönstret får vara bredare, men det nuvarande förslaget kan bara
 * matcha hela bankraden mot en fordran. Belopp över dess utestående utesluts
 * därför även här. Detta gör inte förslaget till en automatisk bokföring.
 */

/** Beloppet stämmer på öret — signalen bär ensam. Speglar avstämningens tolerans. */
export const TOLERANS_KR = 1

/** Samma bredd som avstämningens fuzzy-fönster — men av eget skäl, se ovan. */
export const FONSTER_DAGAR = 90

/**
 * Hur fel ett OCR får vara och ändå räknas som en signal.
 *
 * ETT tecken: en felskriven siffra, en utelämnad siffra eller två som bytt
 * plats. Två fel är inte längre ett skrivfel utan ett annat nummer, och en
 * regel som accepterar det pekar ut fel hyresgäst med hög konfidens — precis
 * det identitetsgrinden (`ocr-identity.ts`) finns för att förhindra.
 */
export const OCR_MAX_AVSTAND = 1

/**
 * Taket på hur många kandidater modellen får se.
 *
 * Taket SYNS: `provaKandidater` returnerar `takNått` så att en trunkering blir
 * ett tal och inte en tystnad. En uppräkning som krymper tyst är samma defekt
 * som ett `head` i ett svep.
 */
export const MAX_KANDIDATER = 5

export type Kandidatsort = 'AVI' | 'FAKTURA'

export interface Kandidat {
  id: string
  sort: Kandidatsort
  /** `noticeNumber` / `invoiceNumber` — läsytans identitet, aldrig id:t. */
  nummer: string
  ocr: string | null
  /** Utestående belopp i kronor (payable minus krediteringar och allokeringar). */
  utestaende: number
  forfallodatum: Date
  motpartId: string | null
  motpartNamn: string | null
}

export interface Bankrad {
  id: string
  datum: Date
  text: string
  /** Inbetalt belopp i kronor. Alltid positivt — ingest avvisar övriga. */
  belopp: number
  rawOcr: string | null
}

export interface RankadKandidat extends Kandidat {
  /** Antal tecken OCR:et skiljer sig, eller `null` när jämförelse inte går. */
  ocrAvstand: number | null
  /** |utestående − inbetalt|, i kronor. */
  beloppsavvikelse: number
  dagarFranForfall: number
  namnTraff: boolean
  /** Vilka regler som släppte in kandidaten. Ordagrant till förslagets `evidence`. */
  signaler: string[]
}

export type Regelutfall =
  | { typ: 'INGEN_FRAGA'; skäl: string }
  | { typ: 'INGEN'; skäl: string }
  | { typ: 'KANDIDATER'; kandidater: RankadKandidat[]; takNått: boolean }

/** Gemener, bokstäver och siffror kvar, allt annat till mellanslag. Bevarar å/ä/ö. */
export function normalisera(text: string): string {
  return text
    .toLocaleLowerCase('sv-SE')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/**
 * Hur många tecken skiljer två OCR-nummer?
 *
 * Tre former, och bara tre:
 *   samma längd        → antal positioner som skiljer (felskriven siffra,
 *                        och två som bytt plats ger 2)
 *   längd skiljer 1    → 1 om den korta är den långa med EN siffra borttagen
 *   annars             → null, "går inte att jämföra"
 *
 * `null` och `0` är olika svar och får aldrig blandas ihop: det första betyder
 * att regeln inte kunde uttala sig, det andra att numren är IDENTISKA.
 */
export function ocrAvstand(a: string | null, b: string | null): number | null {
  if (!a || !b) return null
  const x = a.replace(/\D/g, '')
  const y = b.replace(/\D/g, '')
  if (!x || !y) return null
  if (x === y) return 0
  if (x.length === y.length) {
    let n = 0
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) n++
    return n
  }
  if (Math.abs(x.length - y.length) === 1) {
    const lang = x.length > y.length ? x : y
    const kort = x.length > y.length ? y : x
    for (let i = 0; i < lang.length; i++) {
      if (lang.slice(0, i) + lang.slice(i + 1) === kort) return 1
    }
    return null
  }
  return null
}

/**
 * Står motpartens namn i bankradens text?
 *
 * Bara namndelar på minst fyra tecken. Kortare delar ("af", "von", "li") ger
 * träff i var och varannan banktext och hade gjort signalen värdelös utan att
 * göra den tyst — den hade bara börjat peka överallt.
 */
export function namnTraff(text: string, namn: string | null): boolean {
  if (!namn) return false
  const hö = normalisera(text)
  const delar = normalisera(namn)
    .split(' ')
    .filter((d) => d.length >= 4)
  if (delar.length === 0) return false
  return delar.some((d) => hö.includes(d))
}

function dagarMellan(a: Date, b: Date): number {
  return Math.round(Math.abs(a.getTime() - b.getTime()) / 86_400_000)
}

/**
 * Regelutfallet för EN bankrad.
 *
 * Ordningen är fail-closed och billig först, precis som i agent 1: det som kan
 * avgöras utan ett modellanrop avgörs här.
 *
 *   1. EXAKT OCR-träff → INGEN_FRAGA. Automatiken tar redan den raden
 *      (`matchTransaction` gren 1), och ett förslag om något som händer ändå är
 *      brus i inkorgen.
 *   2. Inga kandidater → INGEN. Ett aktivt nej, inte tystnad — se `INGEN_AVI`.
 *   3. Annars kandidaterna, rangordnade och med taket synligt.
 */
export function provaKandidater(
  rad: Bankrad,
  kandidater: readonly Kandidat[],
  nu: Date = new Date(),
): Regelutfall {
  void nu
  const exakt = rad.rawOcr
    ? kandidater.find((k) => k.ocr && ocrAvstand(rad.rawOcr, k.ocr) === 0)
    : undefined

  // ── ETT EXAKT OCR RÄCKER INTE — BELOPPET MÅSTE OCKSÅ RYMMAS ──────────────
  //
  // Regeln stod först som "exakt OCR → INGEN_FRAGA", och det var fel på ett
  // sätt som bara syntes när mätkorpusen byggdes. En DUBBELBETALNING bär ett
  // KORREKT OCR: hyresgästen betalar samma avi två gånger, och den andra raden
  // har alltså exakt rätt nummer. `applyMatchToRentNotice` avvisar den som en
  // ÖVERBETALNING och raden blir UNMATCHED — men den gamla regeln såg OCR:et,
  // svarade "automatiken tar den" och föreslog aldrig något.
  //
  // Utfallet hade varit den tystnad som är värst: pengar på kontot, ingen
  // matchning, och ingen fråga. Villkoret nedan säger det regeln egentligen
  // menade: automatiken tar raden när OCR:et löser ut OCH beloppet ryms i det
  // utestående. Gör det inte det är OCR:et en SIGNAL, inte ett svar, och
  // kandidaten går vidare till förslaget som alla andra.
  if (exakt && rad.belopp <= exakt.utestaende + TOLERANS_KR) {
    return {
      typ: 'INGEN_FRAGA',
      skäl:
        `bankradens OCR ${String(rad.rawOcr)} löser ut mot ${exakt.nummer} och beloppet ryms ` +
        'i det utestående — avstämningens deterministiska gren tar den, och ett förslag ' +
        'hade bara varit brus.',
    }
  }

  const inomFonstret = kandidater.filter(
    (k) => dagarMellan(k.forfallodatum, rad.datum) <= FONSTER_DAGAR,
  )

  const rankade: RankadKandidat[] = []
  for (const k of inomFonstret) {
    // Ett förslag matchar hela bankraden mot EN fordran. OCR och namn kan
    // identifiera en post, men kan inte göra plats för ett överskjutande belopp.
    // Filtrera före rangordning och tak så att omöjliga val inte tränger ut
    // giltiga kandidater. Delbetalningar har ingen motsvarande nedre gräns.
    if (k.utestaende <= 0 || rad.belopp > k.utestaende + TOLERANS_KR) continue
    const avstånd = ocrAvstand(rad.rawOcr, k.ocr)
    const avvikelse = Math.abs(k.utestaende - rad.belopp)
    const namn = namnTraff(rad.text, k.motpartNamn)
    const signaler: string[] = []

    if (avstånd !== null && avstånd <= OCR_MAX_AVSTAND) {
      signaler.push(`OCR skiljer ${avstånd} tecken från ${String(k.ocr)}`)
    }
    if (avvikelse <= TOLERANS_KR) {
      signaler.push(`beloppet stämmer inom ${TOLERANS_KR} kr`)
    }

    // Namnet kan föra fram även en mycket liten delbetalning. Att kandidaten
    // finns här är inte ett beslut om identitet; modellen kan fortfarande avstå.
    if (namn) {
      signaler.push(
        avvikelse <= TOLERANS_KR
          ? 'motpartens namn står i banktexten'
          : `motpartens namn står i banktexten och beloppet (${avvikelse.toFixed(2)} kr ifrån) ` +
              'överstiger inte det utestående',
      )
    }
    if (signaler.length === 0) continue

    rankade.push({
      ...k,
      ocrAvstand: avstånd,
      beloppsavvikelse: avvikelse,
      dagarFranForfall: dagarMellan(k.forfallodatum, rad.datum),
      namnTraff: namn,
      signaler,
    })
  }

  if (rankade.length === 0) {
    return {
      typ: 'INGEN',
      skäl:
        'ingen öppen avi eller faktura som rymmer hela betalningen inom fönstret bär ett närliggande OCR, ett belopp ' +
        `inom ${TOLERANS_KR} kr eller ett namn som står i banktexten.`,
    }
  }

  // Rangordningen är DETERMINISTISK hela vägen ned till id:t. Två kandidater
  // med identiska signaler får annars olika ordning mellan två körningar, och
  // en mätning mot korpusen blir då omöjlig att reproducera.
  rankade.sort((a, b) => {
    const ao = a.ocrAvstand ?? 99
    const bo = b.ocrAvstand ?? 99
    if (ao !== bo) return ao - bo
    if (a.beloppsavvikelse !== b.beloppsavvikelse) return a.beloppsavvikelse - b.beloppsavvikelse
    if (a.namnTraff !== b.namnTraff) return a.namnTraff ? -1 : 1
    if (a.dagarFranForfall !== b.dagarFranForfall) return a.dagarFranForfall - b.dagarFranForfall
    return a.id < b.id ? -1 : 1
  })

  return {
    typ: 'KANDIDATER',
    kandidater: rankade.slice(0, MAX_KANDIDATER),
    takNått: rankade.length > MAX_KANDIDATER,
  }
}

/**
 * Full eller del? EN plats, läst av både förslaget och facit.
 *
 * Toleransen är densamma som kandidatfiltrets snäva: betalar hyresgästen en
 * krona för lite är avin i praktiken reglerad, och att kalla det en
 * delbetalning hade gjort facit oense med avstämningen.
 */
export function beloppsutfall(inbetalt: number, utestaende: number): 'FULL' | 'DEL' {
  return utestaende - inbetalt > TOLERANS_KR ? 'DEL' : 'FULL'
}
