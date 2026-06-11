/**
 * Enkel nyckelords-/paragraf-retrieval över den verifierade lagtexten.
 *
 * Etapp 2, PR 2.2 — INGEN AI, ingen modell, inget Anthropic-anrop. Ren
 * text→text-sökning: given en svensk fråga, returnera de mest relevanta
 * paragraf-chunkarna ur LEGAL_KNOWLEDGE, var och en med sin egen källmetadata
 * (lag + paragraf + SFS + verifieradPer) — hämtad ur strukturen, aldrig gissad.
 *
 * Semantisk sökning (embeddings) bor i LegalRetrievalService (Etapp 3, PR 3.3a)
 * — byggd efter att mätningen mot eval-setet visade att BM25 ensam är för
 * trubbig (12/18 answerable). Denna fil förblir den lexikala kanalen: ren,
 * synkron, nätfri — och gap B-grindens enda signalkälla.
 */
import { buildLegalChunks, type LegalChunk } from './legal-chunk'

export interface RetrievedChunk {
  chunk: LegalChunk
  /** BM25-score (lexikala kanalen). Betydelsen är oförändrad sedan PR 2.2 —
   * gap B-grindens golv läser detta fält och får aldrig se en annan skala. */
  score: number
  /**
   * Query-täckning: andelen av frågans sökstammar (efter tesaurus-expansion,
   * samma ≥4-teckenstammar som BM25 poängsätter) som finns i chunken (0–1).
   * Relevanssignal för miss-grinden (gap B, PR 2.3b): en hög score med låg
   * täckning kan vara ett enstaka starkt ord i fel paragraf.
   */
  coverage: number
  /**
   * Cosine-likhet (0–1) från den semantiska kanalen (PR 3.3a). Satt ENDAST när
   * chunken hämtades via pgvector — ren observabilitet/råsignal i 3.3a; grinden
   * läser den inte (cosine-grindkanalen är PR 3.3b).
   */
  cosine?: number
}

/**
 * Hybrid-retrievalens kontrakt (Etapp 3, PR 3.3a — produceras av
 * LegalRetrievalService). De två kanalerna bärs SEPARAT som bärande invariant:
 * gap B-grindens golv läser BARA `lexical` (bit-för-bit dagens BM25-topp-3) —
 * den fuserade ordningen kan per konstruktion inte ändra ett grindutfall, bara
 * vilka chunkar domaren/grundningen ser för en redan godkänd kandidat.
 */
export interface HybridLegalRetrieval {
  /** BM25-kanalen, identisk med retrieveLegalChunks(query, {topK: 3}) — grindens ENDA signalkälla. */
  lexical: RetrievedChunk[]
  /** RRF-fuserad topp-3 — kandidaterna till domare/grundning. === lexical när semantiska kanalen är nere. */
  fused: RetrievedChunk[]
}

// Vanliga svenska funktionsord som inte bär ämnesinnehåll.
const STOPWORDS = new Set([
  'och',
  'att',
  'det',
  'som',
  'för',
  'med',
  'jag',
  'kan',
  'har',
  'min',
  'mitt',
  'mina',
  'den',
  'ett',
  'inte',
  'till',
  'hur',
  'vad',
  'när',
  'vill',
  'får',
  'ska',
  'är',
  'på',
  'om',
  'en',
  'av',
  'eller',
  'man',
  'sin',
  'hon',
  'han',
  'här',
  'ett',
  'lång',
  'göra',
  'gör',
  'samt',
  'vid',
  'ur',
  'då',
  'nu',
])

/**
 * Allmän juridisk tesaurus: knyter naturligt språk (som en hyresvärd skriver)
 * till lagtextens formella vokabulär. Generell, inte fall-anpassad. Om frågan
 * innehåller någon term i en grupp expanderas sökningen med hela gruppen.
 */
const CONCEPT_GROUPS: string[][] = [
  ['uppsägning', 'uppsäga', 'säga upp', 'säg upp', 'sägs upp', 'sagt upp', 'uppsagd', 'upphöra'],
  ['besittningsskydd', 'besittning', 'förlängning', 'förlänga', 'bo kvar', 'rätt till förläng'],
  [
    'förverkad',
    'förverkande',
    'vräka',
    'vräkning',
    'avhysning',
    'avhysa',
    'skiljas från lägenheten',
  ],
  ['andrahand', 'andra hand', 'andrahandsupplåtelse', 'upplåta', 'samtycke'],
  ['hyreshöjning', 'höja hyran', 'höjd hyra', 'hyresvillkor', 'ändring av hyresvillkoren'],
  ['deposition', 'säkerhet', 'handpenning'],
  ['dröjsmålsränta', 'ränta', 'förseningsränta', 'referensränta'],
  ['delgivning', 'delge', 'delgiven', 'delgetts', 'rekommenderat brev'],
  ['störning', 'störande', 'störningar i boendet', 'bristande skötsamhet'],
  ['diskriminering', 'diskriminera', 'etnisk', 'religion', 'sexuell läggning', 'missgynnas'],
  ['bruksvärde', 'skälig', 'hyrans storlek', 'likvärdiga'],
  ['skriftlig', 'skriftligen', 'skriftligt'],
  ['tillträde', 'tillsyn', 'besiktning', 'förbättringsarbeten'],
  ['förfallodag', 'betalas', 'betalning av hyra'],
  ['kontrakt', 'hyresavtal', 'avtal'],
  ['tidsbestämt', 'bestämd tid', 'obestämd tid', 'förlängt'],
]

/** Lätt svensk stamning: kapar vanliga böjningsändelser. Pure. */
function stem(word: string): string {
  const w = word.toLowerCase()
  const suffixes = [
    'ningarna',
    'ningar',
    'ningen',
    ' heten',
    'heten',
    'arna',
    'erna',
    'orna',
    'andet',
    'else',
    'ning',
    'het',
    'ande',
    'arne',
    'en',
    'et',
    'ar',
    'er',
    'or',
    'na',
    'an',
    'a',
  ]
  for (const suf of suffixes) {
    if (w.length - suf.length >= 4 && w.endsWith(suf)) return w.slice(0, w.length - suf.length)
  }
  return w
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-zåäöéü]+/i)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t))
}

/** Bygger sökstammar ur frågan + expanderar via tesaurusen. */
function queryStems(query: string): Set<string> {
  const lower = query.toLowerCase()
  const stems = new Set<string>(tokenize(query).map(stem))
  for (const group of CONCEPT_GROUPS) {
    if (group.some((term) => lower.includes(term))) {
      for (const term of group) {
        for (const tok of tokenize(term)) stems.add(stem(tok))
      }
    }
  }
  return stems
}

// ── BM25-index (fortfarande ren nyckelords-sökning, inga embeddings) ──────────
//
// Naiv substräng-räkning gynnar långa paragrafer och dränks av allmänord som
// förekommer i många paragrafer (cross-law-brus). BM25 är standard-baslinjen
// för nyckelords-sökning: IDF nedviktar allmänna ord och längdnormaliseringen
// tar bort längd-biasen. Det är text→text-matematik, ingen modell.

const K1 = 1.5
const B = 0.75

interface Bm25Index {
  chunks: LegalChunk[]
  /** Per chunk: stam → frekvens. */
  termFreqs: Map<string, number>[]
  /** Per chunk: antal stammar (dokumentlängd). */
  lengths: number[]
  /** Stam → antal chunkar som innehåller den. */
  docFreq: Map<string, number>
  avgLength: number
}

let index: Bm25Index | null = null

function buildIndex(): Bm25Index {
  if (index) return index
  const chunks = buildLegalChunks()
  const termFreqs: Map<string, number>[] = []
  const lengths: number[] = []
  const docFreq = new Map<string, number>()
  let totalLength = 0

  for (const chunk of chunks) {
    const tokens = tokenize(chunk.text).map(stem)
    const tf = new Map<string, number>()
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1)
    for (const term of tf.keys()) docFreq.set(term, (docFreq.get(term) ?? 0) + 1)
    termFreqs.push(tf)
    lengths.push(tokens.length)
    totalLength += tokens.length
  }

  index = {
    chunks,
    termFreqs,
    lengths,
    docFreq,
    avgLength: chunks.length ? totalLength / chunks.length : 0,
  }
  return index
}

function bm25(idx: Bm25Index, chunkIndex: number, stems: Set<string>): number {
  const tf = idx.termFreqs[chunkIndex]!
  const len = idx.lengths[chunkIndex]!
  const N = idx.chunks.length
  let score = 0
  for (const term of stems) {
    if (term.length < 4) continue
    const f = tf.get(term)
    if (!f) continue
    const df = idx.docFreq.get(term) ?? 1
    const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5))
    score += idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * len) / idx.avgLength)))
  }
  return score
}

/**
 * BM25-score + täckning för ALLA chunkar (osorterat, ofiltrerat — även score 0).
 * Intern sanningskälla för BM25-matematiken: `retrieveLegalChunks` är
 * sort+filter+slice över denna, och hybrid-servicen (PR 3.3a) använder den för
 * att ge semantik-träffar deras sanna lexikala råsignaler utan att duplicera
 * matematiken. Tom lista om frågan saknar sökstammar.
 */
export function scoreAllLegalChunks(query: string): RetrievedChunk[] {
  const stems = queryStems(query)
  if (stems.size === 0) return []

  const idx = buildIndex()
  // Samma stam-filter som bm25() använder — täckningen mäter exakt de stammar
  // som kan bidra till poängen.
  const scorableStems = [...stems].filter((s) => s.length >= 4)
  return idx.chunks.map((chunk, i) => ({
    chunk,
    score: bm25(idx, i, stems),
    coverage: scorableStems.length
      ? scorableStems.filter((s) => idx.termFreqs[i]!.has(s)).length / scorableStems.length
      : 0,
  }))
}

/**
 * Returnerar de top-K mest relevanta paragraf-chunkarna för en fråga.
 * Tom lista om inget matchar (ren retrieval — beslutet att avstå/be om jurist
 * görs av osäkerhetsgrinden i PR 2.3, inte här).
 */
export function retrieveLegalChunks(query: string, opts?: { topK?: number }): RetrievedChunk[] {
  const topK = opts?.topK ?? 3
  return scoreAllLegalChunks(query)
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.chunk.paragraph.localeCompare(b.chunk.paragraph))
    .slice(0, topK)
}
