#!/usr/bin/env node
/**
 * CI-guard — backupens R2-endpoint ska HÄRLEDAS ur jurisdiktionen, aldrig skrivas.
 *
 * ── VAD DEN SKYDDAR MOT ──────────────────────────────────────────────────────
 *
 * En R2-bucket tillhör EXAKT EN jurisdiktion, och jurisdiktionen väljs av
 * VÄRDNAMNET (`<konto>.r2…` respektive `<konto>.eu.r2…`). Frågar man efter
 * bucketen på fel endpoint svarar R2 `404 NoSuchBucket` — samma svar som när
 * bucketen inte finns alls. Uppmätt 2026-08-27: appens egen bucket gav `200` på
 * default-endpointen och `404` på EU-endpointen, med samma nycklar.
 *
 * Hårdkodas värdnamnet igen försvinner jurisdiktionsvalet TYST: konfigurationen
 * säger `eu`, klienten pratar med default, och skillnaden syns först som ett
 * 404 klockan 03:00 — i ett larm som ser ut att handla om en saknad bucket.
 *
 * ── REGLERNA ─────────────────────────────────────────────────────────────────
 *
 *   R1  `r2EndpointFor` finns och är exporterad. Utan härledningen finns inget
 *       jurisdiktionsval att bevaka.
 *   R2  R2:s värdnamn får förekomma i backupvägen ENDAST inuti `r2EndpointFor`.
 *   R3  VARJE `new S3Client(` i backupvägen får sin endpoint från
 *       `r2EndpointFor(`. Att härledningen finns räcker inte om klienten inte
 *       använder den — det är samma skillnad som mellan att en vakt existerar
 *       och att den är påkopplad.
 *   R4  KANARIEFÅGELN: den strukturerade skanningen måste hitta LIKA MÅNGA
 *       S3Client-konstruktioner som en oberoende, parserfri räkning ger. Går de
 *       isär har skanningen gått blind, och R3 blir grön på fel underlag.
 *       (Det var exakt defekten i #573: en kontroll som bara krävde "fler än
 *       noll" var grön medan den läste 29 av 30.)
 *
 * ⚠️ GRÄNSEN, UTSKRIVEN. Guarden mäter FORMEN i källan. Att en EU-bucket
 * faktiskt nås mäts av `assertBackupBucketReachable` vid körning, och att
 * härledningen ger rätt värdnamn av `backup.service.spec.ts`.
 *
 * SCOPE: bara `src/backup/`. `storage.service.ts` har med flit kvar sitt
 * hårdkodade värdnamn — huvudbucketen finns i default-jurisdiktionen och kan
 * inte flytta. Skälet står i den filen; ändras det ska den här listan utökas.
 *
 * Rent statiskt (fs-only, ingen DB) → eget CI-steg.
 * Lokalt:      node apps/api/scripts/check-backup-endpoint.mjs
 * Självtest:   node apps/api/scripts/check-backup-endpoint.mjs --self-test
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { withoutComments, kanariefåglar } from '../../../scripts/lib/source-scan.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const BACKUP_DIR = join(HERE, '..', 'src', 'backup')

/** R2:s värdnamn. Delsträngen som aldrig får skrivas utanför härledningen. */
const R2_HOST = 'r2.cloudflarestorage.com'
const DERIVER = 'r2EndpointFor'

/**
 * Källfilerna i backupvägen.
 *
 * Testfiler utesluts på FORM (`\.spec\.ts$`), inte på ordet "spec". Ett
 * `-v spec` hade uteslutit varje sökväg som BÄR delsträngen — det var precis
 * så `apps/api/src/in[spec]tions/` föll ur en uppräkning i #567.
 */
export function backupSourceFiles(dir = BACKUP_DIR) {
  return readdirSync(dir)
    .filter((f) => /\.ts$/.test(f) && !/\.spec\.ts$/.test(f))
    .sort()
    .map((f) => ({ fil: f, text: readFileSync(join(dir, f), 'utf8') }))
}

/** Kroppen för en namngiven funktion, via klammermatchning. `null` om den saknas. */
export function functionBody(text, name) {
  const i = text.indexOf(`function ${name}(`)
  if (i === -1) return null
  const start = text.indexOf('{', i)
  if (start === -1) return null
  let djup = 0
  for (let j = start; j < text.length; j++) {
    if (text[j] === '{') djup++
    else if (text[j] === '}' && --djup === 0) return text.slice(start, j + 1)
  }
  return null
}

/**
 * Argumentobjektet för varje `new S3Client(` — via klammermatchning.
 *
 * STRUKTURERAD skanning: den vet var en konstruktion börjar och slutar, till
 * skillnad från en radvis sökning. Priset är att den kan gå blind om formen
 * ändras, och det är därför R4 finns.
 */
export function s3ClientConstructions(text) {
  const ut = []
  let från = 0
  for (;;) {
    const i = text.indexOf('new S3Client(', från)
    if (i === -1) return ut
    const start = text.indexOf('{', i)
    if (start === -1) return ut
    let djup = 0
    let slut = -1
    for (let j = start; j < text.length; j++) {
      if (text[j] === '{') djup++
      else if (text[j] === '}' && --djup === 0) { slut = j; break }
    }
    if (slut === -1) return ut
    ut.push(text.slice(start, slut + 1))
    från = slut
  }
}

/**
 * OBEROENDE ANTAL — ren delsträngsräkning, ingen klammermatchning.
 *
 * Kanariefågeln mot `s3ClientConstructions`. Den får inte dela dess antagande:
 * delar de mekanism går båda blinda samtidigt och bekräftar felet i stället för
 * att fånga det (#463).
 */
export function countS3ClientOccurrences(text) {
  let n = 0
  for (let i = text.indexOf('new S3Client('); i !== -1; i = text.indexOf('new S3Client(', i + 1)) n++
  return n
}

/** Kärnan. Exporterad så självtestet kör exakt samma kod som CI. */
export function evaluate(filer) {
  const problem = []
  const service = filer.find((f) => f.fil === 'backup.service.ts')

  // ── R1 — härledningen finns ───────────────────────────────────────────────
  if (!service || !service.text.includes(`export function ${DERIVER}(`)) {
    problem.push({
      rule: `${DERIVER} saknas eller är inte exporterad`,
      detail:
        'Utan en härledning finns inget jurisdiktionsval att bevaka, och endpointen ' +
        'är tillbaka där den var: hårdkodad.',
    })
  }

  let totaltKonstruktioner = 0
  for (const { fil, text } of filer) {
    const kod = withoutComments(text)

    // ── R2 — värdnamnet bara inuti härledningen ─────────────────────────────
    if (kod.includes(R2_HOST)) {
      const kropp = functionBody(kod, DERIVER) ?? ''
      const utanför = kod.split(R2_HOST).length - 1 - (kropp.split(R2_HOST).length - 1)
      if (utanför > 0) {
        problem.push({
          rule: `${fil}: R2:s värdnamn skrivs ${utanför} gång(er) utanför ${DERIVER}`,
          detail:
            'Jurisdiktionen väljs av värdnamnet. Skrivs det för hand försvinner ' +
            `R2_BACKUP_JURISDICTION tyst — konfigurationen säger "eu", klienten pratar ` +
            'med default, och skillnaden syns först som ett 404 NoSuchBucket klockan ' +
            `03:00. Använd ${DERIVER}(accountId, jurisdiction).`,
        })
      }
    }

    // ── R3 + R4 — varje klient använder härledningen, och skanningen mäter ──
    const konstruktioner = s3ClientConstructions(kod)
    const räknade = countS3ClientOccurrences(kod)
    totaltKonstruktioner += räknade
    if (konstruktioner.length !== räknade) {
      problem.push({
        rule: `${fil}: skanningen hittade ${konstruktioner.length} av ${räknade} S3Client-konstruktioner`,
        detail:
          'Klammermatchningen har gått blind. R3 skulle då pröva färre klienter än ' +
          'som finns och bli grön på fel underlag — samma form som när en teckenklass ' +
          'läste 29 av 30 verktyg (#573).',
      })
    }
    for (const args of konstruktioner) {
      if (!new RegExp(`endpoint:\\s*${DERIVER}\\(`).test(args)) {
        problem.push({
          rule: `${fil}: en S3Client får inte sin endpoint från ${DERIVER}(`,
          detail:
            'Att härledningen finns räcker inte om klienten inte använder den — ' +
            'samma skillnad som mellan att en vakt existerar och att den är påkopplad.',
        })
      }
    }
  }

  // ── R4 (forts.) — noll konstruktioner betyder att skanningen tappat filen ──
  if (filer.length > 0 && totaltKonstruktioner === 0) {
    problem.push({
      rule: 'NOLL S3Client-konstruktioner i backupvägen',
      detail:
        'Backupen laddar upp till R2 och måste ha en klient. Noll betyder att ' +
        'skanningen inte läser källan, inte att koden är ren.',
    })
  }

  return problem
}

// ── självtest ────────────────────────────────────────────────────────────────
const OK_FIL = `
export function r2EndpointFor(accountId, jurisdiction) {
  const prefix = jurisdiction === 'default' ? '' : \`\${jurisdiction}.\`
  return \`https://\${accountId}.\${prefix}r2.cloudflarestorage.com\`
}
const c = new S3Client({ region: 'auto', endpoint: r2EndpointFor(acc, j) })
`
const fixtur = (text) => [{ fil: 'backup.service.ts', text }]

function selfTest() {
  let ok = true
  const fail = (m) => { ok = false; console.error(`❌ ${m}`) }
  const grön = (label, r) =>
    r.length === 0 ? console.log(`✅ inget falsklarm: ${label}`) : fail(`FALSKLARM: ${label} → ${r[0].rule}`)
  const röd = (label, r, väntad) => {
    if (r.length === 0) return fail(`MISSADE: ${label}`)
    if (väntad && !r.some((x) => x.rule.includes(väntad))) {
      return fail(`${label} fälldes av FEL regel: "${r[0].rule}" — väntade "${väntad}"`)
    }
    console.log(`✅ fångad: ${label} (${r[0].rule})`)
  }

  // ── KANARIEFÅGEL 1: mot den RIKTIGA källan, med ANTAL — inte "fler än noll" ──
  //
  // Den svaga formen (`length > 0`) var defekten i #573. Kravet här är att den
  // strukturerade skanningen och den parserfria räkningen ger SAMMA tal, och att
  // talet skrivs ut. Kan ingen se talen går det inte att skilja "stämmer" från
  // "kontrollen tittade inte".
  const riktiga = backupSourceFiles()
  if (riktiga.length === 0) fail('kanariefågel: NOLL källfiler i backupvägen — skanningen är blind')
  let summaStruktur = 0
  let summaRäknat = 0
  for (const { fil, text } of riktiga) {
    const kod = withoutComments(text)
    const a = s3ClientConstructions(kod).length
    const b = countS3ClientOccurrences(kod)
    summaStruktur += a
    summaRäknat += b
    if (a !== b) fail(`kanariefågel: ${fil} — strukturerad ${a} ≠ räknad ${b}`)
  }
  if (summaRäknat === 0) fail('kanariefågel: NOLL S3Client i den riktiga backupvägen')
  else if (summaStruktur === summaRäknat) {
    console.log(
      `✅ kanariefågel: ${riktiga.length} källfiler, ${summaStruktur} av ${summaRäknat} ` +
        'S3Client-konstruktioner lästa, riktig källa',
    )
  }

  // ── KANARIEFÅGEL 1b: skiljer räknarna på en KÄND blindhet? ────────────────
  //
  // 1:an är bara värd något om de två räknarna faktiskt går isär när
  // klammermatchningen tappar något. Mata in en oavslutad konstruktion och kräv
  // att de skiljer sig — annars kan 1:an vara grön för att båda gick blinda.
  const trasig = 'const a = new S3Client({ endpoint: r2EndpointFor(x, y) })\nconst b = new S3Client('
  const s = s3ClientConstructions(trasig).length
  const r = countS3ClientOccurrences(trasig)
  if (!(s === 1 && r === 2)) fail(`kanariefågel 1b: väntade strukturerad 1 / räknad 2, fick ${s}/${r}`)
  else console.log(`✅ kanariefågel 1b: räknarna går isär på en tappad konstruktion (${s} vs ${r})`)

  grön('korrekt form', evaluate(fixtur(OK_FIL)))

  // ── R2 — värdnamnet hårdkodat igen (defekten guarden finns för) ───────────
  röd(
    'endpointen hårdkodad utanför härledningen',
    evaluate(fixtur(OK_FIL.replace('endpoint: r2EndpointFor(acc, j)', 'endpoint: `https://${acc}.r2.cloudflarestorage.com`'))),
    'värdnamn skrivs',
  )
  röd(
    'härledningen finns men klienten använder den inte',
    evaluate(fixtur(OK_FIL.replace('endpoint: r2EndpointFor(acc, j)', 'endpoint: nagotAnnat(acc)'))),
    'får inte sin endpoint',
  )
  röd('härledningen borttagen', evaluate(fixtur(OK_FIL.replace('export function r2EndpointFor(', 'function annat('))), 'saknas eller är inte exporterad')
  röd('ingen S3Client alls (skanningen läser inte källan)', evaluate(fixtur(OK_FIL.replace('new S3Client(', 'new Annat('))), 'NOLL S3Client')

  // ── FÖRBEHANDLINGEN: värdnamnet i en KOMMENTAR ska inte fälla ─────────────
  //
  // Kommentarerna i backup.service.ts nämner värdnamnet i prosa. Räknade guarden
  // dem hade den fällt korrekt kod — samma familj som när en annan guard räknade
  // ett namn i en doc-kommentar som ett anrop.
  grön(
    'värdnamnet nämnt i en kommentar fäller inte',
    evaluate(fixtur(`// jurisdiktionen väljs av r2.cloudflarestorage.com\n${OK_FIL}`)),
  )

  // Den DELADE skannerns kanariefåglar — bryts source-scan.mjs blir DEN HÄR
  // vakten röd, inte bara skannerns egen körning (#463).
  for (const f of kanariefåglar()) { ok = false; console.error(`❌ delad källskanner: ${f}`) }

  console.log(ok ? '\n✅ Självtest OK.' : '\n❌ Självtest misslyckades.')
  process.exit(ok ? 0 : 1)
}

// ── main ─────────────────────────────────────────────────────────────────────
function main() {
  if (process.argv.includes('--self-test')) return selfTest()
  const filer = backupSourceFiles()
  const problem = evaluate(filer)
  if (problem.length > 0) {
    console.error('\n=== BACKUPENS ENDPOINT ÄR INTE HÄRLEDD (CI-guard) ===\n')
    for (const p of problem) console.error(`❌ ${p.rule}\n   ${p.detail}`)
    console.error(
      '\nRegeln: jurisdiktionen väljs av värdnamnet, och en bucket tillhör exakt en\n' +
        'jurisdiktion. Skrivs värdnamnet för hand blir fel jurisdiktion ett 404\n' +
        'NoSuchBucket klockan 03:00 — omöjligt att skilja från en saknad bucket.\n',
    )
    process.exit(1)
  }
  const antal = filer.reduce((n, f) => n + countS3ClientOccurrences(withoutComments(f.text)), 0)
  console.log(
    `✅ backupens endpoint härleds ur jurisdiktionen; ${filer.length} källfiler granskade, ` +
      `${antal} S3Client-konstruktion(er) använder ${DERIVER}.`,
  )
}

main()
