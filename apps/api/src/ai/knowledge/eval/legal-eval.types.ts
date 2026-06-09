/**
 * Typer för juridik-AI:ns eval-set (Etapp 2, PR 2.1 — mätstickan).
 *
 * Eval-setet är BÅDE måttstock och regressionsspärr: när retrieval (PR 2.2) och
 * svar+osäkerhetsgrind (PR 2.3) byggs blir "fungerar det?" en mätning mot dessa
 * fall, inte en gissning. Denna PR innehåller BARA datan + harness-strukturen —
 * ingen produktions-AI, ingen retrieval körs.
 */

/** Förväntad utgång för en fråga — styr vilken förmåga fallet testar. */
export type EvalExpectedOutcome =
  | 'answerable' // går att besvara grundat i kunskapsbasen
  | 'needs-jurist' // känslig/tolkningsfråga: rätt utgång är "kontakta jurist/revisor"
  | 'no-clear-rule' // ingen exakt regel i kunskapsbasen (testar miss-grinden i 2.3)

/** En förväntad källa: en lag i LEGAL_KNOWLEDGE + paragraf(er) som ska träffas. */
export interface EvalSource {
  /** Måste matcha ett id i LEGAL_KNOWLEDGE, t.ex. "hyreslagen". */
  lawId: string
  /**
   * Paragraf-etiketter som de står i lagtextens rubriker, t.ex. "45", "54 a".
   * Existens verifieras mot "## <paragraf> §" i lagens innehåll.
   */
  paragraphs: string[]
}

/** Ett eval-fall: en verklig hyresvärdsfråga med facit. */
export interface LegalEvalCase {
  /** Stabil slug, t.ex. "besittningsskydd-forstahand-1ar". */
  id: string
  /** Ämnesområde, t.ex. "besittningsskydd". */
  category: string
  /** Frågan, formulerad som en hyresvärd skulle ställa den. */
  question: string
  /** Rätt källa/paragrafer. Tom lista för no-clear-rule/needs-jurist utan lagstöd. */
  expectedSources: EvalSource[]
  /** Kärnan i det korrekta svaret — kort, faktabaserat. */
  expectedAnswerCore: string
  /** Bör svaret rekommendera kontakt med jurist/revisor? */
  shouldRecommendJurist: boolean
  /** Förväntad utgång (se EvalExpectedOutcome). */
  expectedOutcome: EvalExpectedOutcome
  /** Markerar uttryckliga regressionsfall (t.ex. besittningsskydds-felet från #129). */
  isRegression?: boolean
  /** Fri kommentar, t.ex. kapitelhänvisning för flerkapitels-lagar. */
  note?: string
}
