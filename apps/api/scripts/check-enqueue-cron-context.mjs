#!/usr/bin/env node
/**
 * ETT enqueueSafely-ANROP I EN CRON-FIL MÅSTE LÄMNA SIN KONTEXT (#605).
 *
 * ── VARFÖR REGELN FINNS ─────────────────────────────────────────────────────
 *
 * `enqueueSafely` loggar lokalt, larmar skrubbat till Sentry och **kastar
 * aldrig** — den returnerar ett utfall. Det gör den till samma farliga form som
 * per-org-looparna: köandet misslyckas, jobbet fortsätter, körningen ser lyckad
 * ut, och felet finns ingenstans att fråga efter i morgon.
 *
 * Hjälparen kan inte lösa det själv. Den bär TVÅ felkontrakt — samma anrop sker
 * på cron-vägen och på HTTP-vägen — och den kan inte veta vilken den är i.
 * Alltså gissar den inte: ANROPAREN lämnar kontexten (`cron: { name, sink }`).
 * Saknas den beter sig hjälparen exakt som förut, så HTTP-vägen är oförändrad
 * per konstruktion och inte per försiktighet.
 *
 * Invarianten "exakt en sänkrad per fel" håller av sig själv: eftersom
 * `enqueueSafely` aldrig kastar ser ett yttre `runCronSafely` aldrig felet och
 * kan inte rapportera det en andra gång. Raden skrivs där kontexten finns.
 *
 * ── VAD REGELN FRÅGAR ───────────────────────────────────────────────────────
 *
 * För varje fil som innehåller `@Cron`: lämnar VARJE `enqueueSafely`-anrop i
 * den filen en cron-kontext?
 *
 * Det är en FORMREGEL, inte en nåbarhetsanalys. Den fångar det som faktiskt
 * återfaller: någon lägger till ett nytt `enqueueSafely` i en fil som redan har
 * cron-jobb och glömmer kontexten. Den säger INGET om filer utan `@Cron` som
 * ändå nås från ett cron-jobb — `avisering/avisering.service.ts` är just en
 * sådan, och den täcks av en genomtrådad parameter i stället för av den här
 * regeln. Gränsen står här med flit: en regel som låtsas mäta nåbarhet men
 * mäter filnamn är sämre än en som säger vad den mäter.
 *
 * ── SPRIDNINGEN ÄR INTE VALFRI ATT FÖRSTÅ ───────────────────────────────────
 *
 * `leases.service.ts` bygger ett gemensamt `base`-objekt och sprider det i tre
 * anrop. En regel som bara letar efter `cron:` i argumenten hade fällt alla tre
 * — och en regel som accepterar vilken spridning som helst hade släppt igenom
 * ett `base` UTAN kontext. Därför löses spridningen upp ETT steg: `...ident`
 * slås upp mot `const ident = { … }` i samma fil, och det objektet frågas i sin
 * tur. Kanariefågeln nedan matar in båda fallen och kräver motsatt utfall — ett
 * prov som bara visar det positiva hade inte skilt analysen från en blind regel.
 *
 * Frågan ställs mot KOD (`codeMask`): ett `cron:` i en kommentar ska inte
 * uppfylla någonting.
 *
 * Kör:        node apps/api/scripts/check-enqueue-cron-context.mjs
 * Självtest:  node apps/api/scripts/check-enqueue-cron-context.mjs --self-test
 */
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { codeMask, kanariefåglar } from '../../../scripts/lib/source-scan.mjs'
import { källfiler } from './check-cron-error-sink.mjs'

/** MÄTT mot d0920af: 4 filer med både @Cron och enqueueSafely, 6 anrop i dem. */
const MIN_FILER = 3
const MIN_ANROP = 5

/** Matchande slutparentes från och med `från`. Förutsätter en KOD-vy. */
export function slutparentes(kod, från) {
  const j = kod.indexOf('(', från)
  if (j < 0) return null
  let d = 0
  for (let k = j; k < kod.length; k++) {
    if (kod[k] === '(') d++
    else if (kod[k] === ')') {
      d--
      if (!d) return [j, k]
    }
  }
  return null
}

/**
 * Slår upp `const <ident> = { … }` i samma fil och returnerar objektets kropp.
 * ETT steg — ingen transitiv upplösning. Räcker den inte är svaret "nej", vilket
 * fäller: en spridning vi inte kan följa får aldrig räknas som uppfylld.
 */
export function slåUppObjekt(kod, ident) {
  const m = new RegExp(`\\bconst\\s+${ident}\\s*=\\s*\\{`).exec(kod)
  if (!m) return null
  const start = kod.indexOf('{', m.index)
  let d = 0
  for (let k = start; k < kod.length; k++) {
    if (kod[k] === '{') d++
    else if (kod[k] === '}') {
      d--
      if (!d) return kod.slice(start, k + 1)
    }
  }
  return null
}

/** Bär anropets argument en cron-kontext — direkt eller via EN spridning? */
export function lämnarKontext(kod, argument) {
  if (/\bcron\s*:/.test(argument)) return true
  for (const m of argument.matchAll(/\.\.\.\s*([\p{L}\p{N}_$]+)(?![\p{L}\p{N}_$])/gu)) {
    const kropp = slåUppObjekt(kod, m[1])
    if (kropp && /\bcron\s*:/.test(kropp)) return true
  }
  return false
}

/** Alla enqueueSafely-anrop i en fil, med sitt utfall. Exporterad för provet. */
export function anropIFil(text) {
  const kod = codeMask(text)
  const harCron = /@Cron\s*\(/.test(kod)
  const ut = []
  for (const m of kod.matchAll(/\benqueueSafely\s*\(/g)) {
    const p = slutparentes(kod, m.index + 'enqueueSafely'.length)
    if (!p) continue
    const [j, k] = p
    ut.push({
      rad: kod.slice(0, m.index).split('\n').length,
      ok: lämnarKontext(kod, kod.slice(j, k + 1)),
    })
  }
  return { harCron, anrop: ut }
}

/** Kärnan. Exporterad så självtestet kör exakt samma kod som CI. */
export function evaluate(filer) {
  const problem = []
  let cronFiler = 0
  let cronAnrop = 0

  for (const { fil, text } of filer) {
    const { harCron, anrop } = anropIFil(text)
    if (!harCron || anrop.length === 0) continue
    cronFiler++
    cronAnrop += anrop.length
    for (const a of anrop) {
      if (a.ok) continue
      problem.push({
        rule: `\`${fil}:${a.rad}\` — enqueueSafely i en cron-fil utan cron-kontext`,
        detail:
          'enqueueSafely kastar aldrig, så ett yttre runCronSafely ser aldrig felet. ' +
          'Utan `cron: { name, sink }` finns ett misslyckat köande ingenstans att fråga ' +
          'efter i morgon. Lämna kontexten från anroparen — hjälparen ska inte gissa.',
      })
    }
  }

  if (cronFiler === 0) {
    problem.push({
      rule: 'NOLL cron-filer med enqueueSafely — mängden är tom',
      detail:
        'En regel med tom mängd är grön för alltid. Antingen har härledningen slutat ' +
        'fungera, eller så finns formen inte längre — och då ska regeln tas bort, inte ' +
        'stå kvar och se ut att mäta något.',
    })
  }

  return { problem, cronFiler, cronAnrop }
}

function läs() {
  return källfiler()
    .filter((f) => !/\.spec\.ts$/.test(f))
    .map((f) => ({ fil: f.replace(/.*\/src\//, ''), text: readFileSync(f, 'utf8') }))
}

// ── prov ────────────────────────────────────────────────────────────────────

const PROV = {
  utanKontext: `
export class X {
  @Cron('0 9 * * *')
  async jobb(): Promise<void> {
    await enqueueSafely(() => this.q.enqueue({}), { queue: 'q', jobType: 't' })
  }
}`,
  medKontext: `
export class X {
  @Cron('0 9 * * *')
  async jobb(): Promise<void> {
    await enqueueSafely(() => this.q.enqueue({}), {
      queue: 'q',
      jobType: 't',
      cron: { name: 'x', sink: this.cronErrors },
    })
  }
}`,
  // Spridningen: samma form, enda skillnaden är om `base` bär kontexten.
  spridningMed: `
export class X {
  @Cron('0 9 * * *')
  async jobb(): Promise<void> {
    const base = { queue: 'q', logger: this.logger, cron: { name: 'x', sink: this.s } }
    await enqueueSafely(() => this.q.enqueue({}), { ...base, jobType: 't' })
  }
}`,
  spridningUtan: `
export class X {
  @Cron('0 9 * * *')
  async jobb(): Promise<void> {
    const base = { queue: 'q', logger: this.logger }
    await enqueueSafely(() => this.q.enqueue({}), { ...base, jobType: 't' })
  }
}`,
  // KOMMENTARSPROVET: identifieraren står i prosa, inte i kod.
  baraKommentar: `
export class X {
  @Cron('0 9 * * *')
  async jobb(): Promise<void> {
    // cron: { name: 'x', sink: this.cronErrors } — TODO, inte gjort än
    await enqueueSafely(() => this.q.enqueue({}), { queue: 'q', jobType: 't' })
  }
}`,
  // Ingen @Cron i filen → utanför regelns omfång, ska INTE fällas.
  utanCron: `
export class X {
  async httpVäg(): Promise<void> {
    await enqueueSafely(() => this.q.enqueue({}), { queue: 'q', jobType: 't' })
  }
}`,
}

function självtest() {
  let fel = 0
  const t = (namn, ok, extra = '') => {
    console.warn(`${ok ? '✅' : '❌'} ${namn}${extra ? '  → ' + extra : ''}`)
    if (!ok) fel++
  }
  // ── #713: SPRIDNINGENS VARIABELNAMN ─────────────────────────────────────
  //
  // Kontexten får lämnas via EN spridning: `enqueueSafely(kön, { ...bas })`,
  // där `bas` är ett objekt med `cron:`. Namnet härleddes med
  // `[A-Za-z_$][\w$]*`, som är ASCII.
  //
  // Uppmätt mot origin/main, med `const ärKontext = { cron: true }`:
  //
  //   { ...ärKontext }        → false   MISSAD, spridningen slås aldrig upp
  //   { ...kontextFörCron }   → false   KAPAD, namnet blir "kontextF" och
  //                                     uppslaget hittar inget objekt
  //
  // Båda ger FALSKLARM: anropet rapporteras sakna cron-kontext fast objektet
  // det sprider bär den. Vakten pekar då ut en rad som redan är rätt.
  {
    const kod = (namn) => `const ${namn} = { cron: true }\nawait enqueueSafely(kön, { ...${namn} })`
    for (const namn of ['ärKontext', 'kontextFörCron'])
      t(`#713 MISSAD/KAPAD: spridning av \`${namn}\` ses`,
        lämnarKontext(kod(namn), `{ ...${namn} }`))
    t('#713 MOTPROV: ren ASCII fungerar som förut',
      lämnarKontext(kod('bas'), '{ ...bas }'))
    t('#713 MOTPROV: en spridning av ett objekt UTAN cron: räknas inte',
      !lämnarKontext('const ärTom = { x: 1 }\nawait enqueueSafely(kön, { ...ärTom })', '{ ...ärTom }'))
    t('#713 MOTPROV: ett objekt som inte finns räknas inte',
      !lämnarKontext('await enqueueSafely(kön, { ...ärOkänd })', '{ ...ärOkänd }'))
  }

  const fäller = (src) =>
    evaluate([{ fil: 'p.ts', text: src }]).problem.some((p) => p.rule.includes('utan cron-kontext'))

  // (0) Den delade skannerns kanariefåglar — metavaktens krav.
  const skanner = kanariefåglar()
  t('delad skanner: kanariefåglarna gröna', skanner.length === 0, skanner.join(' | '))

  // (1) REGELN — grundfallen.
  t('anrop utan kontext i en cron-fil FÄLLS', fäller(PROV.utanKontext))
  t('anrop med kontext går igenom', !fäller(PROV.medKontext))

  // (2) SPRIDNINGSKANARIEFÅGELN. Samma form, motsatt utfall — det är den som
  //     skiljer en riktig upplösning från en regel som accepterar vilken
  //     spridning som helst (eller fäller alla).
  t('spridning där base BÄR kontexten går igenom', !fäller(PROV.spridningMed))
  t('spridning där base SAKNAR kontexten FÄLLS', fäller(PROV.spridningUtan))

  // (3) PROSA ÄR INTE KOD.
  t('kontext enbart i en kommentar FÄLLS', fäller(PROV.baraKommentar))

  // (4) OMFÅNGET — regeln får inte bre ut sig över HTTP-vägar.
  t('fil utan @Cron ligger utanför regeln', !fäller(PROV.utanCron))

  // (5) OMFÅNGSKANARIEFÅGELN — tom mängd fäller, och golven är MÄTTA.
  const tom = evaluate([{ fil: 'p.ts', text: 'export class X {}' }])
  t('OMFÅNG: en tom mängd fälls', tom.problem.some((p) => p.rule.includes('NOLL cron-filer')))

  const riktigt = evaluate(läs())
  t(
    `OMFÅNG: ${riktigt.cronFiler} cron-filer med enqueueSafely (golv ${MIN_FILER})`,
    riktigt.cronFiler >= MIN_FILER,
  )
  t(
    `OMFÅNG: ${riktigt.cronAnrop} anrop i dem (golv ${MIN_ANROP})`,
    riktigt.cronAnrop >= MIN_ANROP,
  )

  // (6) Kodbasen uppfyller regeln i dag.
  t(
    'kodbasen uppfyller regeln',
    riktigt.problem.length === 0,
    riktigt.problem.map((p) => p.rule).slice(0, 3).join(' | '),
  )

  console.warn(fel === 0 ? '\n✅ Självtest OK.' : `\n❌ Självtest: ${fel} fallerade.`)
  process.exit(fel === 0 ? 0 : 1)
}

function kör() {
  const { problem, cronFiler, cronAnrop } = evaluate(läs())
  if (problem.length > 0) {
    console.error('\n=== enqueueSafely UTAN CRON-KONTEXT (CI-guard) ===\n')
    for (const p of problem) console.error(`❌ ${p.rule}\n   ${p.detail}`)
    console.error(
      '\nRegeln: enqueueSafely kastar aldrig. Ett misslyckat köande på cron-vägen\n' +
        'passerar därför FÖRBI runCronSafely och finns ingenstans att fråga efter i\n' +
        'morgon. Hjälparen kan inte gissa vilket felkontrakt den är i — anroparen\n' +
        'lämnar kontexten. Se #605.\n',
    )
    process.exit(1)
  }
  console.warn(
    `✅ ${cronAnrop} enqueueSafely-anrop i ${cronFiler} filer med @Cron — alla lämnar cron-kontext.`,
  )
}

const körsDirekt = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (!körsDirekt) {
  // importerad — exportera bara
} else if (process.argv.includes('--self-test')) självtest()
else kör()
