/** Ofarligt återspel som standard. Opt-in ger högst 64 nya modellförfrågningar. */
import Anthropic from '@anthropic-ai/sdk'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import type { Bankrad, Kandidat } from '../src/ai/shadow/payment/payment-candidates'
import {
  BETALNINGSMODELL,
  BETALNING_MAX_TOKENS,
} from '../src/ai/shadow/payment/payment-shadow.service'
import type { Betalningsbedomning } from '../src/ai/shadow/eval/experiment-betalningsbedomning'
import { verklighetslikaBetalningar } from '../src/ai/shadow/eval/verklighetslika-betalningar'
import {
  mataVerklighetslikBetalning,
  type Provanrop,
  type VerklighetslikMatpunkt,
} from '../src/ai/shadow/eval/verklighetslik-betalningsmatning'
import { nyaGrindprover } from '../src/ai/shadow/eval/betalningsgrind-prover'
import {
  matGrindprov,
  sammanfattaGrindprov,
  type Grindmatpunkt,
} from '../src/ai/shadow/eval/betalningsgrind-matning'

async function main() {
  const live = process.env.EVAL_PAYMENTS_LIVE === '1'
  const output = process.argv[2] ?? '/tmp/betalningsgrind-aterspel.json'
  if (existsSync(output)) throw new Error('Rapport finns redan; välj en ny utfil.')
  if (live && !process.env.ANTHROPIC_API_KEY) throw new Error('Utvecklingsnyckel saknas.')
  const dir = 'src/ai/shadow/eval/'
  const read = (file: string) => JSON.parse(readFileSync(dir + file, 'utf8'))
  const saved = read('verklighetslika-betalningar.modell.json') as {
    rader: VerklighetslikMatpunkt[]
  }
  const cases = verklighetslikaBetalningar()
  const replay = saved.rader
    .filter((r) => r.arm === 'referensstod' && !r.kontroll)
    .map((r) => {
      const c = cases.find((c) => c.id === r.id)!
      return matGrindprov({ ...c, facit: c.bedomning }, r.bedomning, r.repetition, r.status)
    })
  type JsonPost = Omit<Kandidat, 'forfallodatum'> & { forfallodatum: string }
  type JsonRad = Omit<Bankrad, 'datum'> & { datum: string; facit: Betalningsbedomning }
  const oldCases = read('korpus-referensstod-betalning.json') as {
    poster: JsonPost[]
    bankrader: JsonRad[]
  }
  const old = read('experiment-referensstod-betalning.json') as {
    rader: {
      id: string
      repetition: number
      arm: string
      svar: Betalningsbedomning | null
      status: string
    }[]
  }
  const olderReplay = old.rader
    .filter((r) => r.arm === 'referensstod')
    .map((r) => {
      const c = oldCases.bankrader.find((c) => c.id === r.id)!
      return matGrindprov(
        {
          id: c.id,
          rad: { ...c, datum: new Date(c.datum) },
          poster: oldCases.poster.map((p) => ({ ...p, forfallodatum: new Date(p.forfallodatum) })),
          facit: c.facit,
        },
        r.svar,
        r.repetition,
        r.status,
      )
    })
  const fresh = nyaGrindprover()
  const files = [
    'scripts/eval-betalningsgrind.ts',
    ...[
      'betalningsgrind-prover.ts',
      'betalningsgrind-matning.ts',
      'experiment-betalningsgrind.ts',
      'experiment-betalningsreferenser.ts',
      'experiment-betalningsbedomning.ts',
      'verklighetslika-betalningar.ts',
      'verklighetslik-betalningsmatning.ts',
      'verklighetslika-betalningar.modell.json',
      'korpus-referensstod-betalning.json',
      'experiment-referensstod-betalning.json',
    ].map((f) => dir + f),
    'src/ai/shadow/payment/payment-candidates.ts',
    'src/ai/shadow/payment/payment-shadow.service.ts',
  ]
  const meta = {
    at: new Date().toISOString(),
    sha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    lage: live ? 'NYA_MODELLSVAR' : 'ATERSPEL',
    modell: BETALNINGSMODELL,
    repetitions: 2,
    sourceHashes: Object.fromEntries(
      files.map((f) => [f, createHash('sha256').update(readFileSync(f)).digest('hex')]),
    ),
    forklaring:
      'Samma råa AI-bedömning före och efter ny kontroll. Återspel är utvecklingsmaterial. De 32 nya fallen skrevs före implementation, men är också syntetiska med Codex facit. Inte oberoende driftdata eller bevis för 99,1 %. Provkandidaten är ingen verkställighetstillåtelse. Textbegränsningen och all manuell rest redovisas; inga kandidater försvinner.',
    nyaFall: fresh,
  }
  const rows: Grindmatpunkt[] = []
  const observations: VerklighetslikMatpunkt[] = []
  const client = live ? new Anthropic({ maxRetries: 0, timeout: 60_000 }) : null
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
  const save = () =>
    writeFileSync(
      output,
      JSON.stringify(
        {
          ...meta,
          aterspel: { sammanfattning: sammanfattaGrindprov(replay), rader: replay },
          aldreAterspel: { sammanfattning: sammanfattaGrindprov(olderReplay), rader: olderReplay },
          nyttProv: {
            planerade: live ? 64 : 0,
            sammanfattning: sammanfattaGrindprov(rows),
            rader: rows,
            observationer: observations,
          },
          usage: {
            inputTokens: observations.reduce(
              (n, r) => n + (r.response?.usage.input_tokens ?? 0),
              0,
            ),
            outputTokens: observations.reduce(
              (n, r) => n + (r.response?.usage.output_tokens ?? 0),
              0,
            ),
            anropMedUsage: observations.filter((r) => r.response).length,
            komplett: !observations.some((r) => r.status === 'API_FEL'),
          },
        },
        null,
        2,
      ) + '\n',
    )
  save()
  let stopped = false
  if (live)
    for (let repetition = 1; repetition <= 2; repetition++) {
      for (const c of fresh) {
        const item = {
          ...c,
          bedomning: c.facit,
          forslag: c.facit.avier.length === 1 ? c.facit.avier[0]! : 'INGEN',
        }
        const observation = await mataVerklighetslikBetalning(
          item,
          'referensstod',
          repetition,
          stopped ? undefined : invoke,
        )
        observations.push(observation)
        if (observation.status === 'API_FEL') stopped = true
        const row = matGrindprov(c, observation.bedomning, repetition, observation.status)
        rows.push(row)
        process.stdout.write(
          `${repetition}/2 ${c.id}: före ${row.foreRatt ? 'rätt' : 'fel'}, efter ${row.efterRatt ? 'rätt' : 'fel'}, ${row.efter.provmatchning ? 'provkandidat' : 'manuell/oklart'}\n`,
        )
        save()
      }
    }
  process.stdout.write(
    JSON.stringify({
      aterspel: sammanfattaGrindprov(replay),
      aldreAterspel: sammanfattaGrindprov(olderReplay),
      nyttProv: sammanfattaGrindprov(rows),
    }) + '\n',
  )
  if (
    [...replay, ...olderReplay, ...rows].some(
      (r) => !r.efterRatt || r.felaktigProvmatchning || r.missadProvmatchning,
    )
  )
    process.exitCode = 1
}
if (require.main === module)
  void main().catch(() => {
    console.error(
      'Provet kunde inte slutföras. Råfel eller nycklar skrivs inte ut. Kontrollera bland annat att utfilen är ny.',
    )
    process.exitCode = 1
  })
