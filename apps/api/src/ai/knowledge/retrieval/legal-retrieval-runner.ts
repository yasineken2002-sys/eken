/**
 * Kopplar retrieval till eval-harnessen (PR 2.1) så vi kan MÄTA träffsäkerheten.
 *
 * Implementerar retrieval-delen av LegalEvalRunner-kontraktet. `answer` och
 * `recommendedJurist` lämnas tomma — de fylls av AI:n + osäkerhetsgrinden i
 * PR 2.3. Här mäter vi bara: hittade retrieval rätt paragraf (sourceHit)?
 *
 * Ingen AI, ingen modell.
 */
import { retrieveLegalChunks, type RetrievedChunk } from './legal-retrieval'
import { scoreRun, type EvalRunOutput, type LegalEvalRunner } from '../eval/legal-eval-harness'
import type { EvalSource, LegalEvalCase } from '../eval/legal-eval.types'
import { LEGAL_EVAL_SET } from '../eval/legal-eval-set'

/** Grupperar retrievade chunkar till EvalSource[] — källan kommer från chunkens metadata. */
export function chunksToSources(retrieved: RetrievedChunk[]): EvalSource[] {
  const byLaw = new Map<string, Set<string>>()
  for (const { chunk } of retrieved) {
    if (!byLaw.has(chunk.lawId)) byLaw.set(chunk.lawId, new Set())
    byLaw.get(chunk.lawId)!.add(chunk.paragraph)
  }
  return [...byLaw].map(([lawId, paragraphs]) => ({ lawId, paragraphs: [...paragraphs] }))
}

/** Retrieval-runner: fyller retrievedSources, lämnar svar/grind till PR 2.3. */
export const retrievalRunner: LegalEvalRunner = (testCase: LegalEvalCase) => {
  const retrieved = retrieveLegalChunks(testCase.question, { topK: 3 })
  const output: EvalRunOutput = {
    retrievedSources: chunksToSources(retrieved),
    answer: '', // AI:n skriver svaret i PR 2.3
    recommendedJurist: false, // osäkerhetsgrinden i PR 2.3
  }
  return Promise.resolve(output)
}

export interface RetrievalEvalRow {
  id: string
  category: string
  expectedOutcome: LegalEvalCase['expectedOutcome']
  sourceHit: boolean
  retrieved: EvalSource[]
}

export interface RetrievalEvalReport {
  rows: RetrievalEvalRow[]
  /** Antal answerable-fall där rätt paragraf hämtades / totalt antal answerable. */
  answerableHits: number
  answerableTotal: number
}

/** Kör retrieval mot hela eval-setet och sammanställer träffsäkerheten. */
export async function runRetrievalEval(): Promise<RetrievalEvalReport> {
  const rows: RetrievalEvalRow[] = []
  for (const testCase of LEGAL_EVAL_SET) {
    const output = await retrievalRunner(testCase)
    rows.push({
      id: testCase.id,
      category: testCase.category,
      expectedOutcome: testCase.expectedOutcome,
      sourceHit: scoreRun(testCase, output).sourceHit,
      retrieved: output.retrievedSources,
    })
  }
  const answerable = rows.filter((r) => r.expectedOutcome === 'answerable')
  return {
    rows,
    answerableHits: answerable.filter((r) => r.sourceHit).length,
    answerableTotal: answerable.length,
  }
}
