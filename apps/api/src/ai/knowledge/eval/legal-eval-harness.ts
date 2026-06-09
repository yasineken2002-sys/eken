/**
 * Utvärderingsharness för juridik-AI:n (Etapp 2, PR 2.1).
 *
 * Denna PR levererar STRUKTUREN, inte körningen: det finns ingen retrieval och
 * ingen AI att köra mot ännu. Här finns
 *   1) källverifiering (paragrafer i eval-setet finns faktiskt i LEGAL_KNOWLEDGE),
 *   2) en ren poängsättnings-funktion (jämför ett kört resultat mot facit), och
 *   3) ett runner-kontrakt som PR 2.2 (retrieval) och 2.3 (svar + osäkerhetsgrind)
 *      implementerar.
 * Inget här anropar en modell eller läser produktions-AI:ns prompt.
 */
import { getLegalDocument } from '../legal-knowledge'
import type { EvalSource, LegalEvalCase } from './legal-eval.types'

/** Sant om "## <paragraf> §" finns i den angivna lagens verifierade text. */
export function paragraphExists(lawId: string, paragraph: string): boolean {
  const doc = getLegalDocument(lawId)
  if (!doc) return false
  return doc.innehall.includes(`## ${paragraph} §`)
}

/**
 * Verifierar att ALLA förväntade källor i ett eval-fall faktiskt existerar i
 * kunskapsbasen. Returnerar listan över saknade referenser (tom = allt finns).
 * Fall utan källor (no-clear-rule/needs-jurist utan lagstöd) har inget att verifiera.
 */
export function findMissingSources(testCase: LegalEvalCase): string[] {
  const missing: string[] = []
  for (const source of testCase.expectedSources) {
    if (!getLegalDocument(source.lawId)) {
      missing.push(`${source.lawId} (okänd lag)`)
      continue
    }
    for (const paragraph of source.paragraphs) {
      if (!paragraphExists(source.lawId, paragraph)) {
        missing.push(`${source.lawId} § ${paragraph}`)
      }
    }
  }
  return missing
}

// ── Forward-looking: körnings- och poängstruktur (används av 2.2+) ────────────

/** Vad en kör-runner (PR 2.2/2.3) ska returnera för en fråga. */
export interface EvalRunOutput {
  /** Källorna retrieval valde ut. */
  retrievedSources: EvalSource[]
  /** AI:ns svarstext. */
  answer: string
  /** Rekommenderade svaret kontakt med jurist/revisor? */
  recommendedJurist: boolean
}

/**
 * Kontraktet som PR 2.2 (retrieval) och 2.3 (svar + grind) implementerar.
 * KÖRS INTE i denna PR — det finns ingen implementation ännu.
 */
export type LegalEvalRunner = (testCase: LegalEvalCase) => Promise<EvalRunOutput>

/** Poäng för ett kört fall jämfört med facit. Ren funktion, ingen AI. */
export interface EvalScore {
  /** Innehöll de retrievade källorna minst en förväntad (lag + paragraf)? */
  sourceHit: boolean
  /** Matchade jurist-rekommendationen facit? */
  juristMatch: boolean
}

/** Jämför ett runner-resultat mot facit. Tillgänglig redan nu för 2.2+. */
export function scoreRun(testCase: LegalEvalCase, output: EvalRunOutput): EvalScore {
  const expectedKeys = new Set(
    testCase.expectedSources.flatMap((s) => s.paragraphs.map((p) => `${s.lawId}#${p}`)),
  )
  const sourceHit =
    expectedKeys.size === 0
      ? output.retrievedSources.length === 0 // miss-fall: rätt att inte hämta något
      : output.retrievedSources.some((s) =>
          s.paragraphs.some((p) => expectedKeys.has(`${s.lawId}#${p}`)),
        )
  return {
    sourceHit,
    juristMatch: output.recommendedJurist === testCase.shouldRecommendJurist,
  }
}
