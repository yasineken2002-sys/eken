/** Återspel av frysta bankögonblick. Standardläget planerar och gör noll API-anrop. */
import 'reflect-metadata'
import Anthropic from '@anthropic-ai/sdk'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Bankrad, Kandidat } from '../src/ai/shadow/payment/payment-candidates'
import { provaKandidater } from '../src/ai/shadow/payment/payment-candidates'
import {
  BETALNINGSMODELL,
  BETALNING_MAX_TOKENS,
} from '../src/ai/shadow/payment/payment-shadow.service'
import { skapaKundflode } from '../src/ai/shadow/eval/kundflode-2000'
import type { Testbetalning } from '../src/ai/shadow/eval/kundflode-2000'
import type { Betalningsbedomning } from '../src/ai/shadow/eval/experiment-betalningsbedomning'
import { granskaBetalningsbedomning } from '../src/ai/shadow/eval/experiment-betalningsgrind'
import { berikaReferenser } from '../src/ai/shadow/eval/experiment-betalningsreferenser'
import {
  mataVerklighetslikBetalning,
  sammanfattaVerklighetslikaBetalningar,
  type Provanrop,
  type VerklighetslikMatpunkt,
} from '../src/ai/shadow/eval/verklighetslik-betalningsmatning'

interface SparadRad {
  id: string
  typ: Testbetalning['typ']
  status: string
  felaktigAutomatisk?: boolean
  bankrad: Omit<Bankrad, 'datum'> & { datum: string }
  underlag?: {
    kandidater: (Omit<Kandidat, 'forfallodatum'> & { forfallodatum: string })[]
    takNått: boolean
  }
}

const MAX_ANROP = 220
const ARMAR = ['befintlig', 'referensstod'] as const
const hash = (s: string | Buffer) => createHash('sha256').update(s).digest('hex')

async function main() {
  const source = resolve(process.argv[2] ?? '')
  const output = resolve(process.argv[3] ?? '/tmp/kundflode-modell-plan.json')
  const live = process.env.EVAL_BANK2000_LIVE === '1'
  const orakel = process.argv.includes('--orakelkontroll')
  // Facit får bara matas till den lokala kontrollen, aldrig till ett modellanrop.
  if (live && orakel) throw new Error('Orakelkontroll får inte kombineras med modellkörning')
  if (existsSync(output)) throw new Error('Rapporten finns redan')
  if (live && !process.env.ANTHROPIC_API_KEY) throw new Error('Utvecklingsnyckel saknas')
  const saved = JSON.parse(readFileSync(resolve(source, 'AGENT_PA.json'), 'utf8')) as {
    arm: string
    sha: string
    datamixUppmattHosKund: boolean
    rader: SparadRad[]
  }
  const world = skapaKundflode()
  if (
    saved.arm !== 'AGENT_PA' ||
    saved.datamixUppmattHosKund !== false ||
    saved.rader.length !== 2000 ||
    new Set(saved.rader.map((r) => r.id)).size !== 2000 ||
    saved.rader.some((r) => !world.betalningar.some((p) => p.id === r.id)) ||
    JSON.stringify(JSON.parse(readFileSync(resolve(source, 'kund-och-facit.json'), 'utf8'))) !==
      JSON.stringify(world)
  )
    throw new Error('Underlaget är inte det frysta syntetiska kundflödet')
  const pending = saved.rader.filter((r) => r.status !== 'MATCHED' || r.felaktigAutomatisk)
  if (pending.length !== 110 || pending.some((r) => !r.underlag || r.underlag.takNått))
    throw new Error('Urvalet eller dess fullständighet har ändrats')
  // Facit mappas för bedömningen, aldrig för kandidatval eller modellens prompt.
  const cases = pending.map((r) => {
    const gold = world.betalningar.find((p) => p.id === r.id)!
    const poster = r.underlag!.kandidater.map((p) => ({
      ...p,
      forfallodatum: new Date(p.forfallodatum),
    }))
    const avinummer = world.avier.find((n) => n.id === gold.facit.avseddAvi)!.nummer
    const avsedd = poster.filter((p) => p.nummer === avinummer)
    const oklar = ['INGEN_IDENTIFIERARE', 'MOTSTRIDIGA_IDENTIFIERARE'].includes(r.typ)
    if (!oklar && avsedd.length !== 1) throw new Error('Avsedd avi saknas i sparat underlag')
    const bedomning: Betalningsbedomning = oklar
      ? { avier: [], hantering: 'OKLART' }
      : {
          avier: [avsedd[0]!.id],
          hantering: r.typ === 'OVERBETALNING' ? 'OVERSKOTT' : 'FULL',
        }
    return {
      id: r.id,
      scenario: r.typ,
      poster,
      rad: { ...r.bankrad, datum: new Date(r.bankrad.datum) },
      forslag: oklar ? 'INGEN' : avsedd[0]!.id,
      bedomning,
      granskningKravs: gold.facit.granskningKravsAvUnderlaget,
    }
  })
  const files = [
    'scripts/eval-kundflode-modell.ts',
    'src/ai/shadow/eval/kundflode-2000.ts',
    'src/ai/shadow/eval/verklighetslik-betalningsmatning.ts',
    'src/ai/shadow/eval/experiment-betalningsbedomning.ts',
    'src/ai/shadow/eval/experiment-betalningsreferenser.ts',
    'src/ai/shadow/eval/experiment-betalningsgrind.ts',
    'src/ai/shadow/payment/payment-candidates.ts',
    'src/ai/shadow/payment/payment-shadow.service.ts',
  ]
  const meta = {
    at: new Date().toISOString(),
    sha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    workingTreeChanged: Boolean(execFileSync('git', ['status', '--porcelain']).length),
    sourceSha: saved.sha,
    sourceHashes: Object.fromEntries(files.map((f) => [f, hash(readFileSync(f))])),
    inputHashes: Object.fromEntries(
      ['AGENT_PA.json', 'kund-och-facit.json'].map((f) => [
        f,
        hash(readFileSync(resolve(source, f))),
      ]),
    ),
    modell: BETALNINGSMODELL,
    maxAnrop: MAX_ANROP,
    maxSvarstokensPerAnrop: BETALNING_MAX_TOKENS,
    planeradeObservationer: cases.length * ARMAR.length,
    syntetiskt: true,
    automatiskVerkstallning: false,
    lage: orakel ? 'ORAKELKONTROLL' : live ? 'MODELL' : 'PLAN',
    hypotetisktPerfektForslag: orakel,
    begransning:
      'Frysta underlag före import. Inga framtida data. Fristående förslagsmätning; kö, skuggjobbsbehörighet och återkopplad bokföring körs inte. En modellbedömning är inte en automatisk betalning. Facit eller scenario ingår aldrig i request.',
  }
  let calls = 0
  let stopped = false
  const observations: VerklighetslikMatpunkt[] = []
  const guards: {
    id: string
    granskningKravs: boolean
    korrektProvmatchning: boolean
    kontroll: ReturnType<typeof granskaBetalningsbedomning>
  }[] = []
  const client = live ? new Anthropic({ maxRetries: 0, timeout: 45_000 }) : null
  const invoke: Provanrop | undefined = client
    ? async (request) => {
        if (calls >= MAX_ANROP) throw new Error('Anropstaket nått')
        calls++
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
          anrop: calls,
          avbrutet: stopped,
          aterstar: cases.length * ARMAR.length - observations.length,
          sammanfattning: sammanfattaVerklighetslikaBetalningar(observations),
          grind: {
            antal: guards.length,
            provmatchningar: guards.filter((g) => g.kontroll.provmatchning).length,
            korrektaProvmatchningar: guards.filter((g) => g.korrektProvmatchning).length,
            felaktigaProvmatchningar: guards.filter(
              (g) => g.kontroll.provmatchning && !g.korrektProvmatchning,
            ).length,
            rader: guards,
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
            fullstandig: !stopped,
          },
          rader: observations,
        },
        null,
        2,
      ) + '\n',
    )
  save()
  for (const item of cases) {
    for (const arm of ARMAR) {
      const row = await mataVerklighetslikBetalning(item, arm, 1, stopped ? undefined : invoke)
      observations.push(row)
      if (row.status === 'API_FEL') stopped = true
      if (arm === 'referensstod') {
        const regel = provaKandidater(item.rad, item.poster)
        const kandidater = berikaReferenser(
          item.rad,
          item.poster,
          regel.typ === 'KANDIDATER' ? regel.kandidater : [],
        ).kandidater
        const kontroll = granskaBetalningsbedomning(
          item.rad,
          item.poster,
          kandidater,
          orakel ? item.bedomning : row.bedomning,
          true,
        )
        guards.push({
          id: item.id,
          granskningKravs: item.granskningKravs,
          korrektProvmatchning:
            Boolean(kontroll.provmatchning) &&
            !item.granskningKravs &&
            kontroll.provmatchning!.avi === item.bedomning.avier[0] &&
            kontroll.provmatchning!.beloppOre === String(Math.round(item.rad.belopp * 100)),
          kontroll,
        })
      }
      save()
      process.stdout.write(
        `${observations.length}/${meta.planeradeObservationer} ${item.id} ${arm}: ${row.status}\n`,
      )
    }
  }
  process.stdout.write(
    JSON.stringify({
      lage: meta.lage,
      anrop: calls,
      sammanfattning: sammanfattaVerklighetslikaBetalningar(observations),
    }) + '\n',
  )
  if (live && (stopped || observations.some((r) => ['EJ_KORD', 'AVVISAT'].includes(r.status))))
    process.exitCode = 2
}

if (require.main === module)
  void main().catch(() => {
    console.error(
      'Kundflödets modellprov kunde inte slutföras. Inga nycklar eller råfel skrivs ut.',
    )
    process.exitCode = 2
  })
