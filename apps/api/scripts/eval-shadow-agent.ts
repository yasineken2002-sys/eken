/**
 * MÄTRIGG FÖR SKUGGAGENTEN — träffgrad, frågeandel och kostnad mot en korpus.
 *
 * ── VARFÖR DEN INTE KÖRS I CI ───────────────────────────────────────────────
 *
 * Femtio riktiga modellanrop kostar pengar varje gång. Riggen körs för hand, och
 * dess resultat skrivs in i planen med DATUM och SHA — det är en mätpunkt, inte
 * en grind. Det som DÄREMOT prövas i CI är korpusens form (`korpus.spec.ts`) och
 * rapportens summering (`rapport.spec.ts`), som båda går utan ett enda anrop.
 *
 * ── DEV-NYCKELN, ALDRIG PROD-NYCKELN ────────────────────────────────────────
 *
 * CLAUDE.md: en prod-credential på en utvecklarmaskin är en onödig exponering,
 * och en skenande loop mot prod-kvoten kan stoppa riktiga kunder. Nyckeln läses
 * ur `apps/api/.env` (dev), och förhandskontrollen skiljer SAKNAS / FELFORMAD /
 * OGILTIG åt innan ett enda betalt anrop görs — samma form som
 * `knowledge:eval`.
 *
 * ── EGEN DATABAS, EGNA FÖRUTSÄTTNINGAR ──────────────────────────────────────
 *
 * Riggen skapar sin organisation, sin ägare, sin fastighet och sina ärenden, och
 * städar efter sig. Den lånar ingenting av `eken_dev`: en körning som råkar
 * lyckas för att någon annans data låg där mäter omgivningen, inte agenten.
 *
 * Kör:  cd apps/api && DATABASE_URL=…/eken_tom pnpm eval:shadow
 */
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import Anthropic from '@anthropic-ai/sdk'
import { PrismaClient } from '@prisma/client'

import { requireApiKey, verifyAnthropicKey, PreflightError } from './preflight-keys'
import {
  FORSLAG_VERKTYGSNAMN,
  byggPrompt,
  forslagsverktyg,
  tolkaVerktygsanrop,
} from '../src/ai/shadow/maintenance-shadow.service'
import { tillämpaRegler } from '../src/ai/shadow/triage-rules'
import { INGEN_ATGARD, skuggverktygForFelanmalan } from '../src/ai/shadow/shadow-tool-gate'
import { prövaDelegerbarhet } from '../src/ai/delegation/delegation-scope'
import {
  byggRapport,
  formateraRapport,
  type Facit,
  type Utfall,
} from '../src/ai/shadow/eval/rapport'

const MODEL = 'claude-haiku-4-5-20251001'
const MAX_TOKENS = 1024

/**
 * Haikus listpris per miljon token, 2026-09.
 *
 * TALEN STÅR HÄR OCH INTE I EN DELAD KONSTANT: det här är en mätning av vad EN
 * körning kostade, inte en fakturagrund. Ändras priset ska en gammal rapport
 * fortsätta säga vad den kostade då.
 */
const PRIS_IN_PER_MTOK = 1.0
const PRIS_UT_PER_MTOK = 5.0

interface KorpusArende {
  id: string
  titel: string
  beskrivning: string
  registreradKategori: string
  registreradPrioritet: string
  facit: Facit & { skal: string }
}

async function main(): Promise<void> {
  // ── FÖRHANDSKONTROLLEN, FÖRE ALLT ARBETE ──────────────────────────────────
  const nyckel = requireApiKey({
    envVar: 'ANTHROPIC_API_KEY',
    whatFor: 'mätriggen för skuggagenten (eval:shadow)',
    expectedPrefix: 'sk-ant-',
  })
  await verifyAnthropicKey(nyckel)

  const dbUrl = process.env['DATABASE_URL'] ?? ''
  if (!dbUrl) throw new PreflightError('DATABASE_URL saknas — riggen skriver riktiga ärenden.')
  if (/eken_dev\b/.test(dbUrl)) {
    // EN RIGG SOM LÅNAR OMGIVNINGENS DATA MÄTER OMGIVNINGEN. Och `eken_dev` är
    // den databas allt annat lokalt arbete använder — femtio ärenden där är
    // skräp som ligger kvar.
    throw new PreflightError(
      'Peka DATABASE_URL på en EGEN databas (t.ex. eken_tom), inte på eken_dev.',
    )
  }

  const korpus = JSON.parse(
    readFileSync(join(__dirname, '../src/ai/shadow/eval/korpus.json'), 'utf8'),
  ) as { arenden: KorpusArende[] }

  const anthropic = new Anthropic({ apiKey: nyckel })
  const prisma = new PrismaClient()
  const verktyg = skuggverktygForFelanmalan()

  const sfx = randomUUID().slice(0, 8)
  const org = await prisma.organization.create({
    data: {
      name: `eval-${sfx}`,
      email: `eval-${sfx}@example.invalid`,
      street: 'a',
      city: 'b',
      postalCode: '11111',
    },
    select: { id: true },
  })
  const prop = await prisma.property.create({
    data: {
      organizationId: org.id,
      name: 'Evalhuset',
      propertyDesignation: `EVAL ${sfx}`,
      type: 'RESIDENTIAL',
      street: 'a',
      city: 'b',
      postalCode: '11111',
      totalArea: 100,
    },
    select: { id: true },
  })

  const poster: Array<{ facit: Facit; utfall: Utfall }> = []

  try {
    for (const a of korpus.arenden) {
      // ÄRENDET SKRIVS PÅ RIKTIGT. Prompten byggs ur samma funktion som
      // produktionen använder — en kopia här hade mätt en annan prompt.
      const ticket = await prisma.maintenanceTicket.create({
        data: {
          organizationId: org.id,
          propertyId: prop.id,
          ticketNumber: `EV-${a.id}`,
          title: a.titel,
          description: a.beskrivning,
          category: a.registreradKategori as never,
          priority: a.registreradPrioritet as never,
          // NEW, inte 'OPEN' — enumen heter det senare i inget läge. Typen
          // fällde gissningen, vilket är rätt håll att fela åt.
          status: 'NEW',
        },
        select: { id: true },
      })

      const prompt = byggPrompt(
        {
          title: a.titel,
          description: a.beskrivning,
          category: a.registreradKategori,
          priority: a.registreradPrioritet,
        },
        // INGEN HISTORIK. Korpusens ärenden är fristående, och en påhittad
        // historik hade mätt hur bra agenten läser en historik jag skrev.
        [],
        verktyg,
      )

      const svar = await anthropic.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        temperature: 0,
        // BÅDA UR PRODUKTIONEN. Namnet stod först som literalen 'foresla_atgard'
        // här — och verktyget heter `lamna_forslag`. Anropet hade fallit på ett
        // fel som ser ut att handla om modellen. En rigg som bygger sitt eget
        // schema eller sitt eget namn mäter inte produktionen.
        tools: [forslagsverktyg(verktyg)],
        tool_choice: { type: 'tool', name: FORSLAG_VERKTYGSNAMN },
        messages: [{ role: 'user', content: prompt }],
      })

      const block = svar.content.find((c) => c.type === 'tool_use')
      const tolkat = block && block.type === 'tool_use' ? tolkaVerktygsanrop(block.input) : null
      const raTool =
        block && block.type === 'tool_use'
          ? ((block.input as Record<string, unknown>)['toolName'] as string | undefined)
          : undefined

      const inTok = svar.usage.input_tokens
      const utTok = svar.usage.output_tokens
      const kostnad = (inTok / 1e6) * PRIS_IN_PER_MTOK + (utTok / 1e6) * PRIS_UT_PER_MTOK

      // ── UTFALLET, MED `INGEN` SOM DET TREDJE SVARET ────────────────────────
      //
      // `tolkaVerktygsanrop` returnerar null både för INGEN_ATGARD och för ett
      // otolkbart svar. De två är olika saker, och rapporten måste kunna skilja
      // dem: det RÅA `toolName` avgör vilket.
      const atgardFöreRegler =
        tolkat?.toolName ?? (raTool === INGEN_ATGARD ? 'INGEN' : raTool ? 'OTOLKBART' : 'OTOLKBART')

      // ── PREDICTION BEHÅLLS ÄVEN NÄR SVARET ÄR INGEN_ATGARD ─────────────────
      //
      // `tolkaVerktygsanrop` returnerar null för `INGEN_ATGARD` — rätt i
      // PRODUKTIONEN, där det inte finns någon rad att skriva. I MÄTNINGEN är
      // det en tyst förlust: modellen fyllde i sin bedömning, och att kasta den
      // gör att varje förbättring av tystnadsmålet SÄNKER nämnaren för kategori
      // och prioritet. Uppmätt i körning 3: nämnaren var 50 av 52, och de två
      // som saknades var precis de två `INGEN`-svaren. Lyckas agenten med alla
      // fem tystnadsfallen mäts kategorin på fem ärenden färre.
      //
      // Koden gör redan motsatsen för FRÅGA, med samma motivering ordagrant.
      // Här läses fältet ur det råa blocket i stället, så mätningen behåller
      // datapunkten utan att produktionens semantik ändras.
      const råPrediction =
        block && block.type === 'tool_use'
          ? (((block.input as Record<string, unknown>)['prediction'] as
              | Record<string, unknown>
              | undefined) ?? {})
          : {}
      const strängEllerNull = (v: unknown): string | null =>
        typeof v === 'string' && v !== '' ? v : null
      const kat =
        (tolkat?.prediction?.['category'] as string | undefined) ??
        strängEllerNull(råPrediction['category'])
      const råPri =
        (tolkat?.prediction?.['priority'] as string | undefined) ??
        strängEllerNull(råPrediction['priority'])
      const andraKategori =
        tolkat?.andraKategori ??
        (block && block.type === 'tool_use'
          ? strängEllerNull((block.input as Record<string, unknown>)['andraKategori'])
          : null)

      // ── REGLERNA UR PRODUKTIONEN, INTE EN KOPIA HÄR ────────────────────────
      //
      // Samma skäl som `byggPrompt` och `forslagsverktyg` importeras: en rigg som
      // tillämpar sin egen version av en regel mäter sin egen version. Golvet och
      // frågeregeln körs alltså genom exakt den funktion skuggtjänsten anropar.
      const regler = tillämpaRegler(
        { atgärd: atgardFöreRegler, prioritet: råPri, kategori: kat, andraKategori },
        {
          titel: a.titel,
          beskrivning: a.beskrivning,
          registreradKategori: a.registreradKategori,
        },
      )
      const atgard = regler.atgärd
      const pri = regler.prioritet
      const utanModell = tillämpaRegler(
        {
          atgärd: atgardFöreRegler,
          prioritet: a.registreradPrioritet,
          kategori: kat,
          andraKategori,
        },
        {
          titel: a.titel,
          beskrivning: a.beskrivning,
          registreradKategori: a.registreradKategori,
        },
      )

      // TORRLÄGETS DOM: hade en delegation för verktyget kunnat bära det här?
      // Räknas för verktygsförslag, inte för INGEN eller FRAGA — de utför inget.
      const domWouldExecute =
        atgard !== 'INGEN' && atgard !== 'FRAGA' && atgard !== 'OTOLKBART'
          ? prövaDelegerbarhet(atgard).delegerbar
          : false

      poster.push({
        facit: a.facit,
        utfall: {
          id: a.id,
          atgard,
          kategori: kat,
          prioritet: pri,
          confidence: tolkat?.confidence ?? null,
          fragaFalt: regler.fråga?.fält ?? tolkat?.fraga?.fält ?? null,
          // VAD REGLERNA GJORDE, per ärende. Utan de två fälten går det inte att
          // i efterhand skilja modellens svar från regelns — och då mäter nästa
          // körning två saker som ser ut som en.
          atgardForeRegler: atgardFöreRegler,
          prioritetForeRegler: råPri,
          // DEN DETERMINISTISKA KONTROLLEN: samma golv, men med ärendets
          // REGISTRERADE prioritet i stället för modellens. Utan den går det
          // inte att svara på om modellen ens tjänar sitt tokenpris — se
          // `rapport.ts`. Den kostar noll extra anrop: samma rena funktion,
          // annan indata.
          prioritetUtanModell: utanModell.prioritet ?? undefined,
          domWouldExecute,
          kostnadUsd: kostnad,
          inTokens: inTok,
          utTokens: utTok,
        },
      })

      const märke = markeraTraff(a.facit, atgard)
      process.stderr.write(`${a.id} ${märke} ${atgard.padEnd(26)} ${kat ?? '-'}/${pri ?? '-'}\n`)
      await prisma.maintenanceTicket.delete({ where: { id: ticket.id } })
    }
  } finally {
    await prisma.maintenanceTicket.deleteMany({ where: { organizationId: org.id } })
    await prisma.property.deleteMany({ where: { organizationId: org.id } })
    await prisma.organization.deleteMany({ where: { id: org.id } })
    await prisma.$disconnect()
  }

  const rapport = byggRapport(poster)
  const text = formateraRapport(rapport)
  process.stdout.write(`\n${text}\n`)

  const ut = join(__dirname, '../src/ai/shadow/eval/senaste-korning.json')
  writeFileSync(ut, `${JSON.stringify({ rapport, poster }, null, 2)}\n`)
  process.stderr.write(`\nRådata: ${ut}\n`)
}

function markeraTraff(f: Facit, atgard: string): string {
  const rätt = f.fragaRatt ? atgard === 'FRAGA' : atgard === f.atgard
  return rätt ? '✓' : '✗'
}

main().catch((err: unknown) => {
  if (err instanceof PreflightError) {
    process.stderr.write(`\n${err.message}\n\n`)
    process.exit(1)
  }
  process.stderr.write(`\n${err instanceof Error ? err.stack : String(err)}\n`)
  process.exit(1)
})
