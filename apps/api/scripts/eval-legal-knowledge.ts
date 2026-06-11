/**
 * Gate-eval för juridik-RAG:en (Etapp 3, PR 3.3b): kör HELA kedjan — hybrid-
 * retrieval (riktig Voyage + pgvector) → miss-grind (BM25-golv + cosine-golv)
 * → RIKTIG Haiku-relevansdomare → grundning — för varje eval-fall, skriver ut
 * matrisen och FAILAR (exit 1) om någon av de hårda invarianterna bryts.
 *
 * KÖRS MANUELLT (inte i CI — kräver nät: Voyage + Anthropic + embeddad DB):
 *   VOYAGE_API_KEY=… pnpm --filter @eken/api knowledge:eval
 * Kräver: DATABASE_URL mot en databas där knowledge:embed körts (lokal dev),
 * ANTHROPIC_API_KEY (ur .env), VOYAGE_API_KEY. Kostnad: ~22 query-embeddings
 * (gratis under free tier) + ~15 Haiku-domaranrop (ören).
 *
 * HÅRDA INVARIANTER (exit 1 vid brott):
 *   1. besittningsskydd-forstahand-1ar (#129-regressionsfallet) GRUNDAS med
 *      hyreslagen §45/§46 — beviset att frågan nu BESVARAS, inte faller till
 *      jurist.
 *   2. besittningsskydd-andrahand-2ar får ENDAST det säkra utfallet: ärlig
 *      miss ELLER grundad med §45 — aldrig grundad med fel källa. (Uppmätt
 *      2026-06-11: §45 utanför fused topp-8 i båda kanalerna för denna
 *      formulering — fallet kan inte lyftas utan overfit-tuning; beslutat
 *      att dokumentera som känd begränsning.)
 *   3. deposition-storlek grundas ALDRIG (golv eller domare — domaren är
 *      designförsvaret: cosine 0.605 ligger över golvet).
 *   4. agandeform-skatt-paketering är ej-juridisk (fångas före retrieval).
 *   5. answerableHits ≥ 14 av 18 (stabilt reproducerad nivå 2026-06-11, 3×
 *      identiska körningar; BM25-baslinjen var 12). 16 har observerats i en
 *      tidigare mätning men är INTE stabil: besittningsskydd-lokal och
 *      drojsmalsranta-sen-hyra är domar-gränsfall som flappar mellan grundad
 *      och ärlig miss (se invariant 7) — golvet kodar den nivå som håller
 *      oavsett vilken sida de landar på.
 *   6. altan/eget-behov (needs-jurist): grundas de alls måste rätt källa
 *      (§24 ELLER §42 resp. §46) finnas bland chunkarna — grundat svar med
 *      rätt källa + jurist-rekommendation är OK; grundat med fel källa är det
 *      inte. Altan-facit vidgat till §24+§42 (juristbedömt 2026-06-11):
 *      frågan gäller uppsägning — §24 är grundnormen (vårdplikt) men
 *      uppsägningsvägen går via §42 förverkande (närmast p.9 vanvård), med
 *      rättelse-efter-uppmaning och ringa-betydelse-undantaget som gör
 *      utfallet till en skälighetsbedömning (→ needs-jurist).
 *   7. besittningsskydd-lokal och drojsmalsranta-sen-hyra får ENDAST säkra
 *      utfall: ärlig miss ELLER grundad med rätt källa (§57 resp. räntelagen
 *      §4/§6) — samma mönster som invariant 2. Uppmätt 2026-06-11: Haiku-
 *      domaren (pinnad snapshot, temperature 0) fäller båda 6/6 ÄVEN när rätt
 *      paragraf ligger i kandidatmängden (probe med lexical∪fused-union) —
 *      lokal-fallet kräver inferens ur regel-FRÅNVARO (inget direkt skydd)
 *      och §6 villkorar på §3/§4 som inte hämtas. Verdiktet är försvarbart
 *      strikt; degraderingen är säker (ärlig miss + juristrekommendation).
 *      Domarprompten mjukas INTE upp för att vinna dessa två — den är design-
 *      försvaret som håller deposition-storlek (invariant 3) ute.
 */
import { PrismaClient } from '@prisma/client'
import { ConfigService } from '@nestjs/config'
import Anthropic from '@anthropic-ai/sdk'
import { LegalEmbeddingService } from '../src/ai/knowledge/embedding/legal-embedding.service'
import { LegalRetrievalService } from '../src/ai/knowledge/retrieval/legal-retrieval.service'
import {
  isLegalQuestion,
  evaluateLegalCandidate,
  groundLegalCandidate,
  buildRelevanceJudgePrompt,
  parseRelevanceVerdict,
} from '../src/ai/knowledge/grounding/legal-grounding'
import { chunksToSources } from '../src/ai/knowledge/retrieval/legal-retrieval-runner'
import { scoreRun } from '../src/ai/knowledge/eval/legal-eval-harness'
import { LEGAL_EVAL_SET } from '../src/ai/knowledge/eval/legal-eval-set'
import { AI_MODELS } from '../src/ai/ai.config'
import type { LegalChunk } from '../src/ai/knowledge/retrieval/legal-chunk'

interface EvalRow {
  id: string
  expectedOutcome: string
  bm25Top: number | null
  coverageTop: number | null
  cosineTop: number | null
  gate: string // 'ej-juridisk' | 'miss:<reason>' | 'kandidat'
  judge: string // '—' | 'JA' | 'NEJ' | 'ogiltig'
  outcome: string // 'ej-juridisk' | 'miss' | 'grundad'
  chunks: LegalChunk[]
  sourceHit: boolean
}

function hasChunk(row: EvalRow, lawId: string, paragraphs: string[]): boolean {
  return row.chunks.some((c) => c.lawId === lawId && paragraphs.includes(c.paragraph))
}

async function main(): Promise<void> {
  const prisma = new PrismaClient()
  const retrievalService = new LegalRetrievalService(
    prisma as never,
    new LegalEmbeddingService(new ConfigService()),
  )
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? '' })

  const rows: EvalRow[] = []
  try {
    for (const c of LEGAL_EVAL_SET) {
      const row: EvalRow = {
        id: c.id,
        expectedOutcome: c.expectedOutcome,
        bm25Top: null,
        coverageTop: null,
        cosineTop: null,
        gate: 'ej-juridisk',
        judge: '—',
        outcome: 'ej-juridisk',
        chunks: [],
        sourceHit: false,
      }
      rows.push(row)

      if (!isLegalQuestion(c.question)) {
        row.sourceHit = scoreRun(c, {
          retrievedSources: [],
          answer: '',
          recommendedJurist: false,
        }).sourceHit
        continue
      }

      const retrieval = await retrievalService.retrieve(c.question)
      row.bm25Top = retrieval.lexical[0]?.score ?? null
      row.coverageTop = retrieval.lexical[0]?.coverage ?? null
      row.cosineTop = retrieval.semanticTopCosine

      const candidate = evaluateLegalCandidate(c.question, retrieval)
      if (candidate === null || candidate.outcome === 'miss') {
        row.gate = candidate === null ? 'ej-juridisk' : `miss:${candidate.reason}`
        row.outcome = candidate === null ? 'ej-juridisk' : 'miss'
        row.sourceHit = scoreRun(c, {
          retrievedSources: [],
          answer: '',
          recommendedJurist: false,
        }).sourceHit
        continue
      }

      row.gate = 'kandidat'
      const chunks = candidate.retrieved.map((r) => r.chunk)
      const response = await anthropic.messages.create({
        model: AI_MODELS.MEMORY,
        max_tokens: 8,
        temperature: 0, // deterministisk domare — samma som produktionen
        messages: [{ role: 'user', content: buildRelevanceJudgePrompt(c.question, chunks) }],
      })
      const textBlock = response.content.find((b) => b.type === 'text')
      const verdict = parseRelevanceVerdict(textBlock?.type === 'text' ? textBlock.text : '')
      row.judge = verdict === true ? 'JA' : verdict === false ? 'NEJ' : 'ogiltig'

      if (verdict === true) {
        const grounding = groundLegalCandidate(candidate.retrieved)
        row.outcome = 'grundad'
        row.chunks = grounding.chunks
        row.sourceHit = scoreRun(c, {
          retrievedSources: chunksToSources(candidate.retrieved),
          answer: '',
          recommendedJurist: false,
        }).sourceHit
      } else {
        row.outcome = 'miss'
        row.sourceHit = scoreRun(c, {
          retrievedSources: [],
          answer: '',
          recommendedJurist: false,
        }).sourceHit
      }
    }
  } finally {
    await prisma.$disconnect()
  }

  // ── Matrisen ────────────────────────────────────────────────────────────────
  console.warn(
    '\nfall'.padEnd(35) +
      '| bm25/cov'.padEnd(14) +
      '| cosine'.padEnd(9) +
      '| grind'.padEnd(22) +
      '| domare'.padEnd(9) +
      '| utfall'.padEnd(13) +
      '| sourceHit | källor',
  )
  for (const r of rows) {
    const bm25 =
      r.bm25Top === null ? '—' : `${r.bm25Top.toFixed(1)}/${(r.coverageTop ?? 0).toFixed(2)}`
    const sources = r.chunks.map((ch) => `${ch.lawId}:${ch.paragraph}`).join(' ')
    console.warn(
      r.id.padEnd(35) +
        `| ${bm25}`.padEnd(14) +
        `| ${r.cosineTop?.toFixed(3) ?? '—'}`.padEnd(9) +
        `| ${r.gate}`.padEnd(22) +
        `| ${r.judge}`.padEnd(9) +
        `| ${r.outcome}`.padEnd(13) +
        `| ${r.sourceHit ? 'JA' : 'nej'}`.padEnd(11) +
        `| ${sources}`,
    )
  }

  const byId = new Map(rows.map((r) => [r.id, r]))
  const answerable = rows.filter((r) => r.expectedOutcome === 'answerable')
  const answerableHits = answerable.filter((r) => r.outcome === 'grundad' && r.sourceHit).length
  console.warn(`\nanswerable grundade med rätt källa: ${answerableHits}/${answerable.length}`)

  // ── Hårda invarianter ───────────────────────────────────────────────────────
  const failures: string[] = []
  const forstahand = byId.get('besittningsskydd-forstahand-1ar')!
  if (!(forstahand.outcome === 'grundad' && hasChunk(forstahand, 'hyreslagen', ['45', '46']))) {
    failures.push('besittningsskydd-forstahand-1ar (#129) grundas inte med hyreslagen §45/§46')
  }
  const andrahand = byId.get('besittningsskydd-andrahand-2ar')!
  if (!(andrahand.outcome === 'miss' || hasChunk(andrahand, 'hyreslagen', ['45']))) {
    failures.push('besittningsskydd-andrahand-2ar fick OSÄKERT utfall (grundad utan §45)')
  }
  const deposition = byId.get('deposition-storlek')!
  if (deposition.outcome === 'grundad') {
    failures.push('deposition-storlek GRUNDADES — måste förbli miss (golv eller domare)')
  }
  const skatt = byId.get('agandeform-skatt-paketering')!
  if (skatt.outcome !== 'ej-juridisk') {
    failures.push('agandeform-skatt-paketering passerade ingångsgrinden (ska vara ej-juridisk)')
  }
  if (answerableHits < 14) {
    failures.push(`answerableHits ${answerableHits} < 14 (stabil uppmätt nivå efter 3.3b)`)
  }
  const lokal = byId.get('besittningsskydd-lokal')!
  if (!(lokal.outcome === 'miss' || hasChunk(lokal, 'hyreslagen', ['57']))) {
    failures.push('besittningsskydd-lokal fick OSÄKERT utfall (grundad utan §57)')
  }
  const ranta = byId.get('drojsmalsranta-sen-hyra')!
  if (!(ranta.outcome === 'miss' || hasChunk(ranta, 'ranteslagen', ['4', '6']))) {
    failures.push('drojsmalsranta-sen-hyra fick OSÄKERT utfall (grundad utan räntelagen §4/§6)')
  }
  const altan = byId.get('altan-utan-lov-tvist')!
  if (altan.outcome === 'grundad' && !hasChunk(altan, 'hyreslagen', ['24', '42'])) {
    failures.push('altan-utan-lov-tvist grundades UTAN §24/§42 (fel källa)')
  }
  const egetBehov = byId.get('besittningsskydd-eget-behov')!
  if (egetBehov.outcome === 'grundad' && !hasChunk(egetBehov, 'hyreslagen', ['46'])) {
    failures.push('besittningsskydd-eget-behov grundades UTAN §46 (fel källa)')
  }

  if (failures.length > 0) {
    console.error('\n[eval] HÅRDA INVARIANTER BRUTNA:')
    for (const f of failures) console.error(`  ✗ ${f}`)
    process.exit(1)
  }
  console.warn('\n[eval] ALLA hårda invarianter håller. ✓')
}

main().catch((err: unknown) => {
  console.error('[eval] MISSLYCKADES:', err instanceof Error ? err.message : err)
  process.exit(1)
})
