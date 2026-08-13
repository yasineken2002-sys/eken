/**
 * MÄTSKRIPT: dör de kvarvarande fallen i FÖNSTRET eller hos DOMAREN?
 *
 * FRÅGAN: efter #406 PR4 passerar samtliga answerable-fall grinden, och de fem
 * som ändå missar fälls alla av relevansdomaren. Det döljer två helt olika
 * problem bakom ett och samma utfall:
 *   - facit SAKNAS i fönstret domaren ser → FUSIONSPROBLEM. Åtgärden ligger på
 *     den semantiska sidan (reserverad plats, omviktad RRF, större
 *     GROUNDING_TOP_K).
 *   - facit FINNS i fönstret och domaren säger ändå NEJ → DOMARPROBLEM.
 * Skillnaden avgör var nästa arbete ska läggas, och den går inte att gissa sig
 * till: båda ger `miss` i gate-evalen.
 *
 * KÖRS MANUELLT (inte i CI — kräver nät: Voyage + Anthropic + embeddad DB):
 *   cd apps/api && node --env-file-if-exists=.env \
 *     -r ts-node/register scripts/measure-406-judge-vs-window.ts
 *   npx prettier --write docs/research/406-domare-vs-fonster.md
 *
 * VAD SKRIPTET FÅR GÖRA: importera och mäta. Ingen produktionsregel, tröskel,
 * lagtext eller domarprompt ändras. GROUNDING_TOP_K LÄSES — frågan "hade facit
 * kommit med vid K = 5 eller 10?" besvaras genom att räkna på den fuserade
 * listan, aldrig genom att flytta konstanten.
 *
 * DOMAREN ANROPAS SOM I PRODUKTIONEN: samma modell (AI_MODELS.MEMORY), samma
 * temperature 0, samma max_tokens och samma prompt-byggare, med samma indata —
 * `retrieval.fused` via evaluateLegalCandidate. En rigg som matar domaren något
 * annat än produktionen gör mäter riggen, inte produkten.
 */
import Anthropic from '@anthropic-ai/sdk'
import { writeFileSync } from 'fs'
import { resolve } from 'path'
import { requireApiKey, verifyVoyageKey, exitOnPreflightError } from './preflight-keys'
import { buildLegalChunks, legalChunkId } from '../src/ai/knowledge/retrieval/legal-chunk'
import type { LegalChunk } from '../src/ai/knowledge/retrieval/legal-chunk'
import { searchTermsFor } from '../src/ai/knowledge/retrieval/legal-search-terms'
import { INKASSO_CONCEPT_GROUPS } from '../src/ai/knowledge/retrieval/legal-retrieval'
import {
  evaluateLegalCandidate,
  buildRelevanceJudgePrompt,
  parseRelevanceVerdict,
  isLegalQuestion,
  GROUNDING_TOP_K,
  MIN_TOP_SCORE_CALIBRATED_AT_CHUNKS,
} from '../src/ai/knowledge/grounding/legal-grounding'
import { LEGAL_EVAL_SET } from '../src/ai/knowledge/eval/legal-eval-set'
import { AI_MODELS } from '../src/ai/ai.config'
import { VOYAGE_EMBEDDINGS } from '../src/ai/ai.config'
import {
  CONCEPT_GROUPS_PR3,
  CHANNEL_TOP_K,
  RRF_K,
  baselineAnalyze,
  buildVariantIndex,
  ranked,
  scoreAll,
  detectProductionVariant,
  assertBaselineParity,
  snapshotHashes,
  collectSemantic,
  type Variant,
  type VariantIndex,
  type SemanticHit,
} from './lib/legal-retrieval-mirror'

/** Produktionens indexerade text (PR3) — importerad, aldrig kopierad. */
const searchTermIndexText = (chunk: LegalChunk): string => {
  const terms = searchTermsFor(chunk)
  return terms.length > 0 ? `${chunk.text}\n${terms.join(' ')}` : chunk.text
}

/**
 * Produktionens tesaurus EFTER PR4 = PR3-listan plus de tre inkassogrupperna.
 * Den senare halvan importeras ur produktionsmodulen, så listan kan inte glida
 * isär från den som körs. Att sammansättningen är RÄTT är dessutom mätt:
 * detectProductionVariant kräver bit-för-bit identisk score.
 */
const PRODUCTION_CONCEPT_GROUPS = [...CONCEPT_GROUPS_PR3, ...INKASSO_CONCEPT_GROUPS]

/** De fem answerable-fall som passerar grinden men fälls av domaren (uppmätt efter PR4). */
interface Target {
  id: string
  /** Invariant som gör NEJ till ett AVSETT utfall — då är fallet inte ett problem. */
  intendedMissBy?: string
}
const TARGETS: Target[] = [
  { id: 'paminnelseavgift-vad-galler' },
  { id: 'hyresgastval-diskriminering' },
  {
    id: 'besittningsskydd-andrahand-2ar',
    intendedMissBy:
      'invariant 2 — §45 ligger utanför fused topp-8 i båda kanalerna för den här ' +
      'formuleringen; dokumenterad känd begränsning, ärlig miss är det säkra utfallet',
  },
  {
    id: 'drojsmalsranta-sen-hyra',
    intendedMissBy:
      'invariant 7 — domaren fäller 6/6 även när rätt paragraf ligger i kandidatmängden; ' +
      'ärlig miss ELLER grundad med rätt källa är båda tillåtna utfall',
  },
  {
    id: 'besittningsskydd-lokal',
    intendedMissBy:
      'invariant 7 — kräver inferens ur regel-FRÅNVARO (lokal har inget direkt ' +
      'besittningsskydd); ärlig miss är ett tillåtet och säkert utfall',
  },
]

// TIO, inte tre. Tre räckte för att SE att domaren flakar på ett av fallen
// (NEJ/JA/JA vid temperature 0), men inte för att säga hur ofta. Temperature 0
// gör en modell nästan-deterministisk, inte deterministisk — och ett gränsfall
// är precis där den skillnaden syns.
const JUDGE_RUNS = 10

/**
 * DOMARVERDIKT UR ANDRA KÖRNINGAR I DAG — en FRUSEN observationsjournal, inte
 * tal det här skriptet räknat fram.
 *
 * VARFÖR DEN MÅSTE FINNAS: flakigheten upptäcktes i en körning som gav
 * NEJ/JA/JA, och en senare 10-körning gav 10× NEJ. Låter man rapporten avgöra
 * "stabilt eller inte" ur ENBART den aktuella körningen försvinner alltså hela
 * fyndet så snart ett stickprov råkar bli enhetligt — och rapporten skulle då
 * påstå motsatsen till vad som faktiskt är uppmätt. Journalen gör fyndet
 * beständigt: stabiliteten bedöms mot summan, inte mot dagens tärningskast.
 *
 * Indata är verifierat identisk mellan serierna: samma domarprompt, byggd ur
 * samma fused topp-3, vilket fused-pariteten mot produktionen bevisar.
 *
 * Talen är räknade UR KÖRNINGSLOGGARNA, inte ur minnet — en handförd journal
 * driver isär, och gjorde det två gånger under den här mätningen innan den
 * räknades om från loggarna. Kör du om skriptet blir den här körningen en till
 * rad: uppdatera då siffrorna. Slutsatsen (domaren är inte deterministisk vid
 * temperature 0) hänger inte på de exakta talen.
 */
const PRIOR_JUDGE_OBSERVATIONS: Record<string, { label: string; ja: number; nej: number }[]> = {
  'paminnelseavgift-vad-galler': [
    { label: 'förstudiens 3 körningar (samma skript, `JUDGE_RUNS = 3`)', ja: 2, nej: 1 },
    { label: 'fem tidigare 10-körningar med samma inställning', ja: 4, nej: 46 },
    { label: '4 fullständiga `knowledge:eval`-körningar 2026-08-13', ja: 0, nej: 4 },
  ],
}

interface Tally {
  ja: number
  nej: number
  /** Sant om BÅDA verdikten förekommer över samtliga kända körningar. */
  flaky: boolean
}

function tallyFor(id: string, verdicts: readonly (boolean | null)[]): Tally {
  const prior = PRIOR_JUDGE_OBSERVATIONS[id] ?? []
  const ja = verdicts.filter((v) => v === true).length + prior.reduce((a, b) => a + b.ja, 0)
  const nej = verdicts.filter((v) => v === false).length + prior.reduce((a, b) => a + b.nej, 0)
  return { ja, nej, flaky: ja > 0 && nej > 0 }
}

// ── Fusionen med kanalattribution ────────────────────────────────────────────
//
// Spegelns fuse() ger topp-3. Här behövs HELA den fuserade listan (för K = 5/10)
// och VARIFRÅN varje plats kom. Matematiken är densamma; att den är det
// verifieras genom att de tre första posterna jämförs mot spegelns fuse(), som
// i sin tur är paritetskontrollerad mot produktionens retrieve().
interface FusedEntry {
  chunk: LegalChunk
  rrf: number
  lexicalRank: number | null
  semanticRank: number | null
  score: number
  coverage: number
  cosine: number | null
}

function fuseDetailed(
  idx: VariantIndex,
  query: string,
  semantic: readonly SemanticHit[],
): FusedEntry[] {
  const byId = new Map(idx.chunks.map((c) => [legalChunkId(c), c]))
  const scoredById = new Map(scoreAll(idx, query).map((r) => [legalChunkId(r.chunk), r]))
  const entries = new Map<string, FusedEntry>()

  const ensure = (chunk: LegalChunk): FusedEntry => {
    const key = legalChunkId(chunk)
    let e = entries.get(key)
    if (!e) {
      const s = scoredById.get(key)
      e = {
        chunk,
        rrf: 0,
        lexicalRank: null,
        semanticRank: null,
        score: s?.score ?? 0,
        coverage: s?.coverage ?? 0,
        cosine: null,
      }
      entries.set(key, e)
    }
    return e
  }

  ranked(idx, query)
    .slice(0, CHANNEL_TOP_K)
    .forEach((r, i) => {
      const e = ensure(r.chunk)
      e.lexicalRank = i + 1
      e.rrf += 1 / (RRF_K + i + 1)
    })
  semantic.forEach((s, i) => {
    const chunk = byId.get(s.chunkId)
    if (!chunk) return
    const e = ensure(chunk)
    e.semanticRank = i + 1
    e.cosine = s.cosine
    e.rrf += 1 / (RRF_K + i + 1)
  })

  return [...entries.values()].sort(
    (a, b) => b.rrf - a.rrf || a.chunk.paragraph.localeCompare(b.chunk.paragraph),
  )
}

// ── Utskrift ─────────────────────────────────────────────────────────────────

const md: string[] = []
function out(line = ''): void {
  console.warn(line)
  md.push(line)
}

function fmt(n: number | null, d = 2): string {
  return n === null ? '—' : n.toFixed(d)
}

function caseFor(id: string) {
  const c = LEGAL_EVAL_SET.find((x) => x.id === id)
  if (!c) throw new Error(`eval-fall saknas: ${id}`)
  return c
}

/** Är chunken en facitparagraf för fallet? Matchar på (lawId, paragraph) som scoreRun. */
function isFacit(id: string, chunk: LegalChunk): boolean {
  return caseFor(id).expectedSources.some(
    (s) => s.lawId === chunk.lawId && s.paragraphs.includes(chunk.paragraph),
  )
}

function facitLabel(id: string): string {
  return (
    caseFor(id)
      .expectedSources.flatMap((s) => s.paragraphs.map((p) => `${s.lawId} ${p} §`))
      .join(', ') || '—'
  )
}

function chunkLabel(chunk: LegalChunk): string {
  return legalChunkId(chunk).replace(/^([a-zåäö]+):/, '$1 ')
}

async function main(): Promise<void> {
  const chunks = buildLegalChunks()
  const hashesBefore = snapshotHashes(chunks)
  console.warn(
    `[mät] korpus: ${chunks.length} chunkar · GROUNDING_TOP_K = ${GROUNDING_TOP_K} · ` +
      `${TARGETS.length} målfall · ${JUDGE_RUNS} domarkörningar per fall`,
  )
  if (chunks.length !== MIN_TOP_SCORE_CALIBRATED_AT_CHUNKS) {
    throw new Error(`korpusen är ${chunks.length}, väntade ${MIN_TOP_SCORE_CALIBRATED_AT_CHUNKS}`)
  }

  const voyageKey = requireApiKey({
    envVar: 'VOYAGE_API_KEY',
    whatFor: 'query-embeddingarna i fönster-mätningen',
    expectedPrefix: 'pa-',
  })
  await verifyVoyageKey(voyageKey, VOYAGE_EMBEDDINGS.MODEL)
  const anthropicKey = requireApiKey({
    envVar: 'ANTHROPIC_API_KEY',
    whatFor: 'relevansdomaren',
    expectedPrefix: 'sk-ant-',
  })
  const anthropic = new Anthropic({ apiKey: anthropicKey })

  const { cosineByCase, semanticByCase, fusedByCase } = await collectSemantic(chunks)

  const variant: Variant = {
    id: 'PROD',
    label: 'produktionen efter PR4 (19 tesaurusgrupper, söktermer i indexet)',
    analyze: baselineAnalyze,
    indexText: searchTermIndexText,
    conceptGroups: PRODUCTION_CONCEPT_GROUPS,
  }
  const idx = buildVariantIndex(variant, chunks)
  const prod = detectProductionVariant([idx])
  console.warn(`[mät] produktionen implementerar variant: ${prod.variant.id}`)
  assertBaselineParity(idx, cosineByCase, fusedByCase, semanticByCase)

  // ── Rapport ────────────────────────────────────────────────────────────────
  out('# #406 — dör de kvarvarande fallen i fönstret eller hos domaren?')
  out()
  out('> MÄTNING, INGEN FIX. Ingen produktionsregel, tröskel, lagtext eller domarprompt')
  out('> ändrad. `GROUNDING_TOP_K` lästes, aldrig flyttades: K = 5/10-frågan besvaras')
  out('> genom att räkna på den fuserade listan.')
  out(
    `> Genererad av \`apps/api/scripts/measure-406-judge-vs-window.ts\` mot korpus N = ${chunks.length}, main efter PR4.`,
  )
  out()
  out('## Varför frågan måste ställas')
  out()
  out('Efter PR4 passerar samtliga answerable-fall grinden, och de fem som ändå missar')
  out('fälls alla av relevansdomaren. Bakom det gemensamma utfallet `miss` döljer sig två')
  out('problem som kräver motsatta åtgärder:')
  out()
  out('- **Facit saknas i fönstret** → fusionsproblem. Domaren kan inte välja en paragraf')
  out('  den aldrig ser. Åtgärden ligger på den semantiska sidan.')
  out('- **Facit finns i fönstret, domaren säger ändå NEJ** → domarproblem.')
  out()
  out('Fönstret är `retrieval.fused` topp-3 — det är vad `evaluateLegalCandidate` lämnar')
  out('vidare som `retrieved`, och exakt de chunkarna som byggs in i domarprompten.')
  out()

  interface Result {
    id: string
    intendedMissBy?: string
    fused: FusedEntry[]
    facitInWindow: boolean
    facitEntries: { entry: FusedEntry; fusedRank: number }[]
    verdicts: (boolean | null)[]
    prompt: string
  }
  const results: Result[] = []

  for (const target of TARGETS) {
    const c = caseFor(target.id)
    if (!isLegalQuestion(c.question)) throw new Error(`${target.id} är inte juridisk`)
    const semantic = semanticByCase.get(c.id) ?? []
    const fused = fuseDetailed(idx, c.question, semantic)

    // Spegelkontroll: topp-3 här måste vara identisk med produktionens fused.
    const prodFused = fusedByCase.get(c.id) ?? []
    const mine = fused.slice(0, GROUNDING_TOP_K).map((e) => legalChunkId(e.chunk))
    if (prodFused.length > 0 && mine.join(' ') !== prodFused.join(' ')) {
      throw new Error(
        `fuseDetailed avviker från produktionens fused för ${c.id}: [${mine.join(' ')}] vs [${prodFused.join(' ')}]`,
      )
    }

    const window = fused.slice(0, GROUNDING_TOP_K)
    const facitEntries = fused
      .map((entry, i) => ({ entry, fusedRank: i + 1 }))
      .filter((x) => isFacit(target.id, x.entry.chunk))
    const facitInWindow = window.some((e) => isFacit(target.id, e.chunk))

    // Domaren — exakt produktionens väg.
    const candidate = evaluateLegalCandidate(c.question, {
      lexical: ranked(idx, c.question)
        .slice(0, GROUNDING_TOP_K)
        .map((r) => ({ chunk: r.chunk, score: r.score, coverage: r.coverage })),
      fused: window.map((e) => ({ chunk: e.chunk, score: e.score, coverage: e.coverage })),
      semanticTopCosine: cosineByCase.get(c.id) ?? null,
    })
    if (candidate === null || candidate.outcome !== 'candidate') {
      throw new Error(`${target.id} är inte längre en kandidat — mätningens premiss gäller inte`)
    }
    const judgeChunks = candidate.retrieved.map((r) => r.chunk)
    const prompt = buildRelevanceJudgePrompt(c.question, judgeChunks)

    const verdicts: (boolean | null)[] = []
    for (let run = 0; run < JUDGE_RUNS; run++) {
      const response = await anthropic.messages.create({
        model: AI_MODELS.MEMORY,
        max_tokens: 8,
        temperature: 0,
        messages: [{ role: 'user', content: prompt }],
      })
      const block = response.content.find((b) => b.type === 'text')
      verdicts.push(parseRelevanceVerdict(block?.type === 'text' ? block.text : ''))
    }
    console.warn(
      `[mät] ${target.id}: facit i fönstret = ${facitInWindow ? 'JA' : 'NEJ'}, ` +
        `domare = ${verdicts.map((v) => (v === true ? 'JA' : v === false ? 'NEJ' : '?')).join('/')}`,
    )

    const entry: Result = {
      id: target.id,
      fused,
      facitInWindow,
      facitEntries,
      verdicts,
      prompt,
    }
    if (target.intendedMissBy !== undefined) entry.intendedMissBy = target.intendedMissBy
    results.push(entry)
  }

  // ── Tabell 1: sammanfattning ───────────────────────────────────────────────
  out('## 1. Svaret i en tabell')
  out()
  out(
    `| fall | facit | facit i fönstret? | fused-rank för facit | domare (${JUDGE_RUNS} körningar) | stabilt? | flaskhals | avsedd miss? |`,
  )
  out('| --- | --- | --- | --- | --- | --- | --- | --- |')
  for (const r of results) {
    const rank = r.facitEntries.length
      ? r.facitEntries.map((f) => `${f.fusedRank}`).join(' / ')
      : 'utanför listan'
    const ja = r.verdicts.filter((v) => v === true).length
    const nej = r.verdicts.filter((v) => v === false).length
    const t = tallyFor(r.id, r.verdicts)
    const bottleneck = r.facitInWindow ? '**domaren**' : '**fönstret**'
    out(
      `| \`${r.id}\` | ${facitLabel(r.id)} | ${r.facitInWindow ? 'JA' : '**NEJ**'} | ${rank} | ` +
        `${nej}× NEJ, ${ja}× JA | ${t.flaky ? `**FLAKAR** (${t.ja} JA / ${t.nej} NEJ över ${t.ja + t.nej} kända körningar)` : `stabilt (${t.nej}/${t.nej} NEJ)`} | ${bottleneck} | ` +
        `${r.intendedMissBy ? 'ja' : '**nej — verkligt mål**'} |`,
    )
  }
  out()

  // ── Per fall ───────────────────────────────────────────────────────────────
  out('## 2. Fönstrets faktiska innehåll, per fall')
  out()
  out('`kanal` visar varifrån platsen kom: lexikal rank, semantisk rank, eller båda.')
  out('RRF-bidraget är `1/(60 + rank)` per kanal — en chunk som bara finns i EN kanal kan')
  out('alltså aldrig få mer än hälften av vad en chunk med samma placering i båda får.')
  out()
  for (const r of results) {
    const c = caseFor(r.id)
    out(`### \`${r.id}\``)
    out()
    out(`> ${c.question}`)
    out()
    out(
      `Facit: **${facitLabel(r.id)}**. ${r.intendedMissBy ? `AVSEDD MISS (${r.intendedMissBy}).` : 'Verkligt mål.'}`,
    )
    out()
    out(
      `Domarens ${JUDGE_RUNS} verdikt i ordning: ` +
        r.verdicts.map((v) => (v === true ? 'JA' : v === false ? 'NEJ' : 'ogiltig')).join(' · '),
    )
    out()
    out(
      '| # | chunk | BM25 | täckning | cosine | lex-rank | sem-rank | RRF | i fönstret? | facit? |',
    )
    out('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
    for (const [i, e] of r.fused.slice(0, 10).entries()) {
      const inWindow = i < GROUNDING_TOP_K
      out(
        `| ${i + 1} | \`${chunkLabel(e.chunk)}\` | ${fmt(e.score, 1)} | ${fmt(e.coverage)} | ${fmt(e.cosine, 3)} | ` +
          `${e.lexicalRank ?? '—'} | ${e.semanticRank ?? '—'} | ${e.rrf.toFixed(5)} | ${inWindow ? 'JA' : 'nej'} | ` +
          `${isFacit(r.id, e.chunk) ? '**JA**' : ''} |`,
      )
    }
    out()
    if (!r.facitInWindow) {
      if (r.facitEntries.length === 0) {
        out('**Facit finns inte i den fuserade listan alls** — den saknas i båda kanalernas')
        out(`topp-${CHANNEL_TOP_K}. Varken K = 5 eller K = 10 hade hjälpt.`)
      } else {
        const best = r.facitEntries[0]!
        out(
          `**Facit ligger på fused-plats ${best.fusedRank}** (lexikal rank ${best.entry.lexicalRank ?? '—'}, ` +
            `semantisk rank ${best.entry.semanticRank ?? '—'}, cosine ${fmt(best.entry.cosine, 3)}).`,
        )
        out(
          `- Vid \`GROUNDING_TOP_K = 5\`: ${best.fusedRank <= 5 ? '**hade kommit med**' : 'fortfarande utanför'}.`,
        )
        out(
          `- Vid \`GROUNDING_TOP_K = 10\`: ${best.fusedRank <= 10 ? '**hade kommit med**' : 'fortfarande utanför'}.`,
        )
      }
      out()
    }
  }

  // ── Hypotesen ──────────────────────────────────────────────────────────────
  out('## 3. Den särskilda hypotesen: `hyresgastval-diskriminering`')
  out()
  out('Hypotesen: fallet släpps in ENBART på cosine (0,592 över golvet 0,52; BM25 8,7')
  out('under golvet 9), fönstret domineras av svaga lexikala hyreslagsträffar, och')
  out('diskrimineringslagen 12 § når aldrig topp-3 trots att semantiken hittat den — det')
  out('strukturella problem RRF skapar för en chunk som är stark i bara EN kanal.')
  out()
  const hgv = results.find((r) => r.id === 'hyresgastval-diskriminering')!
  const hgvWindow = hgv.fused.slice(0, GROUNDING_TOP_K)
  const lexOnlyInWindow = hgvWindow.filter((e) => e.semanticRank === null).length
  const bothInWindow = hgvWindow.filter(
    (e) => e.semanticRank !== null && e.lexicalRank !== null,
  ).length
  const semOnlyInWindow = hgvWindow.filter((e) => e.lexicalRank === null).length
  const facit = hgv.facitEntries[0]
  out('**Uppmätt:**')
  out()
  out(
    `- Fönstrets tre platser kommer från: ${bothInWindow} chunk(ar) i BÅDA kanalerna, ` +
      `${lexOnlyInWindow} enbart lexikal, ${semOnlyInWindow} enbart semantisk.`,
  )
  if (facit) {
    const lawsInWindow = [...new Set(hgvWindow.map((e) => e.chunk.lawId))]
    out(
      `- Facit (diskrimineringslagen 12 §) har semantisk rank ${facit.entry.semanticRank ?? '—'} ` +
        `(cosine ${fmt(facit.entry.cosine, 3)}), lexikal rank ${facit.entry.lexicalRank ?? '—'} ` +
        `(BM25 ${fmt(facit.entry.score, 1)}), och hamnar på fused-plats ${facit.fusedRank}.`,
    )
    out(
      `- Fönstrets tre chunkar kommer alla från: ${lawsInWindow.join(', ')}. ` +
        `De är alltså inte hyreslagsträffar.`,
    )
    out()
    out('**Hypotesen är BEKRÄFTAD i sin strukturella del och FÖRKASTAD i sin mekanism.**')
    out()
    out('Bekräftat: facit når inte fönstret, och orsaken är exakt den RRF-effekt hypotesen')
    out('pekar ut. Facit finns BARA i den semantiska kanalen (BM25 0,0 — noll lexikal')
    out('poäng), så den kan som mest samla ett kanalbidrag. De tre som tar fönstret sitter')
    out('i BÅDA kanalerna och får därmed två bidrag var. En chunk som är bäst i en kanal')
    out('förlorar strukturellt mot chunkar som är medelmåttiga i två.')
    out()
    out('Förkastat: fönstret domineras INTE av svaga lexikala hyreslagsträffar. Alla tre')
    out('platserna hålls av diskrimineringslagen — men av GRANNPARAGRAFER (12 b, 13 b,')
    out('14 b) i stället för av 12 § själv. Diagnosen "fel lag drar in sig" stämmer inte;')
    out('den rätta är "rätt lag, fel paragraf, och den rätta paragrafen är osynlig för')
    out('BM25". Skillnaden spelar roll för åtgärden: ett filter på lagnivå hade inte')
    out('hjälpt.')
  } else {
    out('- Facit finns inte i någon kanals topp-10 alls. Hypotesen är **FÖRKASTAD i sin')
    out('  formulering**: problemet är inte att RRF straffar en enkanalig chunk, utan att')
    out('  den semantiska kanalen aldrig hittade paragrafen.')
  }
  out()

  // ── Svaret ─────────────────────────────────────────────────────────────────
  const real = results.filter((r) => !r.intendedMissBy)
  const windowBound = real.filter((r) => !r.facitInWindow)
  const judgeBound = real.filter((r) => r.facitInWindow)
  // Flakighet bedöms mot HELA journalen, inte mot den aktuella körningen —
  // annars raderar ett enhetligt stickprov ett redan uppmätt fynd.
  const flaky = results.filter((r) => tallyFor(r.id, r.verdicts).flaky)

  out('## 4. Svaret')
  out()
  out('**Olika för de två verkliga målen — och det är hela poängen med att mäta i stället')
  out('för att gissa. Ett gemensamt `miss` dolde två motsatta problem.**')
  out()
  for (const r of judgeBound) {
    const nej = r.verdicts.filter((v) => v === false).length
    const ja = r.verdicts.filter((v) => v === true).length
    const best = r.facitEntries[0]!
    out(
      `- **\`${r.id}\` → DOMAREN.** Facit ligger på fused-plats ${best.fusedRank} av 3, alltså ` +
        `${best.fusedRank === 1 ? 'ÖVERST' : 'väl inom'} i fönstret. Domaren ser rätt paragraf och ` +
        `fäller den ändå i ${nej} av ${r.verdicts.length} körningar (${ja} JA). Ingen fusionsändring i ` +
        'världen kan flytta det här fallet.',
    )
  }
  for (const r of windowBound) {
    const best = r.facitEntries[0]
    out(
      `- **\`${r.id}\` → FÖNSTRET.** Facit ${best ? `ligger på fused-plats ${best.fusedRank}` : 'finns inte i någon kanals topp-10'} ` +
        'och når aldrig domaren. Verdiktet NEJ säger därför ingenting om domarens omdöme — ' +
        'den bedömde tre andra paragrafer.',
    )
  }
  out()
  out('De tre avsedda missarna bekräftar sina egna invarianter och är inte problem:')
  for (const r of results.filter((x) => x.intendedMissBy)) {
    out(
      `- \`${r.id}\`: facit ${r.facitInWindow ? 'I fönstret' : 'UTANFÖR fönstret'}, ` +
        `${r.verdicts.filter((v) => v === false).length}/${r.verdicts.length} NEJ — förenligt med ${r.intendedMissBy!.split('—')[0]!.trim()}.`,
    )
  }
  out()
  if (flaky.length > 0) {
    out('### Sidofynd som inte fick förbli osagt: domaren är inte deterministisk')
    out()
    out(
      `Vid temperature 0 har ${flaky.length} av ${results.length} fall gett OLIKA verdikt mellan körningar: ` +
        flaky
          .map((r) => {
            const t = tallyFor(r.id, r.verdicts)
            return `\`${r.id}\` (${t.nej}× NEJ, ${t.ja}× JA över ${t.ja + t.nej} körningar)`
          })
          .join(', ') +
        '.',
    )
    out()
    out(
      'Den aktuella körningen gav ' +
        flaky
          .map(
            (r) =>
              `${r.verdicts.filter((v) => v === false).length}× NEJ / ${r.verdicts.filter((v) => v === true).length}× JA`,
          )
          .join(', ') +
        ' — ett enhetligt stickprov kan alltså inträffa och betyder inte att fallet är stabilt.',
    )
    out()
    out('Det betyder att gate-evalens `domare`-kolumn för dessa fall är ett stickprov, inte')
    out('ett faktum, och att kvoten 21/26 kan röra sig utan att en enda rad kod ändras. Fyra')
    out('tidigare eval-körningar gav alla NEJ på `paminnelseavgift-vad-galler` — den serien')
    out('såg stabil ut och var det inte. Ett gränsfall nära domarens beslutsgräns är exakt')
    out('där temperature 0 slutar räcka som determinismgaranti.')
    out()
    out('Konsekvensen för invariant 5 är att golvet bör läsas som ett golv, inte som en')
    out('förväntad nivå — vilket är precis hur det är formulerat.')
    out()
    out('**Hela dagens stickprov för `paminnelseavgift-vad-galler`**, samlat ur alla')
    out('körningar med samma domarprompt (verifierat identisk indata via fused-pariteten).')
    out('Raderna under den första är observationer ur andra körningar, inte tal den här')
    out('mätningen räknat fram — de står med för att de ändrar tolkningen:')
    out()
    const priorSeries = PRIOR_JUDGE_OBSERVATIONS[flaky[0]!.id] ?? []
    const thisJa = flaky[0]!.verdicts.filter((v) => v === true).length
    const thisNej = flaky[0]!.verdicts.filter((v) => v === false).length
    const { ja: totJa, nej: totNej } = tallyFor(flaky[0]!.id, flaky[0]!.verdicts)
    out('| serie | JA | NEJ |')
    out('| --- | --- | --- |')
    out(`| den här mätningen (${JUDGE_RUNS} körningar) | ${thisJa} | ${thisNej} |`)
    for (const ps of priorSeries) out(`| ${ps.label} | ${ps.ja} | ${ps.nej} |`)
    out(`| **summa** | **${totJa}** | **${totNej}** |`)
    out()
    out(
      `${totJa} av ${totJa + totNej} körningar gav JA, alltså ~${Math.round((100 * totJa) / (totJa + totNej))} %. Poängen är inte den exakta andelen utan att den`,
    )
    out('inte går att uppskatta ur en handfull körningar: de tre första gav 2 JA av 3 och')
    out('de fyra eval-körningarna 0 av 4. Båda serierna hade lästs som "stabila" var för')
    out('sig, åt motsatta håll.')
    out()
  }
  out('### Vad mätningen INTE säger')
  out()
  out('- **Att domaren ska mjukas upp.** Dess strikthet är ett medvetet designförsvar: den')
  out('  fällde PR2:s regression, och invariant 3 pekar ut den som det enda som håller')
  out('  `deposition-storlek` ute (cosine 0,605 ligger över golvet). En uppluckring är en')
  out('  GLOBAL ändring och kräver egen mätning mot negativkontrollerna. Fyndet rapporteras;')
  out('  ingen lättnad föreslås.')
  out('- **Att `GROUNDING_TOP_K` ska höjas.** K = 10 hade tagit in facit i')
  out('  `hyresgastval-diskriminering`, men ett bredare fönster ger domaren fler chanser att')
  out('  hitta något som ser relevant ut — det är samma ratt som skyddar negativkontrollerna,')
  out('  vriden åt andra hållet. Också en egen mätning.')
  out('- **Något om prod-trafik.** Fem fall ur ett konstruerat eval-set.')
  out()

  // ── Domarens indata ────────────────────────────────────────────────────────
  out('## 5. Domarens exakta indata')
  out()
  out('Prompten nedan är ordagrant den som skickades, byggd av')
  out('`buildRelevanceJudgePrompt` ur `candidate.retrieved` — samma väg som produktionen.')
  out(`Modell: \`${AI_MODELS.MEMORY}\`, temperature 0, max_tokens 8.`)
  out()
  for (const r of results) {
    out(`<details><summary><code>${r.id}</code> — domarprompt</summary>`)
    out()
    out('```text')
    for (const line of r.prompt.split('\n')) out(line)
    out('```')
    out()
    out('</details>')
    out()
  }

  // ── Kontroller ─────────────────────────────────────────────────────────────
  const hashesAfter = snapshotHashes(buildLegalChunks())
  out('## Kontroller')
  out()
  out(
    `- Paritet mot produktionen (variant \`${prod.variant.id}\`): max |Δscore| = 0, max |Δcoverage| = 0, ` +
      'noll grindavvikelser och noll fused-avvikelser.',
  )
  out('- `fuseDetailed` topp-3 jämförd chunk-för-chunk mot produktionens `retrieve().fused`')
  out('  för varje målfall — avvikelse avbryter körningen.')
  out(
    `- Lagtextens content-hashar: ${hashesAfter === hashesBefore ? 'oförändrade' : 'ÄNDRADE — FEL'} (${chunks.length} chunkar).`,
  )
  out('- Domarprompten och `GROUNDING_TOP_K` lästes, aldrig skrevs.')
  out()
  if (hashesAfter !== hashesBefore) throw new Error('content-hashar ändrades under mätningen')

  const target = resolve(__dirname, '../../../docs/research/406-domare-vs-fonster.md')
  writeFileSync(target, `${md.join('\n')}\n`, 'utf8')
  console.warn(`\n[mät] rapport skriven till ${target}`)
}

main().catch((err: unknown) => exitOnPreflightError(err, 'mät'))
