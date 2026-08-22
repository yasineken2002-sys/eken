#!/usr/bin/env node
/**
 * CI-guard (M1) — en DELBETALNING kräver en IDENTITET, och varje dörr in till
 * allokeringen måste vara registrerad.
 *
 * ── VAD DEN SKYDDAR MOT ──────────────────────────────────────────────────────
 *
 * `allowPartial` avgör om automatmatchningen får registrera en DELBETALNING. Ett
 * belopp som är mindre än fakturan är INTE ett svagare bevis för samma faktura —
 * det kan lika gärna vara full betalning av en annan, mindre. Utan en
 * identifierare som pekar ut dokumentet entydigt är "delbetalning" en gissning
 * med ett vänligare namn, och till skillnad från en utebliven matchning SER den
 * ut som ett svar.
 *
 * Parametern är en `boolean`. En bar `true` på fel anropsställe är därför en
 * enteckensändring som öppnar gissningsmaskinen, och den syns inte i någon
 * grep — `true` står överallt. Guarden tvingar fram ett NAMN i stället, och
 * kräver att namnet är klassat.
 *
 * ── REGLERNA ─────────────────────────────────────────────────────────────────
 *
 * R1  Varje `allowPartial`-argument i reconciliation.service.ts måste vara en av
 *     de två namngivna konstanterna — aldrig en bar `true`/`false`-literal.
 * R2  `PARTIAL_VID_ENTYDIG_IDENTITET` får bara stå på ett anropsställe som är
 *     uppräknat i `ENTYDIGA_MATCHNINGSVAGAR`; antalet måste stämma.
 * R3  Konstanterna måste ha OLIKA värden, och rätt värden. Är båda `true` är
 *     varje klassificering nedan dekoration — och guarden vore grön.
 * R4  Registren och konstanterna måste finnas och faktiskt användas i
 *     reconciliation.service.ts. Utan det blir R1/R2 vakuöst gröna.
 * R5  Varje `invoicePayment.create` / `rentNoticePayment.create` i
 *     reconciliation.service.ts måste ligga i en funktion som står i
 *     `ALLOKERINGSSKRIVARE`. En NY dörr in till pengarna kan då inte öppnas tyst
 *     — H4 (#483) uppstod just för att en sådan dörr saknade den spärr som
 *     syskonvägen hade.
 *
 * ⚠️ GUARDENS GRÄNS, UTSKRIVEN. R5 mäter att dörren är REGISTRERAD, inte att den
 * avvisar överbetalning. Den egenskapen mäts beteendemässigt i
 * `invoice-partial-auto-match.spec.ts` (grupp 3), där en överbetalning körs
 * genom den nya vägen och ingen allokering får skrivas. En guard som påstått sig
 * mäta båda hade varit den sortens kontroll som inte kan falla.
 *
 * Rent statiskt (fs-only, inga beroenden, ingen DB) → eget CI-steg utan databas.
 * Lokalt:      node apps/api/scripts/check-partial-match-identity.mjs
 * Självtest:   node apps/api/scripts/check-partial-match-identity.mjs --self-test
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { withoutComments, kanariefåglar } from '../../../scripts/lib/source-scan.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const API_SRC = join(HERE, '..', 'src')
const RULE_FILE = join(API_SRC, 'reconciliation', 'partial-match-identity.ts')
const MATCH_FILE = join(API_SRC, 'reconciliation', 'reconciliation.service.ts')

const IDENTITY = 'PARTIAL_VID_ENTYDIG_IDENTITET'
const GUESS = 'PARTIAL_ALDRIG_VID_GISSNING'
const APPLIERS = ['applyMatchToInvoice', 'applyMatchToRentNotice']
const ALLOCATION_WRITES = ['invoicePayment.create', 'rentNoticePayment.create']

const lineOf = (text, idx) => text.slice(0, idx).split('\n').length

/**
 * Dela en argumentlista på KOMMATECKEN PÅ TOPPNIVÅ.
 *
 * Hoppar över nästlade parenteser/hakar/klammer och stränginnehåll, och stryker
 * radkommentarer. Ett `?:`-uttryck innehåller inga kommatecken och överlever
 * därför helt — vilket är nödvändigt, för OCR-grenen skickar just ett sådant.
 */
export function splitTopLevelArgs(args) {
  const ut = []
  let djup = 0
  let sträng = null
  let buf = ''
  // Kommentarerna bort via den DELADE skannern: den nakna regexen åt resten av
  // raden efter ett `//` inuti en sträng (t.ex. en URL i ett argument).
  const rensad = withoutComments(args)
  for (let i = 0; i < rensad.length; i++) {
    const c = rensad[i]
    if (sträng) {
      if (c === sträng && rensad[i - 1] !== '\\') sträng = null
      buf += c
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      sträng = c
      buf += c
      continue
    }
    if (c === '(' || c === '[' || c === '{') djup++
    else if (c === ')' || c === ']' || c === '}') djup--
    if (c === ',' && djup === 0) {
      ut.push(buf.trim())
      buf = ''
      continue
    }
    buf += c
  }
  if (buf.trim().length > 0) ut.push(buf.trim())
  return ut.filter((a) => a.length > 0)
}

/** Läs ett `export const X = [...] as const`-register. */
export function parseRegistry(text, name) {
  const m = new RegExp(`export const ${name}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*as const`).exec(text)
  if (!m) return null
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])
}

/** Läs `export const X = true|false`. Returnerar null om den saknas. */
export function parseBoolConst(text, name) {
  const m = new RegExp(`export const ${name}\\s*=\\s*(true|false)\\b`).exec(text)
  return m ? m[1] === 'true' : null
}

/**
 * Hitta varje anrop till en apply*-funktion och läs dess `allowPartial`-argument.
 *
 * Argumentet är det SISTA före ett eventuellt `matchType` ('fuzzy'). Vi tar därför
 * alla argument och plockar det sista som inte är en strängliteral.
 */
export function findApplyCalls(text) {
  const träffar = []
  for (const fn of APPLIERS) {
    const re = new RegExp(`this\\.${fn}\\s*\\(`, 'g')
    let m
    while ((m = re.exec(text))) {
      // Parentesbalanserad argumentlista.
      const start = text.indexOf('(', m.index)
      let depth = 0
      let end = start
      for (let i = start; i < text.length; i++) {
        if (text[i] === '(') depth++
        else if (text[i] === ')') {
          depth--
          if (depth === 0) {
            end = i
            break
          }
        }
      }
      const args = text.slice(start + 1, end)
      // Dela på TOPPNIVÅKOMMATECKEN, inte på radbrytningar. Radvis delning
      // fungerade bara för flerradiga anrop — ett enradigt anrop blev EN sträng,
      // och guarden läste hela argumentlistan som `allowPartial`. Den läste då
      // aldrig fel argument i den riktiga källan (som är flerradig), vilket är
      // precis varför självtestets kanariefågel behövde en enradig fixtur.
      const argv = splitTopLevelArgs(args)
      // allowPartial = sista argumentet som inte är en strängliteral (matchType).
      let allowPartial = null
      for (let i = argv.length - 1; i >= 0; i--) {
        const a = argv[i]
        if (/^'.*'$/.test(a)) continue
        allowPartial = a
        break
      }
      träffar.push({ fn, allowPartial, line: lineOf(text, m.index) })
    }
  }
  return träffar
}

/** Hitta varje allokeringsskrivning och vilken funktion den ligger i. */
export function findAllocationWrites(text) {
  const rader = text.split('\n')
  const funktionAt = (idx) => {
    for (let i = idx; i >= 0; i--) {
      const m = /^ {2}(?:private |public )?(?:async )?(\w+)\s*\(/.exec(rader[i])
      if (m) return m[1]
    }
    return null
  }
  const träffar = []
  for (let i = 0; i < rader.length; i++) {
    for (const w of ALLOCATION_WRITES) {
      if (rader[i].includes(w)) {
        träffar.push({ skrivning: w, fn: funktionAt(i), line: i + 1 })
      }
    }
  }
  return träffar
}

/** Kärnan. Exporterad så självtestet kör exakt samma kod som CI. */
export function evaluate({ ruleText, matchText }) {
  const problem = []
  const vägar = parseRegistry(ruleText, 'ENTYDIGA_MATCHNINGSVAGAR')
  const villkorade = parseRegistry(ruleText, 'VILLKORADE_MATCHNINGSVAGAR')
  const skrivare = parseRegistry(ruleText, 'ALLOKERINGSSKRIVARE')
  const identityVal = parseBoolConst(ruleText, IDENTITY)
  const guessVal = parseBoolConst(ruleText, GUESS)

  // ── R4 + R3 — mekanismen måste finnas OCH betyda något ────────────────────
  if (vägar === null || vägar.length === 0) {
    problem.push({
      rule: 'ENTYDIGA_MATCHNINGSVAGAR saknas eller är tomt',
      detail: 'Utan register kan inget anropsställe klassas — R2 blir vakuöst grön.',
    })
  }
  if (villkorade === null) {
    problem.push({
      rule: 'VILLKORADE_MATCHNINGSVAGAR saknas',
      detail:
        'Utan det registret räknas bara FÖREKOMSTEN av identitetskonstanten, inte ' +
        'formen — och ett villkorat uttryck kan då tyst bytas mot ett bart.',
    })
  }
  if (skrivare === null || skrivare.length === 0) {
    problem.push({
      rule: 'ALLOKERINGSSKRIVARE saknas eller är tomt',
      detail: 'Utan register kan en ny allokeringsväg inte upptäckas — R5 blir vakuöst grön.',
    })
  }
  if (identityVal === null || guessVal === null) {
    problem.push({
      rule: `${IDENTITY} eller ${GUESS} saknas i partial-match-identity.ts`,
      detail: 'Regeln kan inte upprätthållas av konstanter som inte finns.',
    })
  } else if (identityVal === guessVal) {
    problem.push({
      rule: `${IDENTITY} och ${GUESS} har SAMMA värde (${identityVal})`,
      detail:
        'Konstanterna skiljer då inte längre en identitet från en gissning. Varje ' +
        'anropsställe skickar samma sak och hela klassificeringen blir dekoration.',
    })
  } else if (identityVal !== true || guessVal !== false) {
    problem.push({
      rule: `${IDENTITY}=${identityVal}, ${GUESS}=${guessVal} — omkastade`,
      detail:
        'Identiteten ska tillåta delbetalning (true) och gissningen förbjuda den ' +
        '(false). Omkastade öppnar de gissningsmaskinen och stänger den fungerande vägen.',
    })
  }
  if (!matchText.includes(IDENTITY) || !matchText.includes(GUESS)) {
    problem.push({
      rule: 'konstanterna används inte i reconciliation.service.ts',
      detail:
        'Klassificeringen är bortkopplad. Anropsställena har då gått tillbaka till ' +
        'bara `true`/`false`, och en enteckensändring öppnar delbetalning på en gissning.',
    })
  }
  if (problem.length > 0) return problem // vidare kontroller vore meningslösa

  // ── R1 + R2 — anropsställena ──────────────────────────────────────────────
  const anrop = findApplyCalls(matchText)
  if (anrop.length === 0) {
    problem.push({
      rule: 'NOLL apply*-anrop hittades i reconciliation.service.ts',
      detail:
        'Antingen har matchningen flyttat, eller så har skanningen gått blind. ' +
        'Båda ska falla — en guard utan mätobjekt mäter ingenting.',
    })
    return problem
  }

  let bartIdentitetsanrop = 0
  let villkoradeAnrop = 0
  for (const a of anrop) {
    const arg = a.allowPartial ?? ''
    const barLiteral = arg === 'true' || arg === 'false'
    if (barLiteral) {
      problem.push({
        line: a.line,
        rule: `${a.fn}() får allowPartial som bar \`${arg}\``,
        detail:
          `Använd ${IDENTITY} eller ${GUESS}. En bar boolean säger inte VARFÖR ` +
          'delbetalning är tillåten, och en enteckensändring syns inte i någon grep.',
      })
      continue
    }
    if (!arg.includes(IDENTITY) && !arg.includes(GUESS)) {
      problem.push({
        line: a.line,
        rule: `${a.fn}() får ett OKLASSAT allowPartial-argument: \`${arg}\``,
        detail:
          `Argumentet måste vara ${IDENTITY}, ${GUESS}, eller ett uttryck sammansatt ` +
          'av dem båda. Ett tredje uttryck är en klassificering ingen tagit ställning till.',
      })
      continue
    }
    // FORMEN räknas, inte bara förekomsten. Ett BART identitetsargument säger
    // "den här grenen bär alltid en identitet"; ett VILLKORAT uttryck som nämner
    // båda konstanterna säger "grenen kan nås åt två håll och avgör vid anropet".
    // Räknas bara förekomsten kan det ena tyst bytas mot det andra — se
    // VILLKORADE_MATCHNINGSVAGAR för den uppmätta negativkontrollen.
    if (arg.includes(IDENTITY) && arg.includes(GUESS)) villkoradeAnrop++
    else if (arg === IDENTITY) bartIdentitetsanrop++
  }

  // R2 — antalet ställen av VARJE FORM måste stämma med sitt register.
  if (bartIdentitetsanrop !== vägar.length) {
    problem.push({
      rule: `${bartIdentitetsanrop} anropsställen skickar ett bart ${IDENTITY}, registret har ${vägar.length}`,
      detail:
        'ENTYDIGA_MATCHNINGSVAGAR ska räkna upp exakt de grenar där identiteten är ' +
        'fastställd innan beloppet vägs in. Stämmer inte antalet har någon lagt till ' +
        '(eller tagit bort) en delbetalningsväg utan att ta ställning till den.',
    })
  }
  if (villkoradeAnrop !== villkorade.length) {
    problem.push({
      rule: `${villkoradeAnrop} anropsställen skickar ett VILLKORAT uttryck, registret har ${villkorade.length}`,
      detail:
        'En gren som kan nås både med och utan fastställd identitet MÅSTE avgöra saken ' +
        'vid anropet, med ett uttryck som nämner båda konstanterna. Ett bart ' +
        `${IDENTITY} där öppnar delbetalning för fritextträffar — en gissningsmaskin. ` +
        'Uppmätt: utan den här kontrollen var antalet oförändrat och guarden GRÖN.',
    })
  }

  // ── R5 — allokeringsvägarna ───────────────────────────────────────────────
  const skrivningar = findAllocationWrites(matchText)
  if (skrivningar.length === 0) {
    problem.push({
      rule: 'NOLL allokeringsskrivningar hittades',
      detail: 'Skanningen har gått blind — R5 mäter då ingenting.',
    })
    return problem
  }
  for (const s of skrivningar) {
    if (!s.fn || !skrivare.includes(s.fn)) {
      problem.push({
        line: s.line,
        rule: `${s.skrivning} i OREGISTRERAD funktion \`${s.fn ?? '?'}\``,
        detail:
          'En ny dörr in till pengarna. Lägg funktionen i ALLOKERINGSSKRIVARE och ' +
          'visa i ett test att den avvisar överbetalning — H4 (#483) uppstod för att ' +
          'en sådan dörr saknade den spärr som syskonvägen hade.',
      })
    }
  }
  return problem
}

// ── självtest ────────────────────────────────────────────────────────────────
const RULE_OK = `
export const ${IDENTITY} = true
export const ${GUESS} = false
export const ENTYDIGA_MATCHNINGSVAGAR = ['a', 'b'] as const
export const VILLKORADE_MATCHNINGSVAGAR = ['c'] as const
export const ALLOKERINGSSKRIVARE = ['applyMatchToInvoice'] as const
`

// Fixturen är ENRADIG med flit: den riktiga källan är flerradig, så en
// argumentläsare som bara klarar radbrytningar hade varit grön mot verkligheten
// och blind mot fixturen. Två identitetsanrop (= registrets längd) och TVÅ
// gissningsanrop, så att ett omklassificerat anrop inte råkar ta bort konstanten
// ur filen och kortsluta R4.
const MATCH_OK = `
  private async applyMatchToInvoice(a, b) {
    const x = await this.applyMatchToInvoice(id, invId, org, tot, amt, date, null, null, ${IDENTITY})
    const y = await this.applyMatchToRentNotice(id, nid, org, amt, date, null, ${IDENTITY})
    const z = await this.applyMatchToRentNotice(id, nid, org, amt, date, null, ${GUESS}, 'fuzzy')
    const w = await this.applyMatchToInvoice(id, invId, org, tot, amt, date, null, null, ${GUESS}, 'fuzzy')
    const v = await this.applyMatchToInvoice(id, invId, org, tot, amt, date, null, null, flagga ? ${IDENTITY} : ${GUESS})
    const allocationRow = await tx.invoicePayment.create({ data: {} })
  }
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
  const röd = (label, r, väntad) => {
    if (r.length === 0) return fail(`MISSADE: ${label}`)
    if (väntad && !r.some((x) => x.rule.includes(väntad))) {
      return fail(`${label} fälldes av FEL regel: "${r[0].rule}" — väntade "${väntad}"`)
    }
    console.log(`✅ fångad: ${label} (${r[0].rule})`)
  }

  // ── KANARIEFÅGEL 1: argumentläsningen måste ge utslag på känd indata ───────
  // Läser den fel argument blir varje klassificering nedan meningslös.
  const funna = findApplyCalls(MATCH_OK)
  // RÄKNAS, inte ordnas: skanningen grupperar per funktionsnamn, så ordningen är
  // en implementationsdetalj. Antalet av varje sort är det som betyder något.
  const antalIdentitet = funna.filter((f) => f.allowPartial === IDENTITY).length
  const antalGissning = funna.filter((f) => f.allowPartial === GUESS).length
  const antalVillkorade = funna.filter(
    (f) => (f.allowPartial ?? '').includes(IDENTITY) && (f.allowPartial ?? '').includes(GUESS),
  ).length
  if (funna.length !== 5 || antalIdentitet !== 2 || antalGissning !== 2 || antalVillkorade !== 1) {
    fail(
      `kanariefågel: argumentläsningen gav ${funna.length} anrop ` +
        `(${antalIdentitet} bar identitet, ${antalGissning} gissning, ${antalVillkorade} villkorad), ` +
        'väntade 5 (2 + 2 + 1): ' +
        JSON.stringify(funna.map((f) => f.allowPartial)),
    )
  } else console.log('✅ kanariefågel: argumentläsningen skiljer bart, gissning och VILLKORAT (2 + 2 + 1)')

  // ── KANARIEFÅGEL 2: mot den RIKTIGA källan ────────────────────────────────
  const riktigaText = readFileSync(MATCH_FILE, 'utf8')
  const riktiga = findApplyCalls(riktigaText)
  const riktigaSkrivningar = findAllocationWrites(riktigaText)
  if (riktiga.length === 0) {
    fail('kanariefågel: NOLL apply*-anrop i reconciliation.service.ts — skanningen har gått blind')
  } else if (riktigaSkrivningar.length === 0) {
    fail('kanariefågel: NOLL allokeringsskrivningar i den riktiga källan')
  } else {
    console.log(
      `✅ kanariefågel: ${riktiga.length} apply*-anrop och ` +
        `${riktigaSkrivningar.length} allokeringsskrivningar i den riktiga källan`,
    )
  }

  grön('paritet', evaluate({ ruleText: RULE_OK, matchText: MATCH_OK }))

  // ── R1 — bar literal (den enteckensändring guarden finns för) ─────────────
  röd(
    'bar `true` som allowPartial',
    evaluate({
      ruleText: RULE_OK,
      matchText: MATCH_OK.replace(`null, null, ${IDENTITY})`, 'null, null, true)'),
    }),
    'bar `true`',
  )

  // ── R2 — DEFEKTEN: delbetalning öppnad på en gissningsgren ────────────────
  // Fuzzy-anropet byter till identitetskonstanten. Antalet identitetsställen blir
  // 3 mot registrets 2 → fälls. Det är exakt "gissningsmaskinen".
  röd(
    'delbetalning öppnad på fuzzy-grenen',
    evaluate({
      ruleText: RULE_OK,
      matchText: MATCH_OK.replace(`${GUESS}, 'fuzzy'`, `${IDENTITY}, 'fuzzy'`),
    }),
    'registret har',
  )

  // ── R2, FORMEN — DEFEKTEN NEGATIVKONTROLLEN HITTADE ──────────────────────
  // Det VILLKORADE uttrycket byts mot ett bart identitetsargument. Antalet
  // ställen som NÄMNER identitetskonstanten är då OFÖRÄNDRAT, och den första
  // versionen av guarden rapporterade GRÖNT — om exakt den gissningsmaskin den
  // byggts för att fånga. Fallet står kvar för att en framtida uppmjukning av
  // formräkningen ska falla på det.
  röd(
    'villkorat uttryck utbytt mot ett bart identitetsargument (fritext får delbetala)',
    evaluate({
      ruleText: RULE_OK,
      matchText: MATCH_OK.replace(`flagga ? ${IDENTITY} : ${GUESS}`, IDENTITY),
    }),
    'VILLKORAT uttryck',
  )

  // ── R3 — konstanterna betyder inget ──────────────────────────────────────
  röd(
    'båda konstanterna satta till true',
    evaluate({ ruleText: RULE_OK.replace(`${GUESS} = false`, `${GUESS} = true`), matchText: MATCH_OK }),
    'SAMMA värde',
  )
  röd(
    'konstanterna omkastade',
    evaluate({
      ruleText: RULE_OK.replace(`${IDENTITY} = true`, `${IDENTITY} = false`).replace(
        `${GUESS} = false`,
        `${GUESS} = true`,
      ),
      matchText: MATCH_OK,
    }),
    'omkastade',
  )

  // ── R4 — mekanismen bortkopplad ──────────────────────────────────────────
  röd(
    'tomt vägregister',
    evaluate({ ruleText: RULE_OK.replace("['a', 'b']", '[]'), matchText: MATCH_OK }),
    'ENTYDIGA_MATCHNINGSVAGAR',
  )
  röd(
    'tomt skrivarregister',
    evaluate({ ruleText: RULE_OK.replace("['applyMatchToInvoice']", '[]'), matchText: MATCH_OK }),
    'ALLOKERINGSSKRIVARE',
  )
  röd(
    'konstanterna används inte i matchningen',
    evaluate({
      ruleText: RULE_OK,
      matchText: MATCH_OK.replace(new RegExp(IDENTITY, 'g'), 'true').replace(
        new RegExp(GUESS, 'g'),
        'false',
      ),
    }),
    'används inte',
  )

  // ── R5 — NY DÖRR in till allokeringen ────────────────────────────────────
  röd(
    'allokering i en oregistrerad funktion (ny dörr in till pengarna)',
    evaluate({
      ruleText: RULE_OK,
      matchText:
        MATCH_OK +
        `
  private async nyGenvag(a) {
    const r = await tx.rentNoticePayment.create({ data: {} })
  }
`,
    }),
    'OREGISTRERAD',
  )

  // Blind skanning: mekanismen finns, men inga anrop hittas.
  röd(
    'inga apply*-anrop alls (blind skanning)',
    evaluate({
      ruleText: RULE_OK,
      matchText: `const a = ${IDENTITY}\nconst b = ${GUESS}\nconst c = tx.invoicePayment.create`,
    }),
    'NOLL apply*-anrop',
  )


  // Den DELADE skannerns kanariefåglar. Går scripts/lib/source-scan.mjs sönder
  // blir DEN HÄR vakten röd — inte bara skannerns egen körning. Det är hela
  // poängen med en delad mekanism: bryts den blir varje konsument röd (#463).
  for (const f of kanariefåglar()) {
    ok = false
    console.error(`❌ delad källskanner: ${f}`)
  }

  console.log(ok ? '\n✅ Självtest OK.' : '\n❌ Självtest misslyckades.')
  process.exit(ok ? 0 : 1)
}

// ── main ─────────────────────────────────────────────────────────────────────
function main() {
  if (process.argv.includes('--self-test')) return selfTest()

  const problem = evaluate({
    ruleText: readFileSync(RULE_FILE, 'utf8'),
    matchText: readFileSync(MATCH_FILE, 'utf8'),
  })

  if (problem.length > 0) {
    console.error('\n=== DELBETALNING UTAN IDENTITET, ELLER OREGISTRERAD ALLOKERING (CI-guard, M1) ===\n')
    for (const p of problem) {
      const var_ = p.line ? `reconciliation.service.ts:${p.line}` : 'partial-match-identity.ts'
      console.error(`❌ ${var_}\n   ${p.rule}\n   ${p.detail}`)
    }
    console.error(
      '\nRegeln: ett belopp som är MINDRE än fakturan är inget svagare bevis för samma\n' +
        'faktura — det kan vara full betalning av en annan. Delbetalning kräver därför en\n' +
        'IDENTITET. Klassa anropsstället i\n' +
        'apps/api/src/reconciliation/partial-match-identity.ts.\n',
    )
    process.exit(1)
  }

  const text = readFileSync(MATCH_FILE, 'utf8')
  const anrop = findApplyCalls(text)
  const skrivningar = findAllocationWrites(text)
  console.log(
    `✅ ${anrop.length} matchningsanrop klassade, ${skrivningar.length} allokeringsskrivningar ` +
      'i registrerade funktioner — delbetalning bara vid entydig identitet.',
  )
}

main()
