/**
 * MÄTSPEGEL av den lexikala retrieval-vägen — delad av #406:s mätskript.
 *
 * VARFÖR EN SPEGEL ALLS: produktionens tokenizer/stemmer/tesaurus är
 * modulprivata i `legal-retrieval.ts` och BM25-indexet är memoiserat utan
 * injektionspunkt. För att mäta en ANNAN tokenisering eller en ANNAN tesaurus
 * måste matematiken därför speglas här.
 *
 * VARFÖR SPEGELN INTE FÅR ANTAS VARA TROGEN: en spegel som bara ser riktig ut
 * mäter något annat än produkten. `assertBaselineParity` verifierar den
 * NUMERISKT före varje mätning — identisk score+coverage för samtliga chunkar ×
 * samtliga eval-frågor mot `scoreAllLegalChunks()`, identiskt grindutfall mot
 * `evaluateLegalCandidate()`, och identisk fuserad ordning mot
 * `LegalRetrievalService.retrieve()`. Avviker något avbryts körningen.
 *
 * VARFÖR FILEN FINNS SOM EGEN MODUL: `measure-406-gate.ts` (grind-halvan,
 * #406) och `measure-406-tesaurus.ts` (tesaurus-halvan) mäter olika saker mot
 * SAMMA spegel. En kopia per skript hade gjort det möjligt för det ena att
 * mäta mot en spegel det andra rättat — paritetskontrollen fångar drift mot
 * PRODUKTIONEN, men inte att två skript svarar på olika versioner av frågan.
 *
 * VAD MODULEN FÅR GÖRA: importera och mäta. Den skriver ALDRIG till
 * produktionsvägen, rör ingen tröskel och ingen lagtext.
 */
import { PrismaClient } from '@prisma/client'
import { ConfigService } from '@nestjs/config'
import { LegalEmbeddingService } from '../../src/ai/knowledge/embedding/legal-embedding.service'
import { LegalRetrievalService } from '../../src/ai/knowledge/retrieval/legal-retrieval.service'
import {
  legalChunkId,
  legalChunkContentHash,
  type LegalChunk,
} from '../../src/ai/knowledge/retrieval/legal-chunk'
import { scoreAllLegalChunks } from '../../src/ai/knowledge/retrieval/legal-retrieval'
import {
  isLegalQuestion,
  evaluateLegalCandidate,
  GROUNDING_TOP_K,
} from '../../src/ai/knowledge/grounding/legal-grounding'
import { LEGAL_EVAL_SET } from '../../src/ai/knowledge/eval/legal-eval-set'
import { VOYAGE_EMBEDDINGS } from '../../src/ai/ai.config'

// ── Spegel av produktionens grindkonstanter (legal-grounding.ts) ─────────────
// EJ EXPORTERADE där, därför kopierade. Att kopian är rätt är inte antaget:
// gate-pariteten mot evaluateLegalCandidate() faller om något värde avviker.
// RÖRS INTE av mätskripten — de är läsvärden, inte rattar.
export const MIN_TOP_SCORE = 9
export const LOW_SCORE_BAND = 12
export const MIN_COVERAGE_IN_BAND = 0.4
export const MIN_TOP_COSINE = 0.52

// ── Spegel av produktionens analysator (legal-retrieval.ts) ──────────────────
export const STOPWORDS = new Set([
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
  'lång',
  'göra',
  'gör',
  'samt',
  'vid',
  'ur',
  'då',
  'nu',
])

/** Produktionens tesaurus, ordagrant. Baslinjen varje kandidatgrupp mäts mot. */
export const BASELINE_CONCEPT_GROUPS: readonly (readonly string[])[] = [
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

export function stem(word: string): string {
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

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-zåäöéü]+/i)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t))
}

export const K1 = 1.5
export const B = 0.75

// ── Variantdefinition ────────────────────────────────────────────────────────

export interface Variant {
  id: string
  label: string
  /** Råtoken → sökstammar. Samma funktion på dokument- och frågesidan. */
  analyze: (text: string) => string[]
  /** Texten som INDEXERAS för en chunk (skild från citerbar text i PR3-vägen). */
  indexText: (chunk: LegalChunk) => string
  /** Tesaurusen frågesidan expanderas med. Utelämnad = produktionens. */
  conceptGroups?: readonly (readonly string[])[]
}

export const baselineAnalyze = (text: string): string[] => tokenize(text).map(stem)
export const plainIndexText = (chunk: LegalChunk): string => chunk.text

// ── BM25 över en variant ─────────────────────────────────────────────────────

export interface VariantIndex {
  variant: Variant
  chunks: LegalChunk[]
  termFreqs: Map<string, number>[]
  lengths: number[]
  docFreq: Map<string, number>
  avgLength: number
}

export interface Scored {
  chunk: LegalChunk
  score: number
  coverage: number
}

export function buildVariantIndex(variant: Variant, chunks: LegalChunk[]): VariantIndex {
  const termFreqs: Map<string, number>[] = []
  const lengths: number[] = []
  const docFreq = new Map<string, number>()
  let total = 0
  for (const chunk of chunks) {
    const tokens = variant.analyze(variant.indexText(chunk))
    const tf = new Map<string, number>()
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1)
    for (const term of tf.keys()) docFreq.set(term, (docFreq.get(term) ?? 0) + 1)
    termFreqs.push(tf)
    lengths.push(tokens.length)
    total += tokens.length
  }
  return {
    variant,
    chunks,
    termFreqs,
    lengths,
    docFreq,
    avgLength: chunks.length ? total / chunks.length : 0,
  }
}

/** Vilka tesaurusgrupper frågan utlöser (index i variantens grupplista). */
export function triggeredGroups(variant: Variant, query: string): number[] {
  const lower = query.toLowerCase()
  const groups = variant.conceptGroups ?? BASELINE_CONCEPT_GROUPS
  const hits: number[] = []
  groups.forEach((group, i) => {
    if (group.some((term) => lower.includes(term))) hits.push(i)
  })
  return hits
}

export function queryStems(variant: Variant, query: string): Set<string> {
  const lower = query.toLowerCase()
  const stems = new Set<string>(variant.analyze(query))
  for (const group of variant.conceptGroups ?? BASELINE_CONCEPT_GROUPS) {
    if (group.some((term) => lower.includes(term))) {
      for (const term of group) for (const s of variant.analyze(term)) stems.add(s)
    }
  }
  return stems
}

/**
 * BM25 + täckning för en GIVEN stammängd. Frågevägen (`scoreAll`) är den här
 * med `queryStems`; att den är utbrytbar är vad som gör det möjligt att mäta
 * en enskild stams bidrag utan att duplicera matematiken.
 */
export function scoreAllForStems(idx: VariantIndex, stems: Set<string>): Scored[] {
  if (stems.size === 0) return []
  const scorable = [...stems].filter((s) => s.length >= 4)
  const N = idx.chunks.length
  return idx.chunks.map((chunk, i) => {
    const tf = idx.termFreqs[i]!
    const len = idx.lengths[i]!
    let score = 0
    for (const term of stems) {
      if (term.length < 4) continue
      const f = tf.get(term)
      if (!f) continue
      const df = idx.docFreq.get(term) ?? 1
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5))
      score += idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * len) / idx.avgLength)))
    }
    return {
      chunk,
      score,
      coverage: scorable.length ? scorable.filter((s) => tf.has(s)).length / scorable.length : 0,
    }
  })
}

export function scoreAll(idx: VariantIndex, query: string): Scored[] {
  return scoreAllForStems(idx, queryStems(idx.variant, query))
}

export function ranked(idx: VariantIndex, query: string): Scored[] {
  return scoreAll(idx, query)
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.chunk.paragraph.localeCompare(b.chunk.paragraph))
}

// ── Fusionen: fönstret domaren faktiskt ser ──────────────────────────────────
//
// Grindens golv läser `lexical`, men det är `fused` som blir kandidaterna.
// Att en paragraf klättrar i den lexikala listan betyder därför ingenting förrän
// den når FUSED TOPP-3 — det är den mätning som avgör om domaren ens får se
// regeln. Spegel av LegalRetrievalService.fuse (RRF, k = 60, kanalbredd 10),
// validerad mot produktionens fused i paritetskontrollen.
export const CHANNEL_TOP_K = 10
export const RRF_K = 60

export interface SemanticHit {
  chunkId: string
  cosine: number
}

export function fuse(
  idx: VariantIndex,
  query: string,
  semantic: readonly SemanticHit[],
): LegalChunk[] {
  const byId = new Map(idx.chunks.map((c) => [legalChunkId(c), c]))
  const entries = new Map<string, { chunk: LegalChunk; rrf: number }>()
  const contribute = (chunk: LegalChunk, rank: number): void => {
    const key = legalChunkId(chunk)
    const entry = entries.get(key) ?? { chunk, rrf: 0 }
    entry.rrf += 1 / (RRF_K + rank)
    entries.set(key, entry)
  }
  ranked(idx, query)
    .slice(0, CHANNEL_TOP_K)
    .forEach((r, i) => contribute(r.chunk, i + 1))
  semantic.forEach((s, i) => {
    const chunk = byId.get(s.chunkId)
    if (chunk) contribute(chunk, i + 1)
  })
  return [...entries.values()]
    .sort((a, b) => b.rrf - a.rrf || a.chunk.paragraph.localeCompare(b.chunk.paragraph))
    .slice(0, GROUNDING_TOP_K)
    .map((e) => e.chunk)
}

// ── Grinden (spegel; validerad mot evaluateLegalCandidate) ───────────────────

export type GateOutcome = 'ej-juridisk' | 'miss:no-hits' | 'miss:weak-retrieval' | 'kandidat'

export function gate(question: string, top3: Scored[], cosine: number | null): GateOutcome {
  if (!isLegalQuestion(question)) return 'ej-juridisk'
  const top = top3[0]
  const lexicalPass =
    top !== undefined &&
    top.score >= MIN_TOP_SCORE &&
    !(top.score < LOW_SCORE_BAND && top.coverage < MIN_COVERAGE_IN_BAND)
  const semanticPass = cosine !== null && cosine >= MIN_TOP_COSINE
  if (!lexicalPass && !semanticPass) {
    return top3.length === 0 ? 'miss:no-hits' : 'miss:weak-retrieval'
  }
  return 'kandidat'
}

export function lexicalPasses(top3: Scored[]): boolean {
  const top = top3[0]
  return (
    top !== undefined &&
    top.score >= MIN_TOP_SCORE &&
    !(top.score < LOW_SCORE_BAND && top.coverage < MIN_COVERAGE_IN_BAND)
  )
}

// ── Mätning ──────────────────────────────────────────────────────────────────

export interface CaseMeasurement {
  id: string
  expectedOutcome: string
  legal: boolean
  top3: Scored[]
  topScore: number | null
  topCoverage: number | null
  gate: GateOutcome
  lexicalPass: boolean
  /** Rank (1-baserad, hela korpusen) + score för en namngiven paragraf. */
  probe: Record<string, { rank: number | null; score: number }>
  /** Fönstret domaren ser (RRF-fuserad topp-3) — `lexical` avgör grinden, `fused` avgör svaret. */
  fused: string[]
}

export interface Probe {
  lawId: string
  paragraph: string
}

export function measureVariant(
  idx: VariantIndex,
  cosineByCase: Map<string, number | null>,
  semanticByCase: Map<string, SemanticHit[]>,
  probes: Record<string, Probe>,
): CaseMeasurement[] {
  return LEGAL_EVAL_SET.map((c) => {
    const legal = isLegalQuestion(c.question)
    const all = legal ? ranked(idx, c.question) : []
    const top3 = all.slice(0, GROUNDING_TOP_K)
    const probe: CaseMeasurement['probe'] = {}
    for (const [label, target] of Object.entries(probes)) {
      const at = all.findIndex(
        (r) => r.chunk.lawId === target.lawId && r.chunk.paragraph === target.paragraph,
      )
      probe[label] = { rank: at === -1 ? null : at + 1, score: at === -1 ? 0 : all[at]!.score }
    }
    return {
      id: c.id,
      expectedOutcome: c.expectedOutcome,
      legal,
      top3,
      topScore: top3[0]?.score ?? null,
      topCoverage: top3[0]?.coverage ?? null,
      gate: gate(c.question, top3, cosineByCase.get(c.id) ?? null),
      lexicalPass: lexicalPasses(top3),
      probe,
      fused: legal ? fuse(idx, c.question, semanticByCase.get(c.id) ?? []).map(legalChunkId) : [],
    }
  })
}

// ── Paritetskontroll mot produktionen ────────────────────────────────────────
//
// En spegel som inte reproducerar produktionen bit-för-bit mäter fel sak. Här
// jämförs BÅDA riktningarna som betyder något: råsignalerna (score+coverage för
// samtliga chunkar) och grindutfallet.
export function assertBaselineParity(
  idx: VariantIndex,
  cosineByCase: Map<string, number | null>,
  fusedByCase: Map<string, string[]>,
  semanticByCase: Map<string, SemanticHit[]>,
): void {
  let maxScoreDelta = 0
  let maxCoverageDelta = 0
  let compared = 0
  const gateMismatches: string[] = []
  const fusedMismatches: string[] = []

  for (const c of LEGAL_EVAL_SET) {
    const mine = new Map(scoreAll(idx, c.question).map((r) => [legalChunkId(r.chunk), r]))
    const theirs = scoreAllLegalChunks(c.question)
    if (theirs.length > 0 && mine.size !== theirs.length) {
      throw new Error(`paritet: olika antal chunkar för ${c.id} (${mine.size} vs ${theirs.length})`)
    }
    for (const t of theirs) {
      const m = mine.get(legalChunkId(t.chunk))
      if (!m) throw new Error(`paritet: chunk saknas i spegeln för ${c.id}`)
      maxScoreDelta = Math.max(maxScoreDelta, Math.abs(m.score - t.score))
      maxCoverageDelta = Math.max(maxCoverageDelta, Math.abs(m.coverage - t.coverage))
      compared++
    }

    const top3 = ranked(idx, c.question).slice(0, GROUNDING_TOP_K)
    const cosine = cosineByCase.get(c.id) ?? null
    const mineGate = gate(c.question, top3, cosine)
    const prod = evaluateLegalCandidate(c.question, {
      lexical: top3.map((r) => ({ chunk: r.chunk, score: r.score, coverage: r.coverage })),
      fused: top3.map((r) => ({ chunk: r.chunk, score: r.score, coverage: r.coverage })),
      semanticTopCosine: cosine,
    })
    const prodGate: GateOutcome =
      prod === null
        ? 'ej-juridisk'
        : prod.outcome === 'candidate'
          ? 'kandidat'
          : `miss:${prod.reason}`
    if (mineGate !== prodGate) gateMismatches.push(`${c.id}: spegel=${mineGate} prod=${prodGate}`)

    // Fusionens paritet: bara meningsfull när den semantiska kanalen faktiskt
    // kördes (utan den är fused === lexical i båda ändarna, en trivial likhet).
    const prodFused = fusedByCase.get(c.id)
    if (prodFused && semanticByCase.get(c.id)?.length) {
      const mineFused = fuse(idx, c.question, semanticByCase.get(c.id) ?? [])
        .map(legalChunkId)
        .join(' ')
      if (mineFused !== prodFused.join(' ')) {
        fusedMismatches.push(`${c.id}: spegel=[${mineFused}] prod=[${prodFused.join(' ')}]`)
      }
    }
  }

  console.warn(
    `[paritet] ${compared} chunk-jämförelser · max |Δscore| = ${maxScoreDelta.toExponential(2)} · ` +
      `max |Δcoverage| = ${maxCoverageDelta.toExponential(2)} · grindavvikelser: ${gateMismatches.length} · ` +
      `fused-avvikelser: ${fusedMismatches.length}`,
  )
  if (
    maxScoreDelta > 1e-12 ||
    maxCoverageDelta > 1e-12 ||
    gateMismatches.length > 0 ||
    fusedMismatches.length > 0
  ) {
    for (const m of [...gateMismatches, ...fusedMismatches]) console.error(`  ✗ ${m}`)
    throw new Error(
      `VARIANTEN ${idx.variant.id} MATCHAR INTE PRODUKTIONEN — mätningen är ogiltig, avbryter.`,
    )
  }
}

/**
 * Vilken variant implementerar produktionen just nu?
 *
 * Att hårdkoda antagandet skulle göra skriptet obrukbart så snart
 * produktionsvägen ändras — och värre: grönt av fel skäl. Här MÄTS det i
 * stället: exakt en variant måste reproducera produktionens score bit-för-bit.
 * Noll träffar betyder att produktionen driftat från allt som mätts; fler än en
 * betyder att varianterna inte är åtskiljbara och att mätningen inte visar
 * något.
 */
export function detectProductionVariant(indexes: readonly VariantIndex[]): VariantIndex {
  const matches = indexes.filter((idx) =>
    LEGAL_EVAL_SET.every((c) => {
      const mine = new Map(scoreAll(idx, c.question).map((r) => [legalChunkId(r.chunk), r]))
      return scoreAllLegalChunks(c.question).every((t) => {
        const m = mine.get(legalChunkId(t.chunk))
        return m !== undefined && Math.abs(m.score - t.score) <= 1e-12
      })
    }),
  )
  if (matches.length !== 1) {
    throw new Error(
      `kunde inte identifiera produktionens variant: ${matches.length} av ${indexes.length} ` +
        `matchade (${matches.map((m) => m.variant.id).join(', ') || 'ingen'}). ` +
        'Antingen har produktionen driftat från allt som mäts, eller så är varianterna inte åtskiljbara.',
    )
  }
  return matches[0]!
}

/** Lagtexten ska vara orörd: content-hasharna får inte flyttas av mätningen. */
export function snapshotHashes(chunks: readonly LegalChunk[]): string {
  return chunks.map((c) => `${legalChunkId(c)}=${legalChunkContentHash(c.text)}`).join('\n')
}

// ── Kalibreringsanalys ───────────────────────────────────────────────────────

/** #406:s åtta målfall. */
export const INKASSO_IDS = LEGAL_EVAL_SET.filter(
  (c) => c.id.startsWith('paminnelseavgift-') || c.id === 'kravbrev-avgift',
).map((c) => c.id)

/** De två som ALDRIG får släppas in. Enda normativt bindande "ut"-mängden. */
export const NEGATIVE_CONTROLS = ['deposition-storlek', 'hyresgastval-diskriminering']

export interface FloorSweep {
  /** Golv där varje baslinje-godkänd behålls OCH båda negativkontrollerna hålls ute. */
  safeFloors: number[]
  /** Bästa antal inkassofall som släpps in inom det säkra intervallet (max 8). */
  bestTargetsIn: number
  /** Golvet som ger bestTargetsIn (lägsta sådana). */
  bestFloor: number | null
  /** Vad golvet 9 ger i dag på den här skalan. */
  atNine: { keepsAll: boolean; controlsOut: boolean; targetsIn: number }
}

/**
 * Svepet: finns ETT golv som samtidigt (a) behåller allt som passerar i dag,
 * (b) håller båda negativkontrollerna ute och (c) släpper in #406-målen?
 *
 * Bandet (LOW_SCORE_BAND / MIN_COVERAGE_IN_BAND) hålls FAST vid produktionens
 * värden — svepet prövar golvet, inte hela grinden.
 */
export function sweepFloors(variant: CaseMeasurement[], mustKeep: Set<string>): FloorSweep {
  const byId = new Map(variant.map((m) => [m.id, m]))
  const passesAt = (id: string, floor: number): boolean => {
    const m = byId.get(id)
    if (!m || m.topScore === null) return false
    const cov = m.topCoverage ?? 0
    return m.topScore >= floor && !(m.topScore < LOW_SCORE_BAND && cov < MIN_COVERAGE_IN_BAND)
  }

  const safeFloors: number[] = []
  let bestTargetsIn = -1
  let bestFloor: number | null = null
  for (let t = 0.5; t <= 40.0001; t += 0.05) {
    const floor = Math.round(t * 100) / 100
    const keepsAll = [...mustKeep].every((id) => passesAt(id, floor))
    const controlsOut = NEGATIVE_CONTROLS.every((id) => !passesAt(id, floor))
    if (!keepsAll || !controlsOut) continue
    safeFloors.push(floor)
    const targetsIn = INKASSO_IDS.filter((id) => passesAt(id, floor)).length
    if (targetsIn > bestTargetsIn) {
      bestTargetsIn = targetsIn
      bestFloor = floor
    }
  }

  return {
    safeFloors,
    bestTargetsIn: Math.max(bestTargetsIn, 0),
    bestFloor,
    atNine: {
      keepsAll: [...mustKeep].every((id) => passesAt(id, MIN_TOP_SCORE)),
      controlsOut: NEGATIVE_CONTROLS.every((id) => !passesAt(id, MIN_TOP_SCORE)),
      targetsIn: INKASSO_IDS.filter((id) => passesAt(id, MIN_TOP_SCORE)).length,
    },
  }
}

// ── Semantiska kanalen ───────────────────────────────────────────────────────

export interface SemanticMeasurement {
  cosineByCase: Map<string, number | null>
  semanticByCase: Map<string, SemanticHit[]>
  fusedByCase: Map<string, string[]>
}

/**
 * Kör produktionens retrieval EN gång per eval-fråga och plockar ut både
 * sanningskällan (fused + semanticTopCosine, som pariteten mäts mot) och
 * kanalens egen rangordning (så att VARJE variant kan fuseras mot samma
 * semantiska lista).
 *
 * Varför en enda körning räcker för alla varianter: cosine beräknas parvis
 * mellan Voyage-vektorer av frågan och av chunk-TEXTEN. Varken en ändrad
 * tokenisering eller en ändrad tesaurus rör chunk-texten eller frågesträngen,
 * så en variant kan per konstruktion inte flytta en cosine.
 */
export async function collectSemantic(chunks: readonly LegalChunk[]): Promise<SemanticMeasurement> {
  const cosineByCase = new Map<string, number | null>()
  const semanticByCase = new Map<string, SemanticHit[]>()
  const fusedByCase = new Map<string, string[]>()

  const prisma = new PrismaClient()
  const embedder = new LegalEmbeddingService(new ConfigService())
  const service = new LegalRetrievalService(prisma as never, embedder)
  const validIds = new Set(chunks.map(legalChunkId))
  const byId = new Map(chunks.map((ch) => [legalChunkId(ch), ch]))
  try {
    for (const c of LEGAL_EVAL_SET) {
      if (!isLegalQuestion(c.question)) {
        cosineByCase.set(c.id, null)
        continue
      }
      // Produktionens svar — sanningskällan pariteten mäts mot.
      const r = await service.retrieve(c.question)
      cosineByCase.set(c.id, r.semanticTopCosine)
      fusedByCase.set(
        c.id,
        r.fused.map((f) => legalChunkId(f.chunk)),
      )

      // Kanalens egen rangordning. Samma SQL och samma stale-hash-vakt som
      // LegalRetrievalService.semanticChannel (metoden är privat).
      const { vectors } = await embedder.embed([c.question], 'query')
      const literal = `[${vectors[0]!.join(',')}]`
      const rows = await prisma.$queryRaw<{ id: string; contentHash: string; distance: number }[]>`
          SELECT id, "contentHash", (embedding <=> ${literal}::vector)::float8 AS distance
          FROM "LegalChunkEmbedding"
          WHERE model = ${VOYAGE_EMBEDDINGS.MODEL}
          ORDER BY embedding <=> ${literal}::vector
          LIMIT ${CHANNEL_TOP_K}
        `
      semanticByCase.set(
        c.id,
        rows
          .filter((row) => {
            const chunk = byId.get(row.id)
            return (
              validIds.has(row.id) &&
              chunk !== undefined &&
              row.contentHash === legalChunkContentHash(chunk.text)
            )
          })
          .map((row) => ({ chunkId: row.id, cosine: 1 - row.distance })),
      )
    }
  } finally {
    await prisma.$disconnect()
  }
  console.warn(`[mät] cosine + semantisk rangordning mätt för ${semanticByCase.size} frågor`)
  return { cosineByCase, semanticByCase, fusedByCase }
}
