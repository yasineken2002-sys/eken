#!/usr/bin/env node
/**
 * KONTRAKTET MELLAN WEBB OCH API — nyttolastens typ ska vara DELAD.
 *
 * ── VARFÖR ──────────────────────────────────────────────────────────────────
 *
 * Varje POST/PATCH/PUT i `apps/web/src/features/*​/api/*.ts` skickar en
 * nyttolast som API:t validerar mot en DTO. Beskrivs formen på TVÅ ställen —
 * ett interface i webben och en class-validator-klass i API:t — vet ingen av
 * dem om den andra, och en glidning märks först som ett 400-svar i produktion.
 *
 * Uppmätt (#795): modalen skickade inget `vatAmount` medan DTO:n krävde det.
 * Varje registrering hade svarat 400, och **37 gröna prov** var fortsatt gröna
 * — samtliga anropade tjänsten direkt och gick förbi DTO:n. Det var alltså inte
 * en lucka i testtäckningen utan i KONTRAKTET, och en spärr mot fler av samma
 * form är billigare än ett prov per endpoint.
 *
 * ── VAD DEN HÄR VAKTEN INTE KAN SE ──────────────────────────────────────────
 *
 * Den mäter EN halva: att webben skickar en typ som bor i @eken/shared. Den kan
 * INTE se att API-sidans DTO använder samma schema — den läser inte
 * `apps/api/src/**​/dto`. En endpoint kan alltså vara grön här och ändå ha en
 * DTO som beskriver något annat.
 *
 * Den andra halvan bärs i dag av `implements`-raden och nyckelparitetsraden i
 * DTO:n (`SammaNycklar`, se packages/shared/src/schemas/contract.ts), som är
 * KOMPILERINGSFEL och alltså fälls av Typecheck-jobbet — inte av den här
 * vakten — samt av `supplier-invoice.dto.spec.ts`, som kör kroppen mot riktig
 * ValidationPipe. Att kräva den kopplingen för ALLA endpoints är nästa steg och
 * är INTE gjort: tre av 46 skrivvägar har den i dag.
 *
 * Den kan inte heller se om typen BESKRIVER rätt sak. Ett delat interface som
 * saknar ett fält servern kräver är grönt här.
 *
 * ── VYER ────────────────────────────────────────────────────────────────────
 *
 * TVÅ, vid samma index, därför att frågorna är olika (CLAUDE.md, "EN VY PER
 * FRÅGA"):
 *
 *   codeMask       finns här ett ANROP? — kommentarer och stränginnehåll
 *                  blankade, så `post(` inuti en sträng inte räknas och så
 *                  argumentmatchningen inte snubblar på ett kommatecken i en URL
 *   blankComments  vad STÅR det i URL-strängen? — den bor i en sträng, och
 *                  codeMask har per konstruktion blankat den
 *
 * Båda bevarar längd och radbrytningar, så samma index gäller i båda. En vakt
 * som bara använt codeMask hade rapporterat varje URL som tom; en som bara
 * använt blankComments hade räknat anrop som står i en sträng. Kanariefåglarna
 * kräver att de två vyerna ger OLIKA tal på en fixtur som innehåller båda
 * formerna — annars mäter de inte var sin sak.
 *
 * ── BASLINJEN ───────────────────────────────────────────────────────────────
 *
 * `request-contract.baseline.json` är MEDLEMMAR, inte ett tal, och fäller åt
 * BÅDA hållen: en överträdelse utanför baslinjen är NY, och en baslinjepost som
 * inte längre är en överträdelse är STALE. Den andra riktningen är den som gör
 * spärren till en spärr — utan den står en lagad endpoint kvar som accepterad
 * och formen kan återinföras i tystnad.
 *
 * Baslinjen får bara KRYMPA. Att lägga till en post är att ta på sig ny skuld
 * och ska motiveras i PR-texten.
 *
 * Kör:        node apps/api/scripts/check-request-contract.mjs
 * Självtest:  node apps/api/scripts/check-request-contract.mjs --self-test
 * Baslinje:   node apps/api/scripts/check-request-contract.mjs --skriv
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, relative } from 'node:path'
import {
  codeMask,
  blankComments,
  kanariefåglar,
  KANARIEFÅGEL_LÄGEN,
} from '../../../scripts/lib/source-scan.mjs'

const ROT = resolve(new URL('../../..', import.meta.url).pathname)
const KORPUS = 'apps/web/src/features'
const BASLINJE_PATH = join(new URL('.', import.meta.url).pathname, 'request-contract.baseline.json')

const SKRIVMETODER = ['post', 'patch', 'put']

/** Filerna som ÄR API-lagret: `features/<namn>/api/<fil>.ts`, inte prov. */
export function korpusfiler(rot = ROT) {
  const bas = join(rot, KORPUS)
  const ut = []
  for (const feature of readdirSync(bas)) {
    const apiKatalog = join(bas, feature, 'api')
    let poster
    try {
      poster = readdirSync(apiKatalog)
    } catch {
      continue
    }
    for (const namn of poster) {
      if (!namn.endsWith('.ts')) continue
      if (/\.(spec|test)\.ts$/.test(namn)) continue
      if (!statSync(join(apiKatalog, namn)).isFile()) continue
      ut.push(relative(rot, join(apiKatalog, namn)))
    }
  }
  return ut.sort()
}

/**
 * Namn importerade från @eken/shared — `import` och `import type` lika.
 *
 * Läses ur STRÄNGVYN, inte kodvyn. Modulsökvägen `'@eken/shared'` är en sträng,
 * och codeMask blankar den — en tidig version läste kodvyn och hittade därför
 * NOLL delade importer, vilket gjorde varje anrop till en överträdelse. Att
 * kanariefågeln med en känd delad typ fanns är enda skälet att det upptäcktes
 * i stället för att bli en baslinje med 114 poster som såg trovärdig ut.
 */
function delade(kod) {
  const namn = new Set()
  for (const m of kod.matchAll(/import\s+(?:type\s+)?\{([^{}]*)\}\s*from\s*'@eken\/shared'/g)) {
    for (const bit of m[1].split(',')) {
      const rent = bit
        .trim()
        .replace(/^type\s+/, '')
        .split(/\s+as\s+/)
        .pop()
      if (rent) namn.add(rent.trim())
    }
  }
  return namn
}

/** Slutindex för argumentlistan som börjar vid `start` (index på `(`). */
function slutparentes(kod, start) {
  let djup = 0
  for (let i = start; i < kod.length; i++) {
    const c = kod[i]
    if (c === '(' || c === '[' || c === '{') djup++
    else if (c === ')' || c === ']' || c === '}') {
      djup--
      if (djup === 0) return i
    }
  }
  return -1
}

/** Toppnivåargumenten mellan parenteserna, som [start, slut]-intervall. */
function argumentIntervall(kod, oppna, stang) {
  const ut = []
  let djup = 0
  let start = oppna + 1
  for (let i = oppna + 1; i < stang; i++) {
    const c = kod[i]
    if (c === '(' || c === '[' || c === '{') djup++
    else if (c === ')' || c === ']' || c === '}') djup--
    else if (c === ',' && djup === 0) {
      ut.push([start, i])
      start = i + 1
    }
  }
  ut.push([start, stang])
  return ut
}

/**
 * Typen på det som skickas som kropp.
 *
 * Ett identifierarargument följs till närmaste föregående `namn: Typ` i en
 * signatur. Det är en TEXTUELL upplösning, inte typcheckerns — se
 * begränsningarna överst. Den räcker för formen "en funktion tar emot dto och
 * skickar vidare den", som är hur allt i korpusen är skrivet, och den säger
 * OKÄND när den inte räcker i stället för att gissa.
 */
function kroppenstyp(kod, argtext, fore) {
  const t = argtext.trim()
  if (!t) return { form: 'INGEN KROPP' }
  if (t.startsWith('{')) return { form: 'INLINE-LITERAL' }
  // \p{L}, inte [A-Za-z]: en variabel som heter `ärende` eller `överforing` är
  // ett lika giltigt argument, och en ASCII-klass hade klassat den som UTTRYCK
  // och därmed tappat den ur mängden. Se CLAUDE.md om \b och ASCII.
  if (!/^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(t)) return { form: 'UTTRYCK', typ: t.slice(0, 40) }

  const GRANS_FORE = String.raw`(?<![\p{L}\p{N}_$])`
  const traff = [
    ...fore.matchAll(
      new RegExp(`${GRANS_FORE}${t}\\s*:\\s*([\\p{L}_$][\\p{L}\\p{N}_$.<>\\[\\]]*)`, 'gu'),
    ),
  ]
  const sista = traff[traff.length - 1]
  if (sista) {
    return { form: 'NAMNGIVEN', typ: sista[1].replace(/<.*$/, '').replace(/\[\]$/, '') }
  }

  // Ingen skriven annotering: en lokal variabel byggd med `new X(...)`. Formen
  // finns för multipart-uppladdningarna (`const formData = new FormData()`), och
  // utan den blev FormData-undantaget nedan en gren som ALDRIG kunde nås — en
  // kontroll som inte kan falla mäter ingenting. Uppmätt: undantaget skrevs
  // först mot `typ === 'FormData'` och träffade noll av de tre uppladdningarna.
  const konstruerad = [
    ...fore.matchAll(
      new RegExp(`${GRANS_FORE}${t}\\s*=\\s*new\\s+([\\p{L}_$][\\p{L}\\p{N}_$]*)`, 'gu'),
    ),
  ]
  const sistaNy = konstruerad[konstruerad.length - 1]
  if (sistaNy) return { form: 'KONSTRUERAD', typ: sistaNy[1] }

  return { form: 'OTYPAD', namn: t }
}

/** Alla skrivanrop i en fil, med typ och URL. */
export function anropIFil(kalla) {
  const kodvy = codeMask(kalla)
  const strangvy = blankComments(kalla)
  const delad = delade(strangvy)
  const ut = []

  for (const metod of SKRIVMETODER) {
    // Lookbehinden utesluter bokstäver och siffror (så `repost(` inte matchar)
    // men INTE punkt: `api.post(...)` är en lika verklig skrivväg som `post(...)`.
    // Uppmätt: med punkten i lookbehinden såg vakten 93 anrop där typcheckaren
    // såg 106 — tretton anrop, alla på formen `api.post`, föll tyst ur mängden.
    // Det var bara en jämförelse mot ett ANDRA instrument som visade det.
    const re = new RegExp(`(?<![\\p{L}\\p{N}_$])${metod}\\s*(?:<[^<>]*>)?\\s*\\(`, 'gu')
    for (const m of kodvy.matchAll(re)) {
      const oppna = kodvy.indexOf('(', m.index + metod.length)
      const stang = slutparentes(kodvy, oppna)
      if (stang < 0) continue
      const arg = argumentIntervall(kodvy, oppna, stang)

      // URL:en bor i en STRÄNG → läses ur strängvyn, vid samma index.
      const url = arg[0] ? strangvy.slice(arg[0][0], arg[0][1]).trim().slice(0, 70) : '?'
      const kroppText = arg[1] ? kodvy.slice(arg[1][0], arg[1][1]) : ''
      const typ = kroppenstyp(kodvy, kroppText, kodvy.slice(0, m.index))

      ut.push({
        metod: metod.toUpperCase(),
        url: url.replace(/\s+/g, ' '),
        rad: kalla.slice(0, m.index).split('\n').length,
        ...typ,
        delad: typ.form === 'NAMNGIVEN' && delad.has(typ.typ),
      })
    }
  }
  return ut
}

/** Överträdelser: ett skrivanrop med kropp vars typ inte kommer ur @eken/shared. */
export function overtradelser(rot = ROT) {
  const ut = []
  for (const fil of korpusfiler(rot)) {
    const kalla = readFileSync(join(rot, fil), 'utf8')
    for (const a of anropIFil(kalla)) {
      if (a.form === 'INGEN KROPP') continue
      if (a.delad) continue
      // MULTIPART: en FormData-kropp har ingen JSON-form att dela. Servern tar
      // emot den med @fastify/multipart, inte med en DTO, så ett Zod-schema
      // hade inte haft något att beskriva. Undantaget är SMALT med flit —
      // exakt typnamnet `FormData`, inget mönster — och kanariefågeln kräver
      // att ett annat namn fortfarande fälls.
      if (a.typ === 'FormData') continue
      ut.push({ fil, medlem: `${a.metod} ${a.url} → ${a.typ ?? a.form}` })
    }
  }
  return ut
}

function grupperad(lista) {
  const karta = new Map()
  for (const o of lista) {
    if (!karta.has(o.fil)) karta.set(o.fil, [])
    karta.get(o.fil).push(o.medlem)
  }
  return [...karta.entries()]
    .map(([fil, medlemmar]) => ({ fil, medlemmar: medlemmar.sort() }))
    .sort((a, b) => a.fil.localeCompare(b.fil))
}

function las(path = BASLINJE_PATH) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return { poster: [] }
  }
}

export function jamfor(nu, baslinje) {
  const fel = []
  const bkarta = new Map(baslinje.poster.map((p) => [p.fil, new Set(p.medlemmar)]))
  const nkarta = new Map(nu.map((p) => [p.fil, new Set(p.medlemmar)]))

  for (const post of nu) {
    const kanda = bkarta.get(post.fil) ?? new Set()
    for (const m of post.medlemmar) {
      if (!kanda.has(m)) {
        fel.push(
          `NY ${post.fil} — ${m}: nyttolastens typ måste komma från @eken/shared. ` +
            'Lägg ett Zod-schema i packages/shared/src/schemas och använd z.infer-typen ' +
            'på båda sidor (se contract.ts).',
        )
      }
    }
  }
  for (const post of baslinje.poster) {
    const finns = nkarta.get(post.fil) ?? new Set()
    for (const m of post.medlemmar) {
      if (!finns.has(m)) {
        fel.push(
          `STALE ${post.fil} — ${m} står i baslinjen men är inte längre en ` +
            'överträdelse. Ta bort raden ur request-contract.baseline.json i SAMMA PR.',
        )
      }
    }
  }
  return fel
}

// ── KANARIEFÅGLAR ───────────────────────────────────────────────────────────

const FIXTUR_DELAD = `
import { post } from '@/lib/api'
import type { CreatePropertyInput, Property } from '@eken/shared'
export const skapa = (dto: CreatePropertyInput) => post<Property>('/properties', dto)
`

const FIXTUR_EGEN = `
import { post } from '@/lib/api'
interface EgenInput { a: string }
export const skapa = (dto: EgenInput) => post<void>('/nagot', dto)
`

/**
 * Fixturen som skiljer VYERNA åt. Den bär ett anrop i KOD och ett till i en
 * STRÄNG. codeMask ser ett; blankComments ser två. Ger de samma tal mäter de
 * inte var sin sak, och då är tvåvymodellen ovan en dekoration.
 */
const FIXTUR_VYER = `
import { post } from '@/lib/api'
interface EgenInput { a: string }
const exempel = "post<void>('/i-en-strang', dto)"
export const skapa = (dto: EgenInput) => post<void>('/i-kod', dto)
`

const FIXTUR_MULTIPART = `
import { api } from '@/lib/api'
export async function ladda(fil: File) {
  const formData = new FormData()
  formData.append('file', fil)
  return api.post<void>('/import/preview', formData)
}
`

const FIXTUR_KONSTRUERAD_ANNAN = `
import { api } from '@/lib/api'
class EgenKropp {}
export async function skicka() {
  const kropp = new EgenKropp()
  return api.post<void>('/nagot', kropp)
}
`

function selfTest() {
  let fel = 0
  const f = (m) => {
    console.error(`❌ ${m}`)
    fel++
  }
  const ok = (m) => console.warn(`✅ ${m}`)

  // 1. En delad typ är ingen överträdelse.
  const delad = anropIFil(FIXTUR_DELAD)
  delad.length === 1 && delad[0].delad
    ? ok('delad nyttolasttyp känns igen')
    : f(`delad fixtur gav ${JSON.stringify(delad)}`)

  // 2. En egen typ ÄR en överträdelse.
  const egen = anropIFil(FIXTUR_EGEN)
  egen.length === 1 && !egen[0].delad
    ? ok('egen nyttolasttyp fälls')
    : f(`egen fixtur gav ${JSON.stringify(egen)}`)

  // 3. URL:en läses UR STRÄNGVYN — codeMask har blankat innehållet.
  egen[0]?.url.includes('/nagot')
    ? ok('URL läses ur strängvyn (codeMask hade gett tomt)')
    : f(`URL blev "${egen[0]?.url}" — strängvyn används inte`)

  // 4. VYERNA MÄTER OLIKA SAKER. Utan skillnad är tvåvymodellen dekoration.
  const iKod = anropIFil(FIXTUR_VYER).length
  const iStrangvy = [
    ...blankComments(FIXTUR_VYER).matchAll(/(?<![\p{L}\p{N}_$.])post\s*(?:<[^<>]*>)?\s*\(/gu),
  ].length
  iKod === 1 && iStrangvy === 2
    ? ok(`codeMask ${iKod} · blankComments ${iStrangvy} — vyerna ger OLIKA tal`)
    : f(`vyerna gav samma tal (codeMask ${iKod}, blankComments ${iStrangvy})`)

  // 5. Baslinjen fäller åt BÅDA hållen.
  const nu = grupperad([{ fil: 'a.ts', medlem: 'POST x → Egen' }])
  jamfor(nu, { poster: [] }).some((r) => r.startsWith('NY '))
    ? ok('NY: överträdelse utanför baslinjen fälls')
    : f('en okänd överträdelse fälldes inte')
  jamfor([], { poster: [{ fil: 'a.ts', medlem: undefined, medlemmar: ['POST x → Egen'] }] }).some(
    (r) => r.startsWith('STALE '),
  )
    ? ok('STALE: baslinjepost som inte längre är överträdelse fälls')
    : f('en stale baslinjepost fälldes inte')
  jamfor(nu, { poster: [{ fil: 'a.ts', medlemmar: ['POST x → Egen'] }] }).length === 0
    ? ok('exakt paritet → tyst')
    : f('paritet gav utslag (vakten fäller allt)')

  // 6. MULTIPART undantas — och undantaget är SMALT.
  const multipart = anropIFil(FIXTUR_MULTIPART)
  multipart.length === 1 && multipart[0].typ === 'FormData'
    ? ok('FormData känns igen som konstruerad kropp (annars nås undantaget aldrig)')
    : f(`multipart-fixturen gav ${JSON.stringify(multipart)}`)

  const annanNy = anropIFil(FIXTUR_KONSTRUERAD_ANNAN)
  annanNy.length === 1 && annanNy[0].typ === 'EgenKropp' && !annanNy[0].delad
    ? ok('en ANNAN konstruerad kropp fälls fortfarande — undantaget gäller bara FormData')
    : f(`konstruerad-annan gav ${JSON.stringify(annanNy)}`)

  // 7. `api.post(...)` räknas, inte bara `post(...)`.
  anropIFil(FIXTUR_MULTIPART).length === 1
    ? ok('api.post räknas — punktformen är en lika verklig skrivväg')
    : f('api.post räknades inte')

  // 8. DEN DELADE SKANNERNS EGNA KANARIEFÅGLAR. Vakten läser världen genom
  // codeMask och blankComments — går de sönder mäter den fel utan att bli röd.
  // Kravet kommer ur check-guard-preprocessors (R2), och det är rätt krav.
  // `kanariefåglar()` returnerar FELEN, inte proven — tom lista betyder grönt.
  // Första versionen filtrerade `!k.ok` på strängar och blev därför sann om en
  // TOM mängd: den hade varit grön även med skannern helt sönder. Därför krävs
  // också att provmängden är icke-trivial, så en krympande svit syns.
  const skannerfel = kanariefåglar()
  for (const rad of skannerfel) f(`delad källskanner: ${rad}`)
  skannerfel.length === 0 && KANARIEFÅGEL_LÄGEN.length >= 5
    ? ok(`den delade skannern: ${KANARIEFÅGEL_LÄGEN.length} lägen provade, noll fel`)
    : f(`skannerns provmängd är ${KANARIEFÅGEL_LÄGEN.length} lägen — för liten`)

  // 9. Korpusen är inte tom — en vakt utan filer mäter ingenting.
  const filer = korpusfiler()
  filer.length > 10
    ? ok(`korpus: ${filer.length} api-filer`)
    : f(`korpusen är ${filer.length} filer — för liten för att vara korpusen`)

  console.warn(`\nSjälvtest: ${fel === 0 ? 'alla gröna' : `${fel} FALLERADE`}`)
  process.exit(fel === 0 ? 0 : 1)
}

// ── HUVUDKÖRNING ────────────────────────────────────────────────────────────

if (process.argv.includes('--self-test')) {
  selfTest()
} else {
  const nu = grupperad(overtradelser())
  const antal = nu.reduce((s, p) => s + p.medlemmar.length, 0)

  if (process.argv.includes('--skriv')) {
    writeFileSync(BASLINJE_PATH, `${JSON.stringify({ total: antal, poster: nu }, null, 2)}\n`)
    console.warn(`Baslinje skriven: ${antal} överträdelser i ${nu.length} filer.`)
    process.exit(0)
  }

  const baslinje = las()
  const fel = jamfor(nu, baslinje)
  if (fel.length) {
    console.error('❌ Kontraktet webb↔API: nyttolasttyper som inte är delade\n')
    for (const f of fel) console.error(`  ${f}`)
    console.error(
      '\nRegeln: varje POST/PATCH/PUT i apps/web/src/features/*/api/*.ts ska skicka en\n' +
        'nyttolast vars typ bor i @eken/shared. Baslinjen får bara KRYMPA.\n',
    )
    process.exit(1)
  }
  console.warn(
    `✅ Kontraktet webb↔API: ${antal} kända överträdelser i ${nu.length} filer, ` +
      'inga nya och inga stale.',
  )
  console.warn(
    '   Vakten mäter WEBBENS halva. Att API:ts DTO använder samma schema bärs av ' +
      'SammaNycklar-raden i DTO:n (Typecheck) och av dto.spec-provet — inte av den här.',
  )
}
