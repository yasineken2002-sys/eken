/** Frivilligt modellprov med konstruerade data. Ingen databas eller skrivande verktyg. */
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import Anthropic from '@anthropic-ai/sdk'
import { SYSTEM_PROMPT } from '../src/ai/ai-assistant.service'
import { AI_MODELS } from '../src/ai/ai.config'
import { TOOLS } from '../src/ai/tools/ai-tools.definition'
import { getConsumptionFollowUp } from '../src/ai/tools/consumption-follow-up'
import { getConsumptionReview } from '../src/ai/tools/consumption-review'
import { neutralizeUntrusted } from '../src/ai/tools/untrusted-content'
import type { PrismaService } from '../src/common/prisma/prisma.service'

async function main() {
  if (process.env.EVAL_CONSUMPTION_LIVE !== '1' || !process.env.ANTHROPIC_API_KEY)
    throw new Error('Modellprovet kräver uttryckligt live-val och en testnyckel.')
  const client = new Anthropic({ maxRetries: 0, timeout: 60_000 })
  const cases = [
    {
      id: 'off_with_history',
      role: 'ADMIN',
      state: 'off',
      tool: 'get_consumption_follow_up',
      question:
        'Är den automatiska förbrukningsuppföljningen påslagen? Jag ser en tidigare genomförd kontroll.',
    },
    {
      id: 'waiting_owner',
      role: 'OWNER',
      state: 'waiting',
      tool: 'get_consumption_follow_up',
      question:
        'Kontrollera om automatisk förbrukningsuppföljning är på, slå på den om den är av och kör kontrollen nu.',
    },
    {
      id: 'checked_no_notice',
      role: 'MANAGER',
      state: 'checked',
      tool: 'get_consumption_follow_up',
      question:
        'Jag har inte fått någon förbrukningsnotis. Har den automatiska kontrollen körts, och betyder det att alla avläsningar är felfria?',
    },
    {
      id: 'failed_unknown_cause',
      role: 'VIEWER',
      state: 'failed',
      tool: 'get_consumption_follow_up',
      question:
        'Fungerar den automatiska förbrukningsuppföljningen? Varför misslyckades den och vad ska jag göra?',
    },
    {
      id: 'overdue',
      role: 'OWNER',
      state: 'overdue',
      tool: 'get_consumption_follow_up',
      question:
        'När kördes den automatiska förbrukningskontrollen senast, är det aktuellt och när körs den nästa gång?',
    },
    {
      id: 'status_unavailable',
      role: 'ADMIN',
      state: 'unavailable',
      tool: 'get_consumption_follow_up',
      question: 'Är den automatiska förbrukningsuppföljningen avstängd? Slå på den i så fall.',
    },
    {
      id: 'no_trend_other_checks',
      role: 'VIEWER',
      state: 'checked',
      tool: 'get_consumption_review',
      question:
        'Är alla mina mätaravläsningar felfria? Kan systemet fortfarande hitta några fel om trendhistoriken inte räcker?',
    },
    {
      id: 'assessment_and_setting_roles',
      role: 'VIEWER',
      state: 'off',
      tool: 'get_consumption_review',
      question:
        'Vilka roller kan spara bedömningar av förbrukningsavvikelser och vilka kan slå på automatisk uppföljning? Kan du göra det åt mig?',
    },
    {
      id: 'normal_trend_no_finding',
      role: 'VIEWER',
      state: 'checked',
      tool: 'get_consumption_review',
      question:
        'Varför finns en trendbedömd avläsning men inga varningar? Betyder trendbedömd att avläsningen är misstänkt?',
    },
    {
      id: 'low_rate_no_warning',
      role: 'MANAGER',
      state: 'checked',
      tool: 'get_consumption_review',
      question:
        'Fångar förbrukningsgranskningen både onormalt hög och onormalt låg förbrukning? Kontrollera mitt underlag.',
    },
  ] as const
  const results = []
  for (const item of cases) {
    const now = Date.now()
    const ago = (hours: number) => new Date(now - hours * 3_600_000)
    const state = {
      consumptionReviewFollowUpEnabled: item.state !== 'off',
      consumptionReviewFollowUpEnabledAt: item.state === 'waiting' ? ago(0) : ago(72),
      consumptionReviewFollowUpCheckedAt:
        item.state === 'waiting' ? null : ago(item.state === 'overdue' ? 27 : 1),
      consumptionReviewFollowUpErrorAt: item.state === 'failed' ? ago(0.5) : null,
    }
    const db = {
      organization: {
        findUnique: async () => {
          if (item.state === 'unavailable') throw new Error('synthetic read failure')
          return state
        },
      },
      meterReading: {
        findMany: async () =>
          (item.id === 'normal_trend_no_finding'
            ? [10, 10, 10, 10]
            : item.id === 'low_rate_no_warning'
              ? [10, 10, 10, 1]
              : [10, 10, 10]
          ).map((value, i) => ({
            id: `demo-${i}`,
            meterId: 'demo-meter',
            organizationId: 'demo-org',
            value,
            readingType: 'PERIOD_VOLUME',
            periodStart: new Date(Date.UTC(2026, 0, i + 1)),
            periodEnd: new Date(Date.UTC(2026, 0, i + 1)),
          })),
      },
      meterReadingReview: { findMany: async () => [] },
      meter: { findMany: async () => [] },
    } as unknown as PrismaService
    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: item.question }]
    const calls: Array<{ name: string; input: unknown; result: unknown }> = []
    let answer = '',
      stopReason: string | null = null,
      inputTokens = 0,
      outputTokens = 0
    for (let round = 0; round < 3; round++) {
      const response = await client.messages.create({
        model: AI_MODELS.CHAT,
        max_tokens: 1200,
        system: `${SYSTEM_PROMPT}\n\nAktuell tid: ${new Date().toISOString()}. Inloggad roll i detta konstruerade prov: ${item.role}.`,
        tools: TOOLS,
        messages,
      })
      inputTokens += response.usage.input_tokens
      outputTokens += response.usage.output_tokens
      stopReason = response.stop_reason
      messages.push({ role: 'assistant', content: response.content })
      const toolResults: Anthropic.ToolResultBlockParam[] = []
      for (const block of response.content) {
        if (block.type === 'text') answer += block.text + '\n'
        if (block.type !== 'tool_use') continue
        let result: unknown
        let isError = false
        try {
          if (block.name === 'get_consumption_follow_up')
            result = await getConsumptionFollowUp(
              db,
              'demo-org',
              item.role,
              block.input as Record<string, unknown>,
            )
          else if (block.name === 'get_consumption_review')
            result = await getConsumptionReview(
              db,
              'demo-org',
              item.role,
              block.input as Record<string, unknown>,
            )
          else {
            isError = true
            result = {
              success: false,
              message: 'Detta prov tillåter endast förbrukningens två läsverktyg.',
            }
          }
        } catch {
          isError = true
          result = {
            success: false,
            message: 'Läsningen kunde inte slutföras. Aktuellt läge är okänt.',
          }
        }
        const safeResult = neutralizeUntrusted(result)
        calls.push({ name: block.name, input: block.input, result: safeResult })
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          is_error: isError,
          content: JSON.stringify(safeResult),
        })
      }
      if (!toolResults.length) break
      messages.push({ role: 'user', content: toolResults })
    }
    const executionOk =
      calls.some((call) => call.name === item.tool) &&
      calls.every((call) =>
        ['get_consumption_follow_up', 'get_consumption_review'].includes(call.name),
      ) &&
      stopReason === 'end_turn' &&
      answer.trim().length > 0
    results.push({
      case: item.id,
      role: item.role,
      question: item.question,
      constructedState: item.state,
      calls,
      answer,
      stopReason,
      inputTokens,
      outputTokens,
      executionOk,
    })
    console.warn(
      `${item.id}: ${executionOk ? 'verktygsflöde klart' : 'behöver granskas'}, ${calls.length} läsanrop`,
    )
  }
  writeFileSync(
    process.argv[2] ?? '/tmp/agent3-follow-up-model.json',
    JSON.stringify(
      {
        at: new Date().toISOString(),
        model: AI_MODELS.CHAT,
        systemPromptSha256: createHash('sha256').update(SYSTEM_PROMPT).digest('hex'),
        limitation:
          'Tio konstruerade fall, en körning per fall. Produktionsprompt och verktygsmeny med separat provkontext, attrappad DB och endast två tillåtna läsverktyg. Ingen extra portfölj- eller minneskontext. executionOk mäter verktygsflöde, inte sanningshalt eller driftprecision. Samtliga svar måste granskas manuellt.',
        results,
      },
      null,
      2,
    ) + '\n',
  )
  if (results.some((result) => !result.executionOk)) process.exitCode = 1
}
if (require.main === module)
  void main().catch((error: unknown) => {
    console.error(
      'Modellprovet kunde inte slutföras.',
      error instanceof Anthropic.APIError ? `HTTP ${error.status}` : 'Se testmiljön.',
    )
    process.exitCode = 1
  })
