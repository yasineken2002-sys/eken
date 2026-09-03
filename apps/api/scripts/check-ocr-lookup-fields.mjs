#!/usr/bin/env node
/**
 * CI-guard (H2) — VARJE fält som slås upp mot en banktransaktions råa OCR måste
 * vara KLASSAT, och fritext måste ligga bakom identitetsgrinden.
 *
 * ── VAD DEN SKYDDAR MOT ──────────────────────────────────────────────────────
 *
 * `Invoice.reference` — fritext från klienten — låg i OCR-uppslaget FÖRE avin i
 * fyra månader. Ingen tog ställning till det: fältet följde med filens första
 * commit, inget test täckte det, och utfallet hade varit att en hyresavis OCR
 * inskriven som fakturareferens kapar hyresbetalningen. Tyst, för avins
 * ocrOutstanding rörs inte och kravtrappan går vidare mot någon som betalat.
 *
 * Defekten var inte att fältet fanns. Defekten var att det aldrig KLASSADES.
 * Guarden tvingar fram klassningen: ett nytt fält i uppslaget måste stå i
 * SYSTEM_ASSIGNED_OCR_FIELDS (identitet, får slås upp fritt) eller i
 * FREE_TEXT_OCR_FIELDS (förhoppning, måste ligga bakom grinden). Ett fält som
 * inte står i någon av dem fäller — författaren måste ta ställning.
 *
 * ── REGLERNA ─────────────────────────────────────────────────────────────────
 *
 * R1  Varje uppslag i reconciliation.service.ts som binder ett fält till den råa
 *     OCR-strängen måste vara klassat i ocr-identity.ts.
 * R2  Ett FRITEXT-fält måste ligga bakom identitetsgrinden — grindidentifieraren
 *     ska stå i uttrycket som omsluter uppslaget.
 * R3  Registren får inte vara tomma, och grindfunktionen måste finnas och
 *     faktiskt anropas i reconciliation.service.ts. Ett register som tappats,
 *     eller en grind som slutat anropas, gör R1 och R2 vakuöst gröna.
 *
 * Rent statiskt (fs-only, inga beroenden, ingen DB) → eget CI-steg utan databas.
 * Lokalt:      node apps/api/scripts/check-ocr-lookup-fields.mjs
 * Självtest:   node apps/api/scripts/check-ocr-lookup-fields.mjs --self-test
 */
import { readFileSync } from 'node:fs'
import { codeMask, blankComments, kanariefåglar, KANARIEFÅGEL_LÄGEN } from '../../../scripts/lib/source-scan.mjs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const API_SRC = join(HERE, '..', 'src')
const IDENTITY_FILE = join(API_SRC, 'reconciliation', 'ocr-identity.ts')
const MATCH_FILE = join(API_SRC, 'reconciliation', 'reconciliation.service.ts')

const GATE = 'harSystemtilldelatOcr'

/**
 * De uttryck som BÄR den råa OCR-strängen inne i matchTransaction och
 * vattenfallet. `transaction.rawOcr` är källan; `ocrNumber` är parameternamnet
 * den skickas vidare under (applyWaterfallToRentNotices), och `rawOcr` är den
 * form en framtida destrukturering skulle ge.
 */
const RAW_OCR_BINDINGS = ['transaction.rawOcr', 'rawOcr', 'ocrNumber']

const lineOf = (text, idx) => text.slice(0, idx).split('\n').length

/**
 * Läs ett `export const X = [...] as const`-register ur källtexten.
 *
 * `blankComments` och INTE `codeMask`: fältnamnen ÄR stränginnehåll. Med
 * codeMask hade regexen fortsatt matcha rätt ANTAL poster — men blanktecken,
 * och `system.includes(l.nyckel)` hade aldrig mer blivit sant. Vakten hade
 * fällt varje uppslag som oklassat, eller, om någon tystat det, ingenting alls.
 */
export function parseRegistry(text, name) {
  const m = new RegExp(`export const ${name}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*as const`).exec(
    blankComments(text),
  )
  if (!m) return null // saknas helt — skiljs från "finns men tom"
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])
}

/**
 * Blocket `{ … }` som börjar vid `openIdx`, klammerbalanserat.
 *
 * Körs ENBART mot codeMask-utdata. Ett `'}'` i en stränglitteral stängde annars
 * `where`-blocket för tidigt, och de fältbindningar som stod efter den punkten
 * försvann ur mängden — samma tystnad som kortformsfelet i kommentaren nedan,
 * men utan att någon räknat träffarna.
 */
function sliceBlock(text, openIdx) {
  let depth = 0
  for (let i = openIdx; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}') {
      depth--
      if (depth === 0) return text.slice(openIdx, i + 1)
    }
  }
  return text.slice(openIdx)
}

/**
 * Hitta varje `where: { … }` som binder ett fält till den råa OCR-strängen, och
 * avgör vilken modell uppslaget går mot.
 *
 * Modellen härleds genom att gå BAKÅT till närmaste `<klient>.<modell>.find*(`
 * — det är den enda platsen modellnamnet står, och en `where` utan ett sådant
 * anrop framför sig är inte ett Prisma-uppslag.
 */
/** Variabelnamnen som bär grindens RESULTAT: `const <v> = await GATE(...)`. */
export function gateResultVars(text) {
  // KOD: en tilldelning som bara står i en kommentar binder ingen variabel.
  return [
    ...codeMask(text).matchAll(
      new RegExp(`(?:const|let|var)\\s+(\\w+)\\s*=\\s*await\\s+${GATE}\\s*\\(`, 'g'),
    ),
  ].map((m) => m[1])
}

/**
 * Styrs uppslaget vid `idx` av grinden?
 *
 * Fönstret är avsiktligt KORT (400 tecken): villkoret som avgör ett uppslag står
 * omedelbart före det. Ett längre fönster börjar plocka upp villkor som hör till
 * ett helt annat uppslag — vilket är samma fel som den första versionen gjorde,
 * bara mindre uppenbart.
 */
export function isGovernedByGate(text, idx, gateVars) {
  // Fönstret läses ur KOD. En kommentar som säger "grinden avgör det här" är
  // inget villkor, och fick aldrig kunna intyga att uppslaget är grindat.
  const fönster = codeMask(text).slice(Math.max(0, idx - 400), idx)
  return gateVars.some((v) =>
    new RegExp(`(?:!\\s*${v}\\b|\\b${v}\\s*(?:\\?|&&|\\|\\|))`).test(fönster),
  )
}

export function findOcrLookups(text) {
  const träffar = []
  // HELA skanningen går på kodvyn: `where`-blocken, klammerbalanseringen,
  // fältbindningarna, modellhärledningen och grindfönstret. Masken bevarar
  // längd och radbrytningar, så `line` pekar fortfarande på råfilen.
  const kod = codeMask(text)
  const gateVars = gateResultVars(text)
  const whereRe = /\bwhere\s*:\s*\{/g
  let m
  while ((m = whereRe.exec(kod))) {
    const block = sliceBlock(kod, kod.indexOf('{', m.index))

    // Vilka fält i blocket binds till den råa OCR-strängen?
    const fält = []
    for (const [, key, value] of block.matchAll(/([\p{L}\p{N}_$]+)\s*:\s*([\p{L}\p{N}_$.]+)/gu)) {
      if (RAW_OCR_BINDINGS.includes(value)) fält.push(key)
    }
    // Kortform (`{ organizationId, ocrNumber, … }`) — nyckeln ÄR variabeln.
    //
    // Avgränsaren EFTER nyckeln matchas med lookahead, inte konsumeras. Utan det
    // åt `{ organizationId,` upp kommatecknet som `ocrNumber,` behövde som sin
    // INLEDANDE avgränsare, och vattenfallets uppslag blev osynligt för guarden:
    // 3 träffar i stället för 4. En skanning som missar ett uppslag rapporterar
    // grönt om precis det uppslag den inte kan se.
    for (const [, key] of block.matchAll(/[{,]\s*([\p{L}\p{N}_$]+)\s*(?=[,}])/gu)) {
      if (RAW_OCR_BINDINGS.includes(key)) fält.push(key)
    }
    if (fält.length === 0) continue

    // Modellen: närmaste `.<modell>.find…(` bakåt.
    const före = kod.slice(Math.max(0, m.index - 400), m.index)
    const modellMatch = [...före.matchAll(/\.\s*([\p{L}\p{N}_$]+)\s*\.\s*find\w*\s*\(/gu)].pop()
    const modell = modellMatch ? modellMatch[1] : null

    for (const f of new Set(fält)) {
      träffar.push({
        modell,
        fält: f,
        nyckel: modell ? `${modell[0].toUpperCase()}${modell.slice(1)}.${f}` : `?.${f}`,
        line: lineOf(kod, m.index),
        // GRINDEN MÅSTE STYRA UPPSLAGET — inte bara finnas i närheten.
        //
        // Första versionen frågade om `harSystemtilldelatOcr` nämndes inom 1500
        // tecken bakåt. Negativkontrollen fällde den: när regeln togs bort ur
        // `??`-kedjan stod anropet kvar en rad ovanför, guarden såg det och
        // rapporterade GRÖNT om exakt den kapning den byggts för att fånga.
        //
        // Kriteriet är därför VILLKORSANVÄNDNING av grindens resultatvariabel —
        // `v ?`, `!v`, `v &&`, `v ||` — inom det uttryck som omsluter uppslaget.
        // En tilldelning (`const v = await grind(...)`) räknas INTE: den bevisar
        // att grinden anropades, inte att den avgjorde något.
        gated: isGovernedByGate(text, m.index, gateVars),
      })
    }
  }
  return träffar
}

/** Kärnan. Exporterad så självtestet kör exakt samma kod som CI. */
export function evaluate({ identityText, matchText }) {
  const problem = []
  const system = parseRegistry(identityText, 'SYSTEM_ASSIGNED_OCR_FIELDS')
  const fritext = parseRegistry(identityText, 'FREE_TEXT_OCR_FIELDS')

  // R3 — registren och grinden måste finnas. Utan dem mäter R1/R2 ingenting.
  if (system === null || system.length === 0) {
    problem.push({
      rule: 'SYSTEM_ASSIGNED_OCR_FIELDS saknas eller är tomt',
      detail: 'Utan register kan inget fält klassas — R1 och R2 blir vakuöst gröna.',
    })
  }
  if (fritext === null) {
    problem.push({
      rule: 'FREE_TEXT_OCR_FIELDS saknas',
      detail: 'Fritextfälten måste vara uppräknade för att kunna krävas bakom grinden.',
    })
  }
  if (!codeMask(identityText).includes(`export async function ${GATE}`)) {
    problem.push({
      rule: `grindfunktionen ${GATE} saknas i ocr-identity.ts`,
      detail: 'Regeln kan inte upprätthållas av en grind som inte finns.',
    })
  }
  if (!codeMask(matchText).includes(`${GATE}(`)) {
    problem.push({
      rule: `${GATE}() anropas aldrig i reconciliation.service.ts`,
      detail:
        'Grinden är bortkopplad. Fritextgrenen kan då vinna över en identitet ' +
        'igen, medan varje enskild rad ser rimlig ut.',
    })
  }
  if (problem.length > 0) return problem // vidare kontroller vore meningslösa

  const lookups = findOcrLookups(matchText)
  if (lookups.length === 0) {
    problem.push({
      rule: 'NOLL OCR-uppslag hittades i reconciliation.service.ts',
      detail:
        'Antingen har uppslagen flyttat, eller så har skanningen gått blind. ' +
        'Båda ska falla — en guard utan mätobjekt mäter ingenting.',
    })
    return problem
  }

  for (const l of lookups) {
    if (system.includes(l.nyckel)) continue // identitet — fri uppslagning
    if (fritext.includes(l.nyckel)) {
      if (!l.gated) {
        problem.push({
          line: l.line,
          rule: `${l.nyckel} slås upp mot rawOcr UTAN identitetsgrind`,
          detail:
            'Ett fritextfält är en förhoppning. Det får bara komma till tals när ' +
            `ingen identitet gör anspråk på numret — lägg uppslaget bakom ${GATE}().`,
        })
      }
      continue
    }
    problem.push({
      line: l.line,
      rule: `${l.nyckel} slås upp mot rawOcr men är OKLASSAT`,
      detail:
        'Varje fält i OCR-uppslaget måste stå i SYSTEM_ASSIGNED_OCR_FIELDS ' +
        '(identitet) eller FREE_TEXT_OCR_FIELDS (förhoppning, kräver grind) i ' +
        'ocr-identity.ts. Precis det steget hoppades över när Invoice.reference ' +
        'hamnade i uppslaget.',
    })
  }
  return problem
}

// ── självtest ────────────────────────────────────────────────────────────────
const IDENTITY_OK = `
export const SYSTEM_ASSIGNED_OCR_FIELDS = ['Invoice.ocrNumber', 'RentNotice.ocrNumber'] as const
export const FREE_TEXT_OCR_FIELDS = ['Invoice.reference'] as const
export async function ${GATE}(db, organizationId, rawOcr) { return false }
`

const MATCH_OK = `
const identitet = await ${GATE}(db, organizationId, transaction.rawOcr)
const invoice =
  (await db.invoice.findFirst({ where: { organizationId, ocrNumber: transaction.rawOcr } })) ??
  (identitet ? null : await db.invoice.findFirst({ where: { organizationId, reference: transaction.rawOcr } }))
const notice = await db.rentNotice.findFirst({ where: { organizationId, ocrNumber: transaction.rawOcr } })
`

function selfTest() {
  let ok = true
  const fail = (m) => {
    ok = false
    console.error(`❌ ${m}`)
  }
  const grön = (label, r) =>
    r.length === 0 ? console.log(`✅ inget falsklarm: ${label}`) : fail(`FALSKLARM: ${label} → ${r[0].rule}`)
  /**
   * Kräver att fyndet fälldes av den REGEL som fallet handlar om.
   *
   * Utan `väntad` passerade två av fallen nedan på fel grund: fixturen hade råkat
   * koppla bort grinden helt, så R3 kortslöt och R2 prövades aldrig. Ett grönt
   * självtest sa då att R2 fungerade utan att R2 hade körts en enda gång.
   */
  const röd = (label, r, väntad) => {
    if (r.length === 0) return fail(`MISSADE: ${label}`)
    if (väntad && !r.some((x) => x.rule.includes(väntad))) {
      return fail(`${label} fälldes av FEL regel: "${r[0].rule}" — väntade "${väntad}"`)
    }
    console.log(`✅ fångad: ${label} (${r[0].rule})`)
  }

  // ── DEN DELADE SKANNERNS KANARIEFÅGLAR (metavaktens R2) ───────────────────
  const skanner = kanariefåglar()
  if (skanner.length) fail(`DEN DELADE SKANNERN ÄR TRASIG: ${skanner.join(' | ')}`)
  else console.log(`✅ delad skanner: kanariefåglarna gröna över ${KANARIEFÅGEL_LÄGEN.length} lägen`)

  // ── VYERNAS SEMANTIK ──────────────────────────────────────────────────────
  {
    // Registren läses ur strängvyn. Hade någon bytt parseRegistry till codeMask
    // hade den fortsatt ge rätt ANTAL poster — men blanktecken, och
    // `system.includes(nyckel)` hade aldrig mer blivit sant.
    const r = parseRegistry(IDENTITY_OK, 'SYSTEM_ASSIGNED_OCR_FIELDS') ?? []
    if (r.length === 0 || r.some((f) => !/[A-Za-z]/.test(f))) {
      fail(`registret gav ${JSON.stringify(r)} — masken har blankat stränginnehållet`)
    } else console.log(`✅ registret bär riktiga fältnamn: ${r.join(', ')}`)
  }
  {
    // Ett `}` i en stränglitteral fick inte stänga where-blocket för tidigt.
    // Utan masken försvann bindningen efter strängen ur mängden, och vakten
    // rapporterade grönt om precis det uppslag den inte kunde se.
    const medKlammerISträng =
      `const identitet = await ${GATE}(db, organizationId, transaction.rawOcr)\n` +
      `const inv = await db.invoice.findFirst({ where: { note: 'slut }', reference: transaction.rawOcr } })`
    const f = findOcrLookups(medKlammerISträng)
    if (!f.some((x) => x.nyckel === 'Invoice.reference')) {
      fail(`ett '}' i en sträng dolde uppslaget: ${JSON.stringify(f.map((x) => x.nyckel))}`)
    } else console.log("✅ ett '}' i en sträng stänger inte where-blocket")
  }

  // Grinden får inte kunna intygas av prosa — åt båda hållen.
  röd(
    'VY: grinden bara PÅSTÅDD i en kommentar i matchningsfilen',
    evaluate({
      identityText: IDENTITY_OK,
      matchText: `// uppslaget ligger bakom ${GATE}( i anroparen\nconst x = 1`,
    }),
    'anropas aldrig',
  )
  röd(
    'VY: grindvillkoret bara i en KOMMENTAR före fritextuppslaget',
    evaluate({
      identityText: IDENTITY_OK,
      matchText:
        `const identitet = await ${GATE}(db, organizationId, transaction.rawOcr)\n` +
        `const inv = await db.invoice.findFirst({ where: { organizationId, ocrNumber: transaction.rawOcr } })\n` +
        `// identitet ? null : — grinden avgör det här uppslaget\n` +
        `const ref = await db.invoice.findFirst({ where: { organizationId, reference: transaction.rawOcr } })`,
    }),
    'UTAN identitetsgrind',
  )

  // ── KANARIEFÅGEL: skanningen måste ge utslag på känd indata ────────────────
  // Utan den kan findOcrLookups() returnera [] och R1/R2 loopa över tomhet.
  const funna = findOcrLookups(MATCH_OK)
  const nycklar = funna.map((f) => f.nyckel).sort()
  if (nycklar.join(',') !== 'Invoice.ocrNumber,Invoice.reference,RentNotice.ocrNumber') {
    fail(`kanariefågel: skanningen hittade ${JSON.stringify(nycklar)} i fixturen, väntade tre kända fält`)
  } else console.log('✅ kanariefågel: skanningen hittar alla tre fälten i fixturen')

  // ── KANARIEFÅGEL 2: mot den RIKTIGA källan ────────────────────────────────
  // OMFÅNGSGOLV, inte "fler än noll": en skanning som krympt från 4 uppslag
  // till 1 mäter nästan ingenting men klarar ett nollgolv. Talen är MÄTTA mot
  // e9aea18: 4 uppslag i den riktiga källan, register om 3 resp. 1 fält.
  const MIN_UPPSLAG = 3
  const MIN_SYSTEMFÄLT = 2
  const riktiga = findOcrLookups(readFileSync(MATCH_FILE, 'utf8'))
  const riktigtRegister = parseRegistry(
    readFileSync(IDENTITY_FILE, 'utf8'),
    'SYSTEM_ASSIGNED_OCR_FIELDS',
  ) ?? []
  if (riktiga.length < MIN_UPPSLAG) {
    fail(
      `omfång: ${riktiga.length} OCR-uppslag i reconciliation.service.ts, golv ${MIN_UPPSLAG} ` +
        '— skanningen har gått blind eller uppslagen har flyttat',
    )
  } else if (riktigtRegister.length < MIN_SYSTEMFÄLT) {
    fail(
      `omfång: SYSTEM_ASSIGNED_OCR_FIELDS har ${riktigtRegister.length} fält, golv ` +
        `${MIN_SYSTEMFÄLT} — klassificeringen har nästan inget att klassa`,
    )
  } else {
    console.log(
      `✅ omfång: ${riktiga.length} OCR-uppslag i den riktiga källan (golv ${MIN_UPPSLAG}), ` +
        `${riktigtRegister.length} identitetsfält i registret (golv ${MIN_SYSTEMFÄLT})`,
    )
  }

  grön('paritet', evaluate({ identityText: IDENTITY_OK, matchText: MATCH_OK }))

  // R2 — fritext utan grind
  // Grinden ANROPAS här — men långt bort, så den inte omsluter fritextuppslaget.
  // Annars kortsluter R3 och R2 prövas aldrig.
  röd(
    'fritextfält utan identitetsgrind',
    evaluate({
      identityText: IDENTITY_OK,
      matchText:
        `const oanvand = await ${GATE}(db, organizationId, x)\n` +
        '// '.padEnd(1600, 'x') +
        `
const invoice = await db.invoice.findFirst({ where: { organizationId, reference: transaction.rawOcr } })
`,
    }),
    'UTAN identitetsgrind',
  )

  // DEN MISS NEGATIVKONTROLLEN HITTADE. Grinden anropas — resultatet används bara
  // inte. Första versionen av guarden rapporterade GRÖNT här, alltså om exakt den
  // kapning den byggts för att fånga. Fallet står kvar som självtest för att en
  // framtida uppmjukning av `gated` ska falla på det.
  röd(
    'grinden anropas men styr INTE fritextuppslaget',
    evaluate({
      identityText: IDENTITY_OK,
      matchText: `
const identitet = await ${GATE}(db, organizationId, transaction.rawOcr)
const invoice =
  (await db.invoice.findFirst({ where: { organizationId, ocrNumber: transaction.rawOcr } })) ??
  (await db.invoice.findFirst({ where: { organizationId, reference: transaction.rawOcr } }))
`,
    }),
    'UTAN identitetsgrind',
  )

  // Motsatt riktning: `!v` är lika giltig styrning som `v ?`.
  grön(
    'negerad grindvariabel styr uppslaget',
    evaluate({
      identityText: IDENTITY_OK,
      matchText: `
const identitet = await ${GATE}(db, organizationId, transaction.rawOcr)
const invoice = !identitet
  ? await db.invoice.findFirst({ where: { organizationId, reference: transaction.rawOcr } })
  : null
`,
    }),
  )

  // R1 — NYTT, oklassat fält. Det här är guardens hela existensberättigande.
  röd(
    'nytt oklassat fritextfält i uppslaget',
    evaluate({
      identityText: IDENTITY_OK,
      matchText:
        MATCH_OK +
        `\nconst extra = await db.invoice.findFirst({ where: { organizationId, notes: transaction.rawOcr } })`,
    }),
    'OKLASSAT',
  )
  röd(
    'nytt oklassat fält på en ANNAN modell',
    evaluate({
      identityText: IDENTITY_OK,
      matchText:
        MATCH_OK +
        `\nconst c = await db.customer.findFirst({ where: { organizationId, reference: transaction.rawOcr } })`,
    }),
    'OKLASSAT',
  )

  // R3 — båda riktningarna av "mekanismen finns"
  röd(
    'tomt identitetsregister',
    evaluate({
      identityText: IDENTITY_OK.replace(
        "['Invoice.ocrNumber', 'RentNotice.ocrNumber']",
        '[]',
      ),
      matchText: MATCH_OK,
    }),
    'SYSTEM_ASSIGNED_OCR_FIELDS',
  )
  röd(
    'grinden bortkopplad från matchTransaction',
    evaluate({ identityText: IDENTITY_OK, matchText: MATCH_OK.replace(new RegExp(GATE, 'g'), 'nagotAnnat') }),
    'anropas aldrig',
  )
  röd(
    'grindfunktionen borttagen ur ocr-identity.ts',
    evaluate({
      identityText: IDENTITY_OK.replace(`export async function ${GATE}`, 'async function annatNamn'),
      matchText: MATCH_OK,
    }),
    'grindfunktionen',
  )
  // Grinden anropas, registren finns — men inga uppslag hittas. Utan att grinden
  // ANROPAS här hade R3 kortslutit och nollträffsregeln aldrig prövats.
  röd(
    'inga uppslag alls (blind skanning)',
    evaluate({
      identityText: IDENTITY_OK,
      matchText: `const x = await ${GATE}(db, organizationId, raw)`,
    }),
    'NOLL OCR-uppslag',
  )

  console.log(ok ? '\n✅ Självtest OK.' : '\n❌ Självtest misslyckades.')

  // ── #668: IDENTIFIERARE ÄR UNICODE, INTE \w ─────────────────────────────
  //
  // `\w` är ASCII. Härledningen missade varje namn med å, ä eller ö, och
  // utfallet var TYSTNAD: posten hamnade aldrig i mängden.
  //
  // BÅDA FELFORMERNA prövas, inte bara den positiva:
  //   MISSAD  svensk INITIAL → hittas inte alls (sänker antalet)
  //   KAPAD   svensk bokstav MITT i namnet → ASCII-svansen matchar, FEL namn
  //           (antalet är OFÖRÄNDRAT, så ett tal döljer det)
  {
    const ur = (src) => JSON.stringify(findOcrLookups(src))
    // VÄRDET måste ligga i RAW_OCR_BINDINGS för att fältet ska plockas upp —
    // det är NYCKELN som ska vara svensk, inte bindningen.
    const s1 = 'await prisma.ärende.findFirst({ where: { ärendeNr: rawOcr } })'
    if (!ur(s1).includes('ärende')) fail(`#668 MISSAD: modell/fält med svensk INITIAL härleds inte — ${ur(s1)}`)
    else console.log('✅ #668 MISSAD: modell/fält med svensk INITIAL härleds')
    const s2 = 'await prisma.förvaltning.findFirst({ where: { förvaltningsId: rawOcr } })'
    if (!ur(s2).includes('förvaltning') || ur(s2).includes('"rvaltning"')) fail('#668 KAPAD: ASCII-svansen fångades i stället för hela namnet')
    else console.log('✅ #668 KAPAD: hela namnet fångas, inte svansen')
  }

  process.exit(ok ? 0 : 1)
}

// ── main ─────────────────────────────────────────────────────────────────────
function main() {
  if (process.argv.includes('--self-test')) return selfTest()

  const problem = evaluate({
    identityText: readFileSync(IDENTITY_FILE, 'utf8'),
    matchText: readFileSync(MATCH_FILE, 'utf8'),
  })

  if (problem.length > 0) {
    console.error('\n=== OCR-UPPSLAGET: OKLASSAT ELLER OGRINDAT FÄLT (CI-guard, H2) ===\n')
    for (const p of problem) {
      const var_ = p.line ? `reconciliation.service.ts:${p.line}` : 'ocr-identity.ts'
      console.error(`❌ ${var_}\n   ${p.rule}\n   ${p.detail}`)
    }
    console.error(
      '\nRegeln: ett systemtilldelat nummer är en IDENTITET, en fritextsträng är en\n' +
        'FÖRHOPPNING, och en förhoppning får aldrig vinna över en identitet. Klassa\n' +
        'fältet i apps/api/src/reconciliation/ocr-identity.ts.\n',
    )
    process.exit(1)
  }

  const lookups = findOcrLookups(readFileSync(MATCH_FILE, 'utf8'))
  console.log(
    `✅ ${lookups.length} OCR-uppslag, alla klassade — fritext bara bakom identitetsgrinden.`,
  )
}

main()
