#!/usr/bin/env node
/**
 * VARJE @Cron MÅSTE NÅ EN VARAKTIG FELSÄNKA (#605).
 *
 * ── VAD SOM MÄTTES ──────────────────────────────────────────────────────────
 *
 * Mot `befee7b`, per METODKROPP och med `*Unsafe`-delegaten följd:
 *
 *     25 @Cron-jobb
 *      0  skriver till ErrorLog
 *     12  har någon varaktig rapportväg (Sentry direkt, runCronSafely,
 *         forEachOrgSafely)
 *     13  har ENDAST den lokala loggen
 *
 * En filnivå-mätning gav först 17 via `runCronSafely` — fel, eftersom
 * `notifications.service.ts` använder hjälparen för TVÅ ANDRA jobb än
 * morgonrapporten. Talet 12 gäller per jobb; skillnaden är hela poängen med att
 * mäta metodkroppen.
 *
 * Den lokala loggen överlever inte containern: 204 merges till main på 30 dagar
 * betyder minst lika många containerbyten. Ett cron-fel från förra veckan finns
 * ingenstans att fråga efter.
 *
 * ── DEN FARLIGA FORMEN ──────────────────────────────────────────────────────
 *
 * 5 av 25 fångar fel INUTI en loop, räknar upp en räknare, fortsätter, och
 * loggar sedan en summering på `log`-nivå:
 *
 *     reclassifyProbableLosses · escalateRemindedToInkassoReady
 *     sendMorningInsights · sendWeeklySummary · sendMonthlyReport
 *
 * Körningen rapporterar "3 skickade, 2 misslyckade" och SER LYCKAD UT. En kund
 * som slutat få sin morgonrapport syns som ett tal i en logg som roteras bort.
 *
 * ── VAD REGELN FRÅGAR ───────────────────────────────────────────────────────
 *
 * Inte "finns det felhantering" — det finns det, och den är just problemet.
 * Utan: NÅR jobbet sänkan? Alltså om jobbets kropp (eller dess `*Unsafe`-
 * delegat) skickar en `sink` till cron-hjälparna, eller anropar sänkans
 * rapportmetod direkt.
 *
 * BÅDE mängden cron-jobb OCH sänkans metodnamn HÄRLEDS ur koden. Ingen av dem
 * listas — samma läxa som #600: en uppräkning blir tyst grön den dag något
 * döps om eller läggs till.
 *
 * Kör:        node apps/api/scripts/check-cron-error-sink.mjs
 * Självtest:  node apps/api/scripts/check-cron-error-sink.mjs --self-test
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { codeMask, kanariefåglar } from '../../../scripts/lib/source-scan.mjs'
import { findCronJobs } from './check-cron-classification.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..', 'src')
const SINK_FILE = join(SRC, 'common', 'cron', 'cron-error-sink.ts')
const ACK_FILE = join(HERE, 'cron-error-sink.ack.json')
const MIN_SKÄL = 40

/**
 * HUR MAN UPPFYLLER REGELN — RÄTT.
 *
 * Det här är med flit den FÖRSTA texten en fällning visar, och kvitteringen
 * står sist. En vakt som bara dokumenterar hur man tystar den kommer att tystas:
 * nästa person läser under tidspress, och den enda vägen som står skriven är
 * den hen tar.
 *
 * Exemplet är den riktiga konverteringen av morgonrapporten (#605 batch 1).
 */
const RÄTT_VÄG = [
  'Ett fel här lever bara i containerns logg, som inte överlever nästa deploy.',
  '',
  'SÅ HÄR GÖR DU RÄTT — två vägar, båda beprövade i batch 1:',
  '',
  '  (1) Går jobbet redan via cron-hjälparna? Skicka sänkan som option:',
  '        await runCronSafely(namn, () => this.gör(), { logger, sink: this.cronErrors })',
  '        await forEachOrgSafely(namn, orgar, fn, { orgIdOf: o => o.id, sink: this.cronErrors })',
  '',
  '  (2) Fångar jobbet per organisation i en egen loop? Lägg rapporten BREDVID',
  '      den befintliga logger.error — aldrig i stället för:',
  '        } catch (err) {',
  '          this.logger.error(`… ${org.id}: ${String(err)}`)   // ← står kvar',
  '          await this.cronErrors.report(namn, err, {',
  '            organizationId: org.id,',
  '            detail: { steg: "generering" },',
  '          })',
  '          failed++',
  '        }',
  '',
  '  Injicera CronErrorSink i konstruktorn och importera CronErrorSinkModule i',
  '  modulen. Vakten härleder bindningen ur typen, så namnet spelar ingen roll.',
  '',
  'INGET FÅR BLI TYSTARE. Sänkan läggs TILL; den ersätter aldrig en logg. Byter',
  'du en synlig utskrift mot en rad ingen läser har du gjort saken värre.',
  '',
  'Går det verkligen inte nu: kvittera i cron-error-sink.ack.json med ett skäl',
  'som säger VARFÖR och VEM som äger konverteringen. Kvitteringen är den SÄMRE',
  'utvägen och listan fäller åt båda hållen — den dag jobbet når sänkan blir en',
  'kvarglömd post röd.',
].join('\n   ')

/** Alla .ts under src, utom specar. */
export function källfiler(dir = SRC, ut = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) källfiler(p, ut)
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts')) ut.push(p)
  }
  return ut
}

/**
 * Sänkans rapportmetod(er), HÄRLEDDA ur klassen.
 *
 * Formen: en publik `async`-metod på `CronErrorSink` vars första parameter är
 * `cronName: string`. Det är vad som gör en metod till en rapportväg, och det
 * går inte att råka uppfylla. Döps `report` om följer vakten med.
 */
export function härledSänkmetoder(sinkText) {
  const kod = codeMask(sinkText)
  return [
    ...kod.matchAll(/\basync\s+(\w+)\s*\(\s*cronName\s*:\s*string\s*,/g),
  ].map((m) => m[1])
}

/** Metodkroppen för `metod`, klammerbalanserad, ur en KOD-mask. */
export function metodkropp(kod, metod) {
  const start =
    new RegExp(`\\b${metod}\\s*\\([^)]*\\)\\s*:[^{]*\\{`).exec(kod) ??
    new RegExp(`\\b${metod}\\s*\\(`).exec(kod)
  if (!start) return ''
  const i = kod.indexOf('{', start.index)
  if (i < 0) return ''
  let djup = 0
  for (let j = i; j < kod.length; j++) {
    if (kod[j] === '{') djup++
    else if (kod[j] === '}') {
      djup--
      if (djup === 0) return kod.slice(i, j + 1)
    }
  }
  return kod.slice(i)
}

/**
 * Namnen som är BUNDNA till `CronErrorSink` i filen — härledda ur injektionen.
 *
 * ── VARFÖR INTE BARA LETA EFTER `.report(` ─────────────────────────────────
 *
 * Det var första versionen, och den gav ett FALSKT POSITIVT åt det farligaste
 * hållet. `ai-retention.service.ts` har en egen metod som heter `report`:
 *
 *     this.report(outcome)      ← tjänstens egen utfallsrapport, inte sänkan
 *
 * Vakten sa alltså "täckt" om ett jobb som inte var det. En vakt som ljuger åt
 * det hållet är värre än ingen vakt: den stänger frågan.
 *
 * Formen är därför BINDNINGEN: en konstruktorparameter eller ett fält vars typ
 * är `CronErrorSink`. Typnamnet härleds i sin tur ur sänkans egen fil, så en
 * omdöpning följer med.
 */
export function härledSänkbindningar(text, klassnamn) {
  const kod = codeMask(text)
  return [
    ...kod.matchAll(new RegExp(`(?:private|public|protected|readonly|\\s)\\s*(\\w+)\\s*:\\s*${klassnamn}\\b`, 'g')),
  ].map((m) => m[1])
}

/** Klassnamnet på sänkan, härlett ur dess fil. */
export function härledSänkklass(sinkText) {
  const m = /export\s+class\s+(\w+)/.exec(codeMask(sinkText))
  return m ? m[1] : null
}

/**
 * Når jobbet sänkan?
 *
 * Kräver BÅDE att filen binder en `CronErrorSink` OCH att jobbets kropp
 * använder just den bindningen — som `sink:`-option till cron-hjälparna, eller
 * genom att anropa en av sänkans härledda rapportmetoder på den.
 *
 * Kroppen är jobbets metod PLUS dess `*Unsafe`-delegat i samma fil — det är dit
 * varje låst cron flyttar sitt riktiga arbete, och där felhanteringen bor.
 */
export function nårSänkan(text, metod, sänkmetoder, bindningar) {
  if (!bindningar || bindningar.length === 0) return false
  const kod = codeMask(text)
  const unsafe = `${metod}Unsafe`
  const allt = metodkropp(kod, metod) + '\n' + (kod.includes(unsafe) ? metodkropp(kod, unsafe) : '')
  for (const b of bindningar) {
    // …som option till en cron-hjälpare
    if (new RegExp(`\\bsink\\s*:\\s*[\\w.]*\\b${b}\\b`).test(allt)) return true
    // …eller genom ett direkt anrop på bindningen
    if (sänkmetoder.some((m) => new RegExp(`\\b${b}\\s*\\.\\s*${m}\\s*\\(`).test(allt))) return true
  }
  return false
}

/** Kärnan. Exporterad så självtestet kör exakt samma kod som CI. */
export function evaluate({ jobb, sänkmetoder, sänkklass = 'CronErrorSink', ack }) {
  const problem = []
  const poster = ack?.jobs ?? {}

  if (jobb.length === 0) {
    problem.push({
      rule: 'NOLL @Cron-jobb härleddes ur koden',
      detail: 'Skanningen har gått blind — en vakt utan mätobjekt mäter ingenting.',
    })
    return problem
  }
  if (sänkmetoder.length === 0) {
    problem.push({
      rule: 'ingen rapportmetod kunde härledas ur cron-error-sink.ts',
      detail:
        'Regeln frågar efter en form och har då ingen form att fråga efter. Har ' +
        'CronErrorSink bytt filnamn, eller signaturen `cronName: string` som ' +
        'första parameter? Rätta härledningen — kvittera den inte.',
    })
    return problem
  }

  const utan = []
  for (const j of jobb) {
    if (nårSänkan(j.text, j.metod, sänkmetoder, härledSänkbindningar(j.text, sänkklass))) {
      // ÅT ANDRA HÅLLET: en kvittering för ett jobb som REDAN nått sänkan är
      // inaktuell. Utan den halvan blir listan en tejpbit ingen tar bort.
      if (poster[j.nyckel]) {
        problem.push({
          rule: `\`${j.nyckel}\` är kvitterat men når REDAN sänkan`,
          detail:
            'Konverteringen är gjord — ta bort posten ur cron-error-sink.ack.json. ' +
            'En kvitteringslista som bara kan växa slutar vara en skuld och blir en ursäkt.',
        })
      }
      continue
    }
    utan.push(j.nyckel)
    const post = poster[j.nyckel]
    if (!post) {
      problem.push({
        rule: `\`${j.nyckel}\` når ingen varaktig felsänka`,
        detail: RÄTT_VÄG,
      })
    } else if ((post.reason ?? '').trim().length < MIN_SKÄL) {
      problem.push({
        rule: `\`${j.nyckel}\` har en kvittering med för tunt skäl (${
          (post.reason ?? '').trim().length
        } < ${MIN_SKÄL})`,
        detail:
          'En kvitteringslista utan skäl är en lista över saker ingen minns varför ' +
          'de står där.',
      })
    }
  }

  // Kvitteringar för jobb som inte finns kvar.
  const funna = new Set(jobb.map((j) => j.nyckel))
  for (const nyckel of Object.keys(poster)) {
    if (!funna.has(nyckel)) {
      problem.push({
        rule: `kvittering för \`${nyckel}\`, som inte motsvarar något @Cron`,
        detail: 'Jobbet är borttaget eller omdöpt. Ta bort posten.',
      })
    }
  }

  return problem.map((p) => ({ ...p, utan }))
}

function allaJobb() {
  const filer = källfiler().map((p) => ({
    fil: relative(SRC, p).split('\\').join('/'),
    text: readFileSync(p, 'utf8'),
  }))
  return findCronJobs(filer)
}

// ── självtest ────────────────────────────────────────────────────────────────
const SÄNKA_FIXTUR = `
@Injectable()
export class CronErrorSink {
  async report(cronName: string, err: unknown): Promise<void> {}
}
`
// FIXTURNAMNEN ÄR ASCII MED FLIT. `findCronJobs` matchar metodnamnet med `\w`,
// som är ASCII-only — ett jobb som hette `medSänka` deriveras inte alls. Mätt
// mot befee7b: ingen riktig @Cron-metod har icke-ASCII i namnet (25 jobb med
// båda teckenklasserna), så begränsningen är latent. Men en fixtur som råkar
// utlösa den mäter sin egen stavning i stället för regeln.
const JOBB_MED = {
  fil: 'x/med.service.ts',
  text: `
  constructor(private readonly sink: CronErrorSink) {}

  @Cron('0 1 * * *')
  async medSink(): Promise<void> {
    await runCronSafely('med', () => this.medSinkUnsafe(), { sink: this.sink })
  }
  private async medSinkUnsafe(): Promise<void> {}`,
}
const JOBB_UTAN = {
  fil: 'x/utan.service.ts',
  text: `
  @Cron('0 2 * * *')
  async utanSink(): Promise<void> {
    try {
      await this.gör()
    } catch (err) {
      this.logger.error('gick fel: ' + String(err))
    }
  }`,
}
const JOBB_DIREKT = {
  fil: 'x/direkt.service.ts',
  text: `
  constructor(private readonly sink: CronErrorSink) {}

  @Cron('0 3 * * *')
  async direkt(): Promise<void> {
    try {
      await this.gör()
    } catch (err) {
      await this.sink.report('direkt', err)
    }
  }`,
}

/**
 * Det UPPMÄTTA falsklarmet: en tjänst med en EGEN metod som heter `report`.
 * `ai-retention.service.ts` har `this.report(outcome)`. Utan bindningskravet sa
 * vakten "täckt" om ett jobb som inte var det — ett falskt positivt åt det
 * farligaste hållet, eftersom det STÄNGER frågan.
 */
const JOBB_EGEN_REPORT = {
  fil: 'x/egen.service.ts',
  text: `
  @Cron('0 4 * * *')
  async egenReport(): Promise<void> {
    const outcome = await this.gör()
    this.report(outcome)
  }`,
}

function självtest() {
  let fel = 0
  const t = (namn, ok, extra = '') => {
    console.warn(`${ok ? '✅' : '❌'} ${namn}${extra ? '  → ' + extra : ''}`)
    if (!ok) fel++
  }

  // (0) Den delade skannerns kanariefåglar — metavaktens R2.
  const skanner = kanariefåglar()
  t(
    `delad skanner: kanariefåglarna gröna`,
    skanner.length === 0,
    skanner.join(' | '),
  )

  // (1) HÄRLEDNINGEN av sänkans metodnamn.
  const fixturMetoder = härledSänkmetoder(SÄNKA_FIXTUR)
  t('härleder rapportmetoden ur fixturen', fixturMetoder.join(',') === 'report', fixturMetoder.join(','))
  const riktigaMetoder = härledSänkmetoder(readFileSync(SINK_FILE, 'utf8'))
  t('härleder rapportmetoden ur den RIKTIGA sänkan', riktigaMetoder.length >= 1, riktigaMetoder.join(', '))

  // (2) REGELKANARIEFÅGELN — ett nytt jobb utan sänka MÅSTE fälla.
  const jobbMed = findCronJobs([JOBB_MED])
  const jobbUtan = findCronJobs([JOBB_UTAN])
  const jobbDirekt = findCronJobs([JOBB_DIREKT])
  t('fixturerna ger ett jobb var', jobbMed.length === 1 && jobbUtan.length === 1 && jobbDirekt.length === 1,
    `${jobbMed.length}/${jobbUtan.length}/${jobbDirekt.length}`)

  const utanFynd = evaluate({ jobb: jobbUtan, sänkmetoder: riktigaMetoder, ack: { jobs: {} } })
  t('REGEL: ett jobb utan sänka fälls', utanFynd.some((p) => p.rule.includes('når ingen varaktig felsänka')),
    utanFynd.map((p) => p.rule).join(' | '))

  const medFynd = evaluate({ jobb: jobbMed, sänkmetoder: riktigaMetoder, ack: { jobs: {} } })
  t('REGEL: ett jobb som skickar sink är tyst', medFynd.length === 0, medFynd.map((p) => p.rule).join(' | '))

  const direktFynd = evaluate({ jobb: jobbDirekt, sänkmetoder: riktigaMetoder, ack: { jobs: {} } })
  t('REGEL: ett jobb som anropar sänkan direkt är tyst', direktFynd.length === 0,
    direktFynd.map((p) => p.rule).join(' | '))

  // DET UPPMÄTTA FALSKLARMET — en egen metod som heter `report` är inte sänkan.
  const egen = findCronJobs([JOBB_EGEN_REPORT])
  const egenFynd = evaluate({ jobb: egen, sänkmetoder: riktigaMetoder, ack: { jobs: {} } })
  t('REGEL: en EGEN metod som heter report räknas INTE som sänkan',
    egenFynd.some((p) => p.rule.includes('når ingen varaktig felsänka')),
    egenFynd.map((p) => p.rule).join(' | '))

  // (3) KVITTERINGEN FÄLLER ÅT BÅDA HÅLLEN.
  const kvitterat = evaluate({
    jobb: jobbUtan,
    sänkmetoder: riktigaMetoder,
    ack: { jobs: { [jobbUtan[0].nyckel]: { reason: 'x'.repeat(MIN_SKÄL + 5) } } },
  })
  t('KVITTERING: ett kvitterat jobb utan sänka är tyst', kvitterat.length === 0,
    kvitterat.map((p) => p.rule).join(' | '))

  const inaktuell = evaluate({
    jobb: jobbMed,
    sänkmetoder: riktigaMetoder,
    ack: { jobs: { [jobbMed[0].nyckel]: { reason: 'x'.repeat(MIN_SKÄL + 5) } } },
  })
  t('KVITTERING: ett kvitterat jobb som REDAN når sänkan fälls',
    inaktuell.some((p) => p.rule.includes('kvitterat men når REDAN sänkan')),
    inaktuell.map((p) => p.rule).join(' | '))

  const tunt = evaluate({
    jobb: jobbUtan,
    sänkmetoder: riktigaMetoder,
    ack: { jobs: { [jobbUtan[0].nyckel]: { reason: 'kort' } } },
  })
  t('KVITTERING: för tunt skäl fälls', tunt.some((p) => p.rule.includes('för tunt skäl')))

  const spöke = evaluate({
    jobb: jobbMed,
    sänkmetoder: riktigaMetoder,
    ack: { jobs: { 'x/borta.ts::spöke': { reason: 'x'.repeat(MIN_SKÄL + 5) } } },
  })
  t('KVITTERING: en post utan motsvarande @Cron fälls',
    spöke.some((p) => p.rule.includes('inte motsvarar något @Cron')))

  // (4) FORMEN utan härledning ska vara RÖD, inte tyst grön.
  const utanForm = evaluate({ jobb: jobbUtan, sänkmetoder: [], ack: { jobs: {} } })
  t('utan härledd rapportmetod är vakten RÖD',
    utanForm.some((p) => p.rule.includes('ingen rapportmetod kunde härledas')))

  // (5) OMFÅNGSKANARIEFÅGELN — tom mängd fäller, och golven är MÄTTA.
  const tom = evaluate({ jobb: [], sänkmetoder: riktigaMetoder, ack: { jobs: {} } })
  t('OMFÅNG: en tom jobbmängd fälls', tom.some((p) => p.rule.includes('NOLL @Cron-jobb')))

  const riktiga = allaJobb()
  const utanSink = riktiga.filter(
    (j) => !nårSänkan(j.text, j.metod, riktigaMetoder, härledSänkbindningar(j.text, 'CronErrorSink')),
  )
  // MÄTT mot befee7b: 25 jobb i 14 filer, 13 utan varaktig sänka.
  const MIN_JOBB = 15
  const MIN_FILER = 200
  const antalFiler = källfiler().length
  t(`OMFÅNG: ${riktiga.length} @Cron-jobb härledda (golv ${MIN_JOBB})`, riktiga.length >= MIN_JOBB)
  t(`OMFÅNG: ${antalFiler} källfiler skannade (golv ${MIN_FILER})`, antalFiler >= MIN_FILER)
  console.warn(
    `   mätt nu: ${riktiga.length} jobb, ${riktiga.length - utanSink.length} når sänkan, ` +
      `${utanSink.length} kvitterade`,
  )

  // (6) Kodbasen i paritet med kvitteringen.
  const bas = evaluate({
    jobb: riktiga,
    sänkmetoder: riktigaMetoder,
    ack: JSON.parse(readFileSync(ACK_FILE, 'utf8')),
  })
  t('kodbasen är i paritet med kvitteringen', bas.length === 0,
    bas.map((p) => p.rule).slice(0, 3).join(' | '))

  console.warn(fel === 0 ? '\n✅ Självtest OK.' : `\n❌ Självtest: ${fel} fallerade.`)
  process.exit(fel === 0 ? 0 : 1)
}

function kör() {
  const jobb = allaJobb()
  const sinkText = readFileSync(SINK_FILE, 'utf8')
  const sänkmetoder = härledSänkmetoder(sinkText)
  const sänkklass = härledSänkklass(sinkText)
  const ack = JSON.parse(readFileSync(ACK_FILE, 'utf8'))
  const problem = evaluate({ jobb, sänkmetoder, sänkklass, ack })

  if (problem.length > 0) {
    console.error('\n=== CRON-FEL UTAN VARAKTIG SÄNKA (CI-guard) ===\n')
    for (const p of problem) console.error(`❌ ${p.rule}\n   ${p.detail}`)
    console.error(
      '\nRegeln: containerns logg överlever inte nästa deploy. Ett cron-fel som bara\n' +
        'loggas lokalt finns ingenstans att fråga efter i morgon — och en tom ErrorLog\n' +
        'betyder då antingen "inget fel" eller "ingen sänka". Se #605.\n',
    )
    process.exit(1)
  }

  const utan = Object.keys(ack.jobs ?? {}).length
  console.warn(
    `✅ ${jobb.length} @Cron-jobb — ${jobb.length - utan} når den varaktiga felsänkan, ` +
      `${utan} kvitterade (rapportmetod härledd: ${sänkmetoder.join(', ')}).`,
  )
}

const körsDirekt = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (!körsDirekt) {
  // importerad — exportera bara
} else if (process.argv.includes('--self-test')) självtest()
else kör()
