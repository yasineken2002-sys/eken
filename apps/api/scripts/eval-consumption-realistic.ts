/**
 * Frivilliga riktiga modellanrop på fiktiva data. Ingen DB eller skrivande verktyg.
 * assertions: 18 par med förhandsbestämt facit. conversations: 8 fria svar att granska.
 * Kör inte automatisk domare som facit för samma domare. Spara även fel och uteblivna prov.
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import Anthropic from '@anthropic-ai/sdk'
import { SYSTEM_PROMPT } from '../src/ai/ai-assistant.service'
import { CHAT_PROFILE_TEXT, chatRequestOptions } from '../src/ai/ai.config'
import { TOOLS } from '../src/ai/tools/ai-tools.definition'
import { getConsumptionReview } from '../src/ai/tools/consumption-review'
import { neutralizeUntrusted } from '../src/ai/tools/untrusted-content'
import {
  CONSUMPTION_JUDGE_SYSTEM,
  CONSUMPTION_JUDGE_OPTIONS,
  CONSUMPTION_JUDGE_REQUEST_OPTIONS,
  consumptionJudgePrompt,
  consumptionReadsFromRound,
  parseConsumptionVerdict,
  applyConsumptionVerdict,
} from '../src/ai/consumption-reply-guard'
import type { ConsumptionRead } from '../src/ai/consumption-reply-guard'
import {
  realisticConsumptionCases,
  syntheticConsumptionDb,
  SYNTHETIC_ORG,
} from '../src/ai/testing/consumption-realistic.fixtures'

const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const text = (response: Anthropic.Message) =>
  response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n\n')
const conversationIds = new Set([
  'olika-manadslangd',
  'lackliknande-hopp',
  'borttappat-decimaltecken',
  'tom-lagenhet',
  'nollhistorik',
  'saknade-manader',
  'matarbyte-samma-id',
  'tva-lagenheter',
])

async function main() {
  if (process.env.EVAL_CONSUMPTION_LIVE !== '1' || !process.env.ANTHROPIC_API_KEY)
    throw new Error('Kräver uttryckligt live-val och utvecklingsnyckel.')
  const mode = process.env.EVAL_REALISTIC_MODE ?? 'assertions'
  if (!['assertions', 'conversations'].includes(mode)) throw new Error('Okänt provläge.')
  const output = process.argv[2] ?? `../../docs/eval/agent3-verklighetslika-${mode}.json`
  const client = new Anthropic({ timeout: 60_000, maxRetries: 0 })
  const selected = realisticConsumptionCases().filter(
    (c) => mode === 'assertions' || conversationIds.has(c.id),
  )
  const results: Record<string, unknown>[] = []
  const chatSystem = `${SYSTEM_PROMPT}\n\nInloggad roll i detta konstruerade prov: MANAGER.`
  const report = {
    at: new Date().toISOString(),
    mode,
    planned: selected.length,
    fixtureSha256: hash(readFileSync('src/ai/testing/consumption-realistic.fixtures.ts', 'utf8')),
    judgePromptSha256: hash(CONSUMPTION_JUDGE_SYSTEM),
    judgeSystem: CONSUMPTION_JUDGE_SYSTEM,
    chatPromptSha256: hash(chatSystem),
    chatSystem: mode === 'conversations' ? chatSystem : undefined,
    models: { chat: CHAT_PROFILE_TEXT.model, judge: CONSUMPTION_JUDGE_OPTIONS.model },
    limitation:
      'Konstruerade månadsavläsningar och facit skrivna av Codex före denna körning. Ingen extern mänsklig granskning eller driftprecision. Produktionsregler, läsverktyg, modeller, prompt och svarsgrind; isolerad rigg utan HTTP, databas, historiklagring eller kvoter. Fritextsvaren har inget automatiskt sanningsfacit.',
    results,
  }
  const save = () =>
    writeFileSync(
      output,
      JSON.stringify(
        {
          ...report,
          completed: results.length,
          notRun: selected.slice(results.length).map((c) => c.id),
          ...(mode === 'assertions'
            ? { passed: results.filter((r) => r.passed === true).length }
            : { flowPassed: results.filter((r) => r.flowPassed === true).length }),
        },
        null,
        2,
      ) + '\n',
    )
  save()
  for (const [index, item] of selected.entries()) {
    const start = Date.now()
    const { db, queries } = syntheticConsumptionDb(item.rows)
    const reads: ConsumptionRead[] = []
    const calls: Record<string, unknown>[] = []
    const responses: Anthropic.Message[] = []
    let draft = ''
    let stopReason: string | null = null
    let judgeResponse: Anthropic.Message | undefined
    const expected = index % 2 === 0 ? [true, false] : [false, true]
    try {
      if (mode === 'assertions') {
        const result = neutralizeUntrusted(
          await getConsumptionReview(db, SYNTHETIC_ORG, 'MANAGER', {}),
        )
        reads.push(
          ...consumptionReadsFromRound(
            [{ id: 'read', name: 'get_consumption_review' }],
            [{ tool_use_id: 'read', content: JSON.stringify(result) }],
          ),
        )
        draft = (
          index % 2 === 0 ? [item.supported, item.unsupported] : [item.unsupported, item.supported]
        ).join('\n\n')
      } else {
        const messages: Anthropic.MessageParam[] = [{ role: 'user', content: item.question }]
        for (let round = 0; round < 3; round++) {
          const response = await client.messages.create({
            ...chatRequestOptions(CHAT_PROFILE_TEXT),
            system: chatSystem,
            tools: TOOLS,
            messages,
          })
          responses.push(response)
          stopReason = response.stop_reason
          if (text(response)) draft += (draft ? '\n\n' : '') + text(response)
          messages.push({ role: 'assistant', content: response.content })
          const toolCalls = response.content.filter(
            (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
          )
          if (!toolCalls.length) break
          const toolResults: Anthropic.ToolResultBlockParam[] = []
          for (const call of toolCalls) {
            // Full meny visas, men det finns ingen exekveringsväg till en skrivning.
            let result: unknown = {
              success: false,
              message: 'Riggen tillåter endast läsning av förbrukningsgranskningen.',
            }
            if (call.name === 'get_consumption_review') {
              try {
                result = await getConsumptionReview(
                  db,
                  SYNTHETIC_ORG,
                  'MANAGER',
                  call.input as Record<string, unknown>,
                )
              } catch {
                result = {
                  success: false,
                  message: 'Läsningen kunde inte genomföras. Kontrollera urvalet.',
                }
              }
            }
            const safeResult = neutralizeUntrusted(result)
            calls.push({ name: call.name, input: call.input, result: safeResult, round })
            toolResults.push({
              type: 'tool_result',
              tool_use_id: call.id,
              content: JSON.stringify(safeResult),
            })
          }
          reads.push(...consumptionReadsFromRound(toolCalls, toolResults, round))
          messages.push({ role: 'user', content: toolResults })
        }
      }
      const input = { question: item.question, role: 'MANAGER', draft, reads }
      const prompt = consumptionJudgePrompt(input)
      if (!prompt) throw new Error('Utkastet ryms inte i grinden.')
      judgeResponse = await client.messages.create(
        { ...CONSUMPTION_JUDGE_OPTIONS, messages: [{ role: 'user', content: prompt }] },
        CONSUMPTION_JUDGE_REQUEST_OPTIONS,
      )
      const verdict = text(judgeResponse)
      const actual =
        judgeResponse.stop_reason === 'end_turn'
          ? parseConsumptionVerdict(verdict, draft.split(/\n\s*\n/).length)
          : null
      const passed = JSON.stringify(actual) === JSON.stringify(expected)
      const flowPassed =
        stopReason === 'end_turn' &&
        draft.trim().length > 0 &&
        calls.length > 0 &&
        calls.every((c) => c.name === 'get_consumption_review') &&
        reads.some((r) => (r.result as { success?: boolean }).success === true) &&
        actual !== null
      results.push({
        id: item.id,
        input,
        queries,
        calls,
        stopReason,
        ...(mode === 'assertions'
          ? { expected, actual, passed }
          : { actual, flowPassed, semanticReview: 'PENDING' }),
        rawVerdict: verdict,
        guarded: applyConsumptionVerdict(
          draft,
          judgeResponse.stop_reason === 'end_turn' ? verdict : null,
          reads,
        ),
        chatResponses: responses,
        judgeResponse,
        elapsedMs: Date.now() - start,
      })
      process.stdout.write(
        `${item.id}: ${mode === 'assertions' ? (passed ? 'PASS' : 'FAIL') : flowPassed ? 'FLÖDE KLART, SAKLIGHET EJ BEDÖMD' : 'FLÖDESFEL'}\n`,
      )
      if (mode === 'assertions' ? !passed : !flowPassed) process.exitCode = 1
    } catch (error) {
      results.push({
        id: item.id,
        draft,
        reads,
        queries,
        calls,
        chatResponses: responses,
        judgeResponse,
        passed: false,
        flowPassed: false,
        error:
          error instanceof Anthropic.APIError
            ? `HTTP ${error.status ?? 'unknown'}`
            : 'Provet kunde inte slutföras.',
        elapsedMs: Date.now() - start,
      })
      process.stdout.write(`${item.id}: ERROR, avbryter återstående modellanrop.\n`)
      process.exitCode = 1
      save()
      break
    }
    save()
  }
  save()
}

if (require.main === module)
  void main().catch(() => {
    console.error('Modellprovet kunde inte slutföras.')
    process.exitCode = 1
  })
