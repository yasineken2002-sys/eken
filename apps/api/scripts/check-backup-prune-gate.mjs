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
 * här vakten finns för att beslutet inte ska kunna tas bort av misstag.
 *
 * ── VARFÖR EN VITLISTA OCH INTE MÖNSTER ──────────────────────────────────────
 *
 * Första versionen frågade "finns `=== 'true'` på tilldelningsraden" och
 * "står ett `return` mellan grinden och raderingen". Båda är MÖNSTER, och
 * mönster svarar ja på för mycket. Fem mutationer mättes och passerade alla:
 *
 *   fel flagga        `config.get<string>('BACKUP_ENABLED') === 'true'`
 *   alltid på         `… === 'true' || true`
 *   return i callback `;(() => { return {…} })()` — metoden fortsätter
 *   fel konstantvärde `BACKUP_PRUNE_ENABLED_VAR = 'BACKUP_ENABLED'`
 *   senare skrivning  `(this as {…}).pruneEnabled = true`
 *
 * Därför är reglerna nu en VITLISTA över exakta, normaliserade former. Allt
 * annat är en OKÄND FORM och fäller — även om den skulle vara harmlös. Det är
 * avsiktligt: en ny form ska granskas en gång och läggas till här, inte
 * släppas igenom av ett mönster som råkar matcha. Fel riktning att fela åt är
 * tystnad, inte en extra granskning.
 *
 * ── REGLERNA ─────────────────────────────────────────────────────────────────
 *
 *   R1  `BACKUP_PRUNE_ENABLED_VAR` är exporterad OCH har exakt värdet
 *       `'BACKUP_PRUNE_ENABLED'`. Ett exporterat namn som pekar på en annan
 *       variabel är en grind på fel dörr.
 *   R2  Varje förekomst av `pruneEnabled` i backupvägens KOD tillhör en av tre
 *       vitlistade former, och deklarationen, tilldelningen och grindläsningen
 *       förekommer exakt en gång var. Fångar fel flagga, `|| true` och varje
 *       senare skrivning till fältet.
 *   R3  Fältet är deklarerat `readonly`.
 *   R4  Grinden är metodens FÖRSTA sats och är (normaliserat) exakt den
 *       vitlistade satsen — inklusive sitt `return`. Fångar ett `return` som
 *       bara gäller en inre callback, och en sats som smyger in före grinden.
 *   R5  VARJE `new DeleteObjectCommand(` i backupvägen ligger inuti
 *       `pruneOldBackups`. En radering någon annanstans är ogrindad.
 *   R6  KANARIEFÅGLAR: noll källfiler eller noll raderingar betyder att
 *       skanningen är blind, inte att reglerna håller.
 *
 * ⚠️ GRÄNSERNA, UTSKRIVNA.
 *
 *  • Vakten mäter FORMEN i källan. Att en avstängd grind faktiskt inte skickar
 *    något till R2 mäts av `backup.service.spec.ts` (spionen som räknar varje
 *    S3-anrop); att ett okänt nyckelformat aldrig raderas av `isBackupExpired`.
 *    Vakten kan inte se en runtime-no-op och vet ingenting om Railway.
 *  • Jämförelsen är SATSVIS och normaliserad på vitspace. Delas en vitlistad
 *    sats över flera rader av en omformatering rapporteras den som okänd form.
 *    Det är rätt riktning att fela åt, men det betyder att en Prettier-ändring
 *    kan kräva att en form godkänns om här.
 *  • Vitlistan gäller `src/backup/`. Anropare utanför den katalogen ser vakten
 *    inte; `pruneOldBackups` är publik, och dess grind sitter i metoden just
 *    därför.
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
/** Variabelnamnet konstanten MÅSTE bära. Grinden ska sitta på rätt dörr. */
const GRIND_VÄRDE = 'BACKUP_PRUNE_ENABLED'
const FÄLT = 'pruneEnabled'
const RADERING = 'new DeleteObjectCommand('
const METOD = 'async pruneOldBackups('

/**
 * VITLISTAN — de enda former fältet får förekomma i, normaliserade på vitspace.
 *
 * Läggs en form till här ska den granskas som en grindändring, inte som en
 * formatering: varje rad nedan är en väg fältet får nås på.
 */
const DEKLARATION = `readonly ${FÄLT}: boolean`
const TILLDELNING = `this.${FÄLT} = config.get<string>(${GRIND_VAR}) === 'true'`
const GRINDRAD = `if (!this.${FÄLT}) {`
/** Hela grindsatsen, brace-matchad och normaliserad. `return` ska vara METODENS. */
const GRINDSATS = `if (!this.${FÄLT}) { return { skipped: true, pruned: 0, reason: prunePausedMessage() } }`

/** Vitspace-normalisering. Bevarar ordning och tecken, kollapsar bara mellanrum. */
const norm = (s) => s.replace(/\s+/g, ' ').trim()

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
 * Blocket som börjar vid `öppning`, via klammermatchning.
 *
 * Avgränsaren är STRUKTURELL (matchande klammer), aldrig innehållslig: ett
 * fönster som slutar vid en sträng som står inuti det man letar efter är
 * alltid uppfyllt av sin egen avgränsare.
 */
function blockFrån(kod, öppning) {
  if (öppning === -1) return null
  let djup = 0
  for (let i = öppning; i < kod.length; i++) {
    if (kod[i] === '{') djup++
    else if (kod[i] === '}') {
      djup--
      if (djup === 0) return { från: öppning, till: i }
    }
  }
  return null
}

function metodkropp(kod, namn) {
  const start = kod.indexOf(namn)
  if (start === -1) return null
  const b = blockFrån(kod, kod.indexOf('{', start))
  return b ? { ...b, text: kod.slice(b.från, b.till + 1) } : null
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

/** Raden som index `p` ligger på, ur vyn `v`, normaliserad. */
function radVid(v, p) {
  const a = v.lastIndexOf('\n', p) + 1
  const b = v.indexOf('\n', p)
  return norm(v.slice(a, b === -1 ? v.length : b))
}

/** Radnummer i råfilen (alla vyer bevarar längd och radbrytningar). */
const radnr = (v, p) => v.slice(0, p).split('\n').length

/**
 * Prövar reglerna mot en given källtext. Returnerar en lista fel — tom = grön.
 *
 * Skild från I/O så att kanariefågeln kan mata in en MUTERAD källa utan att
 * skriva till disk.
 */
export function prövaKälla(rå, { filnamn = SERVICE } = {}) {
  const fel = []
  // TVÅ VYER, EN PER FRÅGA — och det är inte en formalitet. Strukturen (anrop,
  // satser, klamrar) söks i `codeMask`, som blankar stränginnehåll så att en
  // sträng eller kommentar som NÄMNER `DeleteObjectCommand` inte kan uppfylla
  // en regel. Texten i de vitlistade formerna innehåller strängliteraler
  // (`'true'`, `'BACKUP_PRUNE_ENABLED'`) och läses därför ur `blankComments`,
  // som behåller stränginnehållet. Med `codeMask` överallt blev en tidigare
  // version RÖD på sin egen gröna källa — jämförelsen den letade efter var
  // bortmaskad. Båda vyerna bevarar längd och radbrytningar, så samma index
  // gäller i båda.
  const kod = codeMask(rå)
  const str = blankComments(rå)

  // ── R1: konstanten finns, är exporterad och bär RÄTT värde ────────────────
  const konstRad = str
    .split('\n')
    .map(norm)
    .find((r) => r.startsWith(`export const ${GRIND_VAR}`))
  if (!konstRad) {
    fel.push(`R1 ${filnamn}: ${GRIND_VAR} saknas eller är inte exporterad`)
  } else if (konstRad !== `export const ${GRIND_VAR} = '${GRIND_VÄRDE}'`) {
    fel.push(
      `R1 ${filnamn}: ${GRIND_VAR} har inte värdet '${GRIND_VÄRDE}' — en grind på fel dörr. ` +
        `Läste: ${konstRad}`,
    )
  }

  // ── R2: varje förekomst av fältet tillhör en vitlistad form ───────────────
  const räknare = { deklaration: 0, tilldelning: 0, grindläsning: 0 }
  for (const p of index(kod, FÄLT)) {
    const rad = radVid(str, p)
    if (rad === DEKLARATION) räknare.deklaration++
    else if (rad === TILLDELNING) räknare.tilldelning++
    else if (rad === GRINDRAD) räknare.grindläsning++
    else {
      fel.push(
        `R2 ${filnamn}:${radnr(kod, p)}: OKÄND FORM för ${FÄLT} — "${rad.slice(0, 100)}". ` +
          'Vitlistan har tre former (deklaration, tilldelning, grindläsning); ' +
          'en ny form ska granskas och läggas till i vakten, inte släppas igenom.',
      )
    }
  }
  for (const [namn, antal] of Object.entries(räknare)) {
    if (antal !== 1) {
      fel.push(`R2 ${filnamn}: ${namn} av ${FÄLT} förekommer ${antal} gånger, ska vara exakt 1`)
    }
  }

  // ── R3: fältet är readonly ────────────────────────────────────────────────
  if (!kod.includes(`readonly ${FÄLT}`)) {
    fel.push(`R3 ${filnamn}: ${FÄLT} är inte deklarerat readonly`)
  }

  // ── R4/R5: metodkroppen ───────────────────────────────────────────────────
  const kropp = metodkropp(kod, METOD)
  if (!kropp) {
    fel.push(`R4/R5 ${filnamn}: hittade ingen kropp för ${METOD}`)
    return fel
  }

  // R5 — varje radering ligger inuti pruneOldBackups.
  for (const p of index(kod, RADERING)) {
    if (p < kropp.från || p > kropp.till) {
      fel.push(`R5 ${filnamn}:${radnr(kod, p)}: ${RADERING} utanför ${METOD} — ogrindad radering`)
    }
  }

  // R4 — grinden är FÖRSTA satsen och exakt den vitlistade satsen.
  //
  // "Första satsen" mäts strukturellt: första icke-blanka tecknet efter
  // metodens öppningsklammer ska inleda grinden. Då kan ingen sats smyga in
  // före den. Och HELA satsen jämförs, brace-matchad — så ett `return` som
  // tillhör en inre callback är en annan text och fälls.
  const efterÖppning = kropp.från + 1
  const relativt = kod.slice(efterÖppning, kropp.till).search(/\S/)
  const satsStart = relativt === -1 ? -1 : efterÖppning + relativt
  const ifBlock = satsStart === -1 ? null : blockFrån(kod, kod.indexOf('{', satsStart))
  const satsText = satsStart === -1 || !ifBlock ? '' : norm(str.slice(satsStart, ifBlock.till + 1))

  if (satsText !== GRINDSATS) {
    fel.push(
      `R4 ${filnamn}: ${METOD}:s första sats är inte den vitlistade grinden. ` +
        `Väntade "${GRINDSATS}", läste "${satsText.slice(0, 140) || '(tom)'}".`,
    )
  }

  return fel
}

function kör() {
  const filer = källfiler()
  // R6 — kanariefågel: noll källfiler betyder att skanningen är blind.
  if (filer.length === 0) {
    console.error('❌ kanariefågel: NOLL källfiler i backupvägen — skanningen är blind')
    return false
  }

  let fel = []
  let raderingar = 0
  for (const f of filer) {
    const rå = readFileSync(join(BACKUP_DIR, f), 'utf8')
    const kod = codeMask(rå)
    raderingar += index(kod, RADERING).length
    if (f === SERVICE) fel = fel.concat(prövaKälla(rå, { filnamn: f }))
    else {
      for (const p of index(kod, RADERING)) {
        fel.push(`R5 ${f}:${radnr(kod, p)}: ${RADERING} utanför ${SERVICE} — ogrindad radering`)
      }
      for (const p of index(kod, FÄLT)) {
        fel.push(
          `R2 ${f}:${radnr(kod, p)}: ${FÄLT} nämns utanför ${SERVICE} — vitlistan gäller bara där`,
        )
      }
    }
  }

  // R6 — kanariefågel: hittar skanningen ingen radering mäter R4/R5 ingenting.
  if (raderingar === 0) {
    console.error(`❌ kanariefågel: NOLL ${RADERING} i backupvägen — reglerna kan inte falla`)
    return false
  }

  for (const f of fel) console.error(`❌ ${f}`)
  if (fel.length === 0) {
    console.log(
      `✅ backupens raderingsväg är grindad: ${filer.length} källfiler, ` +
        `${raderingar} ${RADERING} — alla i ${METOD}, och ${FÄLT} förekommer bara i ` +
        'vitlistans tre former',
    )
  }
  return fel.length === 0
}

/**
 * Självtest — muterar källan i minnet och kräver att reglerna FÄLLER.
 *
 * M1–M5 är uppmätta kringgåenden av den FÖRSTA versionen av den här vakten:
 * alla fem gav `errors: []` då. De ligger kvar som permanenta motprov, så att
 * en framtida "förenkling" av reglerna inte tyst återinför dem. Facit är
 * skrivet FÖRE mätningen: varje farlig mutation ska fälla, originalet vara grönt.
 */
function självtest() {
  const rå = readFileSync(join(BACKUP_DIR, SERVICE), 'utf8')
  let ok = true

  const fall = [
    {
      namn: 'M1 fel flagga i tilldelningen',
      regel: 'R2',
      muterad: rå.replace(
        `config.get<string>(${GRIND_VAR}) === 'true'`,
        "config.get<string>('BACKUP_ENABLED') === 'true'",
      ),
    },
    {
      namn: 'M2 `|| true` — alltid på',
      regel: 'R2',
      muterad: rå.replace(
        `config.get<string>(${GRIND_VAR}) === 'true'`,
        `config.get<string>(${GRIND_VAR}) === 'true' || true`,
      ),
    },
    {
      namn: 'M3 return i en IIFE — metoden fortsätter till raderingen',
      regel: 'R4',
      muterad: rå.replace(
        '      return { skipped: true, pruned: 0, reason: prunePausedMessage() }',
        '      ;(() => { return { skipped: true, pruned: 0, reason: prunePausedMessage() } })()',
      ),
    },
    {
      namn: 'M4 konstanten bär fel variabelnamn',
      regel: 'R1',
      muterad: rå.replace(
        `export const ${GRIND_VAR} = '${GRIND_VÄRDE}'`,
        `export const ${GRIND_VAR} = 'BACKUP_ENABLED'`,
      ),
    },
    {
      namn: 'M5 fältet skrivs över efter konstruktorn',
      regel: 'R2',
      muterad: rå.replace(
        '  async runBackup(',
        `  slaPaGallring() {\n    ;(this as { ${FÄLT}: boolean }).${FÄLT} = true\n  }\n\n  async runBackup(`,
      ),
    },
    {
      namn: 'M6 grindsatsen borttagen',
      regel: 'R2',
      muterad: rå.replace(/\n\s*if \(!this\.pruneEnabled\) \{[\s\S]*?\n\s*\}\n/, '\n'),
    },
    {
      namn: 'M7 radering i en ny, ogrindad metod',
      regel: 'R5',
      muterad: rå.replace(
        '  async listBackups(',
        '  async raderaNagot(key: string) {\n' +
          '    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }))\n' +
          '  }\n\n  async listBackups(',
      ),
    },
    {
      namn: 'M8 en sats smyger in före grinden',
      regel: 'R4',
      muterad: rå.replace(
        `    if (!this.${FÄLT}) {`,
        `    await this.s3.send(new ListObjectsV2Command({ Bucket: this.bucket }))\n    if (!this.${FÄLT}) {`,
      ),
    },
    {
      namn: 'M9 readonly borttaget',
      regel: 'R2',
      muterad: rå.replace(`readonly ${FÄLT}: boolean`, `${FÄLT}: boolean`),
    },
  ]

  // Kanariefågel 0 — den riktiga källan ska vara grön. Annars mäter resten inget.
  const grund = prövaKälla(rå)
  if (grund.length === 0) console.log('✅ kanariefågel 0: den riktiga källan är grön')
  else {
    console.error(`❌ kanariefågel 0: den riktiga källan är RÖD (${grund.join(' | ')})`)
    ok = false
  }

  for (const { namn, regel, muterad } of fall) {
    // En mutation som inte ändrade texten är ett trasigt prov, inte ett utfall.
    if (muterad === rå) {
      console.error(`❌ kanariefågel ${namn}: mutationen ändrade INGENTING — provet är trasigt`)
      ok = false
      continue
    }
    const fel = prövaKälla(muterad)
    if (fel.some((f) => f.startsWith(regel))) {
      console.log(`✅ kanariefågel ${namn}: ${regel} fäller`)
    } else {
      console.error(
        `❌ kanariefågel ${namn}: ${regel} fällde INTE (fel: ${fel.join(' | ') || 'inga'})`,
      )
      ok = false
    }
  }

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
