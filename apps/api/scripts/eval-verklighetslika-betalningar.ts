/** Fristående syntetiskt prov. Inga DB-anslutningar, matchningar eller bokföringsanrop. */
import Anthropic from '@anthropic-ai/sdk'
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { verklighetslikaBetalningar } from '../src/ai/shadow/eval/verklighetslika-betalningar'
import {
  BETALNINGSARMAR,
  mataVerklighetslikBetalning,
  sammanfattaVerklighetslikaBetalningar,
} from '../src/ai/shadow/eval/verklighetslik-betalningsmatning'
import type {
  VerklighetslikMatpunkt,
  Provanrop,
} from '../src/ai/shadow/eval/verklighetslik-betalningsmatning'
import {
  BETALNINGSMODELL,
  BETALNING_MAX_TOKENS,
} from '../src/ai/shadow/payment/payment-shadow.service'

async function main() {
  const live = process.env.EVAL_PAYMENTS_LIVE === '1'
  if (live && !process.env.ANTHROPIC_API_KEY) throw new Error('Utvecklingsnyckel saknas.')
  const client = live ? new Anthropic({ maxRetries: 0, timeout: 60_000 }) : null
  const cases = verklighetslikaBetalningar()
  const rows: VerklighetslikMatpunkt[] = []
  const output = process.argv[2] ?? '/tmp/agent2-verklighetslika.json'
  const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
  const files = [
    'src/ai/shadow/eval/verklighetslika-betalningar.ts',
    'src/ai/shadow/eval/verklighetslik-betalningsmatning.ts',
    'src/ai/shadow/eval/experiment-betalningsbedomning.ts',
    'src/ai/shadow/eval/experiment-betalningsreferenser.ts',
    'src/ai/shadow/payment/payment-candidates.ts',
    'src/ai/shadow/payment/payment-shadow.service.ts',
  ]
  const metadata = {
    at: new Date().toISOString(),
    sha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    sourceHashes: Object.fromEntries(
      files.map((path) => [path, sha256(readFileSync(path, 'utf8'))]),
    ),
    lage: live ? 'MED_MODELL' : 'UTAN_MODELL',
    modell: BETALNINGSMODELL,
    maxTokens: BETALNING_MAX_TOKENS,
    repetitions: 2,
    antalGrundfall: cases.length,
    planeradeMatpunkter: cases.length * 2 * BETALNINGSARMAR.length,
    limitation:
      'Konstruerat facit bestämt av Codex, ingen oberoende mänsklig granskning eller driftprecision. Befintlig arm mäter förslag om EN matchning; experimenten mäter identitet och hantering. De totalsiffrorna kan inte jämföras som samma sak. Kontroller för exakt OCR mäter bara skuggagentens förbigång, aldrig utförd bankmatchning. Två repetitioner är inte oberoende fall.',
    cases,
  }
  const save = () =>
    writeFileSync(
      output,
      JSON.stringify(
        {
          ...metadata,
          sammanfattning: sammanfattaVerklighetslikaBetalningar(rows),
          usage: {
            inputTokens: rows.reduce((n, r) => n + (r.response?.usage.input_tokens ?? 0), 0),
            outputTokens: rows.reduce((n, r) => n + (r.response?.usage.output_tokens ?? 0), 0),
            callsWithUsage: rows.filter((r) => r.response).length,
            complete: !rows.some((r) => r.status === 'API_FEL'),
          },
          rader: rows,
        },
        null,
        2,
      ) + '\n',
    )
  const invoke: Provanrop | undefined = client
    ? async (request) => {
        const response = await client.messages.create({
          model: BETALNINGSMODELL,
          max_tokens: BETALNING_MAX_TOKENS,
          temperature: 0,
          tools: [request.tool],
          tool_choice: { type: 'tool', name: request.tool.name },
          messages: [{ role: 'user', content: request.prompt }],
        })
        const block = response.content.find(
          (b) => b.type === 'tool_use' && b.name === request.tool.name,
        )
        return {
          input: block?.type === 'tool_use' ? block.input : null,
          stopReason: response.stop_reason,
          usage: response.usage,
          rawResponse: response,
        }
      }
    : undefined
  let stopped = false
  save()
  for (let repetition = 1; repetition <= 2; repetition++) {
    for (const item of cases) {
      const arms = repetition === 1 ? [...BETALNINGSARMAR] : [...BETALNINGSARMAR].reverse()
      for (const arm of arms) {
        const row = await mataVerklighetslikBetalning(
          item,
          arm,
          repetition,
          stopped ? undefined : invoke,
        )
        rows.push(row)
        if (row.status === 'API_FEL') stopped = true
        process.stdout.write(
          `${repetition}/2 ${item.id} ${arm}: ${row.status}, ${row.kontroll ? (row.kontrollRatt ? 'kontroll OK' : 'KONTROLLFEL') : row.heltRatt ? 'rätt' : 'ej helt rätt'}\n`,
        )
        save()
      }
    }
  }
  process.stdout.write(JSON.stringify(sammanfattaVerklighetslikaBetalningar(rows)) + '\n')
  // En mätning med felaktiga beslut får inte se ut som godkänd kvalitet.
  if (live && rows.some((r) => !r.kontrollRatt || (!r.kontroll && !r.heltRatt)))
    process.exitCode = 1
}
if (require.main === module)
  void main().catch(() => {
    console.error('Provet kunde inte slutföras. Ingen råfeltext skrivs ut.')
    process.exitCode = 1
  })
