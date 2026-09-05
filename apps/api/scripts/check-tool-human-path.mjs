#!/usr/bin/env node
/**
 * CI-vakt — DELMÄNGDSREGELN: agenten får aldrig kunna mer än människan.
 *
 * ── VAD DEN SKYDDAR MOT ─────────────────────────────────────────────────────
 *
 * Planens Regel 2 (`docs/eveno-agentplan.md`, Del 2) säger att varje förmåga
 * agenten har måste ha en motsvarande mänsklig väg. En sådan regel dör inte med
 * ett brak — den dör av att verktyg nummer 31 läggs till en tisdag och ingen
 * ställer frågan. Vakten gör frågan tvingande.
 *
 * ── REGLERNA ────────────────────────────────────────────────────────────────
 *
 *   R1  OMFÅNG, BÅDA HÅLLEN. Varje namn i `ACTION_TOOLS` har en post i
 *       `HUMAN_PATHS`, och varje post pekar på ett verktyg som finns. Ett nytt
 *       verktyg utan väg fäller; en död post fäller.
 *
 *   R2  RUTTEN FINNS. `rutt` måste vara en path-literal som faktiskt är
 *       registrerad i `apps/web/src/app/router.tsx`. En väg till en sida som
 *       inte finns är ingen väg.
 *
 *   R3  ÅTGÄRDEN FINNS. `atgard` måste förekomma ordagrant i den
 *       feature-katalog rutten pekar på. Kopplingen rutt → katalog HÄRLEDS ur
 *       router.tsx:s egna importer — det finns ingen andra lista att hålla i
 *       synk.
 *
 *   R4  FYNDET HAR ETT SKÄL OCH EN ÄRENDEPLATS. Varje baslinjepost bär `skal`
 *       (minst 40 tecken) och `arende` (tom sträng tills ett ärende finns). Ett
 *       tomt skäl är samma sak som ingen fråga alls, och ett SAKNAT `arende`-fält
 *       är något annat än ett tomt — därför prövas fältets existens, inte dess
 *       innehåll. En post i `HUMAN_PATHS` får aldrig bära både `saknas` och
 *       `rutt`/`atgard`.
 *
 *   R5  RATCHET I TRE RIKTNINGAR, mot `tool-human-path.baseline.json`:
 *
 *         a) verktyg UTAN humanPath som inte står i baslinjen  → rött
 *         b) verktyg som står i baslinjen men HAR humanPath    → rött
 *         c) namn i baslinjen som inte finns i EFFECT_DECLARATIONS → rött
 *
 *       De tre är olika fel och säger olika saker. (a) hindrar att skulden
 *       växer, (b) hindrar att ett löst fynd ser öppet ut, (c) hindrar en
 *       baslinjepost som skyddar ingenting medan den ser ut att göra det.
 *       Baslinjen får bara krympa.
 *
 *       ── BASLINJEN ÄR TOM SEDAN 2026-09-05, OCH FILEN SKA FINNAS KVAR ──────
 *
 *       Alla trettio verktygen har en mänsklig väg. Frågan blev då om filen
 *       skulle raderas och en saknad fil läsas som "noll poster".
 *
 *       NEJ, och skälet är R5c. Den regeln finns för att fånga ett namn i
 *       baslinjen som inte är ett verktyg — en kvittering som skyddar ingenting
 *       men ser ut att göra det. Den kan bara falla om det FINNS en baslinje att
 *       läsa. Läste vakten "ingen fil = noll poster" hade en RADERAD fil blivit
 *       oskiljbar från en tom, och den dag någon lägger tillbaka en post i en
 *       fil som inte längre läses vore R5c grön om en post den aldrig såg.
 *
 *       Filen är därför OBLIGATORISK: går den inte att läsa eller parsa är det
 *       ett FEL, inte ett tomt läge. Se `läsBaslinje` nedan.
 *
 *       Att mängden är tom gör inte R5b och R5c blinda i den mening som räknas:
 *       de itererar en tom mängd i den skarpa körningen, men deras förmåga att
 *       FÄLLA bevisas av självtestet, som matar in syntetiska baslinjer. Det är
 *       skillnaden mellan "inget att rapportera" och "kan inte rapportera".
 *
 *   R6  FAIL-CLOSED ÄR PÅKOPPLAD. `buildHumanPathCatalog` måste KASTA vid en
 *       post som saknas. Specen äger att kastet sker; den här regeln äger att
 *       koden fortfarande innehåller det. (Delningen från #571.)
 *
 * ── EN VY PER FRÅGA ─────────────────────────────────────────────────────────
 *
 * Allt den här vakten letar efter BOR I STRÄNGAR eller i JSX-text: rutter är
 * path-literaler, importsökvägar är strängar, knapptexter är antingen strängar
 * eller JSX-innehåll. Vyn är därför `blankComments` genomgående — `codeMask`
 * hade blankat exakt det som ska läsas och gjort varje regel omöjlig att bryta
 * mot, alltså omöjlig att mäta. Det är den defekt CLAUDE.md beskriver under
 * "EN VY PER FRÅGA — codeMask överallt gör vakten stum", och kanariefåglarna
 * nedan fäller ett sådant byte: en rutt och en åtgärd som bara står i en
 * KOMMENTAR får inte räknas, medan samma text i kod ska räknas.
 *
 * ── VAD DEN HÄR VAKTEN INTE KAN SE ──────────────────────────────────────────
 *
 * DEN MÄTER ATT EN VÄG ÄR ANGIVEN OCH ATT RUTTEN FINNS I `router.tsx` — INTE
 * ATT RUTTEN FAKTISKT UTFÖR SAMMA SAK SOM VERKTYGET. En post kan alltså vara
 * grön och ändå ljuga: `mark_invoice_paid → /invoices · "Registrera betalning"`
 * är sann i dag, men om verktyget i morgon börjar också stänga en kravtrappa
 * står posten kvar oförändrad och grön. Det ekvivalensbeviset finns inte i
 * källtext, och den som läser en grön körning ska veta det.
 *
 * Tre saker till ligger utanför:
 *
 *   • Att åtgärden går att KLICKA. R3 är driftdetektering: den fäller när en
 *     knapptext raderas eller döps om, inte när knappen döljs bakom ett villkor,
 *     blir disabled, eller kräver en roll agenten inte har. Det ägs av
 *     `apps/web/e2e/`.
 *   • Att rutten och åtgärden HÖR IHOP — bara att båda finns i samma
 *     feature-katalog. En åtgärd från en annan flik på samma sida duger.
 *   • Att baslinjens skäl är SANNA. R4 mäter längd och form, inte innehåll.
 *     Ett skäl som var sant i går och falskt i dag är fortfarande grönt.
 *
 * Lokalt:      node apps/api/scripts/check-tool-human-path.mjs
 * Självtest:   node apps/api/scripts/check-tool-human-path.mjs --self-test
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { blankComments, kanariefåglar } from '../../../scripts/lib/source-scan.mjs'

const HÄR = dirname(fileURLToPath(import.meta.url))
const API = join(HÄR, '..')
const ROT = join(API, '..', '..')

const DEKLARATION = join(API, 'src', 'ai', 'tools', 'human-path.ts')
const DEFINITION = join(API, 'src', 'ai', 'tools', 'ai-tools.definition.ts')
const EFFEKTER = join(API, 'src', 'ai', 'tools', 'effect-idempotency.ts')
const ROUTER = join(ROT, 'apps', 'web', 'src', 'app', 'router.tsx')
const FEATURES = join(ROT, 'apps', 'web', 'src', 'features')
const BASLINJE = join(HÄR, 'tool-human-path.baseline.json')

/** Ett skäl kortare än så är ingen mätning. Samma golv som ai-tool-effects.ack. */
const MIN_SKAL = 40

/** Golv för omfånget. Sjunker mängden under det mäter vakten inte längre allt. */
const MIN_VERKTYG = 25
const MIN_RUTTER = 20

// ── läsning ─────────────────────────────────────────────────────────────────

/** Matchar den öppnande klammern efter `från` och returnerar kroppen. */
function block(text, från) {
  const start = text.indexOf('{', från)
  if (start === -1) return null
  let djup = 0
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') djup++
    else if (text[i] === '}') {
      djup--
      if (djup === 0) return { kropp: text.slice(start + 1, i), slut: i }
    }
  }
  return null
}

/** `new Set([...])`-medlemmar ur en namngiven konstant. Strängar, alltså blankComments. */
export function läsVerktyg(definitionText) {
  const text = blankComments(definitionText)
  const i = text.indexOf('export const ACTION_TOOLS')
  if (i === -1) return []
  const start = text.indexOf('[', i)
  const slut = text.indexOf(']', start)
  if (start === -1 || slut === -1) return []
  return [...text.slice(start, slut).matchAll(/'([^']+)'/g)].map((m) => m[1])
}

/**
 * Rutterna som router.tsx faktiskt registrerar, plus vilken feature-katalog var
 * och en renderar.
 *
 * Kopplingen härleds i två steg, båda ur samma fil: `appPage('/x', XPage)` ger
 * rutt → komponentnamn, och `import { XPage } from '../features/x/XPage'` ger
 * komponentnamn → katalog. Ingen handskriven tabell.
 */
export function läsRutter(routerText) {
  const text = blankComments(routerText)

  const katalogFörKomponent = new Map()
  for (const m of text.matchAll(
    /import\s*\{\s*([\p{L}\p{N}_$]+)[^}]*\}\s*from\s*'\.\.\/features\/([^/']+)\//gu,
  )) {
    katalogFörKomponent.set(m[1], m[2])
  }

  const rutter = new Map()
  // 1. appPage('/x', Komponent) — bär både rutt och komponent.
  for (const m of text.matchAll(/appPage\(\s*'([^']+)'\s*,\s*([\p{L}\p{N}_$]+)/gu)) {
    rutter.set(m[1], katalogFörKomponent.get(m[2]) ?? null)
  }
  // 2. path: '/x' — createRoute-formen. Rutten finns; katalogen är okänd här.
  for (const m of text.matchAll(/path:\s*'([^']+)'/g)) {
    if (!rutter.has(m[1])) rutter.set(m[1], null)
  }
  return rutter
}

/**
 * Posterna i `HUMAN_PATHS`. En post är antingen en väg (`rutt` + `atgard`) eller
 * markören `{ saknas: true }` — aldrig båda, aldrig ingen. Skälet läses inte
 * här: det bor i baslinjen, se R4.
 */
export function läsDeklarationer(deklarationText) {
  const text = blankComments(deklarationText)
  const i = text.indexOf('export const HUMAN_PATHS')
  if (i === -1) return []
  const yttre = block(text, i)
  if (!yttre) return []

  const poster = []
  const kropp = yttre.kropp
  const nyckel = /([\p{L}\p{N}_$]+)\s*:\s*\{/gu
  let m
  while ((m = nyckel.exec(kropp)) !== null) {
    const inre = block(kropp, m.index + m[0].length - 1)
    if (!inre) continue
    const b = inre.kropp
    const rutt = /rutt:\s*'([^']*)'/.exec(b)
    const atgard = /atgard:\s*'([^']*)'/.exec(b)
    poster.push({
      namn: m[1],
      rutt: rutt ? rutt[1] : null,
      atgard: atgard ? atgard[1] : null,
      saknar: /saknas:\s*true/.test(b),
    })
    nyckel.lastIndex = inre.slut + 1
  }
  return poster
}

/**
 * Nycklarna i `EFFECT_DECLARATIONS`. Baslinjen prövas mot DEN mängden och inte
 * mot `ACTION_TOOLS`: ett namn som inte är klassificerat är inte ett verktyg,
 * och en baslinjepost för något som inte finns skyddar ingenting medan den ser
 * ut att göra det. Posterna är objektlitteraler på toppnivå i deklarationen.
 */
export function läsKlassificerade(effektText) {
  const text = blankComments(effektText)
  const i = text.indexOf('export const EFFECT_DECLARATIONS')
  if (i === -1) return []
  const yttre = block(text, i)
  if (!yttre) return []
  const namn = []
  const nyckel = /([\p{L}\p{N}_$]+)\s*:\s*\{/gu
  let m
  while ((m = nyckel.exec(yttre.kropp)) !== null) {
    const inre = block(yttre.kropp, m.index + m[0].length - 1)
    if (!inre) continue
    namn.push(m[1])
    nyckel.lastIndex = inre.slut + 1
  }
  return namn
}

function källfiler(dir) {
  const ut = []
  for (const namn of readdirSync(dir)) {
    const full = join(dir, namn)
    if (statSync(full).isDirectory()) ut.push(...källfiler(full))
    else if (/\.(ts|tsx)$/.test(namn)) ut.push(full)
  }
  return ut
}

// ── reglerna, som ren funktion ──────────────────────────────────────────────

/**
 * @param {object} indata
 * @param {string[]} indata.verktyg           ACTION_TOOLS
 * @param {string[]} indata.klassificerade    EFFECT_DECLARATIONS-nycklarna
 * @param {Array} indata.poster               HUMAN_PATHS
 * @param {Map<string,string|null>} indata.rutter
 * @param {(katalog:string)=>string} indata.läsKatalog  sammanslagen källtext, kommentarsfri
 * @param {Record<string,{skal:string,arende:string}>} indata.baslinje
 */
export function utvärdera({ verktyg, klassificerade, poster, rutter, läsKatalog, baslinje }) {
  const fel = []
  const deklarerade = new Map(poster.map((p) => [p.namn, p]))

  // ── R1 — omfång, båda hållen ─────────────────────────────────────────────
  for (const namn of verktyg) {
    if (!deklarerade.has(namn)) {
      fel.push(
        `R1 ${namn}: saknar post i HUMAN_PATHS. Deklarera den mänskliga vägen — ` +
          `eller { saknas: '<skäl>' } om ingen finns. Hitta inte på en rutt.`,
      )
    }
  }
  const verktygsSet = new Set(verktyg)
  for (const p of poster) {
    if (!verktygsSet.has(p.namn)) {
      fel.push(`R1 ${p.namn}: står i HUMAN_PATHS men finns inte i ACTION_TOOLS. Död post.`)
    }
  }

  for (const p of poster) {
    if (!verktygsSet.has(p.namn)) continue
    const saknar = p.saknar

    // ── R4 — markören säger EN sak, och skälet bor i baslinjen ─────────────
    if (saknar) {
      if (p.rutt !== null || p.atgard !== null) {
        fel.push(`R4 ${p.namn}: bär både { saknas: true } och rutt/atgard. Posten säger två saker.`)
      }
      continue
    }

    if (p.rutt === null || p.atgard === null) {
      fel.push(`R1 ${p.namn}: posten har varken rutt+atgard eller { saknas: true }.`)
      continue
    }

    // ── R2 — rutten finns i router.tsx ───────────────────────────────────────
    if (!rutter.has(p.rutt)) {
      fel.push(
        `R2 ${p.namn}: rutten '${p.rutt}' är inte registrerad i apps/web/src/app/router.tsx. ` +
          `En väg till en sida som inte finns är ingen väg.`,
      )
      continue
    }

    // ── R3 — åtgärden finns i den katalog rutten renderar ────────────────────
    const katalog = rutter.get(p.rutt)
    if (!katalog) {
      fel.push(
        `R3 ${p.namn}: rutten '${p.rutt}' går inte att härleda till en feature-katalog ` +
          `ur router.tsx. Åtgärden kan då inte prövas, och en oprövbar regel är ingen regel.`,
      )
      continue
    }
    if (!p.atgard || p.atgard.trim().length < 3) {
      fel.push(`R3 ${p.namn}: åtgärden är tom eller för kort för att kunna slås upp.`)
      continue
    }
    if (!läsKatalog(katalog).includes(p.atgard)) {
      fel.push(
        `R3 ${p.namn}: åtgärden '${p.atgard}' finns inte i apps/web/src/features/${katalog}/. ` +
          `Omdöpt knapp, borttagen yta — eller en påhittad väg.`,
      )
    }
  }

  // ── R5 — RATCHETEN, I TRE RIKTNINGAR ─────────────────────────────────────
  //
  // De tre är olika fel och ska säga olika saker. Att slå ihop dem till "posten
  // stämmer inte" hade gjort felet obegripligt klockan tre på natten.
  const utanVäg = poster
    .filter((p) => p.saknar && verktygsSet.has(p.namn))
    .map((p) => p.namn)
    .sort()
  const basNamn = Object.keys(baslinje)
  const bas = new Set(basNamn)
  const klassade = new Set(klassificerade)

  // (a) Ett verktyg UTAN mänsklig väg som inte står i baslinjen.
  for (const namn of utanVäg) {
    if (!bas.has(namn)) {
      fel.push(
        `R5a ${namn}: saknar mänsklig väg men står INTE i tool-human-path.baseline.json. ` +
          `Baslinjen får bara krympa — ett nytt verktyg utan mänsklig väg bryter mot Regel 2 ` +
          `och ska inte läggas till skulden.`,
      )
    }
  }

  // (b) Ett verktyg som står i baslinjen men HAR en mänsklig väg.
  const utanSet = new Set(utanVäg)
  for (const namn of basNamn) {
    if (utanSet.has(namn)) continue
    if (deklarerade.has(namn)) {
      fel.push(
        `R5b ${namn}: står i tool-human-path.baseline.json men HAR en humanPath. ` +
          `Skulden är betald — ta bort posten ur baslinjen i samma PR, annars ser ` +
          `ett löst fynd ut som ett öppet.`,
      )
    }
  }

  // (c) Ett namn i baslinjen som inte är ett klassificerat verktyg.
  for (const namn of basNamn) {
    if (!klassade.has(namn)) {
      fel.push(
        `R5c ${namn}: står i tool-human-path.baseline.json men finns inte i ` +
          `EFFECT_DECLARATIONS. En baslinjepost för något som inte finns skyddar ingenting ` +
          `och ser ut att göra det.`,
      )
    }
  }

  // R4 flyttad hit: skälet bor i BASLINJEN, en post per fynd, med ärendeplats.
  for (const namn of basNamn) {
    const post = baslinje[namn]
    if (!post || typeof post.skal !== 'string' || post.skal.length < MIN_SKAL) {
      fel.push(
        `R4 ${namn}: baslinjeposten saknar ett skäl på minst ${MIN_SKAL} tecken. ` +
          `Skriv vad som mättes och vad som skulle behöva byggas — ett tomt skäl är ` +
          `samma sak som ingen fråga alls.`,
      )
    }
    if (!post || typeof post.arende !== 'string') {
      fel.push(
        `R4 ${namn}: baslinjeposten saknar fältet "arende". Tom sträng är rätt tills ` +
          `ett ärende finns; ett saknat fält är något annat.`,
      )
    }
  }

  return { fel, utanVäg }
}

/** R6 — fail-closed är kvar i koden, på rätt plats. */
export function prövaFailClosed(deklarationText) {
  const text = blankComments(deklarationText)
  const i = text.indexOf('export function buildHumanPathCatalog')
  if (i === -1) return ['R6: buildHumanPathCatalog finns inte längre — fail-closed är borta.']
  const kropp = block(text, i)?.kropp ?? ''
  if (!/throw new Error/.test(kropp)) {
    return [
      'R6: buildHumanPathCatalog kastar inte längre vid en saknad post. Utan kastet blir ' +
        'ett oklassat verktyg tyst godkänt, och vakten är då den enda spärren.',
    ]
  }
  return []
}

// ── självtest ───────────────────────────────────────────────────────────────

const ROUTER_SOND = `
import { PropertiesPage } from '../features/properties/PropertiesPage'
const r = appPage('/properties', PropertiesPage)
// appPage('/bara-i-en-kommentar', PropertiesPage)
`

function självtest() {
  const fel = []
  // Talet RÄKNAS, det skrivs inte. Ett tal i utskriften som inte härleds blir
  // fel första gången någon lägger till ett prov — och då ser en krympt mängd
  // ut som en oförändrad.
  let antal = 0
  const kräv = (namn, villkor, detalj) => {
    antal++
    if (!villkor) fel.push(`${namn}${detalj ? ` — ${detalj}` : ''}`)
  }
  const SKAL = 'x'.repeat(MIN_SKAL + 10)
  const bas = (...namn) => Object.fromEntries(namn.map((n) => [n, { skal: SKAL, arende: '' }]))
  const kör = (o) =>
    utvärdera({
      verktyg: ['t1'],
      klassificerade: ['t1'],
      poster: [],
      rutter: new Map(),
      läsKatalog: () => '',
      baslinje: {},
      ...o,
    })

  // ── OMFÅNGSKANARIEFÅGEL ─────────────────────────────────────────────────
  //
  // R5 är lärdomen av R5-blindheten i planen: en vakt vars mängd är tom mäter
  // ingenting och är grön för alltid. Läsarna prövas därför mot den RIKTIGA
  // filerna och måste ge något — inte bara mot sonder.
  const verktygLive = läsVerktyg(readFileSync(DEFINITION, 'utf8'))
  const rutterLive = läsRutter(readFileSync(ROUTER, 'utf8'))
  const posterLive = läsDeklarationer(readFileSync(DEKLARATION, 'utf8'))
  const klassLive = läsKlassificerade(readFileSync(EFFEKTER, 'utf8'))
  kräv(
    'OMFÅNG: ACTION_TOOLS läses',
    verktygLive.length >= MIN_VERKTYG,
    `${verktygLive.length} < ${MIN_VERKTYG}`,
  )
  kräv(
    'OMFÅNG: rutterna läses',
    rutterLive.size >= MIN_RUTTER,
    `${rutterLive.size} < ${MIN_RUTTER}`,
  )
  kräv(
    'OMFÅNG: posterna läses, en per verktyg',
    posterLive.length === verktygLive.length,
    `${posterLive.length} poster mot ${verktygLive.length} verktyg`,
  )
  // R5c kan bara falla om läsaren av EFFECT_DECLARATIONS ger något. Ger den tom
  // lista blir VARJE baslinjepost röd — och en regel som alltid faller är lika
  // oanvändbar som en som aldrig gör det.
  kräv(
    'OMFÅNG: EFFECT_DECLARATIONS läses',
    klassLive.length >= MIN_VERKTYG,
    `${klassLive.length} < ${MIN_VERKTYG}`,
  )
  kräv(
    'OMFÅNG: klassificerade täcker verktygen',
    verktygLive.every((v) => klassLive.includes(v)),
    'ett ACTION_TOOL saknar klassificering',
  )

  // ── VY-KANARIEFÅGELN, ÅT BÅDA HÅLL ──────────────────────────────────────
  //
  // Rutten bor i en STRÄNG. Byter någon till codeMask blankas literalen och
  // rutten försvinner ur mängden — regeln blir då omöjlig att bryta mot.
  const sond = läsRutter(ROUTER_SOND)
  kräv('VY: rutt i KOD läses', sond.has('/properties'))
  kräv('VY: rutt i KOMMENTAR läses INTE', !sond.has('/bara-i-en-kommentar'))
  kräv('VY: rutt → feature-katalog härleds', sond.get('/properties') === 'properties')

  // ── R1, båda hållen ──────────────────────────────────────────────────────
  kräv('R1 (verktyg utan post → fälls)', kör({}).fel.some((f) => f.startsWith('R1')))
  kräv(
    'R1 (post utan verktyg → fälls)',
    kör({
      verktyg: [],
      poster: [{ namn: 'dod', rutt: '/x', atgard: 'Knapp', saknar: false }],
    }).fel.some((f) => f.startsWith('R1')),
  )

  // ── R2 — rutten finns / finns inte ───────────────────────────────────────
  const medRutt = new Map([['/properties', 'properties']])
  kräv(
    'R2 (okänd rutt → fälls)',
    kör({
      poster: [{ namn: 't1', rutt: '/finns-inte', atgard: 'Ny fastighet', saknar: false }],
      rutter: medRutt,
      läsKatalog: () => 'Ny fastighet',
    }).fel.some((f) => f.startsWith('R2')),
  )
  kräv(
    'R2 (känd rutt → fälls INTE)',
    kör({
      poster: [{ namn: 't1', rutt: '/properties', atgard: 'Ny fastighet', saknar: false }],
      rutter: medRutt,
      läsKatalog: () => 'Ny fastighet',
    }).fel.length === 0,
  )

  // ── R3 — åtgärden finns / finns inte / står bara i en kommentar ──────────
  kräv(
    'R3 (okänd åtgärd → fälls)',
    kör({
      poster: [{ namn: 't1', rutt: '/properties', atgard: 'Knapp som inte finns', saknar: false }],
      rutter: medRutt,
      läsKatalog: () => 'Ny fastighet',
    }).fel.some((f) => f.startsWith('R3')),
  )
  kräv(
    'R3 (åtgärd bara i en KOMMENTAR → fälls)',
    kör({
      poster: [{ namn: 't1', rutt: '/properties', atgard: 'Ny fastighet', saknar: false }],
      rutter: medRutt,
      // Katalogläsaren ger kommentarsfri text; en åtgärd som bara stod i en
      // kommentar är alltså borta här. Provet fäller om någon slutar blanka.
      läsKatalog: () => blankComments('// knappen hette Ny fastighet förr\nconst x = 1\n'),
    }).fel.some((f) => f.startsWith('R3')),
  )
  kräv(
    'R3 (rutt utan härledd katalog → fälls)',
    kör({
      poster: [{ namn: 't1', rutt: '/x', atgard: 'Knapp', saknar: false }],
      rutter: new Map([['/x', null]]),
    }).fel.some((f) => f.startsWith('R3')),
  )

  // ── R4 — skälets golv och ärendeplatsens existens ────────────────────────
  kräv(
    'R4 (för kort skäl → fälls)',
    kör({
      poster: [{ namn: 't1', rutt: null, atgard: null, saknar: true }],
      baslinje: { t1: { skal: 'kort', arende: '' } },
    }).fel.some((f) => f.startsWith('R4')),
  )
  kräv(
    'R4 (saknat arende-FÄLT → fälls, medan tom sträng är rätt)',
    kör({
      poster: [{ namn: 't1', rutt: null, atgard: null, saknar: true }],
      baslinje: { t1: { skal: SKAL } },
    }).fel.some((f) => f.includes('arende')),
  )
  kräv(
    'R4 (tomt arende → fälls INTE)',
    kör({
      poster: [{ namn: 't1', rutt: null, atgard: null, saknar: true }],
      baslinje: bas('t1'),
    }).fel.length === 0,
  )
  kräv(
    'R4 (saknas OCH rutt → fälls)',
    kör({
      poster: [{ namn: 't1', rutt: '/properties', atgard: 'Ny fastighet', saknar: true }],
      rutter: medRutt,
      baslinje: bas('t1'),
    }).fel.some((f) => f.startsWith('R4')),
  )

  // ── R5 — ratcheten, ALLA TRE riktningarna ────────────────────────────────
  kräv(
    'R5a (verktyg utan väg som inte står i baslinjen → fälls)',
    kör({
      poster: [{ namn: 't1', rutt: null, atgard: null, saknar: true }],
      baslinje: {},
    }).fel.some((f) => f.startsWith('R5a')),
  )
  kräv(
    'R5b (baslinjepost som HAR en väg → fälls)',
    kör({
      poster: [{ namn: 't1', rutt: '/properties', atgard: 'Ny fastighet', saknar: false }],
      rutter: medRutt,
      läsKatalog: () => 'Ny fastighet',
      baslinje: bas('t1'),
    }).fel.some((f) => f.startsWith('R5b')),
  )
  kräv(
    'R5c (baslinjenamn som inte är ett klassificerat verktyg → fälls)',
    kör({
      verktyg: ['t1'],
      klassificerade: ['t1'],
      poster: [{ namn: 't1', rutt: '/properties', atgard: 'Ny fastighet', saknar: false }],
      rutter: medRutt,
      läsKatalog: () => 'Ny fastighet',
      baslinje: bas('pahittat_verktyg'),
    }).fel.some((f) => f.startsWith('R5c')),
  )
  kräv(
    'R5 (baslinjen exakt lika med mängden utan väg → fälls INTE)',
    kör({
      poster: [{ namn: 't1', rutt: null, atgard: null, saknar: true }],
      baslinje: bas('t1'),
    }).fel.length === 0,
  )

  // ── R6 — fail-closed, båda hållen ────────────────────────────────────────
  kräv(
    'R6 (kastet borta → fälls)',
    prövaFailClosed('export function buildHumanPathCatalog() {\n  return []\n}\n').length > 0,
  )
  kräv(
    'R6 (kastet kvar → fälls INTE)',
    prövaFailClosed(
      'export function buildHumanPathCatalog() {\n  throw new Error("x")\n}\n',
    ).length === 0,
  )
  kräv(
    'R6 (kast bara i en KOMMENTAR → fälls)',
    prövaFailClosed(
      'export function buildHumanPathCatalog() {\n  // throw new Error("x")\n  return []\n}\n',
    ).length > 0,
  )

  if (fel.length > 0) {
    console.error('❌ Självtestet föll:\n   • ' + fel.join('\n   • '))
    process.exit(1)
  }
  console.warn(
    `✅ Självtest: ${antal} påståenden gröna — omfångskanariefågel på fyra ` +
      `läsare, vy-kanariefågel åt båda hållen (kod mot kommentar), och R1–R6 i båda ` +
      `riktningarna med ratcheten prövad i alla tre.`,
  )
}

// ── körning ─────────────────────────────────────────────────────────────────

/**
 * Baslinjen är OBLIGATORISK, även när den är tom.
 *
 * En saknad eller trasig fil är ett FEL — aldrig "noll poster". Skälet står i
 * docblocket vid R5: läses en saknad fil som tom blir en RADERAD baslinje
 * oskiljbar från en tom, och R5c kan då aldrig falla för en post i en fil ingen
 * längre läser.
 *
 * Kastet bär sökvägen, så att den som råkat radera filen i en rebase får veta
 * exakt vad som ska tillbaka.
 */
function läsBaslinje() {
  let rå
  try {
    rå = readFileSync(BASLINJE, 'utf8')
  } catch (err) {
    throw new Error(
      `Baslinjen går inte att läsa: ${BASLINJE}\n` +
        'Filen är obligatorisk även när den är TOM — en saknad fil är ett fel, ' +
        'inte noll poster. Se docblocket vid R5.\n' +
        `Ursprungligt fel: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  let parsad
  try {
    parsad = JSON.parse(rå)
  } catch (err) {
    throw new Error(
      `Baslinjen är inte giltig JSON: ${BASLINJE}\n` +
        `${err instanceof Error ? err.message : String(err)}`,
    )
  }
  if (!parsad || typeof parsad.poster !== 'object' || parsad.poster === null) {
    throw new Error(
      `Baslinjen saknar fältet "poster" (objekt): ${BASLINJE}\n` +
        'Ett tomt läge skrivs som "poster": {} — inte genom att utelämna fältet.',
    )
  }
  return parsad.poster
}

function kör() {
  const fel = []

  // Den delade skannerns egna kanariefåglar FÖRST: en vakt som bygger på en
  // trasig förbehandlare mäter bara de filer förbehandlaren klarade att läsa.
  const skannerFel = kanariefåglar()
  if (skannerFel.length > 0) {
    fel.push(`Den delade skannerns kanariefåglar föll:\n     • ${skannerFel.join('\n     • ')}`)
  }

  const verktyg = läsVerktyg(readFileSync(DEFINITION, 'utf8'))
  const deklarationText = readFileSync(DEKLARATION, 'utf8')
  const poster = läsDeklarationer(deklarationText)
  const rutter = läsRutter(readFileSync(ROUTER, 'utf8'))
  const klassificerade = läsKlassificerade(readFileSync(EFFEKTER, 'utf8'))
  const baslinje = läsBaslinje()

  // TOMHETSSPÄRRAR. Var och en av de tre mängderna kan bli tom av ett byte av
  // vy, en omdöpt konstant eller en flyttad fil — och en tom mängd ser exakt ut
  // som att allt är i ordning.
  if (verktyg.length < MIN_VERKTYG) {
    fel.push(`OMFÅNG: läste ${verktyg.length} ACTION_TOOLS (< ${MIN_VERKTYG}). Vakten mäter inte allt.`)
  }
  if (rutter.size < MIN_RUTTER) {
    fel.push(`OMFÅNG: läste ${rutter.size} rutter ur router.tsx (< ${MIN_RUTTER}).`)
  }
  if (poster.length === 0) {
    fel.push('OMFÅNG: läste noll poster ur HUMAN_PATHS. Vakten mäter ingenting.')
  }
  if (klassificerade.length < MIN_VERKTYG) {
    fel.push(
      `OMFÅNG: läste ${klassificerade.length} poster ur EFFECT_DECLARATIONS ` +
        `(< ${MIN_VERKTYG}). R5c hade då fällt varje baslinjepost av fel skäl.`,
    )
  }

  const katalogCache = new Map()
  const läsKatalog = (katalog) => {
    if (!katalogCache.has(katalog)) {
      const dir = join(FEATURES, katalog)
      let text = ''
      try {
        text = källfiler(dir)
          .map((f) => blankComments(readFileSync(f, 'utf8')))
          .join('\n')
      } catch {
        text = ''
      }
      katalogCache.set(katalog, text)
    }
    return katalogCache.get(katalog)
  }

  const { fel: regelFel, utanVäg } = utvärdera({
    verktyg,
    klassificerade,
    poster,
    rutter,
    läsKatalog,
    baslinje,
  })
  fel.push(...regelFel, ...prövaFailClosed(deklarationText))

  if (fel.length > 0) {
    console.error('❌ Delmängdsregeln:\n   • ' + fel.join('\n   • '))
    process.exit(1)
  }
  const medVäg = verktyg.length - utanVäg.length
  console.warn(
    `✅ Delmängdsregeln: ${verktyg.length} verktyg, ${medVäg} med en verifierad mänsklig väg ` +
      `(rutt finns i router.tsx, åtgärden finns i sidans katalog), ` +
      `${utanVäg.length} utan — alla ${utanVäg.length} står i tool-human-path.baseline.json ` +
      `med skäl och ärendeplats. ` +
      `${rutter.size} rutter lästa.`,
  )
}

if (process.argv.includes('--self-test')) självtest()
else kör()
