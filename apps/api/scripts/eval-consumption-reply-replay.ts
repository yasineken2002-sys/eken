/** Återspelning av dokumenterade långa modellsvar. Inga nya kunddata eller åtgärder. */
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import Anthropic from '@anthropic-ai/sdk'
import {
  CONSUMPTION_JUDGE_OPTIONS,
  CONSUMPTION_JUDGE_REQUEST_OPTIONS,
  consumptionJudgePrompt,
  consumptionReadsFromRound,
  parseConsumptionVerdict,
  applyConsumptionVerdict,
} from '../src/ai/consumption-reply-guard'
import { followUpFactsFromRound } from '../src/ai/consumption-follow-up-facts'

// Förhandsmarkerade tydliga fel och korrekta stycken i #865:s sparade svar.
// Omärkta stycken är INTE facitgranskade och får inte räknas som godkända.
const checks: Record<string, { reject: number[]; keep: number[] }> = {
  off_with_history: { reject: [1, 3], keep: [0, 2, 4] },
  waiting_owner: { reject: [], keep: [0, 3, 4] },
  checked_no_notice: { reject: [3], keep: [0, 1, 4] },
  failed_unknown_cause: { reject: [6, 11], keep: [1, 2, 3, 7, 12, 14] },
  overdue: { reject: [], keep: [0, 1, 2, 3, 5, 6] },
  status_unavailable: { reject: [], keep: [0, 1, 2, 3] },
  no_trend_other_checks: { reject: [10, 13], keep: [1, 3, 6, 7, 8] },
  // Verktygsspåret innehåller faktiskt statusläsning även när riggens förväntan var review.
  assessment_and_setting_roles: { reject: [], keep: [2, 3, 5, 6, 8, 9] },
  normal_trend_no_finding: { reject: [5, 7], keep: [0, 2, 8] },
  low_rate_no_warning: { reject: [5], keep: [3, 7, 8, 10, 11] },
}

async function main() {
  if (process.env.EVAL_CONSUMPTION_LIVE !== '1' || !process.env.ANTHROPIC_API_KEY)
    throw new Error('Kräver uttryckligt live-val och en utvecklingsnyckel.')
  const raw = readFileSync('../../docs/eval/agent3-status-modellprov-slut.json', 'utf8')
  const saved = JSON.parse(raw) as {
    results: {
      case: string
      question: string
      role: string
      answer: string
      calls: { name: string; result: unknown }[]
    }[]
  }
  const options = CONSUMPTION_JUDGE_OPTIONS
  const client = new Anthropic(CONSUMPTION_JUDGE_REQUEST_OPTIONS)
  const results = []
  for (const item of saved.results) {
    const calls = item.calls.map((c, i) => ({ id: String(i), name: c.name }))
    const outputs = item.calls.map((c, i) => ({
      tool_use_id: String(i),
      content: JSON.stringify(c.result),
    }))
    const reads = consumptionReadsFromRound(calls, outputs)
    const input = {
      question: item.question,
      role: item.role,
      draft: item.answer,
      reads,
      statusFacts: followUpFactsFromRound(calls, outputs),
    }
    const prompt = consumptionJudgePrompt(input)
    if (!prompt) throw new Error('Underlaget ryms inte; ingen trunkering tillåten.')
    const start = Date.now()
    const response = await client.messages.create({
      ...options,
      messages: [{ role: 'user', content: prompt }],
    })
    const verdict = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
    const actual = parseConsumptionVerdict(verdict, item.answer.split(/\n\s*\n/).length)
    const expected = checks[item.case]!
    const passed =
      response.stop_reason === 'end_turn' &&
      actual !== null &&
      expected.reject.every((i) => actual[i] === false) &&
      expected.keep.every((i) => actual[i] === true)
    results.push({
      id: item.case,
      input,
      expected,
      actual,
      passed,
      rawVerdict: verdict,
      elapsedMs: Date.now() - start,
      usage: response.usage,
      guarded: applyConsumptionVerdict(
        item.answer,
        response.stop_reason === 'end_turn' ? verdict : null,
        reads,
      ),
    })
    process.stdout.write(`${item.case} ${passed ? 'PASS' : 'FAIL'} ${JSON.stringify(actual)}\n`)
  }
  const report = {
    at: new Date().toISOString(),
    model: options.model,
    system: options.system,
    promptSha256: createHash('sha256').update(CONSUMPTION_JUDGE_OPTIONS.system).digest('hex'),
    sourceSha256: createHash('sha256').update(raw).digest('hex'),
    limitation:
      'Samma gamla syntetiska underlag och modellsvar. Facit gäller bara de utpekade styckena; omärkta stycken är inte granskade. Inte oberoende pilot eller driftprecision.',
    passed: results.filter((r) => r.passed).length,
    total: results.length,
    results,
  }
  writeFileSync(
    process.argv[2] ?? '../../docs/eval/agent3-svarsgrind-aterstallda-svar.json',
    JSON.stringify(report, null, 2) + '\n',
  )
  process.stdout.write(`${report.passed}/${report.total}\n`)
  if (report.passed !== report.total) process.exitCode = 1
}
main().catch((error) => {
  const category =
    error instanceof Anthropic.APIError
      ? { status: error.status ?? null, type: error.name }
      : { type: error instanceof Error ? error.name : 'UnknownError' }
  console.error('Återspelningen kunde inte slutföras.', JSON.stringify(category))
  process.exitCode = 1
})
