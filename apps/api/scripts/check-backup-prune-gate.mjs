#!/usr/bin/env node
/**
 * CI-guard — backupens RADERINGSVÄG ska ligga bakom en uttrycklig flagga.
 *
 * ── VAD DEN SKYDDAR MOT ──────────────────────────────────────────────────────
 *
 * `runBackup` laddar upp och anropar sedan `pruneOldBackups`, som raderar
 * objekt i backup-bucketen. Raderingen styrdes tidigare bara av ett tal
 * (`BACKUP_RETENTION_DAYS`, default 30), vilket betyder att den dag
 * `BACKUP_ENABLED=true` sätts blir radering av äldre återställningspunkter
 * påslagen i samma sekund som den första dumpen tas.
 *
 * Grinden (`BACKUP_PRUNE_ENABLED`) gör raderingen till ett eget beslut. Den
 * här vakten finns för att beslutet inte ska kunna tas bort av misstag: en
 * refaktorering som flyttar `DeleteObjectCommand` till en annan metod, eller
 * som byter `=== 'true'` mot en sanningsvärdeskontroll, öppnar raderingsvägen
 * igen utan att något test behöver bli rött.
 *
 * ── REGLERNA ─────────────────────────────────────────────────────────────────
 *
 *   R1  `BACKUP_PRUNE_ENABLED_VAR` finns och är EXPORTERAD. Utan namnet finns
 *       ingen grind att bevaka, och runbooken pekar på en variabel som inte
 *       styr något.
 *   R2  Fältet sätts FAIL-CLOSED: exakt `=== 'true'`. En truthiness-kontroll
 *       (`!!config.get(...)`) hade gjort strängen `'false'` till ett ja.
 *   R3  VARJE `new DeleteObjectCommand(` i backupvägen ligger inuti
 *       `pruneOldBackups`. En radering någon annanstans är per definition
 *       ogrindad.
 *   R4  `pruneOldBackups` returnerar på `!this.pruneEnabled` FÖRE sin första
 *       radering. Att grinden finns i filen räcker inte om den står efter det
 *       den ska hindra — samma skillnad som mellan att en vakt existerar och
 *       att den är påkopplad.
 *   R5  KANARIEFÅGELN: samma källa med grindraden borttagen måste fälla R4, och
 *       med `=== 'true'` utbytt mot en truthiness-kontroll måste fälla R2. En
 *       vakt som bara provats på den gröna källan kan inte skilja "reglerna
 *       håller" från "skanningen läser fel text".
 *
 * ⚠️ GRÄNSEN, UTSKRIVEN. Vakten mäter FORMEN i källan. Att en avstängd grind
 * faktiskt inte skickar något till R2 mäts av `backup.service.spec.ts`
 * (spionen som räknar varje S3-anrop), och att ett okänt nyckelformat aldrig
 * raderas av `isBackupExpired`. Vakten kan inte se en runtime-no-op, och den
 * vet ingenting om vad som står i Railway.
 *
 * Rent statiskt (fs-only, ingen DB) → eget CI-steg.
 * Lokalt:      node apps/api/scripts/check-backup-prune-gate.mjs
 * Självtest:   node apps/api/scripts/check-backup-prune-gate.mjs --self-test
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { codeMask, blankComments, kanariefåglar } from '../../../scripts/lib/source-scan.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const BACKUP_DIR = join(HERE, '..', 'src', 'backup')
const SERVICE = 'backup.service.ts'

const GRIND_VAR = 'BACKUP_PRUNE_ENABLED_VAR'
const GRIND_FÄLT = 'this.pruneEnabled'
const RADERING = 'new DeleteObjectCommand('
const METOD = 'async pruneOldBackups('

/**
 * Källfilerna i backupvägen. Testfiler utesluts på FORM (`\.spec\.ts$`), inte
 * på ordet "spec" — ett `-v spec` utesluter varje sökväg som BÄR delsträngen,
 * och katalognamn som `inspections` innehåller den.
 */
function källfiler() {
  return readdirSync(BACKUP_DIR)
    .filter((f) => f.endsWith('.ts') && !/\.spec\.ts$/.test(f))
    .sort()
}

/**
 * Kroppen för `namn` ur maskerad kod, via klammermatchning.
 *
 * Avgränsaren är STRUKTURELL (matchande klammer), aldrig innehållslig: ett
 * fönster som slutar vid en sträng som står inuti det man letar efter är
 * alltid uppfyllt av sin egen avgränsare.
 */
function metodkropp(kod, namn) {
  const start = kod.indexOf(namn)
  if (start === -1) return null
  const öppning = kod.indexOf('{', start)
  if (öppning === -1) return null
  let djup = 0
  for (let i = öppning; i < kod.length; i++) {
    if (kod[i] === '{') djup++
    else if (kod[i] === '}') {
      djup--
      if (djup === 0) return { från: öppning, till: i, text: kod.slice(öppning, i + 1) }
    }
  }
  return null
}

/** Alla förekomstindex av `nål` i `hö`. */
function index(hö, nål) {
  const ut = []
  let i = hö.indexOf(nål)
  while (i !== -1) {
    ut.push(i)
    i = hö.indexOf(nål, i + 1)
  }
  return ut
}

/**
 * Prövar reglerna mot en given källtext. Returnerar en lista fel — tom = grön.
 *
 * Skild från I/O så att kanariefågeln kan mata in en MUTERAD källa utan att
 * skriva till disk.
 */
export function prövaKälla(rå, { filnamn = SERVICE } = {}) {
  const fel = []
  // TVÅ VYER, EN PER FRÅGA — och det är inte en formalitet. R1/R3/R4 frågar
  // efter KOD (export, anrop, villkor) och läser `codeMask`, som blankar
  // stränginnehåll så att en kommentar eller en sträng som NÄMNER
  // `DeleteObjectCommand` inte kan uppfylla en regel. R2 frågar efter det som
  // BOR I EN STRÄNG (`'true'`) och måste därför läsa `blankComments`, som
  // behåller stränginnehållet. Med `codeMask` överallt blev den här vakten RÖD
  // på sin egen gröna källa — jämförelsen den letar efter var bortmaskad.
  // Båda maskerna bevarar längd och radbrytningar, så samma index gäller i
  // båda och radnumren pekar på råfilen.
  const kod = codeMask(rå)
  const strängar = blankComments(rå)

  // R1 — namnet finns och är exporterat.
  if (!kod.includes(`export const ${GRIND_VAR}`)) {
    fel.push(`R1 ${filnamn}: ${GRIND_VAR} saknas eller är inte exporterad`)
  }

  // R2 — fail-closed. Tilldelningen ska jämföra mot exakt strängen 'true'.
  const tilldelning = strängar.split('\n').find((r) => r.includes(`${GRIND_FÄLT} =`))
  if (!tilldelning) {
    fel.push(`R2 ${filnamn}: ingen tilldelning av ${GRIND_FÄLT} hittades`)
  } else if (!tilldelning.includes("=== 'true'")) {
    fel.push(
      `R2 ${filnamn}: ${GRIND_FÄLT} sätts utan "=== 'true'" — allt utom exakt ` +
        'den strängen måste betyda AV (fail-closed)',
    )
  }

  const kropp = metodkropp(kod, METOD)
  if (!kropp) {
    fel.push(`R3/R4 ${filnamn}: hittade ingen kropp för ${METOD}`)
    return fel
  }

  // R3 — varje radering ligger inuti pruneOldBackups.
  for (const i of index(kod, RADERING)) {
    if (i < kropp.från || i > kropp.till) {
      const rad = kod.slice(0, i).split('\n').length
      fel.push(`R3 ${filnamn}:${rad}: ${RADERING} utanför ${METOD} — ogrindad radering`)
    }
  }

  // R4 — grinden står FÖRE den första raderingen i metodkroppen.
  const grindIKropp = kropp.text.indexOf(`!${GRIND_FÄLT}`)
  const förstaRadering = kropp.text.indexOf(RADERING)
  if (förstaRadering !== -1) {
    if (grindIKropp === -1) {
      fel.push(`R4 ${filnamn}: ${METOD} raderar utan att läsa !${GRIND_FÄLT}`)
    } else if (grindIKropp > förstaRadering) {
      fel.push(`R4 ${filnamn}: grinden står EFTER den första raderingen i ${METOD}`)
    } else if (!kropp.text.slice(grindIKropp, förstaRadering).includes('return')) {
      fel.push(`R4 ${filnamn}: grinden i ${METOD} returnerar inte före raderingen`)
    }
  }

  return fel
}

function kör() {
  const filer = källfiler()
  // Kanariefågel: noll källfiler betyder att skanningen är blind, inte att
  // reglerna håller.
  if (filer.length === 0) {
    console.error('❌ kanariefågel: NOLL källfiler i backupvägen — skanningen är blind')
    return false
  }

  let fel = []
  let raderingar = 0
  for (const f of filer) {
    const rå = readFileSync(join(BACKUP_DIR, f), 'utf8')
    raderingar += index(codeMask(rå), RADERING).length
    if (f === SERVICE) fel = fel.concat(prövaKälla(rå, { filnamn: f }))
    else {
      for (const i of index(codeMask(rå), RADERING)) {
        const rad = rå.slice(0, i).split('\n').length
        fel.push(`R3 ${f}:${rad}: ${RADERING} utanför ${SERVICE} — ogrindad radering`)
      }
    }
  }

  // Kanariefågel: hittar skanningen ingen radering alls mäter R3/R4 ingenting.
  if (raderingar === 0) {
    console.error(`❌ kanariefågel: NOLL ${RADERING} i backupvägen — reglerna kan inte falla`)
    return false
  }

  for (const f of fel) console.error(`❌ ${f}`)
  if (fel.length === 0) {
    console.log(
      `✅ backupens raderingsväg är grindad: ${filer.length} källfiler, ` +
        `${raderingar} ${RADERING} — alla i ${METOD} bakom ${GRIND_VAR}`,
    )
  }
  return fel.length === 0
}

/**
 * Självtest — muterar källan i minnet och kräver att reglerna FÄLLER.
 *
 * Utan det här kan vakten vara grön därför att den läser fel text. Varje fall
 * matar in exakt den form regeln finns för att fånga.
 */
function självtest() {
  const rå = readFileSync(join(BACKUP_DIR, SERVICE), 'utf8')
  let ok = true

  const krav = (namn, muterad, regel) => {
    const fel = prövaKälla(muterad)
    const träff = fel.some((f) => f.startsWith(regel))
    if (träff) console.log(`✅ kanariefågel ${namn}: ${regel} fäller`)
    else {
      console.error(
        `❌ kanariefågel ${namn}: ${regel} fällde INTE (fel: ${fel.join(' | ') || 'inga'})`,
      )
      ok = false
    }
  }

  // Grön källa ska vara grön — annars mäter kanariefåglarna nedan ingenting.
  const grund = prövaKälla(rå)
  if (grund.length === 0) console.log('✅ kanariefågel 0: den riktiga källan är grön')
  else {
    console.error(`❌ kanariefågel 0: den riktiga källan är RÖD (${grund.join(' | ')})`)
    ok = false
  }

  // 1 — grinden borttagen ur metoden.
  krav(
    '1 (grind borttagen)',
    rå.replace(/\n\s*if \(!this\.pruneEnabled\) \{[\s\S]*?\n\s*\}\n/, '\n'),
    'R4',
  )

  // 2 — fail-closed utbytt mot truthiness.
  krav(
    '2 (truthiness i stället för === true)',
    rå.replace(
      "this.pruneEnabled = config.get<string>(BACKUP_PRUNE_ENABLED_VAR) === 'true'",
      'this.pruneEnabled = !!config.get<string>(BACKUP_PRUNE_ENABLED_VAR)',
    ),
    'R2',
  )

  // 3 — radering flyttad ut ur den grindade metoden.
  krav(
    '3 (radering utanför pruneOldBackups)',
    rå.replace(
      '  async listBackups(',
      '  async raderaNågot(key: string) {\n' +
        '    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }))\n' +
        '  }\n\n  async listBackups(',
    ),
    'R3',
  )

  // 4 — exportnamnet borttaget.
  krav(
    '4 (grindnamnet inte exporterat)',
    rå.replace(`export const ${GRIND_VAR}`, `const ${GRIND_VAR}`),
    'R1',
  )

  // Den DELADE skannerns kanariefåglar — bryts source-scan.mjs blir DEN HÄR
  // vakten blind utan att någon av dess egna regler märker det.
  for (const f of kanariefåglar()) {
    console.error(`❌ delad källskanner: ${f}`)
    ok = false
  }

  return ok
}

// Dispatchen skrivs i den kanoniska formen `if (process.argv.includes(…))`.
// Det är inte stil: `check-self-tests-fail.mjs` känner igen självtestlöftet på
// just den formen, och en tilldelning till en variabel läses som "vakten saknar
// självtest" — alltså ett löfte som inte går att pröva.
if (process.argv.includes('--self-test')) {
  process.exit(självtest() ? 0 : 1)
}
process.exit(kör() ? 0 : 1)
