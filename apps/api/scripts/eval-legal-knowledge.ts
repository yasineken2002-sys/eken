/**
 * Gate-eval för juridik-RAG:en (Etapp 3, PR 3.3b): kör HELA kedjan — hybrid-
 * retrieval (riktig Voyage + pgvector) → miss-grind (BM25-golv + cosine-golv)
 * → RIKTIG Haiku-relevansdomare → grundning — för varje eval-fall, skriver ut
 * matrisen och FAILAR (exit 1) om någon av de hårda invarianterna bryts.
 *
 * KÖRS MANUELLT (inte i CI — kräver nät: Voyage + Anthropic + embeddad DB):
 *   VOYAGE_API_KEY=… pnpm --filter @eken/api knowledge:eval
 * Kräver: DATABASE_URL mot en databas där knowledge:embed körts (lokal dev),
 * ANTHROPIC_API_KEY (ur .env), VOYAGE_API_KEY. Kostnad: ~29 query-embeddings
 * (gratis under free tier) + ~21 Haiku-domaranrop (ören).
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
 *   5. answerableHits ≥ 17 av 26 (stabilt reproducerad nivå 2026-08-13, 3×
 *      körningar). Nivån kodar vad som faktiskt MÄTTS, aldrig vad en kommande
 *      fix förväntas ge — höj den först när ett nytt stabilt värde uppmätts.
 *
 *      HISTORIK, och varför varje steg togs i efterhand:
 *        14 av 18 → fram till #406:s åtta nya inkassokostnadsfall.
 *        15 av 26 → #406 PR0: nämnaren steg med 8 och täljaren med 1
 *          (paminnelseavgift-lagens-egna-ord). Kvoten SÄNKTES i andel och
 *          HÖJDES i absoluta tal, för det var vad mätningen visade.
 *        17 av 26 → #406 PR3 (söktermer i chunk-metadata, 2026-08-13).
 *          Täljaren steg med två fall, nämnaren är oförändrad 26:
 *            paminnelseavgift-ratten  — domaren gick från NEJ till JA när 2 §
 *              äntligen nådde fönstret (invariant 8, nu grön).
 *            kravbrev-avgift          — BM25 6,6 → 12,0/1,00, alltså från
 *              miss:weak-retrieval till grundad med sin egen 3 §.
 *          Uppmätt mot en separat FÖRE-körning med inkopplingen backad, inte
 *          härlett: övriga 28 fall gav identiska grindutfall, domarverdikt och
 *          källor. Kvoten var 17/26 i alla tre körningarna; körning 1 och 2 var
 *          byte-identiska och körning 3 skilde sig på en enda tredjedecimal i
 *          altan-utan-lov-tvists cosine (0,498 → 0,499) — pgvector-brus som
 *          inte rör något utfall.
 *
 *      16 av 18 observerades en gång i en tidigare mätning men var INTE stabil:
 *      besittningsskydd-lokal och drojsmalsranta-sen-hyra är domar-gränsfall som
 *      flappar mellan grundad och ärlig miss (se invariant 7) — golvet kodar den
 *      nivå som håller oavsett vilken sida de landar på. Båda missade i samtliga
 *      2026-08-11- OCH 2026-08-13-körningar, så 17 vilar inte på dem.
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
 *   8. paminnelseavgift-ratten GRUNDAS med inkassokostnadslagen 2 §.
 *
 *      ⚠ DENNA INVARIANT ÄR RÖD I DAG, AVSIKTLIGT. Den är #406:s mätsticka och
 *      blir grön först när fixen landar. Att köra knowledge:eval på main innan
 *      dess ger alltså exit 1 med exakt detta fel — det är avsett. Scriptet är
 *      manuellt och ingår inte i CI, så det blockerar ingen merge.
 *
 *      VARFÖR EGEN INVARIANT OCH INTE BARA KVOTEN (invariant 5): en aggregerad
 *      kvot kan uppfyllas medan just den nya lagen aldrig hämtas — det var
 *      precis vad som hände efter #400, då lagen lades i korpusen utan ett enda
 *      eval-fall och gapet därför var osynligt för den här evalen i fyra
 *      månader. Samma beslut som togs i #400 gäller här.
 *
 *      VARFÖR JUST 2 §: den bär RÄTTEN till ersättning för skriftlig
 *      betalningspåminnelse och avtalskravet, och är den regel produktens egen
 *      grind isReminderFeeContractuallyAllowed implementerar. Uppmätt
 *      2026-08-11 är dess BM25-score 0,00 medan den enda inkasso-paragraf som
 *      får lexikal poäng är 4 a § — förseningsersättning mellan näringsidkare,
 *      alltså fel regel för en bostadshyresgäst. Invariant 9 spärrar det utfallet.
 *   9. INGET av de åtta inkassokostnadsfallen får ett OSÄKERT utfall: ärlig miss
 *      ELLER grundad med fallets egen facit-paragraf — aldrig grundad med fel
 *      paragraf, och ALDRIG med 4 a § bland källorna. Samma mönster som
 *      invarianterna 2, 6 och 7.
 *
 *      Detta är #406:s fälla kodad som spärr: dagens miss är ett säkert utfall,
 *      men ett självsäkert svar med 4 a § som källrad till en bostadshyresvärd
 *      är det inte — det vore SÄMRE än att inte svara. Varje kandidatlösning
 *      ska mätas på VILKEN paragraf den lyfter, och den här invarianten är den
 *      mätningen. GRÖN i dag (3/3 körningar 2026-08-11) och måste förbli grön
 *      genom hela #406-serien.
 *
 * AVGRÄNSNING — #406 ÄR TVÅ PROBLEM, OCH PR-PLANEN LÖSER ETT (uppmätt 2026-08-11):
 *   Av de åtta inkassokostnadsfallen når SEX aldrig grinden: de fälls av
 *   miss:weak-retrieval, alltså BM25 under golvet 9 OCH cosine under 0,52.
 *     paminnelseavgift-taket            1,8 / 0,50  ·  cosine 0,417
 *     paminnelseavgift-avtalskravet     6,4 / 0,50  ·  cosine 0,465
 *     paminnelseavgift-vad-galler       5,2 / 0,67  ·  cosine 0,444
 *     paminnelseavgift-vad-sager-lagen  6,5 / 0,25  ·  cosine 0,456
 *     paminnelseavgift-hogre-i-avtal    8,9 / 0,57  ·  cosine 0,409  ← fälls med 0,1
 *     kravbrev-avgift                   6,6 / 0,50  ·  cosine 0,461
 *   Endast paminnelseavgift-ratten blir kandidat och fälls av domaren; endast
 *   paminnelseavgift-lagens-egna-ord grundas.
 *
 *   Den planerade fixen (bredare kandidatfält + per-chunk-selektiv domare)
 *   angriper FÖNSTRET. Den kan per konstruktion inte hjälpa de sex — en domare
 *   som aldrig får se en kandidat kan inte välja den. Grind-halvan behöver en
 *   egen kartläggning; cosine-golvet 0,52 står inte på bordet. Invariant 8
 *   mäter fönster-halvan och ska bli grön av fixen. De sex är AVSIKTLIGT inte
 *   låsta av någon invariant: vi vet ännu inte att de kan lösas, och en
 *   invariant för något som saknar känt lösningsutrymme är ett löfte, inte ett
 *   krav. Invariant 9 skyddar dem ändå mot det farliga utfallet (fel paragraf).
 */
import { PrismaClient } from '@prisma/client'
import { ConfigService } from '@nestjs/config'
import {
  requireApiKey,
  verifyAnthropicKey,
  verifyVoyageKey,
  exitOnPreflightError,
} from './preflight-keys'
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
import { expandWithBackwardReferences } from '../src/ai/knowledge/retrieval/legal-cross-reference'
import { scoreRun } from '../src/ai/knowledge/eval/legal-eval-harness'
import { LEGAL_EVAL_SET } from '../src/ai/knowledge/eval/legal-eval-set'
import { AI_MODELS, VOYAGE_EMBEDDINGS } from '../src/ai/ai.config'
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
  // FÖRHANDSKONTROLL (#385): båda nycklarna verifieras INNAN något arbete görs.
  // Utan den föll scriptet på ett opakt 401 mitt i körningen — efter att ha
  // spenderat ~22 Voyage-embeddings på en körning som ändå inte kunde slutföras.
  const anthropicKey = requireApiKey({
    envVar: 'ANTHROPIC_API_KEY',
    whatFor: 'relevansdomaren i knowledge:eval',
    expectedPrefix: 'sk-ant-',
  })
  const voyageKey = requireApiKey({
    envVar: 'VOYAGE_API_KEY',
    whatFor: 'query-embeddingarna i knowledge:eval',
    expectedPrefix: 'pa-',
  })
  await verifyVoyageKey(voyageKey, VOYAGE_EMBEDDINGS.MODEL)
  await verifyAnthropicKey(anthropicKey)
  console.warn('[eval] förhandskontroll OK — båda nycklarna accepteras.\n')

  const prisma = new PrismaClient()
  const retrievalService = new LegalRetrievalService(
    prisma as never,
    new LegalEmbeddingService(new ConfigService()),
  )
  const anthropic = new Anthropic({ apiKey: anthropicKey })

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
      // DÖM PÅ ORIGINALEN, GRUNDA PÅ DE UTÖKADE (#406 PR2) — samma ordning som
      // resolveLegalGrounding. Utan att spegla den mäter gate-evalen en kedja
      // produktionen inte går, och ett "inget utfall ändrades" blir ett
      // påstående om riggen i stället för om produkten.
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
        const enriched = expandWithBackwardReferences(candidate.retrieved)
        const grounding = groundLegalCandidate(enriched)
        row.outcome = 'grundad'
        row.chunks = grounding.chunks
        row.sourceHit = scoreRun(c, {
          retrievedSources: chunksToSources(enriched),
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
  if (answerableHits < 17) {
    failures.push(`answerableHits ${answerableHits} < 17 (stabil uppmätt nivå 2026-08-13, 3×)`)
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

  // Invariant 8 (#406): den namngivna mätstickan. RÖD tills fixen landar.
  // Skild från kvoten med avsikt — en aggregerad kvot kan uppfyllas medan just
  // den här lagen aldrig hämtas, vilket är exakt vad som hände efter #400.
  const paminnelse = byId.get('paminnelseavgift-ratten')!
  if (!(paminnelse.outcome === 'grundad' && hasChunk(paminnelse, 'inkassokostnadslagen', ['2']))) {
    failures.push(
      `paminnelseavgift-ratten grundas inte med inkassokostnadslagen §2 ` +
        `(utfall: ${paminnelse.outcome}, grind: ${paminnelse.gate}, domare: ${paminnelse.judge}) ` +
        `— #406:s mätsticka, förväntas RÖD tills fixen landar`,
    )
  }

  // Invariant 9 (#406): fällan som spärr. En bostadshyresvärd får aldrig 4 a §
  // (förseningsersättning MELLAN NÄRINGSIDKARE) som källa, och ett grundat svar
  // måste bära fallets egen facit-paragraf. Dagens miss är ett säkert utfall;
  // ett självsäkert svar med fel paragraf är det inte.
  for (const row of rows.filter(
    (r) => r.id.startsWith('paminnelseavgift-') || r.id === 'kravbrev-avgift',
  )) {
    if (row.outcome !== 'grundad') continue
    if (!row.sourceHit) {
      const fick = row.chunks.map((c) => `${c.lawId}:${c.paragraph}`).join(' ')
      failures.push(`${row.id} grundades med FEL paragraf (fick: ${fick || 'inget'})`)
    }
    if (hasChunk(row, 'inkassokostnadslagen', ['4 a'])) {
      failures.push(
        `${row.id} grundades med inkassokostnadslagen §4 a — förseningsersättning mellan ` +
          `NÄRINGSIDKARE, fel regel för en bostadshyresgäst (#406:s fälla)`,
      )
    }
  }

  if (failures.length > 0) {
    console.error('\n[eval] HÅRDA INVARIANTER BRUTNA:')
    for (const f of failures) console.error(`  ✗ ${f}`)
    process.exit(1)
  }
  console.warn('\n[eval] ALLA hårda invarianter håller. ✓')
}

main().catch((err: unknown) => exitOnPreflightError(err, 'eval'))
