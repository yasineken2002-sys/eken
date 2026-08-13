/**
 * Söktermer per paragraf — INDEXERAD text skild från CITERBAR text (#406 PR3).
 *
 * PROBLEMET SOM MÄTTES: hyresvärden skriver "påminnelseavgift", lagen skriver
 * "skriftlig betalningspåminnelse" och "ersättning". BM25 poängsätter exakta
 * stammar, så inkassokostnadslagen 2 § — regeln som bär RÄTTEN till avgiften,
 * och som produktens egen grind isReminderFeeContractuallyAllowed implementerar
 * — fick score 0,00 på huvudfrågan. Den enda inkassoparagraf som fick lexikal
 * poäng var 4 a §: förseningsersättning MELLAN NÄRINGSIDKARE, alltså fel regel
 * för en bostadshyresgäst.
 *
 * VAD DEN HÄR FILEN ÄR: en söktermsrad per paragraf som BM25 indexerar jämte
 * lagtexten. Termerna är sökvokabulär, aldrig innehåll.
 *
 * ── TRE GRÄNSER SOM INTE FÅR SUDDAS ─────────────────────────────────────────
 * 1. `legalChunkContentHash` hashar ENBART `chunk.text`. En sökterm får aldrig
 *    ingå: hashen är embedding-tabellens idempotensnyckel, och ändras den blir
 *    alla 427 vektorer stale — stale-hash-vakten släcker då hela den semantiska
 *    kanalen. Låst av legal-search-terms.spec.ts.
 * 2. Söktermer når ALDRIG AI:n, relevansdomaren eller en källrad.
 *    buildContextBlock, buildRelevanceJudgePrompt och buildSourceCitation läser
 *    `chunk.text` och metadata — aldrig den här filen. Citat-integriteten
 *    (gap A) är därmed oförändrad. Låst av samma spec.
 * 3. Ingen chunk skapas eller tas bort. N förblir 427, så golvets kalibrering
 *    (MIN_TOP_SCORE_CALIBRATED_AT_CHUNKS) gäller fortfarande.
 *
 * ── VARFÖR `reason` ÄR OBLIGATORISK ─────────────────────────────────────────
 * En bar ordlista är precis den tysta uppräkning #382/#390 varnar för: den
 * växer, ingen minns varför en rad finns, och ingen vågar ta bort något. Varje
 * post bär därför vilket UPPMÄTT gap den stänger, med fallnamn ur eval-setet.
 * En term utan mätning bakom sig hör inte hemma här.
 *
 * ── URVALET ÄR MÄTT, INTE HITTAT PÅ ─────────────────────────────────────────
 * Listan är variant B ur `docs/research/406-grind-kartlaggning.md`, med tre
 * termer strukna: `sextio kronor` (4 §) samt `förseningsersättning` och
 * `fyrahundrafemtio kronor` (4 a §). De stod redan ordagrant i sin egen
 * paragraftext och tillförde ingen ny vokabulär — de höjde bara termfrekvensen
 * för ord paragrafen redan hade. Strykningen mättes om (samma skript), och den
 * gör separationen 2 § / 4 a § marginellt STARKARE, aldrig svagare.
 *
 * KVARSTÅENDE RISK, oförändrad: listan är ändlig och skriven av någon som sett
 * eval-frågorna. Det starka i mätningen är att den inte rör resten av korpusen
 * (max |Δscore| 0,03 på 21 icke-inkassofall) — inte att lyftet sker.
 */
import { legalChunkId, type LegalChunk } from './legal-chunk'

export interface LegalSearchTermEntry {
  /** Sökvokabulär som indexeras jämte paragraftexten. Aldrig visad för någon. */
  terms: string[]
  /** Vilket UPPMÄTT gap posten stänger, med fallnamn ur LEGAL_EVAL_SET. */
  reason: string
}

/**
 * Nyckel = `legalChunkId(chunk)`. Att varje nyckel resolvar till en chunk som
 * faktiskt finns verifieras av specen — en nyckel med stavfel vore annars en
 * tyst no-op.
 */
export const LEGAL_SEARCH_TERMS: Record<string, LegalSearchTermEntry> = {
  'inkassokostnadslagen:1': {
    terms: [
      'inkassokostnader',
      'ersättning för kostnader',
      'obetald skuld',
      'förfallen faktura',
      'gäldenär borgenär',
      'lagens tillämpningsområde',
    ],
    reason:
      'Tillämpningsparagrafen saknar helt hyresvärdens vokabulär: lagen säger ' +
      '"förfallen skuld", hyresvärden säger "obetald faktura", och ordet ' +
      '"inkassokostnader" finns bara i lagens TITEL, aldrig i paragraftexten. ' +
      'Ingen fråga i eval-setet pekar på 1 § som facit — posten finns för att ' +
      'de övriga sex paragraferna villkorar på den (4 § och 6 § hänvisar till ' +
      '"kostnader som avses i 1 §"), inte för att vinna ett enskilt fall.',
  },
  'inkassokostnadslagen:2': {
    terms: [
      'påminnelseavgift',
      'avgift för betalningspåminnelse',
      'rätt till ersättning för påminnelse',
      'avtalad avgift',
      'sen betalning',
    ],
    reason:
      'KÄRNGAPET i #406. Uppmätt före PR3: BM25-score 0,00 på ' +
      'paminnelseavgift-ratten, paminnelseavgift-taket, ' +
      'paminnelseavgift-avtalskravet, paminnelseavgift-vad-galler, ' +
      'paminnelseavgift-vad-sager-lagen och kravbrev-avgift — sex av åtta fall ' +
      'där paragrafen är osynlig för den lexikala kanalen. Ordet ' +
      '"påminnelseavgift" finns inte någonstans i korpusen; lagen skriver ' +
      '"skriftlig betalningspåminnelse". Efter posten rankas 2 § över 4 a § i ' +
      '8 av 8 fall (före: 2 av 8) och når domarens fönster på huvudfallet.',
  },
  'inkassokostnadslagen:3': {
    terms: [
      'kravavgift',
      'avgift för kravbrev',
      'inkassokrav',
      'amorteringsplan',
      'avbetalningsplan',
    ],
    reason:
      'kravbrev-avgift (facit 3 §) låg på 6,58 — under golvet 9 — trots att ' +
      '3 § var dess lexikala topp. Lagtexten skriver "krav rörande skulden" och ' +
      '"plan för amortering"; hyresvärden skriver "kravavgift" och ' +
      '"amorteringsplan". Posten är också SKILJEMARKÖREN mot 2 §: krav (3 §) är ' +
      'inte påminnelse (2 §), och utan egen vokabulär skulle 3 § tappa sina ' +
      'egna frågor till 2 §.',
  },
  'inkassokostnadslagen:4': {
    terms: [
      'tak för påminnelseavgift',
      'högsta belopp',
      'avgiftens storlek',
      'skäliga kostnader',
      'kravavgiftens storlek',
    ],
    reason:
      'paminnelseavgift-taket (facit 4 §) hade 1,76 i BM25-topp — lägst av ' +
      'samtliga eval-fall. Att posten bär "påminnelseavgift" jämte 2 § är ' +
      'AVSIKTLIGT: 2 § bär rätten till avgiften och 4 § bär taket för samma ' +
      'avgift, så båda ska vara sökbara på ordet. Det är också vad som gör ' +
      'mätningen ärlig — hade bara 2 § fått ordet skulle varje fråga om ' +
      'påminnelseavgift trivialt landa där.',
  },
  'inkassokostnadslagen:4 a': {
    terms: [
      'näringsidkare mellan företag',
      'företagsfordran',
      'kommersiell betalning',
      'myndighet som kund',
    ],
    reason:
      'FELPARAGRAFEN, och därför den viktigaste posten att skriva ÄRLIGT. 4 a § ' +
      'var före PR3 den enda inkassoparagraf som fick lexikal poäng på ' +
      'huvudfrågan (6,82 mot 2 §:s 0,00) — den drogs in på delade allmänord, ' +
      'inte på att den var rätt. Termerna pekar därför uttryckligen ut det som ' +
      'FAKTISKT avgränsar paragrafen: näringsidkare emellan, inte hyresgäst. ' +
      'Att ge 4 a § svagare vokabulär än den förtjänar hade gjort mätningen av ' +
      '"lyfter vi rätt paragraf?" meningslös.',
  },
  'inkassokostnadslagen:5': {
    terms: [
      'andra åtgärder utan ersättning',
      'avräkning mot förseningsersättning',
      'kostnader utan rätt till ersättning',
    ],
    reason:
      '5 § är den NEGATIVA regeln — vilka åtgärder som INTE ger ersättning — och ' +
      'formuleras i lagtexten som en dubbel negation ("är gäldenären inte ' +
      'skyldig att ersätta"). Inget eval-fall pekar på 5 § som facit; posten ' +
      'finns för att paragrafen annars är sökbar enbart på ord den delar med ' +
      '2 och 3 §§, som den uttryckligen undantar från.',
  },
  'inkassokostnadslagen:6': {
    terms: [
      'ogiltigt avtalsvillkor',
      'avtala om högre avgift',
      'avgiften kan inte avtalas bort',
      'tvingande regel',
    ],
    reason:
      'paminnelseavgift-hogre-i-avtal (facit 6 §) låg på 8,86 — 0,14 under ' +
      'golvet. Frågan ställs som "kan jag avtala om en högre avgift", medan ' +
      'lagtexten säger "utvidgas utöver vad som följer av denna lag är ' +
      'ogiltigt". 6 § är den paragraf som gör svaret sant: utan den blir svaret ' +
      '"du får ta ut en avgift" utan den begränsning som gäller.',
  },
}

/** Memoisering: söktermerna är statiska per process, som lagtexten. */
let cache: Map<string, string[]> | null = null

function index(): Map<string, string[]> {
  if (!cache) {
    cache = new Map(Object.entries(LEGAL_SEARCH_TERMS).map(([id, e]) => [id, e.terms]))
  }
  return cache
}

/**
 * Söktermerna för en chunk, eller tom lista. Ren och memoiserad — anropas per
 * chunk när BM25-indexet byggs.
 */
export function searchTermsFor(chunk: LegalChunk): string[] {
  return index().get(legalChunkId(chunk)) ?? []
}
