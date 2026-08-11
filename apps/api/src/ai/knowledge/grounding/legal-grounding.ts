/**
 * Juridisk grundning av operator-AI:n (Etapp 2, PR 2.3a) — kopplar retrieval
 * (PR 2.2) till produktchatten med CITAT-INTEGRITET (gap A) som bärande invariant:
 *
 *   AI:n skriver SVARET i ord, men får ALDRIG skriva den auktoritativa källan.
 *   KODEN binder källhänvisningen ur de hämtade chunkarnas metadata
 *   (lag + paragraf + SFS + verifieradPer). `buildSourceCitation` kan per
 *   signatur bara se chunkar — aldrig AI-text — så en hallucinerad källa är
 *   FYSISKT OMÖJLIG, inte bara upptäckbar.
 *
 * MISS-GRIND (gap B, PR 2.3b) — tvåstegsgrind före grundning:
 *   Steg 1 (deterministisk, här): ingen träff eller mätbart svag träff
 *     (BM25-score/query-täckning under kalibrerade golv) → MISS.
 *   Steg 2 (semantisk, i AiAssistantService.resolveLegalGrounding): en billig
 *     Haiku-relevansdomare avgör om kandidat-paragraferna faktiskt innehåller
 *     den materiella regel frågan gäller. Uppmätt nödvändigt: lexikalt starka
 *     men semantiskt fel träffar (t.ex. uppsägnings-boilerplate på en
 *     besittningsskyddsfråga) är omöjliga att skilja på score/täckning.
 *   Vid MISS injiceras ett ärlighetsblock ("hittar inte den exakta regeln —
 *   stäm av med jurist") och INGEN kod-bunden källrad sätts — det fanns inget
 *   att grunda i. Grundning sker ALDRIG förbi domaren: denna modul exponerar
 *   bara kandidat-utvärdering + grundnings-/miss-byggare, inte en direktväg.
 *
 * Avgränsning (medveten):
 *   - Gap C: endast operator-AI:n. Tenant-AI:n importerar INTE denna modul.
 *
 * Denna modul: ingen AI, ingen modell, inga sidoeffekter — ren text→text-logik.
 * (Domaranropet bor i servicen; här finns bara dess prompt + verdiktparser.)
 */
import {
  retrieveLegalChunks,
  type HybridLegalRetrieval,
  type RetrievedChunk,
} from '../retrieval/legal-retrieval'
import type { LegalChunk } from '../retrieval/legal-chunk'
import { getLegalDocument } from '../legal-knowledge'

export interface LegalGrounding {
  outcome: 'grounded'
  /** De hämtade paragraf-chunkarna — den ENDA tillåtna källan till källhänvisning. */
  chunks: LegalChunk[]
  /** Systemblock: verifierad lagtext + grundningsinstruktion (injiceras i AI:ns kontext). */
  contextBlock: string
  /** Kod-bunden källhänvisning — byggd ENBART ur chunk-metadata, aldrig ur AI-text. */
  sourceCitation: string
}

/** Varför grinden bedömde frågan som miss (observabilitet + test). */
export type LegalMissReason =
  | 'no-hits' // retrieval hämtade ingenting
  | 'weak-retrieval' // träffen under de deterministiska golven (steg 1)
  | 'judge-rejected' // relevansdomaren bedömde träffen som fel regel (steg 2)
  | 'judge-unavailable' // domaranropet misslyckades/ogiltigt svar → fail-safe till miss

export interface LegalGroundingMiss {
  outcome: 'miss'
  reason: LegalMissReason
  /** Systemblock: ärlighetsinstruktion (hittade ingen regel → rekommendera jurist). */
  contextBlock: string
}

/** null = inte en juridisk fråga (ingen grundning, AI:n svarar som vanligt). */
export type LegalGroundingResult = LegalGrounding | LegalGroundingMiss | null

/** Steg 1-utfall: kandidat som ska vidare till relevansdomaren, eller direkt miss. */
export type LegalRetrievalCandidate =
  | { outcome: 'candidate'; retrieved: RetrievedChunk[] }
  | { outcome: 'miss'; reason: 'no-hits' | 'weak-retrieval' }
  | null

/**
 * Heuristisk ingångsgrind: är detta en juridisk fråga alls? Skiljer juridik
 * ("kan jag säga upp...?") från drift ("skapa en faktura till Anna"), så att
 * lagtext inte injiceras — och källrader inte appendas — på operativa svar.
 * Falsk negativ är ofarlig: AI:n svarar då som idag (konservativt per #129).
 * Den finare miss-/svagträffsgrinden (gap B) byggs i PR 2.3b.
 *
 * OBS: matchas mot lowercase. Undvik \b intill å/ä/ö (icke-\w i JS-regex).
 */
const LEGAL_TRIGGERS: readonly RegExp[] = [
  // Explicit juridik-/lagvokabulär
  /juridi|jurist|lagrum|paragraf|§|formkrav|hyresnämnd|domstol|stämma|stämning/,
  /\blag(en|ens|arna|stiftning|lig|ligt)\b/, // "lagen", "lagligt" — men inte "förslag"/"underlag"
  /hyreslag|jordabalk|räntelag|bokföringslag|mervärdesskattelag|diskrimineringslag|bostadsrättslag/,
  // Uppsägning / förverkande / avhysning / besittning
  /uppsäg|säga upp|säger upp|sagt upp|sägs upp|förverk|vräk|avhys/,
  /besittning|förläng|delgiv/,
  // Andrahand, störningar, diskriminering, tillträde
  /andrahand|andra hand/,
  /störande|störning/,
  /diskriminer|etnicitet|etnisk|religion|sexuell läggning|funktionsneds|missgynna/,
  /tillträde|gå in i lägenheten|förbättringsarbet/,
  // Hyresvillkor med rättsregler/formkrav
  /hyreshöjning|(höj\w*|höjning).{0,20}hyra/,
  /bruksvärde|skälig hyra|ta i hyra|ta ut i hyra/,
  /deposition|dröjsmålsränt|referensränt|skriftlig/,
  /förfallodag|när ska hyran( senast)? betalas/,
  /vad gäller|har jag rätt|har hyresgästen rätt|får jag kräva|vad säger lagen/,
  // ── "Får jag ta ut …" som TILLÅTELSEFRÅGA (#400) ──────────────────────────
  //
  // Samma form som "får jag kräva" ovan: en fråga om vad lagen tillåter. Den
  // saknades, och det var den som gjorde att "Får jag ta ut en påminnelseavgift
  // när hyran betalas för sent?" aldrig ens nådde retrieval — trots att
  // avgiftens rättsliga grund (2 § lagen 1981:739) är den regel produktens egen
  // grind implementerar.
  //
  // NAKET ORDVAL MÄTTES OCH FÖLL. Till skillnad från "kräva" är "ta ut" också
  // ett OPERATIVT verb i den här produkten — man tar ut en rapport, en export,
  // ett underlag. Ett blott /får jag ta ut/ drog in 8 av 8 prövade datafrågor
  // ("Får jag ta ut rapporten för juni?", "Får jag ta ut saldot på Annas
  // konto?"). Samma slutsats som momsmönstren nedan: skillnaden ligger inte i
  // ordet utan i frågans FORM. Mönstret kodar därför tre formkrav:
  //
  //   1. OBJEKTET ÄR RÄTTSLIGT och står EFTER verbet. En påföljd tas ut
  //      (avgift/ersättning/ränta/påminnelse), en rapport tas bara hämtad.
  //   2. FRÅGAN ÄR INTE EN UPPRÄKNING. "Vilka avgifter får jag ta ut…" och
  //      "Hur många påminnelseavgifter…" är datafrågor trots rättsligt objekt.
  //      Uppräkningsordet spärras var som helst i meddelandet — det står inte
  //      alltid omedelbart före verbet, vilket en lookbehind-variant mättes och
  //      föll på. "Hur mycket" är INTE med i listan: det är en regelfråga om
  //      taket, och den ska fångas.
  //   3. OBJEKTET SLUTAR SOM EGET ORD. Utan det matchade "avgiftsrapporten" och
  //      "påminnelselistan" på sitt prefix. Lösningen är en böjningsbudget
  //      (högst tre bokstäver, sedan måste ordet ta slut) i stället för en
  //      uppräkning av sammansättningsfogar — en fog-lista är samma ändliga
  //      uppräkning som #382 varnade för, och sammansättningsrymden är oändlig.
  //
  // Ankaret ^ används BARA för att förankra uppräknings-lookaheaden över hela
  // meddelandet; [\s\S]* efter den gör mönstret oankrat i praktiken, så
  // "Hej! Får jag ta ut…" och flerradiga meddelanden fångas. Det är alltså inte
  // det ^-ankrade ja/nej-mönster som prövades och ströks i #382 PR3.
  //
  // Uppmätt: 30 prövade formuleringar (12 regelfrågor / 18 data- och
  // driftfrågor) → 0 falska positiva, 0 missade regelfrågor. Låst åt båda håll i
  // legal-grounding.spec.ts. KVARSTÅENDE RISK, oförändrad från #390: listorna är
  // ändliga och avstämda mot formuleringar vi hittat på, inte mot prod-data.
  /^(?![\s\S]*\b(vilka|vilken|vilket|lista|hur många)\b)[\s\S]*får jag ta ut[^.?!]{0,20}(avgift|ersättning|ränta|påminnelse)[a-zåäö]{0,3}(?![a-zåäö])/,
  // ── Moms som RÄTTSFRÅGA (#382 PR3) ────────────────────────────────────────
  //
  // Uppmätt: 3 av 10 realistiska momsfrågor nådde inte ens grinden, utan
  // besvarades utan att grindutfallet ens beräknades och utan källrad. De ska gå
  // samma väg som varje annan rättsfråga: genom kedjan, och — så länge ingen
  // människoverifierad momslag finns i korpusen (#382) — ut som MISS med
  // hänvisning till revisor.
  //
  // GRÄNSDRAGNINGEN ÄR MOT DATAFRÅGOR, inte mot moms. "Vad blev momsen på förra
  // månadens fakturor?" frågar om bokförda belopp, inte om vad lagen kräver.
  // Grindas den blir produkten SÄMRE: AI:n hedgar om ett tal den kan hämta.
  //
  // FÖRSTA UTKASTET LISTADE NORMATIVA ORD (momsplikt, momsfri, momssats,
  // skattskyldig) som fristående triggers. Det mättes och föll: VARJE sådant ord
  // används också beskrivande. "Vilka fakturor är momsfria?", "Vilka lokaler är
  // skattskyldiga just nu?" och "Hur många enheter har momssats 25?" drogs alla
  // in — fem av fem uppmätta datafrågor. Skillnaden ligger inte i ORDET utan i
  // frågans FORM: en regelfråga är ja/nej eller "vad gäller", en datafråga är en
  // uppräkning ("vilka…", "lista…", "hur många…"). Mönstren nedan kodar formen.
  //
  // Ordföljden är avsiktlig i båda riktningarna, och båda är mätta:
  //   "Ska jag ta ut moms…"            → regelfråga, verbet står FÖRE moms
  //   "Hur mycket moms ska jag betala" → avläsning av egna siffror, verbet EFTER
  // Ett symmetriskt mönster hade dragit in den senare.
  //
  // ETT ^-ANKRAT JA/NEJ-MÖNSTER PRÖVADES OCH STRÖKS. Det skulle fånga
  // "Är bostadshyra momsfri?" och skiljas från "Vilka fakturor är momsfria?"
  // genom att kräva att frågan står först. Mätt föll det: ^ matchar bara när
  // frågan inleder MEDDELANDET, och 5 av 9 realistiska chattformuleringar
  // ("Hej! Är bostadshyra momsfri?") missades. Framför allt bar det INGEN av de
  // tre uppmätta missarna — de fångas av mönstren nedan — så det utökade PR:en
  // utan att stänga något mätt hål.
  //
  // Ett meningsankare hade fungerat på papperet (6/6 rätt, 0 falska positiva),
  // men vilade på två ÄNDLIGA ordlistor — inledande konjunktioner och
  // anaforiska pronomen — avstämda mot meningar jag hittat på. Prod har 16
  // användarmeddelanden och noll om moms: vi vet inte hur frågorna faktiskt
  // formuleras. Uppföljning när det finns riktig data att mäta mot: #390.
  /(måste|ska|får|behöver|bör|tillåtet)\s[^.?!]{0,30}\bmoms/,
  // "Vilken momssats gäller för…" — rättsfråga i vilken-form, men bunden till
  // moms + gäller, så den inte fångar "Vilka fakturor gäller juni?".
  /\bmoms\w*[^.?!]{0,20}gäller|gäller[^.?!]{0,25}\bmoms/,
  // Egennamn på rättsliga konstruktioner — ingen datafråga formuleras så.
  /frivillig skattskyldighet|mervärdesskatt/,
]

/** Sant om meddelandet ser ut som en juridisk fråga (se LEGAL_TRIGGERS). */
export function isLegalQuestion(message: string): boolean {
  const lower = message.toLowerCase()
  return LEGAL_TRIGGERS.some((re) => re.test(lower))
}

/** Samma topK som retrieval-mätningen i PR 2.2 (12/18 answerable). */
export const GROUNDING_TOP_K = 3

// ── Steg 1: deterministiska golv, OMKALIBRERADE mot 420-chunks-korpusen (#382) ─
//
// VARFÖR OM: BM25:s statistik är KORPUS-GLOBAL (N, docFreq, avgLength i
// legal-retrieval.ts buildIndex). När mervärdesskattelagen togs bort föll N
// 560 → 420 (−25 %) och avgLength 53.40 → 52.63, vilket sänkte IDF för VARJE
// term i VARJE kvarvarande chunk. Uppmätt effekt: topp-BM25 sjönk 8–11 % rakt
// igenom eval-setet (faktor ≈ 1.09). Golvet 10 var kalibrerat mot den GAMLA
// skalan och fällde därför besittningsskydd-lokal — ett HYRESRÄTTS-fall som
// inget hade med momslagen att göra. Rescale: 10 / 1.09 ≈ 9.17.
//
// Uppmätt på 420-chunks-korpusen (topp-BM25 / topp-täckning, 2026-08-08):
//   Svagast GODKÄNDA träff:   besittningsskydd-lokal        9.51 / 0.43
//   Starkaste som måste fällas AV POÄNGEN (täckning ≥ 0.4, så bandet nedan
//   kan inte hjälpa):         hyreshojning-formkrav          6.81 / 0.50
//                             hyressattning-bruksvarde       5.80 / 0.50
// Intervallet 6.81–9.51 är TOMT — inget eval-fall ligger däremellan. Golvet 9
// sitter i det gapet med 0.51 marginal till svagast godkända och 2.19 till
// starkaste som ska fällas.
//
// NEGATIVKONTROLL (de två som ska förbli ute, uppmätt vid golv 9):
//   deposition-storlek           9.66 / 0.33 → fälls, täckning < 0.4 i bandet
//   hyresgastval-diskriminering  8.63 / 0.29 → fälls, både poäng och täckning
// Båda ligger kvar utanför vid VARJE golv 8.5–10 (mätt) — det är TÄCKNINGEN
// som skiljer dem från besittningsskydd-lokal, inte poängen. Ett golv som
// släppte in dem vore inget golv.
//
// LOW_SCORE_BAND och MIN_COVERAGE_IN_BAND är OFÖRÄNDRADE, och det är mätt, inte
// antaget: täckning är korpus-oberoende (andel av frågans stammar som finns i
// chunken) och identisk före/efter. Inget eval-fall passerade tidigare bandets
// övre kant på poäng med täckning < 0.4 och hamnar innanför den efter skalbytet
// (svagaste sådana är delgivning-uppsagning 15.89 / 0.36, långt över 12).
//
// Lexikalt starka men semantiskt fel träffar (altan 20.4/0.50, eget-behov
// 15.9/0.45, besittningsskydd-förstahand 18.6/0.46) är fortfarande INTE
// separerbara här — de går vidare som kandidater och fälls av relevansdomaren
// (steg 2).
//
// ⚠ 9 ÄR INTE ETT ALLMÄNT VÄRDE. Det gäller för EN korpusstorlek: N = 420
// (se MIN_TOP_SCORE_CALIBRATED_AT_CHUNKS nedan). Eftersom BM25 är korpus-
// globalt flyttas HELA poängskalan när korpusen ändras, och golvet slutar
// betyda det det mättes till — utan att något beteende ser trasigt ut. VÄXER
// korpusen (t.ex. när en verifierad mervärdesskattelag 2023:200 läggs
// tillbaka, PR5 i #382-planen) stiger alla poäng och 9 blir för TILLÅTANDE:
// svaga träffar släpps in till domaren. KRYMPER den blir 9 för strängt och
// giltiga fall fälls — exakt det som hände besittningsskydd-lokal här.
// Tripwiren nedan tvingar fram en ommätning i båda riktningarna.
const MIN_TOP_SCORE = 9

/**
 * Korpusstorleken MIN_TOP_SCORE kalibrerades vid (#382, 2026-08-08).
 *
 * Golvet är en tröskel på en KORPUS-BEROENDE skala, så det är bara giltigt för
 * det N det mättes vid. Konstanten finns här — bredvid golvet den villkorar —
 * i stället för i testet, så att de två inte kan glida isär: den som ändrar
 * golvet ser omedelbart vilket N det gäller. Låses av legal-grounding.spec.ts,
 * som failar med en ommätnings-instruktion så snart buildLegalChunks() ger ett
 * annat antal.
 */
export const MIN_TOP_SCORE_CALIBRATED_AT_CHUNKS = 420
const LOW_SCORE_BAND = 12
const MIN_COVERAGE_IN_BAND = 0.4

// ── Steg 1b: cosine-golvet — semantiska kanalens insläpp (PR 3.3b) ────────────
//
// "(a)+"-grinden: BM25-golven ovan är BIT-FÖR-BIT ORÖRDA. Semantiska kanalen
// får SLÄPPA IN en kandidat som BM25-golven hade fällt, endast om kanalens
// toppsignal (semanticTopCosine — bästa giltiga pgvector-träff) når detta
// golv. En fråga går alltså MISS→kandidat bara via BM25-golven ELLER detta
// golv — och VARJE kandidat måste fortfarande godkännas av relevansdomaren
// (steg 2). Insläppet är monotont: cosine kan aldrig göra en BM25-godkänd
// kandidat till miss.
//
// Uppmätt (topp-cosine, voyage-4, riktiga query-embeddings, 2026-06-11):
//   Ska släppas in (BM25-miss idag):  kontrakt-tidsbestamt        0.548 ← lägst
//                                     hyressattning-bruksvarde    0.584
//                                     hyresgastval-diskriminering 0.592
//                                     hyreshojning-formkrav       0.603
//   Ska INTE släppas in:              altan-referens (kandidat)   0.498
//                                     agandeform-skatt            0.488 (ej-juridisk ändå)
//                                     nonsens "blorptaxa"         0.367
//                                     nonsens "hej hej tjena"     0.167
// Golvet ligger mitt i det uppmätta gapet 0.498–0.548. OBS deposition-storlek
// (0.605) ligger ÖVER golvet och är INTE separerbar här — den släpps in som
// kandidat och fälls av domaren (§22/§28 saknar storleksregel → NEJ → miss),
// exakt som de lexikalt starka felträffarna ovan. Verifieras av knowledge:eval.
//
// OFÖRÄNDRAT av #382, och det är MÄTT: cosine beräknas parvis mellan fråge-
// vektorn och en lagrad vektor — ingen korpus-global normalisering, ingen IDF.
// Att ta bort 140 vektorer kan per konstruktion inte flytta en annan vektors
// cosine. Ommätning 2026-08-08 reproducerade tabellen ovan inom ±0.002. Enda
// avvikelsen är agandeform-skatt (0.488 → 0.455): dess semantiska topp var en
// moms-chunk och blir nu en bokföringschunk. Fallet är ändå ej-juridiskt och
// når aldrig kanalen.
const MIN_TOP_COSINE = 0.52

/**
 * Steg 1 i miss-grinden över ett färdigt retrieval-resultat (3.3a-sömmen,
 * 3.3b-cosineinsläppet). Golven läser KANAL-RENA signaler — `retrieval.fused`
 * (RRF-ordningen) kan per konstruktion inte ändra ett grindutfall:
 *   - kandidat = BM25-golven passerade (orörda sedan 2.3b) ELLER
 *                semanticTopCosine ≥ MIN_TOP_COSINE (3.3b),
 *   - no-hits  = båda kanalerna under golv och lexical tom,
 *   - weak     = båda kanalerna under golv men lexical fanns.
 * semanticTopCosine === null (kanal nere) → bit-för-bit 2.3b-beteende.
 * Passerar grinden blir `fused` kandidaterna som relevansdomaren (steg 2) och
 * grundningen ser. Returnerar ALDRIG en färdig grundning — kandidaten måste
 * passera domaren.
 */
export function evaluateLegalCandidate(
  message: string,
  retrieval: HybridLegalRetrieval,
): LegalRetrievalCandidate {
  if (!isLegalQuestion(message)) return null

  const top = retrieval.lexical[0]
  const lexicalPass =
    top !== undefined &&
    top.score >= MIN_TOP_SCORE &&
    !(top.score < LOW_SCORE_BAND && top.coverage < MIN_COVERAGE_IN_BAND)
  const semanticPass =
    retrieval.semanticTopCosine !== null && retrieval.semanticTopCosine >= MIN_TOP_COSINE

  if (!lexicalPass && !semanticPass) {
    return retrieval.lexical.length === 0
      ? { outcome: 'miss', reason: 'no-hits' }
      : { outcome: 'miss', reason: 'weak-retrieval' }
  }

  return {
    outcome: 'candidate',
    retrieved: retrieval.fused.length > 0 ? retrieval.fused : retrieval.lexical,
  }
}

/**
 * Steg 1 i miss-grinden, ren BM25-väg (utan semantisk kanal): kör lexikal
 * retrieval och bedöm deterministiskt. Samma golvlogik som
 * evaluateLegalCandidate med semanticTopCosine = null — en enda golvkälla,
 * bit-för-bit samma utfall som före Etapp 3. Används av specar/eval och är
 * fallback-beteendet när den semantiska kanalen är nere.
 */
export function evaluateLegalRetrieval(message: string): LegalRetrievalCandidate {
  if (!isLegalQuestion(message)) return null
  const lexical = retrieveLegalChunks(message, { topK: GROUNDING_TOP_K })
  return evaluateLegalCandidate(message, { lexical, fused: lexical, semanticTopCosine: null })
}

/**
 * Bygger den färdiga grundningen för en kandidat som relevansdomaren godkänt.
 * Citat-integriteten (gap A) är oförändrad från 2.3a: källraden byggs ENBART
 * ur chunk-metadata, aldrig ur AI-text.
 */
export function groundLegalCandidate(retrieved: RetrievedChunk[]): LegalGrounding {
  const chunks = retrieved.map((r) => r.chunk)
  return {
    outcome: 'grounded',
    chunks,
    contextBlock: buildContextBlock(chunks),
    sourceCitation: buildSourceCitation(chunks),
  }
}

/** Bygger miss-utfallet: ärlighetsblock i stället för lagtext, ingen källrad. */
export function buildLegalGroundingMiss(reason: LegalMissReason): LegalGroundingMiss {
  return { outcome: 'miss', reason, contextBlock: MISS_CONTEXT_BLOCK }
}

function lawTitle(lawId: string): string {
  return getLegalDocument(lawId)?.titel ?? lawId
}

/**
 * CITAT-INTEGRITET (gap A): den auktoritativa källhänvisningen. Signaturen tar
 * ENBART chunkar — funktionen kan inte se (och kan därmed aldrig påverkas av)
 * vad AI:n skrev. Varje lag/paragraf/SFS/datum i strängen kommer ordagrant ur
 * de hämtade chunkarnas metadata, som i sin tur (per PR 2.2-testerna) alltid
 * är hämtad ur LEGAL_KNOWLEDGE-strukturen — aldrig härledd eller gissad.
 */
export function buildSourceCitation(chunks: readonly LegalChunk[]): string {
  const lawOrder: string[] = []
  const byLaw = new Map<string, LegalChunk[]>()
  for (const chunk of chunks) {
    if (!byLaw.has(chunk.lawId)) {
      byLaw.set(chunk.lawId, [])
      lawOrder.push(chunk.lawId)
    }
    const list = byLaw.get(chunk.lawId)!
    if (!list.some((c) => c.paragraph === chunk.paragraph)) list.push(chunk)
  }
  const parts = lawOrder.map((lawId) => {
    const list = byLaw.get(lawId)!
    const paragraphs = list.map((c) => `${c.paragraph} §`).join(', ')
    const { sfs, verifieradPer } = list[0]!
    return `${lawTitle(lawId)} ${paragraphs} (SFS ${sfs}, gällande lydelse verifierad ${verifieradPer})`
  })
  return `Detta svar bygger på verifierad lagtext: ${parts.join('; ')}.`
}

/**
 * Avskiljare mellan AI:ns text och den kod-bundna källraden. Allt EFTER den
 * sista förekomsten av denna markör i ett svar är skrivet av kod, inte av AI:n.
 */
export const SOURCE_SUFFIX_MARKER = '\n\n---\n'

/** Källsuffixet som koden appendar på ett grundat svar (även SSE-vägen). */
export function formatSourceSuffix(grounding: LegalGrounding): string {
  return `${SOURCE_SUFFIX_MARKER}${grounding.sourceCitation}`
}

/**
 * Appendar den kod-bundna källan på AI:ns text. AI-texten passerar opåverkad —
 * skriver AI:n (mot instruktion) ett eget lagrum blir det kvar som prosa, men
 * det är ALDRIG källhänvisningen: den auktoritativa källan är alltid suffixet,
 * byggt ur metadata innan AI:n ens svarat.
 */
export function appendCodeBoundSource(aiText: string, grounding: LegalGrounding): string {
  return `${aiText.trimEnd()}${formatSourceSuffix(grounding)}`
}

/**
 * Systemblocket vid MISS: systemet VET att det inte hittade en tillräckligt
 * relevant regel — AI:n ska vara ärlig med det och rekommendera jurist, inte
 * svara ur minnet. Samma anda som #129, men nu utlöst av en faktisk mätning.
 */
const MISS_CONTEXT_BLOCK = [
  'JURIDISK FRÅGA UTAN TILLRÄCKLIGT LAGSTÖD (retrieval-miss)',
  '',
  'Användarens senaste fråga ser ut att vara juridisk. Systemet har sökt i sin',
  'människoverifierade lagtext-kunskapsbas men hittade INGEN tillräckligt',
  'relevant regel för just denna fråga.',
  '',
  'REGLER FÖR DITT SVAR (absoluta):',
  '- Var ärlig med detta: säg tydligt att du inte hittar den exakta regeln i',
  '  den verifierade kunskapsbasen och att en jurist bör bekräfta vad som',
  '  gäller (revisor/skatterådgivare om frågan är skatte-/bolagsrelaterad).',
  '- Besvara INTE frågan ur ditt eget minne som om du visste regeln. Du får ge',
  '  försiktig, allmän vägledning i klartext, men presentera ingenting som',
  '  säker juridisk fakta.',
  '- Skriv ALDRIG paragrafnummer, §-hänvisningar eller SFS-nummer.',
  '- Hjälp gärna användaren vidare: föreslå att frågan stäms av med jurist',
  '  innan någon bindande åtgärd, och hänvisa till hyresnämnden vid tvist.',
].join('\n')

// ── Steg 2: relevansdomaren (prompt + verdiktparser; anropet bor i servicen) ──

/**
 * Prompt till den billiga relevansdomaren (Haiku): innehåller kandidat-
 * paragraferna ordagrant och kräver ett strikt JA/NEJ. Domaren fäller de
 * lexikalt starka men semantiskt fel träffarna som steg 1 inte kan se.
 */
export function buildRelevanceJudgePrompt(question: string, chunks: readonly LegalChunk[]): string {
  const sources = chunks
    .map((c, i) => `[${i + 1}] ${lawTitle(c.lawId)}, ${c.paragraph} §:\n${c.text}`)
    .join('\n\n')
  return [
    'Du är en strikt relevansdomare i ett juridiskt RAG-system för svenska hyresvärdar.',
    '',
    'ANVÄNDARENS FRÅGA:',
    '"""',
    question,
    '"""',
    '',
    'HÄMTAD LAGTEXT (kandidater):',
    sources,
    '',
    'UPPGIFT: Avgör om den hämtade lagtexten innehåller den MATERIELLA regel',
    'som behövs för att besvara frågans juridiska kärna.',
    '- Svara JA om minst EN kandidatparagraf innehåller regeln frågan gäller,',
    '  helt eller till väsentlig del.',
    '- Att texten bara rör samma allmänna ämnesområde räcker INTE för JA.',
    '- Procedur-/formregler (t.ex. hur en uppsägning delges) besvarar INTE en',
    '  fråga om RÄTTEN att säga upp — och tvärtom.',
    '- Är du tveksam till om regeln verkligen finns i texten: svara NEJ.',
    '',
    'Svara med EXAKT ett ord: JA eller NEJ.',
  ].join('\n')
}

/**
 * Strikt verdiktparser: "JA" → true, "NEJ" → false, allt annat → null
 * (behandlas som domare otillgänglig → fail-safe till miss).
 */
export function parseRelevanceVerdict(text: string): boolean | null {
  const first = text.trim().toLowerCase()
  if (/^ja\b/.test(first)) return true
  if (/^nej\b/.test(first)) return false
  return null
}

/** Systemblocket med den hämtade lagtexten + grundningsregler för AI:n. */
function buildContextBlock(chunks: readonly LegalChunk[]): string {
  const sources = chunks
    .map(
      (c, i) =>
        `[Källa ${i + 1}: ${lawTitle(c.lawId)}, ${c.paragraph} § — SFS ${c.sfs}, verifierad ${c.verifieradPer}]\n${c.text}`,
    )
    .join('\n\n')

  return [
    'VERIFIERAD LAGTEXT (hämtad av systemet för användarens senaste fråga)',
    '',
    'Nedan följer ordagrann, människoverifierad svensk lagtext som systemet hämtat',
    'ur sin kunskapsbas. GRUNDA ditt juridiska svar i denna text — inte i ditt minne.',
    '',
    'REGLER FÖR DENNA LAGTEXT (absoluta):',
    '- Förklara reglernas innebörd i klartext, pedagogiskt och på svenska.',
    '- Skriv ALDRIG paragrafnummer, §-hänvisningar eller SFS-nummer i ditt svar —',
    '  inte ens de som står nedan. Systemet lägger AUTOMATISKT till den',
    '  auktoritativa källhänvisningen (lag + paragraf + SFS + verifieringsdatum)',
    '  efter ditt svar, hämtad direkt ur källmetadatan.',
    '- Om lagtexten nedan inte räcker för att besvara frågan: säg det öppet och',
    '  rekommendera jurist i stället för att fylla i ur minnet.',
    '- Vid juridiskt känsliga frågor (uppsägning, förverkande, besittningsskydd,',
    '  tvister) gäller fortfarande: rekommendera avstämning med jurist innan',
    '  bindande åtgärd.',
    '',
    sources,
  ].join('\n')
}
