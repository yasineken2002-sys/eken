#!/usr/bin/env node
/**
 * CI-guard — VARJE fält som matas genom en OCR-extraktor måste vara KLASSAT, och
 * PROSA måste gå genom den Luhn-krävande extraktorn.
 *
 * ── VAD DEN SKYDDAR MOT ──────────────────────────────────────────────────────
 *
 * M2 (#492) stänger av beloppsgissningen när en transaktion bär en OCR som inte
 * löser ut. Villkoret är `transaction.rawOcr` satt, vilket LÄSER som "betalaren
 * angav ett OCR" — men `extractOcr` prövar ingen kontrollsiffra, den tar längsta
 * siffersekvensen om 4–20 tecken. Kördes den på bankens fritext blev ett datum,
 * ett mobilnummer och ett kontonummer alla till `rawOcr`:
 *
 *     "Inbetalning 20260601"          rawOcr=20260601     fuzzy körd=NEJ
 *     "Swish 0701234567 Andersson"    rawOcr=0701234567   fuzzy körd=NEJ
 *     "Hyra juni konto 12345678"      rawOcr=12345678     fuzzy körd=NEJ
 *     "Hyra Andersson"                rawOcr=undefined    fuzzy körd=JA
 *
 * Tre av fyra realistiska beskrivningar stängde alltså av matchningen, och
 * betalningen låg kvar omatchad. Defekten var inte att `description` lästes.
 * Defekten var att den aldrig KLASSADES — precis som `Invoice.reference` i H2.
 *
 * ── REGLERNA ─────────────────────────────────────────────────────────────────
 *
 * R1  Varje argument till `extractOcr(...)` / `extractOcrFromProse(...)` i
 *     reconciliation.service.ts måste stå i INTENT_OCR_FIELDS eller
 *     PROSE_OCR_FIELDS i ocr-proveniens.ts.
 * R2  Ett PROSAFÄLT måste läsas med `extractOcrFromProse`. Läses det med den
 *     ogrindade `extractOcr` fäller guarden.
 * R2b Ett AVSIKTSFÄLT får INTE läsas med `extractOcrFromProse`. Den omvända
 *     riktningen (jfr CLAUDE.md, "Spärrar är riktade"): kräver man Luhn på ett
 *     avsiktsfält kastas ett OCR ur ett gammalt system (Vitec/Momentum) bort,
 *     och systemet börjar beloppsgissa ovanpå ett uttryckligen angivet OCR —
 *     exakt den skada M2 byggdes för att hindra.
 * R3  Registren får inte vara tomma, båda extraktorerna måste finnas i
 *     ocr-proveniens.ts, och den Luhn-krävande måste faktiskt anropas i
 *     reconciliation.service.ts. Utan det blir R1/R2 vakuöst gröna.
 * R4  `extractOcrFromProse` måste FAKTISKT kräva kontrollsiffran — den ska
 *     anropa `isValidOcrNumber`. En extraktor som bara delegerar vidare gör
 *     hela klassificeringen till dekoration.
 *
 * Rent statiskt (fs-only, inga beroenden, ingen DB) → eget CI-steg utan databas.
 * Lokalt:      node apps/api/scripts/check-ocr-provenance.mjs
 * Självtest:   node apps/api/scripts/check-ocr-provenance.mjs --self-test
 */
import { readFileSync } from 'node:fs'
import { codeMask, blankComments, kanariefåglar, KANARIEFÅGEL_LÄGEN } from '../../../scripts/lib/source-scan.mjs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const API_SRC = join(HERE, '..', 'src')
const PROVENANCE_FILE = join(API_SRC, 'reconciliation', 'ocr-proveniens.ts')
const INGEST_FILE = join(API_SRC, 'reconciliation', 'reconciliation.service.ts')

const RAW = 'extractOcr'
const PROSE = 'extractOcrFromProse'
const LUHN = 'isValidOcrNumber'

const lineOf = (text, idx) => text.slice(0, idx).split('\n').length

/**
 * Läs ett `export const X = [...] as const`-register ur källtexten.
 *
 * `blankComments` och INTE `codeMask`: fältnamnen ÄR stränginnehåll. Med
 * codeMask hade regexen fortsatt matcha — men på `'          '`, och varje
 * klassificering nedan hade jämförts mot blanktecken och aldrig mer stämt.
 * Kommentarerna bort, så ett utkommenterat gammalt register inte läses.
 */
export function parseRegistry(text, name) {
  const m = new RegExp(`export const ${name}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*as const`).exec(
    blankComments(text),
  )
  if (!m) return null // saknas helt — skiljs från "finns men tom"
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])
}

/**
 * Hitta varje anrop till en OCR-extraktor och vilket argument den läser.
 *
 * `extractOcrFromProse` matchas FÖRST i alternationen — annars skulle `extractOcr`
 * matcha dess prefix och varje prosaanrop rapporteras som ett råanrop. Det är
 * hela skillnaden guarden mäter, så en prefixförväxling här gör den blind på
 * exakt det den finns för.
 */
export function findExtractorCalls(text) {
  const träffar = []
  const re = new RegExp(`\\b(${PROSE}|${RAW})\\s*\\(\\s*([\\w.?![\\]]+)\\s*\\)`, 'g')
  // KOD, inte råtext: ett anropsexempel i en kommentar är inget anrop, och
  // hade räknats som ett oklassat fält.
  const kod = codeMask(text)
  let m
  while ((m = re.exec(kod))) {
    träffar.push({
      extraktor: m[1],
      fält: m[2],
      line: lineOf(kod, m.index),
    })
  }
  return träffar
}

/** Kärnan. Exporterad så självtestet kör exakt samma kod som CI. */
export function evaluate({ provenanceText, ingestText }) {
  const problem = []
  // R3/R4 och kopplingskontrollen frågar EFTER KOD: en kommentar som nämner
  // extraktorn eller Luhn-kontrollen får inte uppfylla kravet. Registren läses
  // däremot ur strängvyn — se parseRegistry.
  const provenansKod = codeMask(provenanceText)
  const ingestKod = codeMask(ingestText)
  const avsikt = parseRegistry(provenanceText, 'INTENT_OCR_FIELDS')
  const prosa = parseRegistry(provenanceText, 'PROSE_OCR_FIELDS')

  // ── R3 + R4 — mekanismen måste finnas. Utan den mäter R1/R2 ingenting. ────
  if (avsikt === null || avsikt.length === 0) {
    problem.push({
      rule: 'INTENT_OCR_FIELDS saknas eller är tomt',
      detail: 'Utan register kan inget fält klassas — R1 och R2 blir vakuöst gröna.',
    })
  }
  if (prosa === null || prosa.length === 0) {
    problem.push({
      rule: 'PROSE_OCR_FIELDS saknas eller är tomt',
      detail: 'Prosafälten måste vara uppräknade för att kunna krävas bakom Luhn-kontrollen.',
    })
  }
  if (!provenansKod.includes(`export function ${PROSE}`)) {
    problem.push({
      rule: `${PROSE} saknas i ocr-proveniens.ts`,
      detail: 'Regeln kan inte upprätthållas av en extraktor som inte finns.',
    })
  } else {
    // R4 — extraktorn måste FAKTISKT pröva kontrollsiffran.
    // Kroppen tas ur KODVYN. Annars räckte det att en kommentar inne i
    // funktionen NÄMNDE isValidOcrNumber för att kravet skulle vara uppfyllt —
    // och en genomsläppande prosaextraktor är hela defekten regeln finns för.
    const kropp = provenansKod.slice(provenansKod.indexOf(`export function ${PROSE}`))
    if (!kropp.slice(0, kropp.indexOf('\n}')).includes(LUHN)) {
      problem.push({
        rule: `${PROSE} anropar inte ${LUHN}`,
        detail:
          'Prosaextraktorn har blivit en genomsläpp. Den skiljer sig då inte från ' +
          `${RAW}, och varje klassificering nedan blir dekoration.`,
      })
    }
  }
  if (!ingestKod.includes(`${PROSE}(`)) {
    problem.push({
      rule: `${PROSE}() anropas aldrig i reconciliation.service.ts`,
      detail:
        'Prosaextraktorn är bortkopplad. Ett datum eller ett mobilnummer i bankens ' +
        'beskrivning stänger då av beloppsmatchningen igen — tyst.',
    })
  }
  if (problem.length > 0) return problem // vidare kontroller vore meningslösa

  const anrop = findExtractorCalls(ingestText)
  if (anrop.length === 0) {
    problem.push({
      rule: 'NOLL extraktoranrop hittades i reconciliation.service.ts',
      detail:
        'Antingen har ingesten flyttat, eller så har skanningen gått blind. ' +
        'Båda ska falla — en guard utan mätobjekt mäter ingenting.',
    })
    return problem
  }

  for (const a of anrop) {
    const ärAvsikt = avsikt.includes(a.fält)
    const ärProsa = prosa.includes(a.fält)

    if (!ärAvsikt && !ärProsa) {
      problem.push({
        line: a.line,
        rule: `${a.fält} matas genom ${a.extraktor}() men är OKLASSAT`,
        detail:
          'Varje fält som blir en rawOcr måste stå i INTENT_OCR_FIELDS (fältet BÄR ' +
          'betalningsreferensen) eller PROSE_OCR_FIELDS (bankens fritext) i ' +
          'ocr-proveniens.ts. Precis det steget hoppades över när description ' +
          'matades genom den ogrindade extraktorn.',
      })
      continue
    }

    // R2 — prosa måste gå genom Luhn-extraktorn.
    if (ärProsa && a.extraktor !== PROSE) {
      problem.push({
        line: a.line,
        rule: `${a.fält} är PROSA men läses med den ogrindade ${a.extraktor}()`,
        detail:
          'En siffersekvens ur bankens fritext är bara ett OCR om den bär giltig ' +
          `kontrollsiffra. Använd ${PROSE}() — annars gör ett datum, ett ` +
          'mobilnummer eller ett kontonummer transaktionen omatchbar.',
      })
    }

    // R2b — OMVÄNDA RIKTNINGEN. Lika viktig, och lättare att glömma.
    if (ärAvsikt && a.extraktor === PROSE) {
      problem.push({
        line: a.line,
        rule: `${a.fält} är ett AVSIKTSFÄLT men läses med ${a.extraktor}()`,
        detail:
          'Fältet BÄR betalningsreferensen — vad som står där är en avsiktshandling, ' +
          'också utan giltig Luhn (ett OCR ur ett gammalt system har annan ' +
          `kontrollsiffra). Kräver man Luhn här kastas det bort, och systemet ` +
          'börjar beloppsgissa ovanpå ett uttryckligen angivet OCR — den skada M2 ' +
          `finns för. Använd ${RAW}().`,
      })
    }
  }
  return problem
}

// ── självtest ────────────────────────────────────────────────────────────────
const PROVENANCE_OK = `
export const INTENT_OCR_FIELDS = ['raw.ocr', 'row.reference'] as const
export const PROSE_OCR_FIELDS = ['row.description', 'raw.description'] as const
export function ${RAW}(text) { return null }
export function ${PROSE}(text) {
  const k = ${RAW}(text)
  return k !== null && ${LUHN}(k) ? k : null
}
`

const INGEST_OK = `
const a = ${RAW}(raw.ocr)
const rawOcr = ${RAW}(row.reference) ?? ${PROSE}(row.description)
`

function selfTest() {
  let ok = true
  const fail = (m) => {
    ok = false
    console.error(`❌ ${m}`)
  }
  const grön = (label, r) =>
    r.length === 0
      ? console.log(`✅ inget falsklarm: ${label}`)
      : fail(`FALSKLARM: ${label} → ${r[0].rule}`)
  /**
   * Kräver att fyndet fälldes av den REGEL som fallet handlar om. Utan `väntad`
   * kan ett fall passera på fel grund — t.ex. att fixturen råkat koppla bort
   * extraktorn helt, så R3 kortsluter och R2 aldrig prövas.
   */
  const röd = (label, r, väntad) => {
    if (r.length === 0) return fail(`MISSADE: ${label}`)
    if (väntad && !r.some((x) => x.rule.includes(väntad))) {
      return fail(`${label} fälldes av FEL regel: "${r[0].rule}" — väntade "${väntad}"`)
    }
    console.log(`✅ fångad: ${label} (${r[0].rule})`)
  }

  // ── DEN DELADE SKANNERNS KANARIEFÅGLAR (metavaktens R2) ──────────────────
  const skanner = kanariefåglar()
  if (skanner.length) fail(`DEN DELADE SKANNERN ÄR TRASIG: ${skanner.join(' | ')}`)
  else console.log(`✅ delad skanner: kanariefåglarna gröna över ${KANARIEFÅGEL_LÄGEN.length} lägen`)

  // Registren läses ur STRÄNGVYN. Hade någon "moderniserat" parseRegistry till
  // codeMask hade den fortsatt returnera rätt ANTAL fält — men blanktecken, och
  // varje klassificering nedan hade blivit vakuös.
  {
    const r = parseRegistry(PROVENANCE_OK, 'INTENT_OCR_FIELDS') ?? []
    if (r.length === 0 || r.some((f) => !/[A-Za-z]/.test(f))) {
      fail(`registret gav ${JSON.stringify(r)} — masken har blankat stränginnehållet`)
    } else console.log(`✅ registret bär riktiga fältnamn: ${r.join(', ')}`)
  }
  // Och ett utkommenterat register ska inte läsas.
  {
    const r = parseRegistry(
      `// export const INTENT_OCR_FIELDS = ['gammalt.falt'] as const\nexport const INTENT_OCR_FIELDS = ['raw.ocr'] as const`,
      'INTENT_OCR_FIELDS',
    )
    if (r?.join(',') !== 'raw.ocr') fail(`utkommenterat register lästes: ${JSON.stringify(r)}`)
    else console.log('✅ ett utkommenterat register läses inte')
  }

  // ── KANARIEFÅGEL 1: skanningen måste ge utslag på känd indata ─────────────
  // Utan den kan findExtractorCalls() returnera [] och R1/R2 loopa över tomhet.
  const funna = findExtractorCalls(INGEST_OK)
  const nyckel = funna.map((f) => `${f.extraktor}(${f.fält})`).sort().join(',')
  const väntat = `${RAW}(raw.ocr),${RAW}(row.reference),${PROSE}(row.description)`
  if (nyckel !== väntat) {
    fail(`kanariefågel: skanningen hittade ${nyckel}, väntade ${väntat}`)
  } else console.log('✅ kanariefågel: skanningen skiljer de två extraktorerna åt i fixturen')

  // ── KANARIEFÅGEL 2: mot den RIKTIGA källan ───────────────────────────────
  // OMFÅNGSGOLV, inte "fler än noll". En skanning som krympt från 4 anrop till
  // 1 mäter nästan ingenting men klarar ett nollgolv. Talen är MÄTTA mot
  // e9aea18: 4 extraktoranrop, varav 2 genom prosaextraktorn; registren har
  // 2 respektive 2 fält.
  const MIN_ANROP = 3
  const MIN_PROSAANROP = 1
  const MIN_REGISTERFÄLT = 2
  const riktiga = findExtractorCalls(readFileSync(INGEST_FILE, 'utf8'))
  const riktigtProvenans = readFileSync(PROVENANCE_FILE, 'utf8')
  const registerStorlek = ['INTENT_OCR_FIELDS', 'PROSE_OCR_FIELDS'].map(
    (n) => (parseRegistry(riktigtProvenans, n) ?? []).length,
  )
  if (riktiga.length < MIN_ANROP) {
    fail(
      `omfång: ${riktiga.length} extraktoranrop i reconciliation.service.ts, golv ${MIN_ANROP} ` +
        '— skanningen har gått blind eller ingesten har flyttat',
    )
  } else if (riktiga.filter((r) => r.extraktor === PROSE).length < MIN_PROSAANROP) {
    fail('omfång: INGET prosaanrop i den riktiga källan — prosaextraktorn är bortkopplad')
  } else if (registerStorlek.some((n) => n < MIN_REGISTERFÄLT)) {
    fail(
      `omfång: registren har ${registerStorlek.join(' resp. ')} fält, golv ${MIN_REGISTERFÄLT} ` +
        '— klassificeringen har nästan inget att klassa',
    )
  } else {
    console.log(
      `✅ omfång (golv ${MIN_ANROP}/${MIN_PROSAANROP}/${MIN_REGISTERFÄLT}, register ` +
        `${registerStorlek.join('+')}): ${riktiga.length} extraktoranrop i den riktiga källan, ` +
        `varav ${riktiga.filter((r) => r.extraktor === PROSE).length} genom ${PROSE}`,
    )
  }

  grön('paritet', evaluate({ provenanceText: PROVENANCE_OK, ingestText: INGEST_OK }))

  // ── R2 — DEFEKTEN SJÄLV. Guardens hela existensberättigande. ─────────────
  röd(
    'prosafält läst med den ogrindade extraktorn (defekten före den här PR:en)',
    evaluate({
      provenanceText: PROVENANCE_OK,
      // Det legitima prosaanropet står kvar med FLIT: utan det försvinner
      // ${PROSE} ur filen, R3 kortsluter på "anropas aldrig", och R2 prövas
      // aldrig. Självtestet var rött på precis det innan `väntad` fångade det.
      ingestText:
        `const ok = ${PROSE}(raw.description)\n` +
        `const rawOcr = ${RAW}(row.reference) ?? ${RAW}(row.description)`,
    }),
    'är PROSA men läses med den ogrindade',
  )

  // ── R2b — OMVÄNDA RIKTNINGEN ────────────────────────────────────────────
  röd(
    'avsiktsfält läst med prosaextraktorn (den sannolika förenklingen)',
    evaluate({
      provenanceText: PROVENANCE_OK,
      // ${PROSE} anropas här ändå (det ÄR defekten), så R3 kortsluter inte.
      ingestText: `const rawOcr = ${PROSE}(row.reference) ?? ${PROSE}(row.description)`,
    }),
    'är ett AVSIKTSFÄLT men läses med',
  )

  // ── R1 — nytt, oklassat fält ────────────────────────────────────────────
  röd(
    'nytt oklassat fält matas genom en extraktor',
    evaluate({
      provenanceText: PROVENANCE_OK,
      ingestText: INGEST_OK + `\nconst extra = ${RAW}(row.memo)`,
    }),
    'OKLASSAT',
  )

  // ── R3 — båda riktningarna av "mekanismen finns" ────────────────────────
  röd(
    'tomt prosaregister',
    evaluate({
      provenanceText: PROVENANCE_OK.replace("['row.description', 'raw.description']", '[]'),
      ingestText: INGEST_OK,
    }),
    'PROSE_OCR_FIELDS',
  )
  röd(
    'tomt avsiktsregister',
    evaluate({
      provenanceText: PROVENANCE_OK.replace("['raw.ocr', 'row.reference']", '[]'),
      ingestText: INGEST_OK,
    }),
    'INTENT_OCR_FIELDS',
  )
  röd(
    'prosaextraktorn bortkopplad från ingesten',
    evaluate({
      provenanceText: PROVENANCE_OK,
      ingestText: INGEST_OK.replace(`${PROSE}(row.description)`, `${RAW}(row.reference)`),
    }),
    'anropas aldrig',
  )
  röd(
    'prosaextraktorn borttagen ur ocr-proveniens.ts',
    evaluate({
      provenanceText: PROVENANCE_OK.replace(`export function ${PROSE}`, `function annatNamn`),
      ingestText: INGEST_OK,
    }),
    'saknas i ocr-proveniens.ts',
  )

  // ── R4 — extraktorn finns men prövar inte kontrollsiffran ───────────────
  // DEN FARLIGASTE UPPMJUKNINGEN: allt heter rätt, alla register stämmer, varje
  // anrop är klassat — och regeln gör ingenting. Utan R4 är guarden grön.
  röd(
    'prosaextraktorn är en genomsläpp (anropar inte Luhn)',
    evaluate({
      provenanceText: PROVENANCE_OK.replace(
        `  const k = ${RAW}(text)\n  return k !== null && ${LUHN}(k) ? k : null`,
        `  return ${RAW}(text)`,
      ),
      ingestText: INGEST_OK,
    }),
    `anropar inte ${LUHN}`,
  )

  // Blind skanning: mekanismen finns, men inga anrop hittas.
  röd(
    'inga extraktoranrop alls (blind skanning)',
    evaluate({
      // Kopplingen finns i KOD, men i en form skanningen inte känner igen
      // (argumentet är en indexering med sträng, inte en identifierarkedja).
      // Då ska R-noll falla, inte kopplingskontrollen.
      //
      // Fixturen såg tidigare ut så här:  `const y = "${PROSE}("`
      // — alltså en STRÄNG som uppfyllde `ingestText.includes(...)`. Den
      // fungerade bara därför att vakten läste råtext, och dokumenterade i
      // praktiken defekten: prosa kunde intyga att extraktorn var inkopplad.
      // Efter migreringen till codeMask är strängen blankad, och fixturen
      // behövde bli en riktig kodkoppling.
      provenanceText: PROVENANCE_OK,
      ingestText: `const y = ${PROSE}(row['description'])`,
    }),
    'NOLL extraktoranrop',
  )

  // Och den omvända riktningen, som är den migreringen faktiskt vann: en
  // koppling som bara PÅSTÅS — i en sträng eller en kommentar — räknas inte.
  röd(
    'kopplingen bara PÅSTÅDD i en sträng',
    evaluate({ provenanceText: PROVENANCE_OK, ingestText: `const y = "${PROSE}("` }),
    'anropas aldrig',
  )
  röd(
    'kopplingen bara PÅSTÅDD i en kommentar',
    evaluate({ provenanceText: PROVENANCE_OK, ingestText: `// vi anropar ${PROSE}( någon annanstans` }),
    'anropas aldrig',
  )
  röd(
    `${LUHN} nämnd bara i en KOMMENTAR inuti ${PROSE}`,
    evaluate({
      provenanceText: `
export const INTENT_OCR_FIELDS = ['raw.ocr'] as const
export const PROSE_OCR_FIELDS = ['row.description'] as const
export function ${RAW}(text) { return null }
export function ${PROSE}(text) {
  // beloppet prövas mot ${LUHN} i anroparen
  return ${RAW}(text)
}
`,
      ingestText: INGEST_OK,
    }),
    `anropar inte ${LUHN}`,
  )

  console.log(ok ? '\n✅ Självtest OK.' : '\n❌ Självtest misslyckades.')
  process.exit(ok ? 0 : 1)
}

// ── main ─────────────────────────────────────────────────────────────────────
function main() {
  if (process.argv.includes('--self-test')) return selfTest()

  const problem = evaluate({
    provenanceText: readFileSync(PROVENANCE_FILE, 'utf8'),
    ingestText: readFileSync(INGEST_FILE, 'utf8'),
  })

  if (problem.length > 0) {
    console.error('\n=== OCR-PROVENIENS: OKLASSAT FÄLT ELLER FEL EXTRAKTOR (CI-guard) ===\n')
    for (const p of problem) {
      const var_ = p.line ? `reconciliation.service.ts:${p.line}` : 'ocr-proveniens.ts'
      console.error(`❌ ${var_}\n   ${p.rule}\n   ${p.detail}`)
    }
    console.error(
      '\nRegeln: ett fält som BÄR betalningsreferensen är en avsiktshandling och läses\n' +
        'med extractOcr(); bankens fritext är prosa och läses med extractOcrFromProse(),\n' +
        'som kräver giltig kontrollsiffra. Klassa fältet i\n' +
        'apps/api/src/reconciliation/ocr-proveniens.ts.\n',
    )
    process.exit(1)
  }

  const anrop = findExtractorCalls(readFileSync(INGEST_FILE, 'utf8'))
  console.log(
    `✅ ${anrop.length} extraktoranrop, alla klassade — prosa bara bakom kontrollsiffran.`,
  )
}

main()
