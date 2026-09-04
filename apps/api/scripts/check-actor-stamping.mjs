#!/usr/bin/env node
/**
 * AKTÖRSSTÄMPLINGENS PÅKOPPLING — den farligaste tystnaden i G1 steg 3.
 *
 * ── VARFÖR DEN HÄR VAKTEN FINNS ─────────────────────────────────────────────
 *
 * `actorKind` är NULLBAR, och NULL betyder OKÄNT. Det gör ett TOTALT HAVERI
 * omöjligt att skilja från ett normalt gammalt dataläge: kopplas extensionen
 * bort får varje ny rad NULL, och NULL är ett giltigt värde. Ingen befintlig
 * kontroll kan se det — sviten är grön, typerna stämmer, inget kastar.
 *
 * ── VAD DEN MÄTER ───────────────────────────────────────────────────────────
 *
 *   R1  mekanismen finns, och PrismaService kopplar på den med returvärdet taget
 *   R2  modellmängden HÄRLEDS ur schemat (DMMF), inte ur en lista i koden
 *   R3  de tre gränserna finns, och det finns inga FLER — härlett ur källkoden
 *   R4  ingen produktionskod sätter `actorKind:` för hand
 *   R5  NULL-svepet finns och läser brytpunkten ur kontextfilen
 *
 * ── VAD DEN INTE KAN SE ─────────────────────────────────────────────────────
 *
 * Att stämplingen faktiskt HAMNAR i databasen. Den läser källtext och mäter att
 * mekanismen är PÅKOPPLAD; en runtime-no-op — extensionen returnerar `args`
 * orört, kontexten sätts men töms direkt — är osynlig här. Det ägs av
 * `actor-stamp.db.spec.ts`, som skriver genom var och en av de tre gränserna
 * mot riktig Postgres och kräver rätt stämpel.
 *
 * Kör med `--self-test` för kanariefåglarna.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  blankComments,
  codeMask,
  kanariefåglar,
  KANARIEFÅGEL_LÄGEN,
} from '../../../scripts/lib/source-scan.mjs'

const HÄR = dirname(fileURLToPath(import.meta.url))
const API = join(HÄR, '..')
const SRC = join(API, 'src')

const EXT_FIL = join(SRC, 'common/prisma/actor-stamp-extension.ts')
const PRISMA_FIL = join(SRC, 'common/prisma/prisma.service.ts')
const KONTEXT_FIL = join(SRC, 'common/actor/actor.context.ts')
const SVEP_FIL = join(SRC, 'common/actor/actor-null-sweep.service.ts')
const SCHEMA_FIL = join(API, 'prisma/schema.prisma')

/** De tre gränserna, och INGA FLER. Fler eller färre ska fälla. */
const GRÄNSER = ['HUMAN', 'SYSTEM', 'AGENT']

function allaKällfiler(dir = SRC) {
  return readdirSync(dir).flatMap((namn) => {
    const full = join(dir, namn)
    if (statSync(full).isDirectory()) return allaKällfiler(full)
    return full.endsWith('.ts') && !full.endsWith('.spec.ts') ? [full] : []
  })
}

export function evaluate({ extText, prismaText, kontextText, svepText, schemaText, källor }) {
  const problem = []
  const säg = (rule, detail) => problem.push({ rule, detail })

  // ── R1 — mekanismen finns och är PÅKOPPLAD ────────────────────────────────
  if (!extText.includes('export const actorStampExtension')) {
    säg('actorStampExtension saknas', 'Mekanismen finns inte.')
  }
  // ── VARFÖR DET INTE RÄCKER ATT NAMNET FÖREKOMMER ──────────────────────────
  //
  // Första versionen frågade `prismaText.includes('actorStampExtension')`.
  // Uppmätt negativ kontroll: med `.$extends(actorStampExtension)` BORTTAGET —
  // men importraden kvar — var vakten GRÖN. Den mätte att filen NÄMNER
  // mekanismen, inte att den kopplar på den, och importen ensam räckte.
  //
  // Det är precis den defekt CLAUDE.md beskriver: ett villkor som frågar efter
  // en förekomst i stället för efter en HANDLING. Regeln kräver därför anropet,
  // på KOD-vyn så att en kommentar som nämner det inte duger.
  const prismaKod = codeMask(prismaText)
  if (!/\$extends\(\s*actorStampExtension\s*\)/.test(prismaKod)) {
    säg(
      'PrismaService kopplar inte på actorStampExtension',
      'Utan påkoppling stämplas ingenting — och NULL är ett GILTIGT värde, så ' +
        'ett totalt haveri ser ut som gammalt data. Det är hela skälet till vakten. ' +
        '(En importrad räcker inte: villkoret kräver anropet.)',
    )
  } else if (!/return\s+this\.\$extends\(|=\s*this\.\$extends\(/.test(prismaKod)) {
    säg(
      '$extends-resultatet tas inte till vara',
      '`$extends` returnerar en NY klient. Ett anrop vars returvärde kastas ' +
        'kompilerar, kör och gör INGENTING.',
    )
  }

  // ── R2 — modellmängden HÄRLEDS, listas inte ───────────────────────────────
  // ── TVÅ VYER, SAMMA INDEX ─────────────────────────────────────────────────
  //
  // `codeMask` blankar BÅDE kommentarer och stränginnehåll. Det är rätt för
  // frågan "är det här ett anrop?" och FEL för "vilket slag står i strängen?" —
  // första versionen av R2 och R3 läste `codeMask` och matchade `'      '` i
  // stället för `'HUMAN'`. Båda reglerna var då gröna om vad som helst.
  //
  // Därför två positionsbevarande vyer av samma text: `codeMask` avgör att
  // träffen är KOD, `blankComments` läser vad som STÅR där. Samma index gäller
  // i båda, eftersom båda bevarar längd och radbrytningar.
  const extKod = codeMask(extText)
  const extSträng = blankComments(extText)
  if (!extKod.includes('Prisma.dmmf.datamodel.models')) {
    säg(
      'modellmängden härleds inte ur schemat',
      'En lista i koden glider isär från schemat utan att något faller: en ny ' +
        'modell med kolumnen stämplas aldrig, och ingen märker det.',
    )
  }
  // Motfrågan: står det ändå en hårdkodad modelluppräkning i filen?
  const schemaModeller = new Set([...schemaText.matchAll(/^model\s+([\p{L}\p{N}_$]+)\s*\{/gmu)].map((m) => m[1]))
  const literaler = [...extSträng.matchAll(/'([\p{L}\p{N}_$]+)'/gu)]
    .filter((m) => extKod[m.index] !== ' ') // träffen ska vara KOD, inte en kommentar
    .map((m) => m[1])
    .filter((n) => schemaModeller.has(n))
  if (literaler.length > 0) {
    säg(
      `extensionen nämner modellnamn som literaler: ${literaler.join(', ')}`,
      'En härledning plus en lista är två sanningar som råkar stämma överens.',
    )
  }

  // ── R3 — exakt tre gränser, härledda ur källkoden ──────────────────────────
  const anrop = []
  for (const [fil, kod] of källor) {
    const kodVy = codeMask(kod)
    const strängVy = blankComments(kod)
    for (const m of strängVy.matchAll(/runWithActor\(\s*'([\p{L}\p{N}_$]+)'/gu)) {
      // Anropet måste stå i KOD (kodVy har tecknet kvar), medan SLAGET läses ur
      // strängvyn. En gräns som bara står i en kommentar är ingen gräns.
      if (kodVy[m.index] === ' ') continue
      anrop.push([fil, m[1]])
    }
  }
  const slag = [...new Set(anrop.map(([, k]) => k))].sort()
  if (anrop.length === 0) {
    säg(
      'ingen gräns sätter aktören',
      'Extensionen stämplar vad kontexten säger. Utan gräns stämplar den ' +
        'ingenting, och är ändå "korrekt".',
    )
  } else if (slag.join(',') !== [...GRÄNSER].sort().join(',')) {
    säg(
      `gränserna är ${slag.join(', ') || '(inga)'} — förväntat ${[...GRÄNSER].sort().join(', ')}`,
      'Fler gränser betyder att "sätt den här på lämpligt ställe" börjat gälla, ' +
        'och då är mekanismen en konvention igen. Färre betyder en väg som tappat sin aktör.',
    )
  }

  // ── R4 — ingen sätter kolumnen för hand ───────────────────────────────────
  const förhand = []
  for (const [fil, kod] of källor) {
    if (fil === EXT_FIL) continue
    if (/actorKind\s*:/.test(codeMask(kod))) förhand.push(fil.replace(API + '/', ''))
  }
  if (förhand.length > 0) {
    säg(
      `${förhand.length} fil(er) sätter actorKind för hand: ${förhand.join(', ')}`,
      'Kolumnen sätts av mekaniken. En handpåläggning är ett ställe som kan bli ' +
        'fel utan att något faller — de 183 icke-AI-skrivställena är skälet till ' +
        'att extensionen finns.',
    )
  }

  // ── R5 — NULL-svepet finns och läser brytpunkten ur kontextfilen ──────────
  if (!kontextText.includes('AKTORSKOLUMNENS_BRYTPUNKT')) {
    säg('brytpunkten saknas', 'Utan brytpunkt går legitima gamla NULL inte att skilja från läckan.')
  }
  if (!svepText.includes('AKTORSKOLUMNENS_BRYTPUNKT')) {
    säg(
      'NULL-svepet läser inte brytpunkten',
      'Ett svep utan brytpunkt räknar varje gammal rad och larmar alltid — ' +
        'och ett larm som alltid går är ett larm ingen läser.',
    )
  }
  if (!/STÄMPLADE_MODELLER/.test(svepText)) {
    säg(
      'NULL-svepet härleder inte sin tabellmängd ur extensionen',
      'Sveper det över en egen lista mäter det inte de tabeller som stämplas.',
    )
  }

  return problem
}

// ── självtest ────────────────────────────────────────────────────────────────
const EXT_OK = `
export const STÄMPLADE_MODELLER = new Set(
  Prisma.dmmf.datamodel.models.filter((m) => m.fields.some((f) => f.name === 'actorKind')).map((m) => m.name),
)
export const actorStampExtension = { name: 'actor-stamping' }
`
const PRISMA_OK = `return this.$extends(aiEffectExtension).$extends(actorStampExtension) as unknown as this`
const KONTEXT_OK = `export const AKTORSKOLUMNENS_BRYTPUNKT = new Date('2026-09-02T00:00:00Z')`
const SVEP_OK = `import { STÄMPLADE_MODELLER } from '...'\nconst t = AKTORSKOLUMNENS_BRYTPUNKT`
const SCHEMA_OK = 'model Invoice {\n}\nmodel Lease {\n}\n'
const KÄLLOR_OK = [
  ['/a/guard.ts', `runWithActor('HUMAN', () => next())`],
  ['/a/cron.ts', `runWithActor('SYSTEM', () => jobb())`],
  ['/a/ai.ts', `runWithActor('AGENT', () => verktyg())`],
]
const BAS = {
  extText: EXT_OK,
  prismaText: PRISMA_OK,
  kontextText: KONTEXT_OK,
  svepText: SVEP_OK,
  schemaText: SCHEMA_OK,
  källor: KÄLLOR_OK,
}

function selfTest() {
  let ok = true
  // ── #713: DE TRE STÄLLEN SOM BYTTES ─────────────────────────────────────
  //
  // Alla tre HÄRLEDER namn ur källtext med `\w`, som är ASCII. Proven är
  // riktade mot exakt de tre; de befintliga proven nedan använder enbart
  // ASCII-fixturer (Invoice, Lease, HUMAN/SYSTEM/AGENT) och kan därför inte se
  // att härledningen gått blind — #736:s lärdom.
  const felTexter = (r) => r.map((x) => `${x.rule ?? ''} ${x.detail ?? ''} ${JSON.stringify(x)}`).join(' | ')
  {
    // (1)+(2) MODELLMÄNGDEN ur schemat, och LITERALERNA i extensionen.
    //     `model Ärende {` hamnade aldrig i mängden, så en hårdkodad
    //     `'Ärende'` i extensionen kunde inte kännas igen som en modell.
    //     Motfrågan i R2 — "står det ändå en hårdkodad uppräkning?" — var
    //     alltså tyst grön för varje svenskt modellnamn.
    const r = evaluate({
      ...BAS,
      schemaText: 'model Ärende {\n}\nmodel Lease {\n}\n',
      extText: `${EXT_OK}\nconst HÅRDKODAT = ['Ärende']`,
    })
    if (!felTexter(r).includes('Ärende')) {
      ok = false
      console.error(`❌ #713 (1)(2) MISSAD: hårdkodad literal för modellen Ärende upptäcks inte — ${felTexter(r).slice(0, 120)}`)
    } else console.log('✅ #713 (1)(2) MISSAD: modellnamn med svensk initial härleds ur schemat och känns igen som literal')

    // MOTPROV: en literal som INTE är ett modellnamn ska fortfarande passera.
    const r2 = evaluate({ ...BAS, extText: `${EXT_OK}\nconst X = ['någotAnnat']` })
    if (felTexter(r2).includes('någotAnnat')) {
      ok = false
      console.error('❌ #713 MOTPROV: en literal som inte är en modell flaggades')
    }
  }
  {
    // (3) AKTÖRSSLAGET i runWithActor. Slagen är versala namn i källkoden, och
    //     ett svenskt slag — `MÄNNISKA` — försvann helt ur uppräkningen. R3
    //     kräver exakt tre gränser; en osynlig gräns gör att vakten larmar om
    //     ett antal som inte stämmer, eller inte ser att en fjärde tillkommit.
    const medSvenskt = [
      ['/a/guard.ts', `runWithActor('MÄNNISKA', () => next())`],
      ['/a/cron.ts', `runWithActor('SYSTEM', () => jobb())`],
      ['/a/ai.ts', `runWithActor('AGENT', () => verktyg())`],
    ]
    //     Vakten fastnaglar med flit exakt {AGENT, HUMAN, SYSTEM}, så ett
    //     svenskt slag SKA fällas. Det diskriminerande är därför inte OM den
    //     fäller utan VAD den redovisar:
    //
    //       \w   → "gränserna är AGENT, SYSTEM"          slaget SAKNAS HELT
    //       fix  → "gränserna är AGENT, MÄNNISKA, SYSTEM" slaget syns
    //
    //     Den första texten säger att en gräns är BORTA. Den som läser den
    //     letar efter ett raderat runWithActor som står kvar i filen.
    const r = evaluate({ ...BAS, källor: medSvenskt })
    if (!felTexter(r).includes('MÄNNISKA')) {
      ok = false
      console.error(`❌ #713 (3) MISSAD: svenskt aktörsslag syns inte i den härledda mängden — ${felTexter(r).slice(0, 140)}`)
    } else console.log('✅ #713 (3) MISSAD: aktörsslag med svenskt tecken härleds helt')

    // MOTPROV: en gräns i en KOMMENTAR är fortfarande ingen gräns.
    const r2 = evaluate({
      ...BAS,
      källor: [medSvenskt[0], medSvenskt[1], ['/a/z.ts', `// runWithActor('MÄNNISKA', ...)`]],
    })
    if (r2.length === 0) {
      ok = false
      console.error('❌ #713 (3) MOTPROV: en gräns som bara står i en kommentar räknades')
    }
  }

  // Den delade skannerns EGNA kanariefåglar. Vakten bygger hela sin R2/R3 på
  // att `codeMask` och `blankComments` bevarar index — går skannern sönder är
  // varje regel här tyst fel, inte högljutt fel.
  //
  // `kanariefåglar()` returnerar de lägen som FÖLL — tom array är grönt. Första
  // versionen här läste den som objekt med `.ok` och skrev "0 lägen OK": ett
  // tal som inte kunde bli något annat, oavsett skannerns tillstånd. Antalet
  // lägen läses därför ur `KANARIEFÅGEL_LÄGEN`, som är den faktiska mängden.
  const fallna = kanariefåglar()
  if (fallna.length > 0) {
    ok = false
    console.error(`❌ den delade skannerns kanariefåglar föll: ${fallna.join(' | ')}`)
  } else {
    console.warn(
      `✅ den delade skannerns kanariefåglar: ${KANARIEFÅGEL_LÄGEN.length} lägen, noll fallna`,
    )
  }
  const grön = (namn, problem) => {
    if (problem.length === 0) console.warn(`✅ ${namn}`)
    else { ok = false; console.error(`❌ ${namn} — förväntade INGA problem, fick: ${problem.map((p) => p.rule).join(' | ')}`) }
  }
  const röd = (namn, problem, delsträng) => {
    if (problem.some((p) => p.rule.includes(delsträng))) console.warn(`✅ fångad: ${namn}`)
    else { ok = false; console.error(`❌ MISSAD: ${namn} — inget problem innehöll "${delsträng}". Fick: ${problem.map((p) => p.rule).join(' | ') || '(inga)'}`) }
  }

  grön('en korrekt uppsättning är ren', evaluate(BAS))

  // R1 — DEN FARLIGASTE: bortkopplad mekanism
  röd('extensionen inte påkopplad', evaluate({ ...BAS, prismaText: 'class PrismaService {}' }), 'kopplar inte på')
  // DEN UPPMÄTTA BLINDHETEN: anropet borta, importen kvar. Vakten var GRÖN här
  // innan villkoret bytte från "nämner" till "anropar".
  röd(
    'anropet borttaget men IMPORTEN kvar',
    evaluate({
      ...BAS,
      prismaText:
        "import { actorStampExtension } from './actor-stamp-extension'\n" +
        'return this.$extends(aiEffectExtension) as unknown as this',
    }),
    'kopplar inte på',
  )
  // …och motprovet: ett anrop som bara står i en KOMMENTAR duger inte heller.
  röd(
    'påkopplingen står bara i en kommentar',
    evaluate({
      ...BAS,
      prismaText:
        '// return this.$extends(aiEffectExtension).$extends(actorStampExtension)\n' +
        'return this.$extends(aiEffectExtension) as unknown as this',
    }),
    'kopplar inte på',
  )
  röd('$extends-resultatet kastas', evaluate({ ...BAS, prismaText: 'this.$extends(actorStampExtension)' }), 'tas inte till vara')
  röd('mekanismen saknas helt', evaluate({ ...BAS, extText: 'const annat = {}' }), 'actorStampExtension saknas')

  // R2
  röd('modellmängden listad i stället för härledd', evaluate({ ...BAS, extText: "export const actorStampExtension = {}\nconst M = new Set(['Invoice','Lease'])" }), 'härleds inte ur schemat')
  röd('härledning PLUS hårdkodad lista', evaluate({ ...BAS, extText: EXT_OK + "\nconst extra = ['Invoice']" }), 'modellnamn som literaler')

  // R3
  röd('ingen gräns alls', evaluate({ ...BAS, källor: [['/a/x.ts', 'const x = 1']] }), 'ingen gräns')
  röd('en gräns saknas (AGENT)', evaluate({ ...BAS, källor: KÄLLOR_OK.slice(0, 2) }), 'gränserna är')
  röd('en FJÄRDE gräns tillkommer', evaluate({ ...BAS, källor: [...KÄLLOR_OK, ['/a/y.ts', `runWithActor('WEBHOOK', () => x())`]] }), 'gränserna är')

  // R4
  röd('någon sätter kolumnen för hand', evaluate({ ...BAS, källor: [...KÄLLOR_OK, ['/a/svc.ts', 'prisma.invoice.create({ data: { actorKind: "HUMAN" } })']] }), 'för hand')

  // R4:s MOTPROV — en KOMMENTAR som nämner fältet får inte fälla. Utan den här
  // raden är R4 en regel som läser prosa, och varje docblock som förklarar
  // kolumnen blir ett falskt larm.
  grön('en kommentar som nämner actorKind: fäller inte', evaluate({ ...BAS, källor: [...KÄLLOR_OK, ['/a/doc.ts', '// sätter actorKind: aldrig för hand\nconst x = 1']] }))

  // R3:s MOTPROV — samma sak för gränserna: ett runWithActor i en kommentar
  // ska inte räknas som en gräns.
  röd('en gräns som bara står i en KOMMENTAR räknas inte', evaluate({ ...BAS, källor: [KÄLLOR_OK[0], KÄLLOR_OK[1], ['/a/z.ts', `// runWithActor('AGENT', ...) borde finnas här`]] }), 'gränserna är')

  // R5
  röd('svepet läser inte brytpunkten', evaluate({ ...BAS, svepText: 'const t = new Date(0)\nSTÄMPLADE_MODELLER' }), 'läser inte brytpunkten')
  röd('brytpunkten saknas i kontexten', evaluate({ ...BAS, kontextText: 'const x = 1' }), 'brytpunkten saknas')
  röd('svepet har egen tabellista', evaluate({ ...BAS, svepText: 'const t = AKTORSKOLUMNENS_BRYTPUNKT' }), 'härleder inte sin tabellmängd')

  console.warn(ok ? '\n✅ Självtest OK.' : '\n❌ Självtest FALLERADE.')
  return ok
}

if (process.argv.includes('--self-test')) {
  process.exit(selfTest() ? 0 : 1)
}

const källor = allaKällfiler().map((f) => [f, readFileSync(f, 'utf8')])
const läs = (f) => { try { return readFileSync(f, 'utf8') } catch { return '' } }
const problem = evaluate({
  extText: läs(EXT_FIL),
  prismaText: läs(PRISMA_FIL),
  kontextText: läs(KONTEXT_FIL),
  svepText: läs(SVEP_FIL),
  schemaText: läs(SCHEMA_FIL),
  källor,
})

if (problem.length > 0) {
  console.error('❌ Aktörsstämplingen är inte hel:\n')
  for (const p of problem) console.error(`  • ${p.rule}\n    ${p.detail}\n`)
  process.exit(1)
}
const antal = (läs(EXT_FIL).match(/actorKind/g) || []).length
console.warn(
  `✅ aktörsstämplingen är påkopplad; modellmängden härleds ur schemat, ` +
    `tre gränser satta, inga handpåläggningar. (${antal} referenser i extensionen)`,
)
