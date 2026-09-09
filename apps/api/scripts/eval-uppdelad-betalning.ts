/** Fristående experiment. Importeras inte av producenten och skriver aldrig till DB. */
import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { requireApiKey, verifyAnthropicKey } from './preflight-keys'
import { BetalningskorpusSchema } from '../src/ai/shadow/eval/betalningsrapport'
import { provaKandidater } from '../src/ai/shadow/payment/payment-candidates'
import {
  BETALNINGSMODELL,
  betalningsverktyg,
  byggBetalningsprompt,
  tolkaBetalningssvar,
} from '../src/ai/shadow/payment/payment-shadow.service'

import { berikaReferenser } from '../src/ai/shadow/eval/experiment-betalningsreferenser'

import {
  Bedomningssvar as Svar,
  bedomningsverktyg,
  bedomningsprompt,
  tolkaBedomning,
} from '../src/ai/shadow/eval/experiment-betalningsbedomning'
const Korpus = z.object({
  poster: BetalningskorpusSchema.innerType().shape.poster,
  bankrader: z.array(
    z.object({
      id: z.string(),
      datum: z.string().date(),
      text: z.string(),
      belopp: z.number().positive(),
      rawOcr: z.string().nullable(),
      facit: Svar,
    }),
  ),
})

async function main() {
  const dir = join(__dirname, '../src/ai/shadow/eval')
  const referensstod = process.argv.includes('--referensstod')
  const armar = referensstod
    ? (['uppdelad', 'referensstod'] as const)
    : (['befintlig', 'uppdelad'] as const)
  const raw = readFileSync(
    join(
      dir,
      referensstod ? 'korpus-referensstod-betalning.json' : 'korpus-uppdelad-betalning.json',
    ),
    'utf8',
  )
  const korpus = Korpus.parse(JSON.parse(raw))
  const poster = korpus.poster.map((p) => ({ ...p, forfallodatum: new Date(p.forfallodatum) }))
  const key = requireApiKey({
    envVar: 'ANTHROPIC_API_KEY',
    expectedPrefix: 'sk-ant-',
    whatFor: 'fristående betalningsexperiment',
  })
  await verifyAnthropicKey(key)
  const client = new Anthropic({ apiKey: key, maxRetries: 0, timeout: 60000 })
  const rader: Array<{
    kandidater: string[]
    allaFacitReferenserFinns: boolean
    id: string
    repetition: number
    arm: 'befintlig' | 'uppdelad' | 'referensstod'
    facit: z.infer<typeof Svar>
    svar: z.infer<typeof Svar> | null
    modellSvar: z.infer<typeof Svar> | null
    regel: string | null
    status: string
    identitetRatt: boolean
    hanteringRatt: boolean | null
  }> = []
  let input = 0
  let output = 0
  let fel = false
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  // Två körningar av båda armar på exakt samma fall; facit finns aldrig i prompten.
  for (let repetition = 1; repetition <= 2; repetition++) {
    for (const r of korpus.bankrader) {
      const rad = {
        id: r.id,
        datum: new Date(r.datum),
        text: r.text,
        belopp: r.belopp,
        rawOcr: r.rawOcr,
      }
      const regel = provaKandidater(rad, poster)
      if (regel.typ === 'INGEN_FRAGA')
        throw new Error('Exakt OCR ingår inte i detta modelljämförelsetest')
      const ursprungliga = regel.typ === 'KANDIDATER' ? regel.kandidater : []
      const stod = berikaReferenser(rad, poster, ursprungliga)
      for (const arm of armar) {
        const kandidater = arm === 'referensstod' ? stod.kandidater : ursprungliga
        let modellSvar: z.infer<typeof Svar> | null = null
        let svar: z.infer<typeof Svar> | null = null
        let status = 'EJ_KORD'
        if (kandidater.length === 0) {
          svar = { avier: [], hantering: 'OKLART' }
          status = 'SVAR'
        }
        if (!fel && kandidater.length > 0) {
          try {
            const tool =
              arm === 'befintlig' ? betalningsverktyg(kandidater) : bedomningsverktyg(kandidater)
            const prompt =
              arm === 'befintlig'
                ? byggBetalningsprompt(rad, kandidater)
                : bedomningsprompt(rad, kandidater)
            const response = await client.messages.create({
              model: BETALNINGSMODELL,
              max_tokens: 1024,
              temperature: 0,
              tools: [tool],
              tool_choice: { type: 'tool', name: tool.name },
              messages: [{ role: 'user', content: prompt }],
            })
            input += response.usage.input_tokens
            output += response.usage.output_tokens
            const block = response.content.find((b) => b.type === 'tool_use')
            status = 'AVVISAT'
            if (response.stop_reason !== 'max_tokens' && block?.type === 'tool_use') {
              if (arm === 'befintlig') {
                const val = tolkaBetalningssvar(block.input, kandidater)
                if (val) svar = { avier: val.avi === 'INGEN' ? [] : [val.avi], hantering: 'OKLART' }
              } else {
                svar = tolkaBedomning(block.input, kandidater)
              }
              modellSvar = svar
              if (svar && arm === 'referensstod' && stod.tvetydigtNamn)
                svar = { avier: [], hantering: 'OKLART' }
              if (svar) status = 'SVAR'
            }
          } catch {
            fel = true
            status = 'API_FEL'
          }
        }
        const identitetRatt =
          svar !== null &&
          JSON.stringify([...svar.avier].sort()) === JSON.stringify([...r.facit.avier].sort())
        rader.push({
          kandidater: kandidater.map((k) => k.id),
          allaFacitReferenserFinns: r.facit.avier.every((id) =>
            kandidater.some((k) => k.id === id),
          ),
          id: r.id,
          repetition,
          arm,
          facit: r.facit,
          svar,
          status,
          modellSvar,
          regel: arm === 'referensstod' && stod.tvetydigtNamn ? 'TVETYDIGT_NAMN' : null,
          identitetRatt,
          hanteringRatt: arm !== 'befintlig' ? svar?.hantering === r.facit.hantering : null,
        })
        console.warn(
          `${repetition}/2 ${r.id} ${arm}: ${status}, identitet ${identitetRatt ? 'rätt' : 'fel'}`,
        )
      }
    }
  }
  const sammanfattning = armar.map((arm) => {
    const rows = rader.filter((r) => r.arm === arm)
    return {
      arm,
      antal: rows.length,
      identitetRatt: rows.filter((r) => r.identitetRatt).length,
      hanteringRatt: arm !== 'befintlig' ? rows.filter((r) => r.hanteringRatt).length : null,
      heltRatt: rows.filter((r) => r.identitetRatt && r.hanteringRatt).length,
      bortfall: rows.filter((r) => r.status !== 'SVAR').length,
    }
  })
  const rapport = {
    regressioner: referensstod
      ? rader
          .filter((r) => r.arm === 'uppdelad' && r.identitetRatt && r.hanteringRatt)
          .filter(
            (fore) =>
              !rader.some(
                (efter) =>
                  efter.arm === 'referensstod' &&
                  efter.id === fore.id &&
                  efter.repetition === fore.repetition &&
                  efter.identitetRatt &&
                  efter.hanteringRatt,
              ),
          )
          .map((r) => ({ id: r.id, repetition: r.repetition }))
      : [],
    sha,
    korpusSha256: createHash('sha256').update(raw).digest('hex'),
    skapad: new Date().toISOString(),
    modell: BETALNINGSMODELL,
    input,
    output,
    uppskattadUsd: (input + output * 5) / 1e6,
    kostnadKomplett: !fel,
    kommentar:
      'Nytt identitetsmått. Inte jämförbart med originalets exekverbara en-avi-facit. Befintlig arm saknar hanteringsfält.',
    sammanfattning,
    rader,
  }
  writeFileSync(
    join(
      dir,
      referensstod
        ? 'experiment-referensstod-betalning.json'
        : 'experiment-uppdelad-betalning.json',
    ),
    JSON.stringify(rapport, null, 2) + '\n',
  )
  console.warn(JSON.stringify(sammanfattning, null, 2))
  console.warn(`Uppskattad kostnad: ${rapport.uppskattadUsd} USD`)
  if (fel) process.exitCode = 1
}
void main().catch(() => {
  console.error('Experimentet kunde inte genomföras. Ingen råfeltext eller nyckel skrivs ut.')
  process.exitCode = 1
})
