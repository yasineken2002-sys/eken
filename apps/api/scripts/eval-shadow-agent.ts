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
import { TOMT_REGISTER_ALTERNATIV, hantverkarmeny } from '../src/ai/shadow/contractor-menu'
import { INGEN_ATGARD, skuggverktygForFelanmalan } from '../src/ai/shadow/shadow-tool-gate'
import { prövaDelegerbarhet } from '../src/ai/delegation/delegation-scope'
import {
  provaKandidater,
  beloppsutfall,
  type Kandidat,
} from '../src/ai/shadow/payment/payment-candidates'
import {
  betalningsverktyg,
  byggBetalningsprompt,
  tolkaBetalningssvar,
} from '../src/ai/shadow/payment/payment-shadow.service'
import { INGEN_AVI } from '../src/ai/shadow/payment/payment-fields'
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

interface Hantverkare {
  id: string
  name: string
  categories: string[]
}

interface KorpusArende {
  id: string
  titel: string
  beskrivning: string
  registreradKategori: string
  registreradPrioritet: string
  facit: Facit & { skal: string }
}

/**
 * RIGGENS ANDRA LÄGE — AGENT 2, "PENGAR IN".
 *
 * ── VARFÖR DET INTE BEHÖVER EN DATABAS ──────────────────────────────────────
 *
 * Felanmälans läge skriver riktiga ärenden, därför att producenten läser dem
 * genom Prisma. Betalningsläget behöver ingen: `provaKandidater` är en ren
 * funktion och `byggBetalningsprompt` tar sina kandidater som argument. Riggen
 * matar alltså korpusens poster direkt, och det är inte en genväg utan samma
 * gräns som produktionskoden drar — reglerna vet ingenting om databasen.
 *
 * ── TVÅ HALVOR, OCH BARA DEN ENA KOSTAR PENGAR ──────────────────────────────
 *
 * `--utan-modell` kör bara regelhalvan: kandidatmängd, recall och de fall
 * reglerna avgör ensamma. Den kostar noll och kräver ingen nyckel. Hela
 * ablationen är regelhalvan MOT regel+modell, och att den nedre halvan går att
 * köra gratis betyder att baslinjen inte kan ruttna mellan två betalda
 * körningar. Regelhalvan mäts dessutom i CI av `korpus-betalningar.spec.ts`.
 */
async function körBetalningsläget(utanModell: boolean): Promise<void> {
  const korpus = JSON.parse(
    readFileSync(join(__dirname, '../src/ai/shadow/eval/korpus-betalningar.json'), 'utf8'),
  ) as {
    poster: Array<{
      id: string
      sort: 'AVI' | 'FAKTURA'
      nummer: string
      ocr: string
      utestaende: number
      forfallodatum: string
      motpartId: string
      motpartNamn: string
    }>
    bankrader: Array<{
      id: string
      datum: string
      text: string
      belopp: number
      rawOcr: string | null
      facit: {
        avi: string
        belopp: 'FULL' | 'DEL'
        motpart: string
        grupp: string
        skal: string
        regel?: string
      }
    }>
  }

  const kandidater: Kandidat[] = korpus.poster.map((p) => ({
    id: p.id,
    sort: p.sort,
    nummer: p.nummer,
    ocr: p.ocr,
    utestaende: p.utestaende,
    forfallodatum: new Date(p.forfallodatum),
    motpartId: p.motpartId,
    motpartNamn: p.motpartNamn,
  }))

  let anthropic: Anthropic | null = null
  if (!utanModell) {
    const nyckel = requireApiKey({
      envVar: 'ANTHROPIC_API_KEY',
      whatFor: 'mätriggen för agent 2 (eval:shadow --betalningar)',
      expectedPrefix: 'sk-ant-',
    })
    await verifyAnthropicKey(nyckel)
    anthropic = new Anthropic({ apiKey: nyckel })
  }

  type Utfall = {
    id: string
    grupp: string
    regelTyp: string
    antalKandidater: number
    rättPostIMängden: boolean | null
    svar: string | null
    facitAvi: string
    träff: boolean | null
    beloppSvar: string | null
    beloppTräff: boolean | null
  }
  const utfall: Utfall[] = []
  let tokensIn = 0
  let tokensUt = 0

  for (const r of korpus.bankrader) {
    const rad = {
      id: r.id,
      datum: new Date(r.datum),
      text: r.text,
      belopp: r.belopp,
      rawOcr: r.rawOcr,
    }
    const regel = provaKandidater(rad, kandidater)
    const iMängden =
      r.facit.avi === INGEN_AVI
        ? null
        : regel.typ === 'KANDIDATER' && regel.kandidater.some((k) => k.id === r.facit.avi)

    if (regel.typ !== 'KANDIDATER') {
      // REGELN AVGJORDE. Ett INGEN_FRAGA är en kontroll; ett INGEN är ett svar.
      const svar = regel.typ === 'INGEN' ? INGEN_AVI : null
      utfall.push({
        id: r.id,
        grupp: r.facit.grupp,
        regelTyp: regel.typ,
        antalKandidater: 0,
        rättPostIMängden: iMängden,
        svar,
        facitAvi: r.facit.avi,
        träff: svar === null ? null : svar === r.facit.avi,
        beloppSvar: null,
        beloppTräff: null,
      })
      continue
    }

    if (!anthropic) {
      utfall.push({
        id: r.id,
        grupp: r.facit.grupp,
        regelTyp: regel.typ,
        antalKandidater: regel.kandidater.length,
        rättPostIMängden: iMängden,
        svar: null,
        facitAvi: r.facit.avi,
        träff: null,
        beloppSvar: null,
        beloppTräff: null,
      })
      continue
    }

    const svarM = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      temperature: 0,
      tools: [betalningsverktyg(regel.kandidater)],
      tool_choice: { type: 'tool', name: 'valj_avi' },
      messages: [{ role: 'user', content: byggBetalningsprompt(rad, regel.kandidater) }],
    })
    tokensIn += svarM.usage.input_tokens
    tokensUt += svarM.usage.output_tokens
    const block = svarM.content.find((b) => b.type === 'tool_use')
    const tolkat =
      block && block.type === 'tool_use' ? tolkaBetalningssvar(block.input, regel.kandidater) : null
    // OTOLKBART SKRIVS UT RÅTT — samma lärdom som felanmälans läge: utan
    // råsvaret går det inte att avgöra VARFÖR nästa gång det händer.
    if (!tolkat && block && block.type === 'tool_use') {
      console.warn(`  OTOLKBART ${r.id}: ${JSON.stringify(block.input)}`)
    }
    const vald = tolkat ? regel.kandidater.find((k) => k.id === tolkat.avi) : undefined
    const beloppSvar = vald ? beloppsutfall(rad.belopp, vald.utestaende) : null
    utfall.push({
      id: r.id,
      grupp: r.facit.grupp,
      regelTyp: regel.typ,
      antalKandidater: regel.kandidater.length,
      rättPostIMängden: iMängden,
      svar: tolkat ? tolkat.avi : null,
      facitAvi: r.facit.avi,
      träff: tolkat ? tolkat.avi === r.facit.avi : null,
      beloppSvar,
      beloppTräff: beloppSvar === null ? null : beloppSvar === r.facit.belopp,
    })
  }

  // ── RAPPORTEN ─────────────────────────────────────────────────────────────
  const kontroller = utfall.filter((u) => u.regelTyp === 'INGEN_FRAGA')
  const modellfall = utfall.filter((u) => u.regelTyp === 'KANDIDATER')
  const regelnej = utfall.filter((u) => u.regelTyp === 'INGEN')

  console.warn('')
  console.warn(`KORPUS: ${korpus.bankrader.length} bankrader mot ${korpus.poster.length} poster`)
  console.warn(`  regeln svarade INGEN_FRAGA (kontroll)   ${kontroller.length}`)
  console.warn(`  regeln svarade INGEN (utan modellanrop) ${regelnej.length}`)
  console.warn(`  gick till modellen                      ${modellfall.length}`)

  // ── NÄMNAREN UTESLUTER KONTROLLERNA, OCH DET ÄR EN RÄTTELSE ─────────────
  //
  // Första versionen räknade `rättPostIMängden !== null`, alltså varje rad vars
  // facit pekar på en post. Det tog med de fyra `exakt_ocr`-KONTROLLERNA, som
  // per konstruktion aldrig når kandidatmängden — regeln svarar INGEN_FRAGA och
  // avstämningen tar raden. De räknades därför som recall-MISSAR, och riggen
  // skrev 19/23 = 82,6 % när den verkliga recallen var 19/19.
  //
  // Felformen är värd att namnge: ett tal som ser lågt och trovärdigt ut. Ingen
  // hade ifrågasatt 82,6 %. Det upptäcktes bara genom att provet i
  // `korpus-betalningar.spec.ts` — som har rätt nämnare — sa 100 % samtidigt.
  // Två uppräkningar av samma mängd är inte en uppräkning.
  const medPost = utfall.filter((u) => u.rättPostIMängden !== null && u.regelTyp !== 'INGEN_FRAGA')
  const recall = medPost.filter((u) => u.rättPostIMängden === true).length
  console.warn('')
  console.warn(
    `RECALL (rätt post fanns bland kandidaterna): ${recall}/${medPost.length}` +
      ` — ${((100 * recall) / Math.max(1, medPost.length)).toFixed(1)} %`,
  )

  const regelnejRätt = regelnej.filter((u) => u.träff === true).length
  console.warn(
    `REGELN ENSAM (INGEN utan modellanrop): ${regelnejRätt}/${regelnej.length} rätt` +
      ` — ${((100 * regelnejRätt) / Math.max(1, regelnej.length)).toFixed(1)} %`,
  )

  if (anthropic) {
    const besvarade = modellfall.filter((u) => u.träff !== null)
    const rätt = besvarade.filter((u) => u.träff).length
    const belopp = modellfall.filter((u) => u.beloppTräff !== null)
    const beloppRätt = belopp.filter((u) => u.beloppTräff).length
    console.warn('')
    console.warn(
      `MODELLEN (avi): ${rätt}/${besvarade.length}` +
        ` — ${((100 * rätt) / Math.max(1, besvarade.length)).toFixed(1)} %`,
    )
    console.warn(
      `MODELLEN (belopp FULL/DEL): ${beloppRätt}/${belopp.length}` +
        ` — ${((100 * beloppRätt) / Math.max(1, belopp.length)).toFixed(1)} %`,
    )
    const helaKedjan = utfall.filter((u) => u.svar !== null)
    const kedjaRätt = helaKedjan.filter((u) => u.träff).length
    console.warn(
      `HELA KEDJAN (regel + modell): ${kedjaRätt}/${helaKedjan.length}` +
        ` — ${((100 * kedjaRätt) / Math.max(1, helaKedjan.length)).toFixed(1)} %`,
    )
    const kostnad = (tokensIn / 1e6) * PRIS_IN_PER_MTOK + (tokensUt / 1e6) * PRIS_UT_PER_MTOK
    console.warn('')
    console.warn(`KOSTNAD: ${tokensIn} in + ${tokensUt} ut ≈ $${kostnad.toFixed(4)}`)
  } else {
    console.warn('')
    console.warn('MODELLHALVAN HOPPADES ÖVER (--utan-modell). Talen ovan är regelhalvan ensam.')
  }

  console.warn('')
  console.warn('PER GRUPP')
  const grupper = [...new Set(utfall.map((u) => u.grupp))].sort()
  for (const g of grupper) {
    const rader = utfall.filter((u) => u.grupp === g)
    const svarade = rader.filter((u) => u.träff !== null)
    const rätt = svarade.filter((u) => u.träff).length
    console.warn(
      `  ${g.padEnd(18)} ${String(rader.length).padStart(2)} rader · ` +
        (svarade.length === 0
          ? 'inget svar (kontroll eller modellhalvan avstängd)'
          : `${rätt}/${svarade.length} rätt`),
    )
  }
}

async function main(): Promise<void> {
  // ── ANDRA LÄGET: AGENT 2 ──────────────────────────────────────────────────
  if (process.argv.includes('--betalningar')) {
    await körBetalningsläget(process.argv.includes('--utan-modell'))
    return
  }

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
  ) as { arenden: KorpusArende[]; hantverkarregister: Hantverkare[] }

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

  // ── HANTVERKARREGISTRET SKRIVS PÅ RIKTIGT ─────────────────────────────────
  //
  // Riggen bygger menyn ur samma väg som produktionen (`hantverkarmeny` över en
  // Prisma-läsning), inte ur korpusens JSON direkt. Korpusens id:n (`h-ror` …)
  // är därför FIXTURNYCKLAR som mappas till riktiga rad-id:n, och facit
  // översätts på samma sätt. En rigg som skickade korpus-id:n rakt in hade mätt
  // en meny produktionen aldrig bygger.
  const idKarta = new Map<string, string>()
  for (const h of korpus.hantverkarregister) {
    const rad = await prisma.contractor.create({
      data: {
        organizationId: org.id,
        name: h.name,
        categories: h.categories as never,
      },
      select: { id: true },
    })
    idKarta.set(h.id, rad.id)
  }
  /** Facitens fixturnyckel → radens riktiga id. */
  const riktigtId = (fixtur: string | undefined): string | undefined =>
    fixtur === undefined ? undefined : idKarta.get(fixtur)

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

      // MENYN UR PRODUKTIONENS EGEN FUNKTION, byggd på ärendets kategori.
      const register = await prisma.contractor.findMany({
        where: { organizationId: org.id, isActive: true },
        select: { id: true, name: true, categories: true },
        orderBy: { name: 'asc' },
      })
      const meny = hantverkarmeny(register as never, a.registreradKategori as never)

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
        meny,
      )

      const svar = await anthropic.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        temperature: 0,
        // BÅDA UR PRODUKTIONEN. Namnet stod först som literalen 'foresla_atgard'
        // här — och verktyget heter `lamna_forslag`. Anropet hade fallit på ett
        // fel som ser ut att handla om modellen. En rigg som bygger sitt eget
        // schema eller sitt eget namn mäter inte produktionen.
        tools: [forslagsverktyg(verktyg, meny)],
        tool_choice: { type: 'tool', name: FORSLAG_VERKTYGSNAMN },
        messages: [{ role: 'user', content: prompt }],
      })

      const block = svar.content.find((c) => c.type === 'tool_use')
      const dynamisktRegister =
        meny.length > 0 ? meny.map((m) => m.id) : [...TOMT_REGISTER_ALTERNATIV]
      const tolkat =
        block && block.type === 'tool_use'
          ? tolkaVerktygsanrop(block.input, dynamisktRegister)
          : null
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
        { atgärd: atgardFöreRegler, kategori: kat, andraKategori },
        {
          titel: a.titel,
          beskrivning: a.beskrivning,
          registreradKategori: a.registreradKategori,
          registreradPrioritet: a.registreradPrioritet,
        },
      )
      const atgard = regler.atgärd
      const pri = regler.prioritet
      // ── UTMANAREN: SAMMA REGLER, MEN MED MODELLENS PRIORITET SOM INDATA ────
      //
      // Fram till körning 6 var det HÄR det byggda och raden ovan kontrollen.
      // Sedan prioriteten sätts av regel är rollerna ombytta, och den här
      // körningen finns kvar för att beslutet ska gå att falsifiera: slår den
      // raden ovan ska bortkopplingen omprövas. Den kostar noll extra anrop —
      // samma rena funktion, annan indata.
      const medModell =
        råPri === null
          ? null
          : tillämpaRegler(
              { atgärd: atgardFöreRegler, kategori: kat, andraKategori },
              {
                titel: a.titel,
                beskrivning: a.beskrivning,
                registreradKategori: a.registreradKategori,
                registreradPrioritet: råPri,
              },
            )

      // TORRLÄGETS DOM: hade en delegation för verktyget kunnat bära det här?
      // Räknas för verktygsförslag, inte för INGEN eller FRAGA — de utför inget.
      const domWouldExecute =
        atgard !== 'INGEN' && atgard !== 'FRAGA' && atgard !== 'OTOLKBART'
          ? prövaDelegerbarhet(atgard).delegerbar
          : false

      // FACIT ÖVERSÄTTS till radens riktiga id, annars jämförs en fixturnyckel
      // med ett UUID och tilldelningsträffen blir noll av en mätartefakt.
      const facitMedRiktigtId: Facit = {
        ...a.facit,
        ...(a.facit.assignedContractorId
          ? { assignedContractorId: riktigtId(a.facit.assignedContractorId) ?? '(okänd fixtur)' }
          : {}),
      }
      const föreslagenHantverkare =
        (tolkat?.prediction?.['assignedContractorId'] as string | undefined) ??
        strängEllerNull(råPrediction['assignedContractorId'])

      poster.push({
        facit: facitMedRiktigtId,
        utfall: {
          id: a.id,
          atgard,
          kategori: kat,
          prioritet: pri,
          ...(föreslagenHantverkare ? { assignedContractorId: föreslagenHantverkare } : {}),
          confidence: tolkat?.confidence ?? null,
          fragaFalt: regler.fråga?.fält ?? tolkat?.fraga?.fält ?? null,
          // VAD REGLERNA GJORDE, per ärende. Utan de två fälten går det inte att
          // i efterhand skilja modellens svar från regelns — och då mäter nästa
          // körning två saker som ser ut som en.
          atgardForeRegler: atgardFöreRegler,
          prioritetForeRegler: råPri,
          // UTMANAREN, och ärendets egen registrerade prioritet — reglernas
          // indata. Båda sparas per ärende, så rapporten kan summera dem utan
          // att läsa korpusen, och så en gammal körning går att läsa om.
          ...(medModell ? { prioritetMedModell: medModell.prioritet } : {}),
          registreradPrioritet: a.registreradPrioritet,
          // ANDRAHANDSVALET SPARAS. Utan det går det inte att i efterhand skilja
          // "regeln avstod" från "modellen gav inget att bygga frågan av" — och
          // det var precis den tvetydigheten som gjorde regeln död utan att
          // något blev rött.
          ...(andraKategori ? { andraKategori } : {}),
          domWouldExecute,
          kostnadUsd: kostnad,
          inTokens: inTok,
          utTokens: utTok,
        },
      })

      // ── OTOLKBART ÄR TVÅ FEL MED SAMMA NAMN ─────────────────────────────
      //
      // `tolkaVerktygsanrop` returnerar null både för ett struntsvar och för en
      // fråga som `ärGiltigFråga` avvisade — och de kräver helt olika åtgärder.
      // Uppmätt i körning 9: `k47` och `k57` gav båda giltiga FRÅGOR i körning 8
      // och OTOLKBART i 9, och orsaken gick inte att avgöra i efterhand: riggen
      // sparade bara etiketten.
      //
      // Det RÅA svaret skrivs därför ut när tolkningen faller. En rad i loggen
      // kostar ingenting och är skillnaden mellan "vi vet inte" och ett svar.
      if (atgardFöreRegler === 'OTOLKBART') {
        process.stderr.write(
          `   ↳ OTOLKBART råsvar: toolName=${JSON.stringify(raTool)} ` +
            `fraga=${JSON.stringify((block as { input?: Record<string, unknown> })?.input?.['fraga'])} ` +
            `toolInput=${JSON.stringify((block as { input?: Record<string, unknown> })?.input?.['toolInput'])}\n`,
        )
      }

      const märke = markeraTraff(a.facit, atgard)
      process.stderr.write(`${a.id} ${märke} ${atgard.padEnd(26)} ${kat ?? '-'}/${pri ?? '-'}\n`)
      await prisma.maintenanceTicket.delete({ where: { id: ticket.id } })
    }
  } finally {
    await prisma.maintenanceTicket.deleteMany({ where: { organizationId: org.id } })
    await prisma.contractor.deleteMany({ where: { organizationId: org.id } })
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
