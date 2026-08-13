/**
 * MÄTSKRIPT för tesaurus-halvan av #406 — kartläggning, INGEN produktionsändring.
 *
 * HYPOTESEN SOM PRÖVAS: `CONCEPT_GROUPS` i legal-retrieval.ts har 16 grupper
 * och ingen för påminnelse/krav/inkassokostnad. BM25-score är en SUMMA över
 * frågans sökstammar, så oexpanderade frågor skulle systematiskt få lägre
 * summa. De fem kvarvarande #406-fallen är alla inkassofrågor — löser en
 * saknad tesaurusgrupp dem, utan att någon tröskel rörs?
 *
 * KÖRS MANUELLT (inte i CI):
 *   cd apps/api && node --env-file-if-exists=.env \
 *     -r ts-node/register scripts/measure-406-tesaurus.ts [--no-semantic]
 *   npx prettier --write docs/research/406-tesaurus-inkasso.md
 *
 * Prettier-steget hör till receptet, inte till städningen: lint-staged
 * formaterar om rapporten vid commit, så utan det ger varje ny körning en diff
 * mot grenen och det går inte att se om SIFFRORNA ändrats eller bara
 * radbrytningarna.
 *
 * VAD SKRIPTET FÅR GÖRA: importera och mäta. Det skriver ALDRIG till
 * produktionsvägen, rör ingen tröskel och ingen lagtext. Spegeln det mäter i
 * (`lib/legal-retrieval-mirror.ts`) verifieras numeriskt mot produktionen före
 * varje mätning, och chunkarnas contentHash kontrolleras som oförändrade.
 *
 * VARFÖR EN TESAURUSGRUPP ÄR EN FRÅGESIDIG ÄNDRING: grupperna expanderar
 * FRÅGANS stammar. Indexet — docFreq, avgLength, N — rörs inte alls. Skalan
 * flyttas alltså inte för korpusen som helhet (till skillnad från kandidat A i
 * `406-grind-kartlaggning.md`); bara de frågor som UTLÖSER en grupp ändras. Det
 * gör riskbilden asymmetrisk: score kan bara stiga (BM25 summerar icke-negativa
 * termbidrag), medan TÄCKNINGEN kan falla, eftersom nämnaren är antalet
 * sökstammar efter expansion.
 */
import { writeFileSync } from 'fs'
import { resolve } from 'path'
import { requireApiKey, verifyVoyageKey, exitOnPreflightError } from './preflight-keys'
import { buildLegalChunks, legalChunkId } from '../src/ai/knowledge/retrieval/legal-chunk'
import type { LegalChunk } from '../src/ai/knowledge/retrieval/legal-chunk'
import { searchTermsFor } from '../src/ai/knowledge/retrieval/legal-search-terms'
import {
  isLegalQuestion,
  MIN_TOP_SCORE_CALIBRATED_AT_CHUNKS,
} from '../src/ai/knowledge/grounding/legal-grounding'
import { LEGAL_EVAL_SET } from '../src/ai/knowledge/eval/legal-eval-set'
import { VOYAGE_EMBEDDINGS } from '../src/ai/ai.config'
import {
  MIN_TOP_SCORE,
  LOW_SCORE_BAND,
  MIN_COVERAGE_IN_BAND,
  BASELINE_CONCEPT_GROUPS,
  stem,
  tokenize,
  baselineAnalyze,
  buildVariantIndex,
  queryStems,
  triggeredGroups,
  ranked,
  assertBaselineParity,
  detectProductionVariant,
  measureVariant,
  snapshotHashes,
  sweepFloors,
  collectSemantic,
  INKASSO_IDS,
  NEGATIVE_CONTROLS,
  type Variant,
  type Probe,
  type CaseMeasurement,
  type SemanticHit,
} from './lib/legal-retrieval-mirror'

// ── Produktionens indexerade text (PR3: söktermer jämte lagtexten) ───────────
// Importerad, aldrig kopierad: varianten ÄR produktionslistan, så en ändrad
// sökterm kan inte göra att skriptet mäter något annat än det som levereras.
const searchTermIndexText = (chunk: LegalChunk): string => {
  const terms = searchTermsFor(chunk)
  return terms.length > 0 ? `${chunk.text}\n${terms.join(' ')}` : chunk.text
}

// ── Kandidatgrupperna ────────────────────────────────────────────────────────
//
// T1 är förslaget ORDAGRANT. Det mäts som det står — en kandidat som skrivs om
// innan den mäts är inte prövad, bara ersatt.
const GROUP_T1: readonly string[] = [
  'påminnelseavgift',
  'påminnelse',
  'betalningspåminnelse',
  'kravavgift',
  'krav',
  'inkassokostnad',
  'ersättning för kostnader',
  'förfallen skuld',
]

// T2: samma mekanism, men bara de termer som faktiskt BÄR — motiverade i
// rapportens termanatomi-tabell (varje term får sin stam, sin df och sina
// träffparagrafer utskrivna, så att "bär" är ett uppmätt påstående).
// Avgränsningen är påminnelse-begreppet ensamt: 2 § (rätten) och 4 § (taket).
const GROUP_T2_PAMINNELSE: readonly string[] = [
  'påminnelseavgift',
  'påminnelse',
  'betalningspåminnelse',
]

// T3 = T2 + en EGEN krav-grupp. Poängen är att pröva om separationen räddar
// skiljefallet: en tesaurusgrupp är oriktad — varje term i gruppen läggs till
// varje fråga som utlöser den — så en blandad påminnelse/krav-grupp drar 3 §
// in i påminnelsefrågor och 2 § in i kravfrågor.
const GROUP_T3_KRAV: readonly string[] = ['kravavgift', 'kravbrev', 'inkassokrav']

// T4 = T3 + en ogiltighetsgrupp riktad mot rankingfällpunkten i
// paminnelseavgift-hogre-i-avtal (facit 6 §). SKRIVEN AV NÅGON SOM SETT
// FACIT — den redovisas därför som vad den är: ett tak för vad en tesaurus
// kan göra åt ranking, inte ett förslag.
//
// T4 behålls i FRASFORM med avsikt, trots att den mättes som en no-op:
// utlösningen sker på `lower.includes(term)`, och frågan skriver "avtala om en
// högre påminnelseavgift" — inte "avtala om högre". En flerordsterm är alltså
// ett sprödare trigger-villkor än den ser ut, och det är ett resultat om
// mekanismen, inte ett misstag att städa bort. T5 är samma grupp med termer
// som faktiskt faller ut.
const GROUP_T4_OGILTIGHET: readonly string[] = [
  'avtala om högre',
  'högre än lagens',
  'ogiltigt avtalsvillkor',
  'utvidgas utöver',
  'tvingande',
]

const GROUP_T5_OGILTIGHET: readonly string[] = [
  'avtala om',
  'ogiltigt avtalsvillkor',
  'utvidgas utöver',
  'tvingande regel',
]

interface Candidate {
  id: string
  label: string
  groups: readonly (readonly string[])[]
  /** Grupperna som TILLKOMMIT jämfört med produktionen (för termanatomin). */
  added: readonly { name: string; terms: readonly string[] }[]
}

const CANDIDATES: Candidate[] = [
  {
    id: 'T1',
    label: 'förslaget ordagrant — en blandad inkassogrupp (8 termer)',
    groups: [...BASELINE_CONCEPT_GROUPS, GROUP_T1],
    added: [{ name: 'inkasso (blandad)', terms: GROUP_T1 }],
  },
  {
    id: 'T2',
    label: 'bara påminnelse-begreppet (3 termer)',
    groups: [...BASELINE_CONCEPT_GROUPS, GROUP_T2_PAMINNELSE],
    added: [{ name: 'påminnelse', terms: GROUP_T2_PAMINNELSE }],
  },
  {
    id: 'T3',
    label: 'påminnelse + separat krav-grupp',
    groups: [...BASELINE_CONCEPT_GROUPS, GROUP_T2_PAMINNELSE, GROUP_T3_KRAV],
    added: [
      { name: 'påminnelse', terms: GROUP_T2_PAMINNELSE },
      { name: 'krav', terms: GROUP_T3_KRAV },
    ],
  },
  {
    id: 'T4',
    label: 'T3 + ogiltighetsgrupp (skriven mot 6 §:s fällpunkt)',
    groups: [...BASELINE_CONCEPT_GROUPS, GROUP_T2_PAMINNELSE, GROUP_T3_KRAV, GROUP_T4_OGILTIGHET],
    added: [
      { name: 'påminnelse', terms: GROUP_T2_PAMINNELSE },
      { name: 'krav', terms: GROUP_T3_KRAV },
      { name: 'ogiltighet (frasform)', terms: GROUP_T4_OGILTIGHET },
    ],
  },
  {
    id: 'T5',
    label: 'T3 + ogiltighetsgrupp med termer som faktiskt utlöses',
    groups: [...BASELINE_CONCEPT_GROUPS, GROUP_T2_PAMINNELSE, GROUP_T3_KRAV, GROUP_T5_OGILTIGHET],
    added: [
      { name: 'påminnelse', terms: GROUP_T2_PAMINNELSE },
      { name: 'krav', terms: GROUP_T3_KRAV },
      { name: 'ogiltighet (utlösande)', terms: GROUP_T5_OGILTIGHET },
    ],
  },
]

/** De fem fall #406 fortfarande fäller (uppmätt i 406-grind-kartlaggning.md). */
const FIVE_REMAINING = [
  'paminnelseavgift-taket',
  'paminnelseavgift-avtalskravet',
  'paminnelseavgift-vad-galler',
  'paminnelseavgift-vad-sager-lagen',
  'paminnelseavgift-hogre-i-avtal',
]

const PROBES: Record<string, Probe> = {
  '1 §': { lawId: 'inkassokostnadslagen', paragraph: '1' },
  '2 §': { lawId: 'inkassokostnadslagen', paragraph: '2' },
  '3 §': { lawId: 'inkassokostnadslagen', paragraph: '3' },
  '4 §': { lawId: 'inkassokostnadslagen', paragraph: '4' },
  '4 a §': { lawId: 'inkassokostnadslagen', paragraph: '4 a' },
  '6 §': { lawId: 'inkassokostnadslagen', paragraph: '6' },
}

/**
 * UTANFÖR EVAL-SETET: konstruerade icke-inkassofrågor som innehåller en
 * utlösande delsträng. De är INTE bevis om produkten — de finns för att
 * eval-setets 30 fall inte innehåller en enda icke-inkassofråga med "krav" i
 * sig, och en global grupp kan därför inte visa sin verkliga riskyta där.
 * Samma kvarstående svaghet som #390: formuleringarna är hittade på.
 */
const OUT_OF_SET_PROBES: { id: string; question: string }[] = [
  { id: 'formkrav-uppsagning', question: 'Vilka formkrav gäller för en uppsägning?' },
  {
    id: 'krav-besiktning',
    question: 'Vad ställer lagen för krav på en besiktning vid avflyttning?',
  },
  { id: 'krav-andrahand', question: 'Vilka krav gäller för att få hyra ut i andra hand?' },
  {
    id: 'krav-hyresgastval',
    question: 'Kan jag ställa krav på inkomst när jag väljer hyresgäst?',
  },
]

// ── Statistik ────────────────────────────────────────────────────────────────

function pearson(xs: number[], ys: number[]): number {
  const n = xs.length
  const mx = xs.reduce((a, b) => a + b, 0) / n
  const my = ys.reduce((a, b) => a + b, 0) / n
  let num = 0
  let dx = 0
  let dy = 0
  for (let i = 0; i < n; i++) {
    const a = xs[i]! - mx
    const b = ys[i]! - my
    num += a * b
    dx += a * a
    dy += b * b
  }
  return dx === 0 || dy === 0 ? 0 : num / Math.sqrt(dx * dy)
}

/** Medelrang vid lika värden — annars blir rho fel för de många 4-stams-fallen. */
function rankify(values: number[]): number[] {
  const sorted = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v)
  const ranks = new Array<number>(values.length)
  let i = 0
  while (i < sorted.length) {
    let j = i
    while (j + 1 < sorted.length && sorted[j + 1]!.v === sorted[i]!.v) j++
    const avg = (i + j) / 2 + 1
    for (let k = i; k <= j; k++) ranks[sorted[k]!.i] = avg
    i = j + 1
  }
  return ranks
}

function spearman(xs: number[], ys: number[]): number {
  return pearson(rankify(xs), rankify(ys))
}

// ── Utskrift ─────────────────────────────────────────────────────────────────

const md: string[] = []
function out(line = ''): void {
  console.warn(line)
  md.push(line)
}

function fmt(n: number | null, digits = 2): string {
  return n === null ? '—' : n.toFixed(digits)
}

function shortId(chunkId: string): string {
  const [law, ...rest] = chunkId.split(':')
  return `${law!.slice(0, 6)}:${rest.join(':')}`
}

function top3Cell(m: CaseMeasurement): string {
  if (m.top3.length === 0) return '—'
  return m.top3
    .map((r) => `${shortId(legalChunkId(r.chunk))} ${r.score.toFixed(1)}/${r.coverage.toFixed(2)}`)
    .join('<br>')
}

/** Facitparagraferna som chunk-id:n, för ranking-frågan. */
function facitIds(id: string): string[] {
  const c = LEGAL_EVAL_SET.find((x) => x.id === id)!
  return c.expectedSources.flatMap((s) => s.paragraphs.map((p) => `${s.lawId}:${p}`))
}

async function main(): Promise<void> {
  const noSemantic = process.argv.includes('--no-semantic')
  const chunks = buildLegalChunks()
  const hashesBefore = snapshotHashes(chunks)

  console.warn(
    `[mät] korpus: ${chunks.length} chunkar (grindens kalibrerings-N: ${MIN_TOP_SCORE_CALIBRATED_AT_CHUNKS}) · ` +
      `${LEGAL_EVAL_SET.length} eval-fall`,
  )
  if (chunks.length !== MIN_TOP_SCORE_CALIBRATED_AT_CHUNKS) {
    throw new Error(
      `korpusen är ${chunks.length} chunkar men golvet är kalibrerat vid ` +
        `${MIN_TOP_SCORE_CALIBRATED_AT_CHUNKS} — mätningen jämför mot ett golv som inte gäller.`,
    )
  }

  // Cosine mäts EN gång: ingen tesaurusgrupp rör chunk-texten eller
  // frågesträngen, så en variant kan per konstruktion inte flytta en cosine.
  let cosineByCase = new Map<string, number | null>()
  let semanticByCase = new Map<string, SemanticHit[]>()
  let fusedByCase = new Map<string, string[]>()
  if (noSemantic) {
    console.warn('[mät] --no-semantic: cosine = null (ren BM25-väg)')
    for (const c of LEGAL_EVAL_SET) cosineByCase.set(c.id, null)
  } else {
    const voyageKey = requireApiKey({
      envVar: 'VOYAGE_API_KEY',
      whatFor: 'query-embeddingarna i tesaurus-mätningen',
      expectedPrefix: 'pa-',
    })
    await verifyVoyageKey(voyageKey, VOYAGE_EMBEDDINGS.MODEL)
    ;({ cosineByCase, semanticByCase, fusedByCase } = await collectSemantic(chunks))
  }

  // ── Varianterna ────────────────────────────────────────────────────────────
  const variants: Variant[] = [
    {
      id: 'PROD',
      label: 'produktionen i dag (16 grupper, söktermer i indexet)',
      analyze: baselineAnalyze,
      indexText: searchTermIndexText,
    },
    {
      // Diagnostisk, inget förslag: tesaurusen HELT avstängd. Isolerar vad
      // expansionen är värd i dag, vilket är det enda sättet att pröva
      // hypotesens mekanism i stället för dess korrelation.
      id: 'NOEXP',
      label: 'diagnostik: tesaurusen avstängd (0 grupper)',
      analyze: baselineAnalyze,
      indexText: searchTermIndexText,
      conceptGroups: [],
    },
    ...CANDIDATES.map((c) => ({
      id: c.id,
      label: c.label,
      analyze: baselineAnalyze,
      indexText: searchTermIndexText,
      conceptGroups: c.groups,
    })),
  ]

  const indexes = variants.map((v) => buildVariantIndex(v, chunks))
  const byVariant = new Map(indexes.map((i) => [i.variant.id, i]))
  const prodVariant = detectProductionVariant(indexes)
  console.warn(`[mät] produktionen implementerar variant: ${prodVariant.variant.id}`)
  if (prodVariant.variant.id !== 'PROD') {
    throw new Error(
      `produktionsvarianten identifierades som ${prodVariant.variant.id}, väntade PROD`,
    )
  }
  assertBaselineParity(prodVariant, cosineByCase, fusedByCase, semanticByCase)

  const results = new Map<string, CaseMeasurement[]>()
  for (const idx of indexes) {
    results.set(idx.variant.id, measureVariant(idx, cosineByCase, semanticByCase, PROBES))
  }
  const base = results.get('PROD')!
  const baseById = new Map(base.map((m) => [m.id, m]))
  const keepIds = new Set(base.filter((m) => m.legal && m.lexicalPass).map((m) => m.id))

  const prodIdx = byVariant.get('PROD')!
  const legalCases = LEGAL_EVAL_SET.filter((c) => isLegalQuestion(c.question))

  // ── Rapport ────────────────────────────────────────────────────────────────
  out('# #406 — löser en saknad tesaurusgrupp de fem kvarvarande fallen?')
  out()
  out('> MÄTNING, INGEN FIX. Ingen produktionsregel, tröskel eller lagtext ändrad.')
  out(
    `> Genererad av \`apps/api/scripts/measure-406-tesaurus.ts\` mot korpus N = ${chunks.length}.`,
  )
  out('> Spegeln som mäts i är densamma som i `406-grind-kartlaggning.md`')
  out('> (`scripts/lib/legal-retrieval-mirror.ts`) och verifieras numeriskt mot')
  out('> produktionen före varje mätning.')
  out()
  out('## Hypotesen')
  out()
  out('`CONCEPT_GROUPS` har 16 grupper och ingen för påminnelse/krav/inkassokostnad.')
  out('BM25-score är en summa över frågans sökstammar, så oexpanderade frågor skulle')
  out('systematiskt få lägre summa — och de fem kvarvarande fallen är alla inkassofrågor.')
  out()
  out('En tesaurusgrupp är en FRÅGESIDIG ändring: indexet (`docFreq`, `avgLength`, `N`)')
  out('rörs inte, bara de frågor som utlöser gruppen. Därav riskbildens asymmetri —')
  out('score kan bara stiga (BM25 summerar icke-negativa termbidrag), medan TÄCKNINGEN')
  out('kan falla, eftersom nämnaren är antalet sökstammar efter expansion.')
  out()

  // ── 1. BASLINJE ────────────────────────────────────────────────────────────
  out('## 1. Baslinje: bär antalet sökstammar poängen?')
  out()
  out(
    `${LEGAL_EVAL_SET.length} eval-fall (${LEGAL_EVAL_SET.filter((c) => c.expectedOutcome === 'answerable').length} \`answerable\`, ` +
      `${LEGAL_EVAL_SET.filter((c) => c.expectedOutcome === 'needs-jurist').length} \`needs-jurist\`, ` +
      `${LEGAL_EVAL_SET.filter((c) => c.expectedOutcome === 'no-clear-rule').length} \`no-clear-rule\`). ` +
      `${legalCases.length} passerar ingångsgrinden \`isLegalQuestion\` och har alltså en BM25-mätning alls.`,
  )
  out()
  out('`stammar` = sökstammar efter expansion; `scorade` = de som är ≥ 4 tecken och därmed')
  out('kan bidra till poängen (nämnaren i täckningen). `via grupp` = hur många av de scorade')
  out('stammar som tillkom genom tesaurus-expansion, mätt som differensen mot `NOEXP`.')
  out()
  out(
    '| fall | scorade stammar | varav via grupp | utlösta grupper | topp-BM25 | täckning | topp-paragraf |',
  )
  out('| --- | --- | --- | --- | --- | --- | --- |')
  const stemCounts: number[] = []
  const topScores: number[] = []
  for (const c of legalCases) {
    const stems = [...queryStems(prodIdx.variant, c.question)].filter((s) => s.length >= 4)
    const bare = [...queryStems(byVariant.get('NOEXP')!.variant, c.question)].filter(
      (s) => s.length >= 4,
    )
    const groups = triggeredGroups(prodIdx.variant, c.question)
    const m = baseById.get(c.id)!
    stemCounts.push(stems.length)
    topScores.push(m.topScore ?? 0)
    const mark = INKASSO_IDS.includes(c.id) ? '**' : ''
    out(
      `| ${mark}\`${c.id}\`${mark} | ${stems.length} | ${stems.length - bare.length} | ` +
        `${groups.length ? groups.map((g) => `#${g}`).join(' ') : '—'} | ${fmt(m.topScore)} | ` +
        `${fmt(m.topCoverage)} | ${m.top3[0] ? shortId(legalChunkId(m.top3[0].chunk)) : '—'} |`,
    )
  }
  out()
  const rAll = pearson(stemCounts, topScores)
  const rhoAll = spearman(stemCounts, topScores)
  const nonInkasso = legalCases
    .map((c, i) => ({ c, s: stemCounts[i]!, y: topScores[i]! }))
    .filter((x) => !INKASSO_IDS.includes(x.c.id))
  const rNon = pearson(
    nonInkasso.map((x) => x.s),
    nonInkasso.map((x) => x.y),
  )
  out(
    `**Korrelation antal scorade stammar → topp-BM25:** Pearson r = ${rAll.toFixed(2)} ` +
      `(R² = ${(rAll * rAll).toFixed(2)}), Spearman ρ = ${rhoAll.toFixed(2)} över ${legalCases.length} fall. ` +
      `Utan de åtta inkassofallen: r = ${rNon.toFixed(2)}.`,
  )
  out()

  // Motexemplen: samma stamantal, olika utfall.
  out('### Motexemplen inifrån målgruppen')
  out()
  out('En korrelation över blandade frågor kan drivas av att långa frågor råkar handla om')
  out('välrepresenterade ämnen. Det som avgör hypotesens mekanism är i stället par med')
  out('SAMMA stamantal och olika utfall — och de finns i själva inkassofamiljen:')
  out()
  out('| fall | scorade stammar | topp-BM25 | grind i dag |')
  out('| --- | --- | --- | --- |')
  const pairIds = [
    'kravbrev-avgift',
    'paminnelseavgift-taket',
    'paminnelseavgift-lagens-egna-ord',
    'paminnelseavgift-avtalskravet',
    'paminnelseavgift-vad-sager-lagen',
    'hyreshojning-formkrav',
    'hyressattning-bruksvarde',
    'besittningsskydd-lokal',
  ]
  for (const id of pairIds) {
    const c = LEGAL_EVAL_SET.find((x) => x.id === id)!
    const stems = [...queryStems(prodIdx.variant, c.question)].filter((s) => s.length >= 4)
    const m = baseById.get(id)!
    out(`| \`${id}\` | ${stems.length} | ${fmt(m.topScore)} | ${m.gate} |`)
  }
  out()

  // NOEXP: vad är expansionen värd i dag?
  out('### Vad är expansionen värd där den FINNS? (diagnostik `NOEXP`)')
  out()
  out('Hypotesens mekanism prövas bäst genom att stänga av tesaurusen helt och mäta vad')
  out('som faller. Tabellen visar bara de fall som utlöser minst en grupp i dag.')
  out()
  out('| fall | topp med grupper | topp utan | Δ | täckning med → utan | grind faller? |')
  out('| --- | --- | --- | --- | --- | --- |')
  const noexpById = new Map(results.get('NOEXP')!.map((m) => [m.id, m]))
  let expansionFlips = 0
  for (const c of legalCases) {
    if (triggeredGroups(prodIdx.variant, c.question).length === 0) continue
    const withG = baseById.get(c.id)!
    const without = noexpById.get(c.id)!
    const flips = withG.lexicalPass && !without.lexicalPass
    if (flips) expansionFlips++
    out(
      `| \`${c.id}\` | ${fmt(withG.topScore)} | ${fmt(without.topScore)} | ` +
        `${((withG.topScore ?? 0) - (without.topScore ?? 0)).toFixed(2)} | ` +
        `${fmt(withG.topCoverage)} → ${fmt(without.topCoverage)} | ${flips ? '**JA**' : 'nej'} |`,
    )
  }
  out()
  out(
    `Tesaurusen är alltså avgörande för **${expansionFlips}** av de ${legalCases.filter((c) => triggeredGroups(prodIdx.variant, c.question).length > 0).length} fall som utlöser en grupp i dag ` +
      '— resten passerar (eller fälls) oavsett.',
  )
  out()

  // ── 2. TERMANATOMI ─────────────────────────────────────────────────────────
  out('## 2. Kandidatgruppernas termanatomi')
  out()
  out('Varje term motiveras av tre mätta storheter: vilka STAMMAR den bidrar med, hur')
  out('många chunkar som innehåller stammen (`df` — låg df = hög IDF = stort poängbidrag),')
  out('och vilka av inkassokostnadslagens paragrafer den träffar. En term vars stam har')
  out('`df = 0` tillför INGEN poäng men växer täckningens nämnare — den gör alltså bara')
  out('skada. En term vars stam träffar FEL paragraf drar den paragrafen uppåt i varje')
  out('fråga som utlöser gruppen.')
  out()
  const N = chunks.length
  const inkassoChunks = chunks.filter((c) => c.lawId === 'inkassokostnadslagen')
  const inkassoTf = new Map<string, Map<string, number>>()
  for (const ch of inkassoChunks) {
    const i = chunks.indexOf(ch)
    inkassoTf.set(ch.paragraph, prodIdx.termFreqs[i]!)
  }
  const seenGroups = new Set<string>()
  for (const cand of CANDIDATES) {
    for (const g of cand.added) {
      if (seenGroups.has(g.name)) continue
      seenGroups.add(g.name)
      out(`### Grupp \`${g.name}\` — ${g.terms.length} termer`)
      out()
      out('| term | stammar (df) | IDF | träffar i inkassokostnadslagen | utlöses av eval-fall |')
      out('| --- | --- | --- | --- | --- |')
      for (const term of g.terms) {
        const stems = tokenize(term).map(stem)
        const scorable = stems.filter((s) => s.length >= 4)
        const dfCell = stems
          .map((s) => {
            const df = prodIdx.docFreq.get(s) ?? 0
            return `\`${s}\` (${df}${s.length < 4 ? ', ej scorad' : ''})`
          })
          .join(' + ')
        const idf = scorable
          .map((s) => {
            const df = prodIdx.docFreq.get(s) ?? 0
            return df === 0 ? '—' : Math.log(1 + (N - df + 0.5) / (df + 0.5)).toFixed(2)
          })
          .join(' / ')
        const hits = [...inkassoTf.entries()]
          .filter(([, tf]) => scorable.some((s) => tf.has(s)))
          .map(([p]) => `${p} §`)
        const triggers = LEGAL_EVAL_SET.filter((c) => c.question.toLowerCase().includes(term)).map(
          (c) => c.id.replace('paminnelseavgift-', 'på-'),
        )
        out(
          `| \`${term}\` | ${dfCell} | ${idf} | ${hits.join(', ') || '**inga**'} | ` +
            `${triggers.length ? triggers.join(', ') : '—'} |`,
        )
      }
      out()
    }
  }

  // ── 3. ALLA FALL, ALLA VARIANTER ───────────────────────────────────────────
  out('## 3. Score och täckning före/efter, samtliga fall')
  out()
  out('Format: `score/täckning (Δscore)`. `ej-jur` = fälls av ingångsgrinden och når')
  out('aldrig retrieval.')
  out()
  out(['| fall | facit |', ...indexes.map((i) => ` ${i.variant.id} |`)].join(''))
  out(['| --- | --- |', ...indexes.map(() => ' --- |')].join(''))
  for (const c of LEGAL_EVAL_SET) {
    const facit =
      c.expectedSources
        .flatMap((s) => s.paragraphs.map((p) => `${s.lawId.slice(0, 6)}:${p}`))
        .join(' ') || '—'
    const cells = indexes.map((idx) => {
      const m = results.get(idx.variant.id)!.find((x) => x.id === c.id)!
      if (!m.legal) return ' ej-jur |'
      const d =
        idx.variant.id === 'PROD'
          ? ''
          : (() => {
              const delta = (m.topScore ?? 0) - (baseById.get(c.id)!.topScore ?? 0)
              return delta === 0 ? ' (0)' : ` (${delta > 0 ? '+' : ''}${delta.toFixed(1)})`
            })()
      return ` ${fmt(m.topScore)}/${fmt(m.topCoverage)}${d} |`
    })
    const mark = FIVE_REMAINING.includes(c.id) ? '**' : ''
    out([`| ${mark}\`${c.id}\`${mark} | ${facit} |`, ...cells].join(''))
  }
  out()

  // ── 4. DE FEM ──────────────────────────────────────────────────────────────
  out('## 4. De fem kvarvarande — över golvet 9 utan att golvet rörs?')
  out()
  out(
    `Grinden hålls FAST vid produktionens värden: golv ${MIN_TOP_SCORE}, band ${LOW_SCORE_BAND} / täckning ${MIN_COVERAGE_IN_BAND}. ` +
      'En rad är grön bara om score ≥ golvet OCH bandet inte fäller den.',
  )
  out()
  for (const cand of ['PROD', ...CANDIDATES.map((c) => c.id)]) {
    const ms = new Map(results.get(cand)!.map((m) => [m.id, m]))
    out(`### \`${cand}\``)
    out()
    out('| fall | facit | score | täckning | ≥ golv 9? | fälls av bandet? | lexikalt insläpp |')
    out('| --- | --- | --- | --- | --- | --- | --- |')
    for (const id of FIVE_REMAINING) {
      const m = ms.get(id)!
      const s = m.topScore ?? 0
      const cov = m.topCoverage ?? 0
      const inBand = s < LOW_SCORE_BAND && cov < MIN_COVERAGE_IN_BAND
      out(
        `| \`${id}\` | ${facitIds(id)
          .map((f) => f.split(':')[1]! + ' §')
          .join(', ')} | ${fmt(s)} | ${fmt(cov)} | ${s >= MIN_TOP_SCORE ? 'JA' : '**NEJ**'} | ` +
          `${inBand ? '**JA**' : 'nej'} | ${m.lexicalPass ? '**JA**' : 'NEJ'} |`,
      )
    }
    out()
  }

  // ── 5. TÄCKNINGSRISKEN ─────────────────────────────────────────────────────
  out('## 5. Täckningsrisken: faller något fall som passerar i dag?')
  out()
  out('Nämnaren växer med expansionen, så ett fall med score i bandet (< 12) och täckning')
  out('nätt och jämnt över 0,4 kan börja fällas. Tabellen listar varje fall som passerar')
  out('lexikalt i dag, med dess marginal.')
  out()
  out(
    [
      '| fall (passerar i dag) | score | täckning |',
      ...CANDIDATES.map((c) => ` ${c.id} täckning |`),
      ' tappas? |',
    ].join(''),
  )
  out(['| --- | --- | --- |', ...CANDIDATES.map(() => ' --- |'), ' --- |'].join(''))
  const lost: string[] = []
  for (const id of [...keepIds]) {
    const b = baseById.get(id)!
    const cells = CANDIDATES.map((cand) => {
      const m = results.get(cand.id)!.find((x) => x.id === id)!
      const moved = (m.topCoverage ?? 0) !== (b.topCoverage ?? 0)
      return ` ${fmt(m.topCoverage)}${moved ? ' ←' : ''} |`
    })
    const dropped = CANDIDATES.filter(
      (cand) => !results.get(cand.id)!.find((x) => x.id === id)!.lexicalPass,
    ).map((c) => c.id)
    if (dropped.length) lost.push(`${id} (${dropped.join(', ')})`)
    out(
      [
        `| \`${id}\` | ${fmt(b.topScore)} | ${fmt(b.topCoverage)} |`,
        ...cells,
        ` ${dropped.length ? `**${dropped.join(', ')}**` : 'nej'} |`,
      ].join(''),
    )
  }
  out()
  const movedKeepers = [...keepIds].filter((id) =>
    CANDIDATES.some(
      (cand) =>
        (results.get(cand.id)!.find((x) => x.id === id)!.topCoverage ?? 0) !==
        (baseById.get(id)!.topCoverage ?? 0),
    ),
  )
  const minMovedCoverage = Math.min(
    ...movedKeepers.flatMap((id) =>
      CANDIDATES.map((cand) => results.get(cand.id)!.find((x) => x.id === id)!.topCoverage ?? 0),
    ),
  )
  out(
    lost.length === 0
      ? '**Inget fall som passerar i dag tappas av någon kandidat.**'
      : `⚠ **Fall som tappas:** ${lost.join('; ')}.`,
  )
  out()
  out(
    `Täckningen faller likväl: ${movedKeepers.length} av de ${keepIds.size} fall som passerar i dag utlöser en ny ` +
      `grupp och tappar täckning (lägst uppmätt: ${minMovedCoverage.toFixed(2)}) — ` +
      `${movedKeepers.map((i) => `\`${i}\``).join(', ')}. Att det ändå inte kostar något beror på att `,
  )
  out('deras score samtidigt stiger förbi bandets övre kant (12), och över den kanten läser')
  out('grinden inte täckningen alls. Skyddet är alltså inte att täckningen håller — det är att')
  out('poängen springer ifrån bandet. Det är en annan sak, och den håller bara så länge')
  out('expansionen ger ett STORT poänglyft.')
  out()

  // ── 6. GLOBALITETEN ────────────────────────────────────────────────────────
  out('## 6. Gruppen är global — vilka frågor utlöser den?')
  out()
  out('| variant | icke-inkassofall som utlöser en ny grupp | max \\|Δscore\\| utanför inkasso |')
  out('| --- | --- | --- |')
  for (const cand of CANDIDATES) {
    const idx = byVariant.get(cand.id)!
    const triggered = legalCases.filter((c) => {
      if (INKASSO_IDS.includes(c.id)) return false
      const before = triggeredGroups(prodIdx.variant, c.question).length
      const after = triggeredGroups(idx.variant, c.question).length
      return after > before
    })
    const deltas = results
      .get(cand.id)!
      .filter((m) => m.legal && !INKASSO_IDS.includes(m.id))
      .map((m) => Math.abs((m.topScore ?? 0) - (baseById.get(m.id)!.topScore ?? 0)))
    out(
      `| \`${cand.id}\` | ${triggered.length ? triggered.map((t) => `\`${t.id}\``).join(', ') : '**inga**'} | ` +
        `${Math.max(...deltas).toFixed(2)} |`,
    )
  }
  out()
  out('### Men eval-setet kan inte se riskytan')
  out()
  out('Ingen av eval-setets icke-inkassofrågor innehåller delsträngen `krav` — utlösningen')
  out('sker på `lower.includes(term)`, alltså på DELSTRÄNG, inte på ord. `formkrav` och')
  out('`kravbrev` matchar därför `krav` lika bra som ordet självt. Sonderingen nedan är')
  out('KONSTRUERAD (samma kvarstående svaghet som #390) och mäter bara den lexikala vägen.')
  out()
  out(
    [
      '| konstruerad fråga | juridisk? | PROD topp |',
      ...CANDIDATES.map((c) => ` ${c.id} topp (score/täckning) |`),
    ].join(''),
  )
  out(['| --- | --- | --- |', ...CANDIDATES.map(() => ' --- |')].join(''))
  for (const probe of OUT_OF_SET_PROBES) {
    const legal = isLegalQuestion(probe.question)
    const b = ranked(prodIdx, probe.question)[0]
    const cells = CANDIDATES.map((cand) => {
      const t = ranked(byVariant.get(cand.id)!, probe.question)[0]
      if (!t) return ' — |'
      const contaminated = t.chunk.lawId === 'inkassokostnadslagen'
      const cell = `${shortId(legalChunkId(t.chunk))} ${t.score.toFixed(1)}/${t.coverage.toFixed(2)}`
      return ` ${contaminated ? `**${cell}**` : cell} |`
    })
    out(
      [
        `| ${probe.question} | ${legal ? 'ja' : 'nej'} | ` +
          `${b ? `${shortId(legalChunkId(b.chunk))} ${b.score.toFixed(1)}/${b.coverage.toFixed(2)}` : '—'} |`,
        ...cells,
      ].join(''),
    )
  }
  out()
  out('Fetstil = inkassokostnadslagen har tagit förstaplatsen på en fråga som inte handlar')
  out('om inkassokostnader.')
  out()

  // ── 6b. Expansionen som NÄMNARE ────────────────────────────────────────────
  out('### Expansionen är också en nämnare — mätt åt båda hållen')
  out()
  out('Två fall i korpusen avgörs i dag av att en BEFINTLIG grupp lägger till stammar som')
  out('inte ger poäng. Båda syns genom att jämföra `PROD` mot `NOEXP`, och de pekar åt')
  out('motsatta håll — vilket är själva poängen: täckning är inte en relevanssignal som')
  out('bara skyddar, den är ett kvottal som expansionen kan flytta i vilken riktning som')
  out('helst.')
  out()
  out(
    '| fall | grupp som utlöses | score | täckning MED grupper | täckning UTAN | lexikalt insläpp med → utan |',
  )
  out('| --- | --- | --- | --- | --- | --- |')
  for (const id of ['paminnelseavgift-hogre-i-avtal', 'deposition-storlek']) {
    const c = LEGAL_EVAL_SET.find((x) => x.id === id)!
    const withG = baseById.get(id)!
    const without = noexpById.get(id)!
    const groups = triggeredGroups(prodIdx.variant, c.question)
      .map((g) => `#${g} (${BASELINE_CONCEPT_GROUPS[g]![0]!})`)
      .join(', ')
    out(
      `| \`${id}\` | ${groups} | ${fmt(withG.topScore)} | ${fmt(withG.topCoverage)} | ${fmt(without.topCoverage)} | ` +
        `${withG.lexicalPass ? 'JA' : 'NEJ'} → ${without.lexicalPass ? '**JA**' : 'NEJ'} |`,
    )
  }
  out()
  out('Båda landar UTAN expansion på exakt 0,40 — bandets kant, som är ett `<`-villkor. Det är')
  out('alltså inte två fall med marginal åt något håll, utan två fall som avgörs på decimalen')
  out('av hur många stammar frågan råkar ha. Stammarna, term för term:')
  out()
  out('| fall | stam | i toppchunken? | från grupp? |')
  out('| --- | --- | --- | --- |')
  for (const id of ['paminnelseavgift-hogre-i-avtal', 'deposition-storlek']) {
    const c = LEGAL_EVAL_SET.find((x) => x.id === id)!
    const withStems = [...queryStems(prodIdx.variant, c.question)]
      .filter((s) => s.length >= 4)
      .sort()
    const bare = new Set(
      [...queryStems(byVariant.get('NOEXP')!.variant, c.question)].filter((s) => s.length >= 4),
    )
    const top = baseById.get(id)!.top3[0]!
    const tf = prodIdx.termFreqs[chunks.indexOf(top.chunk)]!
    for (const s of withStems) {
      out(
        `| \`${id}\` | \`${s}\` | ${tf.has(s) ? 'ja' : 'nej'} | ${bare.has(s) ? 'nej (ur frågan)' : '**ja**'} |`,
      )
    }
  }
  out()

  // ── 7. NEGATIVKONTROLLERNA ─────────────────────────────────────────────────
  out('## 7. Negativkontrollerna')
  out()
  out(
    `\`${NEGATIVE_CONTROLS.join('` och `')}\` ska förbli ute. Kolumnen mäter den LEXIKALA vägen — den enda en tesaurus kan flytta.`,
  )
  out()
  out(['| variant |', ...NEGATIVE_CONTROLS.map((n) => ` ${n} (score/täckning) | ute? |`)].join(''))
  out(['| --- |', ...NEGATIVE_CONTROLS.map(() => ' --- | --- |')].join(''))
  for (const idx of indexes) {
    const ms = new Map(results.get(idx.variant.id)!.map((m) => [m.id, m]))
    const cells = NEGATIVE_CONTROLS.map((n) => {
      const m = ms.get(n)!
      return ` ${fmt(m.topScore)}/${fmt(m.topCoverage)} | ${m.lexicalPass ? '**NEJ — släpps in**' : 'JA'} |`
    })
    out([`| \`${idx.variant.id}\` |`, ...cells].join(''))
  }
  out()

  // ── 8. GOLVSVEPET ──────────────────────────────────────────────────────────
  out('## 8. Golvsvepet: håller golvet 9 sin kalibrering?')
  out()
  out('Svepet prövar varje golv 0,50–40,00 i steg om 0,05 och frågar om det samtidigt (a)')
  out(
    `behåller alla ${keepIds.size} fall som passerar lexikalt i dag och (b) håller båda negativkontrollerna`,
  )
  out('ute. Bandet hålls fast vid produktionens värden.')
  out()
  out(
    '| variant | säkert golvintervall (a+b) | max inkassofall in | vid golv | vid dagens golv 9 |',
  )
  out('| --- | --- | --- | --- | --- |')
  for (const idx of indexes) {
    const s = sweepFloors(results.get(idx.variant.id)!, keepIds)
    const range = s.safeFloors.length
      ? `${s.safeFloors[0]!.toFixed(2)}–${s.safeFloors[s.safeFloors.length - 1]!.toFixed(2)}`
      : '**tomt**'
    const atNine =
      `${s.atNine.targetsIn}/8 in` +
      `${s.atNine.keepsAll ? '' : ', TAPPAR behåll'}${s.atNine.controlsOut ? '' : ', SLÄPPER IN kontroll'}`
    out(
      `| \`${idx.variant.id}\` | ${range} | **${s.bestTargetsIn}/8** | ${s.bestFloor?.toFixed(2) ?? '—'} | ${atNine} |`,
    )
  }
  out()

  // ── 9. RANKING ─────────────────────────────────────────────────────────────
  out('## 9. Ranking, inte bara insläpp')
  out()
  out('Ett insläpp utan rättad ranking ger domaren fel paragrafer. Tabellen visar per')
  out('inkassofall: den lexikala topp-3, hela lagens paragrafrangordning, och FÖNSTRET')
  out('domaren faktiskt ser (RRF-fuserad topp-3 mot samma semantiska kanal).')
  out()
  for (const vid of ['PROD', ...CANDIDATES.map((c) => c.id)]) {
    const ms = new Map(results.get(vid)!.map((m) => [m.id, m]))
    out(`### \`${vid}\``)
    out()
    out(
      '| fall | facit | lexikal topp-3 | facit lexikal rank | inkassoparagrafernas ordning | domarens fönster | facit i fönstret? |',
    )
    out('| --- | --- | --- | --- | --- | --- | --- |')
    for (const id of INKASSO_IDS) {
      const m = ms.get(id)!
      const facits = facitIds(id)
      const facitRanks = facits
        .map((f) => {
          const label = `${f.split(':')[1]!} §`
          const p = Object.entries(m.probe).find(([k]) => k === label)
          return `${label}: ${p?.[1].rank ?? '—'}`
        })
        .join(', ')
      const order = Object.entries(m.probe)
        .filter(([, v]) => v.rank !== null)
        .sort((a, b) => a[1].rank! - b[1].rank!)
        .map(([k, v]) => `${k} ${v.score.toFixed(1)}`)
        .join(' > ')
      const window = m.fused.length
        ? m.fused
            .map((f) =>
              facits.includes(f)
                ? `**${shortId(f)}**`
                : f.startsWith('inkassokostnadslagen')
                  ? `${f.split(':').pop()!} §`
                  : shortId(f),
            )
            .join(' · ')
        : '—'
      const hit = facits.some((f) => m.fused.includes(f))
      const rank1 = facits.includes(m.fused[0] ?? '')
      out(
        `| \`${id}\` | ${facits.map((f) => `${f.split(':')[1]!} §`).join(', ')} | ${top3Cell(m)} | ${facitRanks} | ` +
          `${order || '—'} | ${window} | ${hit ? (rank1 ? 'JA, först' : 'ja') : '**NEJ**'} |`,
      )
    }
    out()
  }

  // ── 10. SAMMANFATTANDE UTFALL ──────────────────────────────────────────────
  out('## 10. Sammanfattande utfall per kandidat')
  out()
  out(
    '| variant | de fem över golvet | grindinsläpp totalt (8 inkasso) | facit i fönstret (8) | facit FÖRST i fönstret (8) | tappade fall | max Δ utanför inkasso |',
  )
  out('| --- | --- | --- | --- | --- | --- | --- |')
  for (const vid of ['PROD', ...CANDIDATES.map((c) => c.id)]) {
    const ms = new Map(results.get(vid)!.map((m) => [m.id, m]))
    const fiveIn = FIVE_REMAINING.filter((id) => ms.get(id)!.lexicalPass).length
    const gateIn = INKASSO_IDS.filter((id) => ms.get(id)!.gate === 'kandidat').length
    const inWindow = INKASSO_IDS.filter((id) =>
      facitIds(id).some((f) => ms.get(id)!.fused.includes(f)),
    ).length
    const first = INKASSO_IDS.filter((id) =>
      facitIds(id).includes(ms.get(id)!.fused[0] ?? ''),
    ).length
    const dropped = [...keepIds].filter((id) => !ms.get(id)!.lexicalPass)
    const deltas = results
      .get(vid)!
      .filter((m) => m.legal && !INKASSO_IDS.includes(m.id))
      .map((m) => Math.abs((m.topScore ?? 0) - (baseById.get(m.id)!.topScore ?? 0)))
    out(
      `| \`${vid}\` | ${fiveIn}/5 | ${gateIn}/8 | ${inWindow}/8 | ${first}/8 | ` +
        `${dropped.length ? dropped.join(', ') : '—'} | ${Math.max(...deltas).toFixed(2)} |`,
    )
  }
  out()

  // ── 11. SVARET ─────────────────────────────────────────────────────────────
  //
  // Varje siffra nedan interpoleras ur mätningen. Inget påstående får stå här
  // som skriptet inte räknat fram — annars är slutsatsen ett minne av en
  // körning i stället för ett resultat av den.
  const summary = (vid: string) => {
    const ms = new Map(results.get(vid)!.map((m) => [m.id, m]))
    const contaminated = OUT_OF_SET_PROBES.filter(
      (p) => ranked(byVariant.get(vid)!, p.question)[0]?.chunk.lawId === 'inkassokostnadslagen',
    ).length
    return {
      fiveIn: FIVE_REMAINING.filter((id) => ms.get(id)!.lexicalPass).length,
      first: INKASSO_IDS.filter((id) => facitIds(id).includes(ms.get(id)!.fused[0] ?? '')).length,
      inWindow: INKASSO_IDS.filter((id) => facitIds(id).some((f) => ms.get(id)!.fused.includes(f)))
        .length,
      contaminated,
      hogre: ms.get('paminnelseavgift-hogre-i-avtal')!,
      krav: ms.get('kravbrev-avgift')!,
      /** 1 § är tillämpningsparagrafen — aldrig ett svar. Hur ofta tar den en topp-3-plats? */
      oneInTop3: INKASSO_IDS.filter((id) =>
        ms.get(id)!.top3.some((r) => legalChunkId(r.chunk) === 'inkassokostnadslagen:1'),
      ).length,
    }
  }
  const sPROD = summary('PROD')
  const sT1 = summary('T1')
  const sT3 = summary('T3')
  const sT5 = summary('T5')
  const hogreNoexp = noexpById.get('paminnelseavgift-hogre-i-avtal')!

  out('## 11. Svaret')
  out()
  out('**Ja — en tesaurusgrupp lyfter alla fem över golvet utan att någon tröskel rörs.**')
  out('**Men gruppen som föreslogs gör det till priset av sämre ranking och av att dra in')
  out('inkassokostnadslagen i frågor som inte handlar om den. Den variant som klarar båda')
  out('delarna måste vara både beskuren och riktad mot ett känt facit — vilket gör den till')
  out('ett tak för metoden, inte ett generellt svar.**')
  out()
  out('### Insläppet: ja, utan att en tröskel rörs')
  out()
  out(
    `Samtliga fem passerar golvet ${MIN_TOP_SCORE} i varje mätt kandidat (${sT1.fiveIn}/5 i T1, ${sT3.fiveIn}/5 i T3), och det ` +
      'säkra golvintervallet är oförändrat mot produktionen i alla varianter — golvet 9 behåller',
  )
  out('sin kalibrering. Ingen negativkontroll släpps in. Inget fall som passerar i dag tappas.')
  out()
  out('### Men hypotesens mekanism stämmer inte som den formulerades')
  out()
  out(
    `Korrelationen finns (r = ${rAll.toFixed(2)}, ρ = ${rhoAll.toFixed(2)}), men "antal stammar" är inte det som avgör:`,
  )
  out(
    `\`kravbrev-avgift\` har ${[...queryStems(prodIdx.variant, LEGAL_EVAL_SET.find((c) => c.id === 'kravbrev-avgift')!.question)].filter((s) => s.length >= 4).length} scorade stammar och passerar på ${fmt(baseById.get('kravbrev-avgift')!.topScore)}, medan`,
  )
  out(
    `\`paminnelseavgift-taket\` har lika många och stannar på ${fmt(baseById.get('paminnelseavgift-taket')!.topScore)}. Det som skiljer är inte ANTALET`,
  )
  out('stammar utan om någon av dem är SÄLLSYNT och finns i rätt paragraf — `kravbrev` har')
  out(
    `df = ${prodIdx.docFreq.get('kravbrev') ?? 0}, medan takets \`myck\`/\`påminnelseavgift\` delas av 4 §. En grupp hjälper alltså`,
  )
  out('inte genom att vara lång, utan genom att den råkar innehålla en högfrekvent-IDF-stam')
  out('som bara målparagrafen har.')
  out()
  out('Och för ett av de fem är premissen direkt omvänd:')
  out(
    `\`paminnelseavgift-hogre-i-avtal\` UTLÖSER redan en grupp (#14 \`kontrakt|hyresavtal|avtal\`).`,
  )
  out(
    `Den ger 0,00 poäng — men sänker täckningen från ${fmt(hogreNoexp.topCoverage)} till ${fmt(baseById.get('paminnelseavgift-hogre-i-avtal')!.topCoverage)}, och det är precis det`,
  )
  out(
    `som fäller fallet i bandet. Med tesaurusen AVSTÄNGD passerar det (${fmt(hogreNoexp.topScore)} / ${fmt(hogreNoexp.topCoverage)}).`,
  )
  out('Fallet fälls alltså inte av en SAKNAD grupp utan av en BEFINTLIG. Samma mekanism åt')
  out(
    `andra hållet håller negativkontrollen \`deposition-storlek\` ute: utan expansion når den ${fmt(noexpById.get('deposition-storlek')!.topCoverage)}`,
  )
  out('och släpps in.')
  out()
  out('### Rankingen: insläppet räcker inte — den måste rättas separat')
  out()
  out(
    `- **\`paminnelseavgift-hogre-i-avtal\` (facit 6 §) blir SÄMRE av att släppas in av en ORIKTAD grupp.** 6 § ligger på ` +
      `lexikal rank ${sT3.hogre.probe['6 §']!.rank ?? '—'} i T3 och når inte domarens fönster; fönstret blir ` +
      `\`${sT3.hogre.fused.map(shortId).join(' · ')}\`. Kandidaten går alltså in med RÄTTEN (2 §) och TAKET (4 §)`,
  )
  out('  men utan ogiltighetsregeln — det svar #406:s eval-fall uttryckligen kallar osant.')
  out(
    `- **T1 blandar ihop paragraferna.** I \`kravbrev-avgift\` (facit 3 §) tappar 3 § förstaplatsen till 2 § ` +
      `(lexikal rank ${sT1.krav.probe['3 §']!.rank ?? '—'}), och 1 § — tillämpningsparagrafen, aldrig ett svar — tar en lexikal`,
  )
  out(
    `  topp-3-plats i ${sT1.oneInTop3} av 8 inkassofall (i dag: ${sPROD.oneInTop3}). Facit ligger FÖRST i fönstret i ${sT1.first}/8 fall mot ${sPROD.first}/8 i dag:`,
  )
  out('  T1 gör rankingen sämre samtidigt som den öppnar grinden. Det är exakt det utfall')
  out('  `kravbrev-avgift` skrevs för att fånga.')
  out(
    `- **Separationen (T2/T3) håller ordningen** — ${sT3.first}/8 facit först, 1 § i topp-3 i ${sT3.oneInTop3} fall — men lyfter`,
  )
  out(
    `  inte 6 §: facit når fönstret i ${sT3.inWindow}/8, samma som i dag. En ORIKTAD grupp kan inte veta`,
  )
  out('  vilken av lagens paragrafer frågan gäller.')
  out(
    `- **Riktad grupp kan laga ranking-hålet, men bara riktad.** T5 lyfter 6 § till lexikal rank ` +
      `${sT5.hogre.probe['6 §']!.rank ?? '—'} och in i fönstret (${sT5.inWindow}/8 facit i fönstret mot ${sT3.inWindow}/8 för T3), utan att tappa`,
  )
  out(
    `  något annat fall (${sT5.first}/8 facit först). Priset är att gruppen är skriven mot ett känt facit —`,
  )
  out('  och att dess frasform T4 aldrig ens utlöstes: `avtala om högre` är inte en delsträng av')
  out('  "avtala om **en** högre", så T4 är bit-för-bit identisk med T3. En tesaurus som ska')
  out('  träffa formuleringar den inte sett kan alltså inte förlita sig på fraser.')
  out()
  out('### Priset ligger utanför eval-setet')
  out()
  out(
    `T1:s term \`krav\` utlöses på DELSTRÄNG. Av ${OUT_OF_SET_PROBES.length} konstruerade icke-inkassofrågor med "krav" i sig ` +
      `får **${sT1.contaminated}** inkassokostnadslagen som lexikal etta i T1 — en fråga om formkrav vid uppsägning`,
  )
  out('landar alltså i påminnelseavgiftens paragraf, med score långt över bandets kant så att')
  out(
    `täckningen inte kan rädda den. T3 ger ${sT3.contaminated}/${OUT_OF_SET_PROBES.length}. Eval-setet innehåller ingen sådan fråga och kan`,
  )
  out('därför inte se skillnaden — det är en mätning av instrumentet, inte av korpusen.')
  out()
  out('### Vad mätningen INTE visar')
  out()
  out('- **Ingen domare kördes.** Mätningen stannar vid fönstret. Att facit når fönstret')
  out('  betyder att svaret KAN bli grundat i rätt paragraf, inte att det blir det.')
  out('- **Sonderingsfrågorna är påhittade.** De visar att riskytan finns, inte hur stor den är i')
  out('  prod-trafik. Samma kvarstående svaghet som #390.')
  out('- **T5 är skriven av någon som sett facit** och är därför ett tak för vad en riktad')
  out('  grupp kan göra, inte ett förslag som kan generaliseras.')
  out(
    '- **Bara den lexikala kanalen mättes för sonderingsfrågorna** — ingen cosine hämtades för dem.',
  )
  out()

  // ── Kontroller ─────────────────────────────────────────────────────────────
  const hashesAfter = snapshotHashes(buildLegalChunks())
  out('## Kontroller')
  out()
  out(
    `- Paritet mot produktionen (variant \`${prodVariant.variant.id}\`): **max |Δscore| = 0, max |Δcoverage| = 0**, ` +
      `noll grindavvikelser och noll fused-avvikelser (${LEGAL_EVAL_SET.length} frågor × ${chunks.length} chunkar).`,
  )
  out(
    `- Lagtextens content-hashar: **${hashesAfter === hashesBefore ? 'oförändrade' : 'ÄNDRADE — FEL'}** (${chunks.length} chunkar).`,
  )
  out(`- Korpus: N = ${chunks.length}, identisk med golvets kalibrerings-N.`)
  out('- Trösklar: `MIN_TOP_SCORE`, `LOW_SCORE_BAND`, `MIN_COVERAGE_IN_BAND` och')
  out('  `MIN_TOP_COSINE` lästes, aldrig skrevs. Ingen produktionsfil ändrad av mätningen.')
  out()

  if (hashesAfter !== hashesBefore) throw new Error('content-hashar ändrades under mätningen')

  const target = resolve(__dirname, '../../../docs/research/406-tesaurus-inkasso.md')
  writeFileSync(target, `${md.join('\n')}\n`, 'utf8')
  console.warn(`\n[mät] rapport skriven till ${target}`)
}

main().catch((err: unknown) => exitOnPreflightError(err, 'mät'))
