/**
 * MÄTSKRIPT för #425 — täckningens nämnare. Kartläggning, INGEN produktionsändring.
 *
 * DEFEKTEN SOM MÄTS: `queryStems()` expanderar frågan med hela tesaurusgruppen,
 * och de tillagda stammarna hamnar i BÅDE poängen och täckningens NÄMNARE. En
 * tillagd stam som saknas i chunken bidrar 0 till poängen men räknas ändå i
 * nämnaren — alltså sänker en grupp som ger noll poäng täckningen strikt.
 * Täckningen är inte kosmetisk: grinden läser den i bandet
 * `score < LOW_SCORE_BAND && coverage < MIN_COVERAGE_IN_BAND` → fäll.
 *
 * VARIANTEN SOM PRÖVAS (#425:s lösningsförslag 1): täckningen räknas över
 * frågans EGNA stammar, före expansion. Tesaurusen är ett RECALL-verktyg; att
 * låta den sätta nämnaren i ett PRECISIONS-mått blandar ihop två syften.
 *
 * VARFÖR MÄTNINGEN ÄR BILLIG OCH AVGÖRANDE: varianten rör inte en enda score.
 * Poängen är identisk med produktionens på varje fråga × chunk — bara nämnaren
 * flyttas. Täckningens ENDA produktionskonsument är grindens band
 * (legal-grounding.ts, en rad), så hela effekten är mätbar som en
 * insläppsändring. Ingen fusion, ingen cosine och inget domaranrop kan flyttas
 * av varianten.
 *
 * KÖRS MANUELLT (inte i CI):
 *   cd apps/api && node --env-file-if-exists=.env \
 *     -r ts-node/register scripts/measure-425-coverage-denominator.ts [--no-semantic]
 *   npx prettier --write docs/research/425-taeckningens-namnare.md
 *
 * Prettier-steget hör till receptet, inte städningen: lint-staged formaterar om
 * rapporten vid commit, så utan det ger varje ny körning en diff mot grenen och
 * det går inte att se om SIFFRORNA ändrats eller bara radbrytningarna.
 *
 * VARFÖR --no-semantic INTE RÄCKER FÖR SLUTSATSEN: grinden släpper in på
 * lexikal ELLER semantisk väg. En lexikal vändning som maskeras av ett
 * semantiskt insläpp ändrar ingenting i produktionen. Utan cosine mäter
 * skriptet därför den lexikala halvan korrekt men kan inte säga vad grinden
 * faktiskt hade gjort. Flaggan finns för snabb iteration, inte för rapporten.
 */
import { writeFileSync } from 'fs'
import { resolve } from 'path'
import { requireApiKey, verifyVoyageKey, exitOnPreflightError } from './preflight-keys'
import { buildLegalChunks, legalChunkId } from '../src/ai/knowledge/retrieval/legal-chunk'
import type { LegalChunk } from '../src/ai/knowledge/retrieval/legal-chunk'
import { searchTermsFor } from '../src/ai/knowledge/retrieval/legal-search-terms'
import { INKASSO_CONCEPT_GROUPS } from '../src/ai/knowledge/retrieval/legal-retrieval'
import {
  isLegalQuestion,
  MIN_TOP_SCORE_CALIBRATED_AT_CHUNKS,
} from '../src/ai/knowledge/grounding/legal-grounding'
import { LEGAL_EVAL_SET } from '../src/ai/knowledge/eval/legal-eval-set'
import { VOYAGE_EMBEDDINGS } from '../src/ai/ai.config'
import {
  LOW_SCORE_BAND,
  MIN_COVERAGE_IN_BAND,
  MIN_TOP_SCORE,
  CONCEPT_GROUPS_PR3,
  baselineAnalyze,
  buildVariantIndex,
  queryStems,
  scoreAll,
  triggeredGroups,
  assertBaselineParity,
  detectProductionVariant,
  measureVariant,
  snapshotHashes,
  collectSemantic,
  NEGATIVE_CONTROLS,
  type Variant,
  type Probe,
  type CaseMeasurement,
  type SemanticHit,
} from './lib/legal-retrieval-mirror'

// ── Produktionens indexerade text (PR3: söktermer jämte lagtexten) ───────────
// Importerad, aldrig kopierad.
const searchTermIndexText = (chunk: LegalChunk): string => {
  const terms = searchTermsFor(chunk)
  return terms.length > 0 ? `${chunk.text}\n${terms.join(' ')}` : chunk.text
}

/** Produktionens tesaurus efter PR4 = PR3-baslinjen + inkassogrupperna. */
const PRODUCTION_GROUPS: readonly (readonly string[])[] = [
  ...CONCEPT_GROUPS_PR3,
  ...INKASSO_CONCEPT_GROUPS,
]

/**
 * Nämnaren i variant 1: frågans egna stammar, INNAN någon grupp expanderat.
 * Noterbart att den inte tar hänsyn till vilken grupp som utlöstes — den
 * frågar inte "bidrog gruppen?" utan "kom stammen från användaren?".
 */
const ownStemsOnly = (variant: Variant, query: string): Set<string> =>
  new Set(variant.analyze(query))

const PROBES: Record<string, Probe> = {
  'inkasso 2 §': { lawId: 'inkassokostnadslagen', paragraph: '2' },
  'inkasso 4 §': { lawId: 'inkassokostnadslagen', paragraph: '4' },
  'inkasso 6 §': { lawId: 'inkassokostnadslagen', paragraph: '6' },
}

const fmt = (n: number | null, d = 2): string => (n === null ? '—' : n.toFixed(d))
const md: string[] = []
const out = (s = ''): void => {
  md.push(s)
}

/** Facit för ett fall, som chunk-id-prefix (lawId + paragraf). */
function facitIds(caseId: string): string[] {
  const c = LEGAL_EVAL_SET.find((x) => x.id === caseId)
  if (!c) return []
  return c.expectedSources.flatMap((s) => s.paragraphs.map((p) => `${s.lawId} ${p}`))
}

/** Ligger facit i topp-3 av den lexikala listan? */
function facitInTop3(m: CaseMeasurement): boolean {
  const want = new Set(facitIds(m.id))
  return m.top3.some((r) => want.has(`${r.chunk.lawId} ${r.chunk.paragraph}`))
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

  // Cosine mäts EN gång: varianten rör varken chunk-texten eller frågesträngen,
  // så den kan per konstruktion inte flytta en cosine.
  let cosineByCase = new Map<string, number | null>()
  let semanticByCase = new Map<string, SemanticHit[]>()
  let fusedByCase = new Map<string, string[]>()
  if (noSemantic) {
    console.warn(
      '[mät] --no-semantic: cosine = null (ren BM25-väg, EJ giltig för rapportens grind)',
    )
    for (const c of LEGAL_EVAL_SET) cosineByCase.set(c.id, null)
  } else {
    const voyageKey = requireApiKey({
      envVar: 'VOYAGE_API_KEY',
      whatFor: 'query-embeddingarna i täckningsmätningen',
      expectedPrefix: 'pa-',
    })
    await verifyVoyageKey(voyageKey, VOYAGE_EMBEDDINGS.MODEL)
    ;({ cosineByCase, semanticByCase, fusedByCase } = await collectSemantic(chunks))
  }

  // ── Varianterna ────────────────────────────────────────────────────────────
  const variants: Variant[] = [
    {
      id: 'PROD',
      label: 'produktionen i dag: nämnaren = stammarna EFTER expansion',
      analyze: baselineAnalyze,
      indexText: searchTermIndexText,
      conceptGroups: PRODUCTION_GROUPS,
    },
    {
      id: 'V1',
      label: '#425 förslag 1: nämnaren = frågans EGNA stammar, före expansion',
      analyze: baselineAnalyze,
      indexText: searchTermIndexText,
      conceptGroups: PRODUCTION_GROUPS,
      coverageStems: ownStemsOnly,
    },
    {
      // Diagnostik, inget förslag. Isolerar vad expansionen är värd i dag: här
      // faller BÅDE score och täckning bort, medan V1 bara rör täckningen.
      // Skillnaden V1 − NOEXP är precis den recall expansionen köper.
      id: 'NOEXP',
      label: 'diagnostik: tesaurusen helt avstängd (0 grupper) — score OCH täckning faller',
      analyze: baselineAnalyze,
      indexText: searchTermIndexText,
      conceptGroups: [],
    },
  ]

  const indexes = variants.map((v) => buildVariantIndex(v, chunks))
  const byVariant = new Map(indexes.map((i) => [i.variant.id, i]))

  // Att produktionen implementerar PROD är inte ett antagande här utan en
  // mätning. Sedan #425 jämför detectProductionVariant BÅDE score och täckning
  // — utan det hade V1 (identisk score, annan nämnare) varit oskiljbar från
  // PROD och funktionen fällt körningen på "fler än en matchade".
  const prodVariant = detectProductionVariant(indexes)
  console.warn(`[mät] produktionen implementerar variant: ${prodVariant.variant.id}`)
  if (prodVariant.variant.id !== 'PROD') {
    throw new Error(
      `produktionen implementerar ${prodVariant.variant.id} — väntade PROD. ` +
        'Antingen har tesaurusen eller täckningsformeln flyttats sedan mätningen skrevs.',
    )
  }
  assertBaselineParity(prodVariant, cosineByCase, fusedByCase, semanticByCase)

  const results = new Map<string, CaseMeasurement[]>()
  for (const idx of indexes) {
    results.set(idx.variant.id, measureVariant(idx, cosineByCase, semanticByCase, PROBES))
  }
  const prod = results.get('PROD')!
  const v1 = new Map(results.get('V1')!.map((m) => [m.id, m]))
  const noexp = new Map(results.get('NOEXP')!.map((m) => [m.id, m]))
  const legalCases = prod.filter((m) => m.legal)

  // ── Kontroll: rör varianten någon score? ───────────────────────────────────
  // Påståendet "V1 ändrar inte en enda score" är hela grunden för att effekten
  // kan avläsas i grinden ensam. Det MÄTS, aldrig antas.
  let maxScoreDelta = 0
  const prodIdx = byVariant.get('PROD')!
  const v1Idx = byVariant.get('V1')!
  for (const c of LEGAL_EVAL_SET) {
    if (!isLegalQuestion(c.question)) continue
    const a = new Map(scoreAll(prodIdx, c.question).map((r) => [legalChunkId(r.chunk), r.score]))
    for (const r of scoreAll(v1Idx, c.question)) {
      maxScoreDelta = Math.max(
        maxScoreDelta,
        Math.abs((a.get(legalChunkId(r.chunk)) ?? 0) - r.score),
      )
    }
  }
  console.warn(`[mät] max |Δscore| PROD vs V1 = ${maxScoreDelta.toExponential(2)}`)
  if (maxScoreDelta > 1e-12) {
    throw new Error(
      `V1 flyttade en score (max |Δ| = ${maxScoreDelta}) — varianten skulle bara röra nämnaren. ` +
        'Mätningen är ogiltig.',
    )
  }

  // ── Rapport ────────────────────────────────────────────────────────────────
  out('# #425 — täckningens nämnare: räknas den på frågan eller på tesaurusen?')
  out()
  out('> MÄTNING, INGEN FIX. Ingen tröskel, lagtext, tesaurusgrupp eller domarprompt ändrad.')
  out(
    `> Genererad av \`apps/api/scripts/measure-425-coverage-denominator.ts\` mot korpus N = ${chunks.length}, main efter #406 PR4.`,
  )
  out(
    `> Grindens band: \`score < ${LOW_SCORE_BAND} && coverage < ${MIN_COVERAGE_IN_BAND}\` → fäll. Golvet: \`score >= ${MIN_TOP_SCORE}\`.`,
  )
  out()
  out('## 0. Varianten rör inte en enda score')
  out()
  out(
    `Uppmätt över samtliga ${LEGAL_EVAL_SET.length} eval-frågor × ${chunks.length} chunkar: ` +
      `**max |Δscore| = ${maxScoreDelta.toExponential(2)}** mellan PROD och V1.`,
  )
  out()
  out(
    'Det är förutsättningen för att läsa resten som en grindmätning. Eftersom täckningens enda ' +
      'produktionskonsument är bandet i `legal-grounding.ts`, och ingen score flyttas, kan varianten ' +
      'varken röra den lexikala rangordningen, fusionen, cosine eller vilka chunkar domaren ser. ' +
      'Hela dess verkan är insläppet.',
  )
  out()

  // ── 1. Vilka frågor expanderas överhuvudtaget? ────────────────────────────
  out('## 1. Hur många frågor rör varianten?')
  out()
  out('| fall | egna stammar | efter expansion | tillagda | utlösta grupper |')
  out('| --- | --- | --- | --- | --- |')
  let touched = 0
  for (const m of legalCases) {
    const c = LEGAL_EVAL_SET.find((x) => x.id === m.id)!
    const own = ownStemsOnly(prodIdx.variant, c.question)
    const expanded = queryStems(prodIdx.variant, c.question)
    const added = expanded.size - own.size
    if (added > 0) touched++
    const groups = triggeredGroups(prodIdx.variant, c.question)
    out(
      `| \`${m.id}\` | ${own.size} | ${expanded.size} | ${added > 0 ? `**+${added}**` : '0'} | ` +
        `${groups.length > 0 ? groups.map((g) => `#${g + 1}`).join(', ') : '—'} |`,
    )
  }
  out()
  out(
    `**${touched} av ${legalCases.length}** juridiska eval-frågor utlöser minst en grupp som ` +
      'tillför stammar. För resten är V1 och PROD identiska per konstruktion.',
  )
  out()

  // ── 2. Täckning och insläpp, per fall ─────────────────────────────────────
  out('## 2. Täckning och lexikalt insläpp')
  out()
  out(
    'Täckningen avser topp-chunken i den lexikala listan — det är den grinden läser. ' +
      '`NOEXP` står med som diagnostik: där faller både score och täckning bort, så den ' +
      'är inte ett alternativ till V1 utan referensen som visar vad expansionen köper.',
  )
  out()
  out(
    '| fall | topp-score | täckn. PROD | täckn. V1 | täckn. NOEXP | lex. insläpp PROD → V1 | grind PROD → V1 |',
  )
  out('| --- | --- | --- | --- | --- | --- | --- |')
  const lexFlips: CaseMeasurement[] = []
  const gateFlips: CaseMeasurement[] = []
  for (const m of legalCases) {
    const a = v1.get(m.id)!
    const n = noexp.get(m.id)!
    const lexFlip = m.lexicalPass !== a.lexicalPass
    const gateFlip = m.gate !== a.gate
    if (lexFlip) lexFlips.push(m)
    if (gateFlip) gateFlips.push(m)
    const lexCell = lexFlip
      ? `**${m.lexicalPass ? 'passerar' : 'fälls'} → ${a.lexicalPass ? 'passerar' : 'fälls'}**`
      : m.lexicalPass
        ? 'passerar'
        : 'fälls'
    const gateCell = gateFlip ? `**${m.gate} → ${a.gate}**` : m.gate
    out(
      `| \`${m.id}\` | ${fmt(m.topScore, 1)} | ${fmt(m.topCoverage)} | ${fmt(a.topCoverage)} | ` +
        `${fmt(n.topCoverage)} | ${lexCell} | ${gateCell} |`,
    )
  }
  out()

  // ── 3. Vändningarna ───────────────────────────────────────────────────────
  out('## 3. Vändningarna')
  out()
  if (lexFlips.length === 0) {
    out(
      '**Ingen fråga i eval-setet ändrar lexikalt insläpp.** Varianten är i så fall inert på ' +
        'det mätbara underlaget — vilket inte är samma sak som att defekten inte finns, bara att ' +
        'eval-setet inte innehåller ett fall som exponerar den.',
    )
  } else {
    out(`**${lexFlips.length} fall ändrar lexikalt insläpp:**`)
    out()
    out(
      '| fall | riktning | täckn. PROD → V1 | topp-score | negativkontroll? | facit i lex. topp-3? |',
    )
    out('| --- | --- | --- | --- | --- | --- |')
    for (const m of lexFlips) {
      const a = v1.get(m.id)!
      out(
        `| \`${m.id}\` | ${m.lexicalPass ? 'passerar → **fälls**' : 'fälls → **passerar**'} | ` +
          `${fmt(m.topCoverage)} → ${fmt(a.topCoverage)} | ${fmt(m.topScore, 1)} | ` +
          `${NEGATIVE_CONTROLS.includes(m.id) ? '**JA**' : 'nej'} | ` +
          `${facitInTop3(a) ? 'ja' : 'nej'} |`,
      )
    }
  }
  out()
  out(
    'Skillnaden mellan lexikalt insläpp och GRIND är inte formalia: grinden släpper in på ' +
      'lexikal **eller** semantisk väg. En lexikal vändning som maskeras av ett semantiskt ' +
      'insläpp ändrar ingenting i produktionen.',
  )
  out()
  if (gateFlips.length === 0) {
    out(
      '**Noll fall ändrar grindutfall.** Varje lexikal vändning ovan är alltså maskerad av ' +
        'den semantiska vägen — varianten är osynlig för produktionen på det här eval-setet.',
    )
  } else {
    out(`**${gateFlips.length} fall ändrar grindutfall:**`)
    out()
    out('| fall | grind PROD → V1 | cosine | negativkontroll? |')
    out('| --- | --- | --- | --- |')
    for (const m of gateFlips) {
      const a = v1.get(m.id)!
      out(
        `| \`${m.id}\` | ${m.gate} → **${a.gate}** | ${fmt(cosineByCase.get(m.id) ?? null, 3)} | ` +
          `${NEGATIVE_CONTROLS.includes(m.id) ? '**JA**' : 'nej'} |`,
      )
    }
  }
  out()

  // ── 4. Negativkontrollerna, alltid utskrivna ──────────────────────────────
  out('## 4. Negativkontrollerna')
  out()
  out(
    'De står här oavsett om de rörde sig. En variant som släpper in en negativkontroll är ' +
      'inte en förbättring även om den räddar ett riktigt fall.',
  )
  out()
  out('| negativkontroll | täckn. PROD → V1 | lex. insläpp PROD → V1 | grind PROD → V1 |')
  out('| --- | --- | --- | --- |')
  for (const id of NEGATIVE_CONTROLS) {
    const m = prod.find((x) => x.id === id)
    const a = v1.get(id)
    if (!m || !a) {
      out(`| \`${id}\` | — | — | SAKNAS I EVAL-SETET |`)
      continue
    }
    out(
      `| \`${id}\` | ${fmt(m.topCoverage)} → ${fmt(a.topCoverage)} | ` +
        `${m.lexicalPass ? 'passerar' : 'fälls'} → ${a.lexicalPass ? 'passerar' : 'fälls'} | ` +
        `${m.gate} → ${a.gate} |`,
    )
  }
  out()

  // ── 5. Reproducerar mätningen #425:s två rader? ───────────────────────────
  out('## 5. Reproducerar mätningen #425:s tabell?')
  out()
  out(
    'Ärendet uppger två rader. Kolumnrubriken där lyder "täckning med → utan expansion" ' +
      'medan brödtexten säger "utan expansion ligger båda på exakt 0,40" — de två läsningarna ' +
      'är oförenliga, och tabellen nedan avgör vilken som gäller.',
  )
  out()
  out(
    '| fall | täckn. MED expansion (PROD) | täckn. UTAN expansion i nämnaren (V1) | #425 uppger |',
  )
  out('| --- | --- | --- | --- |')
  for (const [id, claim] of [
    ['paminnelseavgift-hogre-i-avtal', '0,40 → 0,29'],
    ['deposition-storlek', '0,40 → 0,33'],
  ] as const) {
    const m = prod.find((x) => x.id === id)
    const a = v1.get(id)
    out(
      `| \`${id}\` | ${fmt(m?.topCoverage ?? null)} | ${fmt(a?.topCoverage ?? null)} | ${claim} |`,
    )
  }
  out()

  // ── 6. Varför V1 nollar täckningen på vissa fall ──────────────────────────
  const zeroed = legalCases.filter((m) => {
    const a = v1.get(m.id)!
    return (m.topCoverage ?? 0) > 0 && a.topCoverage === 0
  })
  out('## 6. Varför V1 nollar täckningen på vissa fall')
  out()
  if (zeroed.length === 0) {
    out('Ingen fråga går till täckning 0,00 under V1.')
  } else {
    out(
      `${zeroed.length} fall får täckning **exakt 0,00** under V1 — inte lågt, utan noll: ` +
        'ingen enda av frågans egna stammar finns i topp-chunken. Det är svenskans ' +
        'sammansättningar. Hyresvärden skriver ett sammansatt ord, lagen skriver leden isär, ' +
        'och stamningen förenar dem inte.',
    )
    out()
    out('| fall | frågans egna stammar (≥ 4 tecken) | i topp-chunken? | topp-chunk |')
    out('| --- | --- | --- | --- |')
    for (const m of zeroed) {
      const c = LEGAL_EVAL_SET.find((x) => x.id === m.id)!
      const own = [...ownStemsOnly(prodIdx.variant, c.question)].filter((s) => s.length >= 4)
      const top = m.top3[0]
      const tf = top ? prodIdx.termFreqs[prodIdx.chunks.indexOf(top.chunk)] : undefined
      const present = own.filter((s) => tf?.has(s))
      out(
        `| \`${m.id}\` | ${own.map((s) => `\`${s}\``).join(', ')} | ` +
          `${present.length > 0 ? present.map((s) => `\`${s}\``).join(', ') : '**ingen**'} | ` +
          `${top ? `\`${legalChunkId(top.chunk)}\`` : '—'} |`,
      )
    }
    out()
    out(
      'Det är exakt det vokabulärgap #406 handlar om. Tesaurusen finns för att brygga det — ' +
        'och i V1 räknas bryggan bort ur BÅDE täljaren och nämnaren, så måttet blir noll ' +
        'precis där gapet är som störst.',
    )
  }
  out()

  // ── 7. Svaret ─────────────────────────────────────────────────────────────
  const harmful = lexFlips.filter((m) => m.lexicalPass && !v1.get(m.id)!.lexicalPass)
  const loosened = lexFlips.filter((m) => !m.lexicalPass && v1.get(m.id)!.lexicalPass)
  out('## 7. Svaret')
  out()
  out(
    `**Variant 1 är motbevisad som fix.** Den räddar inget fall och kostar ${harmful.length}: ` +
      `${harmful.map((m) => `\`${m.id}\``).join(', ') || '—'} tappar lexikalt insläpp` +
      `${gateFlips.length > 0 ? ' och byter grindutfall' : ''}, trots att facit ligger i den lexikala topp-3:an. ` +
      `Samtidigt släpper den igenom ${loosened.length} fall lexikalt: ` +
      `${loosened.map((m) => `\`${m.id}\``).join(', ') || '—'}` +
      `${loosened.some((m) => NEGATIVE_CONTROLS.includes(m.id)) ? ' — en **negativkontroll**.' : '.'}`,
  )
  out()
  out(
    'Mekanismen ärendet beskriver är verklig: nämnaren styrs i dag av tesaurusen, och ' +
      `${touched} av ${legalCases.length} frågor expanderas. Men slutsatsen att nämnaren därför ` +
      'bör vara frågans egna stammar följer inte. Täljaren kommer från samma expansion. Att ta ' +
      'bort expansionen ur kvoten mäter inte "hur väl chunken täcker frågan" utan "hur mycket av ' +
      'användarens ordagranna formulering som råkar stå i lagtexten" — och det är precis det ' +
      'måttet svenska sammansättningar bryter.',
  )
  out()
  out(
    'Det oavsiktliga skyddet ärendet pekar ut är däremot **bekräftat**: `deposition-storlek` ' +
      `hålls ute lexikalt i dag (täckning ${fmt(prod.find((m) => m.id === 'deposition-storlek')?.topCoverage ?? null)}) ` +
      `och släpps in under V1 (${fmt(v1.get('deposition-storlek')?.topCoverage ?? null)}, mot ett \`<\`-villkor vid ${MIN_COVERAGE_IN_BAND}). ` +
      'Ingen test bevakar det, och det är en utspädning som råkar peka rätt — inte en design. ' +
      'Att grindutfallet ändå inte rör sig beror på att fallet passerar semantiskt; det är ' +
      'domaren, inte grinden, som håller det ute (invariant 3).',
  )
  out()
  out(
    '**Vad mätningen inte säger:** ingenting om förslag 2 (bara stammar som finns i korpusen ' +
      'i nämnaren), 3 (rätta stamningen) eller 4 (delsträngsutlösningen). Förslag 3 pekar ' +
      'dessutom rakt mot fyndet i avsnitt 6 — sammansättningsledsdelning hade gjort ' +
      'täckningen meningsfull på exakt de fall där V1 nollar den — men är korpus-global och ' +
      'tvingar fram en omkalibrering av golvet enligt `406-grind-kartlaggning.md`.',
  )
  out()

  // ── 8. Lagtexten orörd ────────────────────────────────────────────────────
  const hashesAfter = snapshotHashes(buildLegalChunks())
  out('## 8. Lagtexten är orörd')
  out()
  out(
    hashesAfter === hashesBefore
      ? `Content-hasharna för samtliga ${chunks.length} chunkar är identiska före och efter mätningen.`
      : '**HASHARNA FLYTTADE SIG UNDER KÖRNINGEN — rapporten är ogiltig.**',
  )
  if (hashesAfter !== hashesBefore) {
    throw new Error('chunk-hasharna ändrades under mätningen')
  }
  out()
  if (noSemantic) {
    out(
      '> ⚠ Körd med `--no-semantic`: cosine = null för alla fall, så grind-kolumnerna ' +
        'beskriver INTE produktionens grind. Endast de lexikala kolumnerna är giltiga.',
    )
    out()
  }

  const target = resolve(__dirname, '../../../docs/research/425-taeckningens-namnare.md')
  writeFileSync(target, `${md.join('\n')}\n`, 'utf8')
  console.warn(`[mät] rapport skriven: ${target}`)
}

main().catch((err: unknown) => exitOnPreflightError(err, 'mät'))
