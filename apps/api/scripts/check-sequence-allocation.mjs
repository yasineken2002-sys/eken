#!/usr/bin/env node
/**
 * CI-guard (H1) — skyddar ATOMICITETEN i varje nummerserie.
 *
 * ── VAD DEN SKYDDAR MOT ──────────────────────────────────────────────────────
 *
 * Fyra gånger har samma defekt återuppstått i olika dräkt, och varje gång var
 * utfallet att två samtidiga anrop fick SAMMA nummer:
 *
 *   • Tenant.ocrNumber        `tenant.count(...) + 1`               (#487)
 *   • RentNotice.noticeNumber `findMany → parsa suffix → max + 1`   (#484)
 *   • Invoice.invoiceNumber   deposits egen `count() + 1` vid sidan (invoice-number.ts)
 *   • PlatformInvoice…        buyCredits egen `count() + 1`         (FAR-fyndet)
 *
 * Alla fyra är numera lösta med SAMMA mekanism: en rad per scope i en
 * `*Sequence`-tabell, muterad med en atomär increment-UPSERT inne i samma
 * transaktion som raden skapas. Postgres tar då radlås på scope-raden och
 * serialiserar allokeringarna.
 *
 * Den här guarden bevakar MEKANISMEN, inte en av dess användare. Att fyra fall
 * löstes med samma konstruktion är hela argumentet för det: en guard per fält
 * hade behövt skrivas en femte gång av den som inför den femte serien.
 *
 * ── REGLERNA ─────────────────────────────────────────────────────────────────
 *
 * R1  Varje `*Sequence`-modell får BARA röras av `.upsert()` vars `update` är
 *     `{ lastNumber: { increment: N } }`. Ett `.update()`, `.create()`,
 *     `.updateMany()`, `.delete()` eller en läsning följd av en skrivning är ett
 *     läs-modifiera-skriv utan lås — exakt racet ovan.
 *
 * R2  Varje `*Sequence`-modell får ha EXAKT EN anropsplats i apps/api/src.
 *     Två anropsplatser betyder att allokeringslogiken kopierats, och det är
 *     precis så depositions-numreringen blev en egen count()+1 vid sidan av
 *     fakturasekvensen. Behöver flera moduler numret: anropa den delade
 *     allokerarfunktionen, inte sekvensmodellen.
 *
 * R3  Den FUNKTION som äger anropsplatsen får inte innehålla `.count(`,
 *     `.aggregate(` eller `_max`. Det är formen på den gamla härledningen, och
 *     den har ingenting att göra i en funktion vars uppgift är att läsa en
 *     räknare.
 *
 *     Scopet är funktionen och inte FILEN, och det är mätt: en filbred regel gav
 *     fyra falsklarm i maintenance.service.ts, där `generateTicketNumber()` är en
 *     privat metod i en stor tjänst vars `getStats()` och `addImages()` räknar
 *     rader helt legitimt. En regel som fäller på grannmetoder blir avstängd, och
 *     en avstängd regel mäter ingenting.
 *
 * ── MODELLERNA HÄRLEDS UR SCHEMAT ────────────────────────────────────────────
 *
 * Listan räknas ALDRIG upp här. En uppräkning krymper tyst: den som lägger till
 * en nionde sekvens skulle inte få något fel, bara en guard som mäter mindre än
 * den ser ut att mäta. Modellerna läses ur schema.prisma (namn på `*Sequence`
 * MED ett `lastNumber Int`-fält), och guarden går RÖD om härledningen ger noll
 * modeller — en trasig parser ska falla, inte tystna.
 *
 * Rent statiskt (fs-only, inga beroenden, ingen DB) → eget CI-steg utan databas.
 * Lokalt:      node apps/api/scripts/check-sequence-allocation.mjs
 * Självtest:   node apps/api/scripts/check-sequence-allocation.mjs --self-test
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const API_DIR = join(HERE, '..')
const SRC_DIR = join(API_DIR, 'src')
const SCHEMA = join(API_DIR, 'prisma', 'schema.prisma')
const REPO_ROOT = join(HERE, '..', '..', '..')

/** Prisma-klientens accessor för en modell: `TenantOcrSequence` → `tenantOcrSequence`. */
const accessorOf = (model) => model[0].toLowerCase() + model.slice(1)

const lineOf = (text, idx) => text.slice(0, idx).split('\n').length

// ── balanserad ()-extraktion från ett metodanrops inledande parentes ─────────
function sliceCall(text, openParenIdx) {
  let depth = 0
  for (let i = openParenIdx; i < text.length; i++) {
    const ch = text[i]
    if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth === 0) return text.slice(openParenIdx, i + 1)
    }
  }
  return text.slice(openParenIdx) // obalanserat (syntaxfel) — ta resten
}

/**
 * Kroppen för den funktion som omsluter `idx`.
 *
 * Går bakåt tills en obalanserad `{` hittas — det är det innersta omslutande
 * blockets öppning — och accepterar den först när raden ser ut som en
 * funktionsdeklaration (`function`, `=>`, eller `namn(...)` med valfritt
 * `async`/modifierare). Ett `if`/`for`/`try`-block hoppas alltså över och vi
 * fortsätter utåt. Hittas ingen funktion returneras hela texten, vilket är den
 * säkra riktningen: hellre en bredare kontroll än ingen.
 */
export function enclosingFunction(text, idx) {
  let i = idx
  let depth = 0
  while (i > 0) {
    i--
    const ch = text[i]
    if (ch === '}') depth++
    else if (ch === '{') {
      if (depth > 0) {
        depth--
        continue
      }
      // Obalanserad `{` — blockets öppning. Är raden en funktionsdeklaration?
      const lineStart = text.lastIndexOf('\n', i) + 1
      const header = text.slice(lineStart, i)
      const isFunction =
        /\bfunction\b/.test(header) ||
        /=>\s*$/.test(header) ||
        /\b[\w$]+\s*\([^)]*\)\s*(:[^{]*)?$/.test(header)
      if (isFunction) {
        // Framåt med parentesbalansering till blockets slut.
        let d = 0
        for (let j = i; j < text.length; j++) {
          if (text[j] === '{') d++
          else if (text[j] === '}') {
            d--
            if (d === 0) return { body: text.slice(i, j + 1), start: i }
          }
        }
        return { body: text.slice(i), start: i }
      }
      // Inte en funktion (if/for/try/objektliteral) — fortsätt utåt.
    }
  }
  return { body: text, start: 0 }
}

/**
 * Härled sekvensmodellerna ur schema.prisma.
 *
 * Kravet är BÅDE namnet och fältet. Bara namnet hade fångat en `…Sequence` som
 * inte är en räknare; bara fältet hade fångat varje modell med ett `lastNumber`.
 * Exporterad så självtestet kör exakt samma parser som CI.
 */
export function deriveSequenceModels(schemaText) {
  const models = []
  const re = /^model\s+(\w*Sequence)\s*\{/gm
  let m
  while ((m = re.exec(schemaText))) {
    const bodyStart = schemaText.indexOf('{', m.index)
    const bodyEnd = schemaText.indexOf('\n}', bodyStart)
    const body = schemaText.slice(bodyStart, bodyEnd === -1 ? schemaText.length : bodyEnd)
    if (/^\s*lastNumber\s+Int\b/m.test(body)) models.push(m[1])
  }
  return models
}

/**
 * Skanna EN källfils text mot R1 och R3, givet de härledda modellerna.
 * Returnerar { violations, callSites } — anropsplatserna matas vidare till R2,
 * som är en egenskap hos HELA trädet och inte hos en enskild fil.
 */
export function scanSource(text, relPath, models) {
  const violations = []
  const callSites = []
  const seqCallIdx = []

  for (const model of models) {
    const accessor = accessorOf(model)
    // \b…\. binder till accessorn: `tx.invoiceNumberSequence.upsert(` matchar,
    // men `tx.invoice.` gör det inte — och omvänt matchar `.invoice.` aldrig
    // sekvensmodellen, så en modell som är prefix till en annan blir inte
    // förväxlad.
    const re = new RegExp(`\\b${accessor}\\s*\\.\\s*(\\w+)\\s*\\(`, 'g')
    let m
    while ((m = re.exec(text))) {
      const method = m[1]
      const line = lineOf(text, m.index)
      callSites.push({ model, file: relPath, line, method })
      seqCallIdx.push(m.index)

      if (method !== 'upsert') {
        violations.push({
          line,
          file: relPath,
          rule: `${accessor}.${method}() — bara upsert() får röra en sekvens`,
          detail:
            'Allt utom en increment-UPSERT är läs-modifiera-skriv utan radlås. ' +
            'Två samtidiga allokeringar får då samma nummer.',
        })
        continue
      }

      const call = sliceCall(text, text.indexOf('(', m.index + m[0].length - 1))
      // Formen, inte en exakt sträng: `increment` ska stå i upsertens update-gren.
      // En upsert som SÄTTER lastNumber (`update: { lastNumber: n }`) är samma
      // race i ny dräkt — värdet räknades fram utanför låset.
      if (!/\bincrement\s*:/.test(call)) {
        violations.push({
          line,
          file: relPath,
          rule: `${accessor}.upsert() utan { lastNumber: { increment: N } }`,
          detail:
            'Utan increment räknas det nya värdet fram utanför radlåset — ' +
            'atomiciteten försvinner även om upsert:en står kvar.',
        })
      }
    }
  }

  // R3 gäller FUNKTIONEN som äger anropsplatsen — inte filen. En `count()` i en
  // grannmetod är legitim (statistik, kvottak) och ska inte falla här.
  for (const site of seqCallIdx) {
    const { body, start } = enclosingFunction(text, site)
    body.split('\n').forEach((ln, i) => {
      if (/^\s*(\*|\/\/)/.test(ln)) return // kommentarer beskriver ofta det gamla mönstret
      if (!/\.count\s*\(|\.aggregate\s*\(|\b_max\b/.test(ln)) return
      violations.push({
        line: lineOf(text, start) + i,
        file: relPath,
        rule: 'allokerarfunktionen innehåller count()/aggregate()/_max',
        detail:
          'Det är formen på den gamla, icke-atomära härledningen. ' +
          'En allokerare ska läsa sin räknare, inte räkna rader.',
      })
    })
  }

  return { violations, callSites }
}

/** R2 — en anropsplats per modell. Egenskap hos hela trädet, inte hos en fil. */
export function checkOneCallSitePerModel(models, callSites) {
  const violations = []
  for (const model of models) {
    const sites = callSites.filter((c) => c.model === model)
    if (sites.length === 0) {
      violations.push({
        file: 'apps/api/src',
        line: 0,
        rule: `${model} har NOLL anropsplatser`,
        detail:
          'Antingen är sekvensen död och ska tas bort, eller så har skanningen ' +
          'gått blind. Båda ska falla — en guard som inte hittar sitt mätobjekt ' +
          'mäter ingenting.',
      })
    } else if (sites.length > 1) {
      violations.push({
        file: sites.map((s) => `${s.file}:${s.line}`).join(', '),
        line: 0,
        rule: `${model} rörs från ${sites.length} platser`,
        detail:
          'Allokeringslogiken har kopierats. Anropa den delade allokerarfunktionen ' +
          'i stället — två kopior driver isär, och det var så depositions- ' +
          'numreringen blev en egen count()+1 vid sidan av fakturasekvensen.',
      })
    }
  }
  return violations
}

// ── fil-traversering ─────────────────────────────────────────────────────────
function* walk(dir) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name)
    if (ent.isDirectory()) yield* walk(p)
    else if (ent.name.endsWith('.ts') && !ent.name.endsWith('.spec.ts')) yield p
  }
}

// ── självtest ────────────────────────────────────────────────────────────────
const MODELS = ['TenantOcrSequence', 'InvoiceNumberSequence']

const GOOD = [
  [
    'atomär upsert',
    `const row = await tx.tenantOcrSequence.upsert({ where: { organizationId }, create: { organizationId, lastNumber: 1 }, update: { lastNumber: { increment: 1 } }, select: { lastNumber: true } })`,
  ],
  [
    'count på en ANNAN modell i en fil utan anropsplats',
    `const n = await this.prisma.tenant.count({ where: { organizationId } })`,
  ],
  ['läsning av resultatet', `const seq = row.lastNumber\nreturn formatTenantOcr(seq)`],
  [
    'modell vars namn är prefix till en annan rörs inte',
    `await tx.invoice.create({ data: { ocrNumber } })`,
  ],
  [
    // Regressionen som fällde den filbreda R3:an: allokeraren är en privat metod
    // i en stor tjänst, och grannmetoden räknar rader helt legitimt.
    'count() i en GRANNMETOD i samma fil',
    `class S {
  private async generateTicketNumber(organizationId) {
    const row = await this.prisma.tenantOcrSequence.upsert({
      where: { organizationId },
      create: { organizationId, lastNumber: 1 },
      update: { lastNumber: { increment: 1 } },
    })
    return row.lastNumber
  }

  async getStats(organizationId) {
    return this.prisma.maintenanceTicket.count({ where: { organizationId } })
  }
}`,
  ],
]

const BAD = [
  [
    'update i stället för upsert',
    `await tx.tenantOcrSequence.update({ where: { organizationId }, data: { lastNumber: next } })`,
  ],
  [
    'upsert som sätter i stället för att inkrementera',
    `await tx.invoiceNumberSequence.upsert({ where: { organizationId }, create: { organizationId, lastNumber: 1 }, update: { lastNumber: max + 1 } })`,
  ],
  [
    'läsning följd av skrivning',
    `const cur = await tx.tenantOcrSequence.findUnique({ where: { organizationId } })`,
  ],
  [
    'count() i SAMMA funktion som allokeringen',
    `async function allocate(organizationId) {
  const n = await tx.tenant.count({ where: { organizationId } })
  await tx.tenantOcrSequence.upsert({ where: { organizationId }, create: { organizationId, lastNumber: n }, update: { lastNumber: { increment: 1 } } })
}`,
  ],
  [
    '_max-aggregat i SAMMA funktion som allokeringen',
    `async function allocate(organizationId) {
  const agg = { _max: { lastNumber: true } }
  await tx.invoiceNumberSequence.upsert({ where: { organizationId }, create: {}, update: { lastNumber: { increment: 1 } } })
}`,
  ],
]

// Ett schema-utdrag som självtestet härleder ur. Det speglar formen i
// schema.prisma utan att bero på dess innehåll — annars hade härlednings-
// kanariefågeln bara mätt att filen finns.
const SCHEMA_FIXTURE = `
model TenantOcrSequence {
  organizationId String   @id
  lastNumber     Int      @default(0)
}

model RentNoticeNumberSequence {
  organizationId String
  year           Int
  lastNumber     Int      @default(0)
}

model NotASequenceAtAll {
  id String @id
}

model MissingCounterSequence {
  organizationId String @id
  somethingElse  String
}
`

function selfTest() {
  let ok = true
  const fail = (msg) => {
    ok = false
    console.error(`❌ ${msg}`)
  }

  // ── KANARIEFÅGEL 1: härledningen måste ge utslag på känd indata ────────────
  // Utan den kan parsern gå blind och returnera [] — och då blir R1 och R3
  // vakuöst gröna för evigt, eftersom de loopar över en tom modellista.
  const derived = deriveSequenceModels(SCHEMA_FIXTURE)
  if (derived.length !== 2) {
    fail(`härledning: förväntade 2 modeller ur fixturen, fick ${derived.length} (${derived})`)
  } else console.log('✅ kanariefågel: härledningen hittar båda sekvensmodellerna i fixturen')
  if (derived.includes('MissingCounterSequence')) {
    fail('härledning: en *Sequence UTAN lastNumber togs med — namnet ensamt räcker inte')
  } else console.log('✅ kanariefågel: *Sequence utan lastNumber tas inte med')
  if (derived.includes('NotASequenceAtAll')) fail('härledning: en modell utan Sequence-suffix togs med')

  // ── KANARIEFÅGEL 2: härledningen mot det RIKTIGA schemat ──────────────────
  // Fixturen ovan bevisar att parsern fungerar; den här bevisar att den pekar
  // på verkligheten. Går schemat inte att läsa, eller byter det form, ska
  // guarden falla i stället för att tyst mäta noll modeller.
  const real = deriveSequenceModels(readFileSync(SCHEMA, 'utf8'))
  if (real.length === 0) {
    fail('härledning mot schema.prisma gav NOLL sekvensmodeller — parsern har gått blind')
  } else console.log(`✅ kanariefågel: ${real.length} sekvensmodeller härledda ur schema.prisma`)

  // ── R1/R3: inga falsklarm på legitim kod ──────────────────────────────────
  for (const [label, code] of GOOD) {
    const { violations } = scanSource(code, `good:${label}`, MODELS)
    if (violations.length !== 0) fail(`FALSKLARM på legitim kod: "${label}" → ${violations.map((v) => v.rule).join(', ')}`)
    else console.log(`✅ inget falsklarm: ${label}`)
  }

  // ── R1/R3: varje kringgång fångas ─────────────────────────────────────────
  for (const [label, code] of BAD) {
    const { violations } = scanSource(code, `bad:${label}`, MODELS)
    if (violations.length === 0) fail(`MISSADE kringgång: "${label}" flaggades inte`)
    else console.log(`✅ fångad kringgång: ${label} (${violations[0].rule})`)
  }

  // ── R2: båda riktningarna ─────────────────────────────────────────────────
  // En spärr som bara fäller åt ett håll är halv. Noll anropsplatser är lika
  // illa som två: det första betyder att skanningen gått blind, det andra att
  // logiken kopierats.
  const two = checkOneCallSitePerModel(
    ['X'],
    [
      { model: 'X', file: 'a.ts', line: 1, method: 'upsert' },
      { model: 'X', file: 'b.ts', line: 2, method: 'upsert' },
    ],
  )
  if (two.length === 0) fail('R2 fällde inte TVÅ anropsplatser')
  else console.log(`✅ R2 fäller två anropsplatser (${two[0].rule})`)

  const zero = checkOneCallSitePerModel(['X'], [])
  if (zero.length === 0) fail('R2 fällde inte NOLL anropsplatser — en blind skanning skulle passera')
  else console.log(`✅ R2 fäller noll anropsplatser (${zero[0].rule})`)

  const one = checkOneCallSitePerModel(['X'], [{ model: 'X', file: 'a.ts', line: 1, method: 'upsert' }])
  if (one.length !== 0) fail('R2 falsklarmade på exakt EN anropsplats')
  else console.log('✅ R2 släpper igenom exakt en anropsplats')

  console.log(ok ? '\n✅ Självtest OK.' : '\n❌ Självtest misslyckades.')
  process.exit(ok ? 0 : 1)
}

// ── main ─────────────────────────────────────────────────────────────────────
function main() {
  if (process.argv.includes('--self-test')) return selfTest()

  const models = deriveSequenceModels(readFileSync(SCHEMA, 'utf8'))
  if (models.length === 0) {
    console.error(
      '\n❌ HÄRLEDNINGEN GAV NOLL SEKVENSMODELLER ur prisma/schema.prisma.\n' +
        '   Guarden vägrar rapportera grönt utan mätobjekt — en kontroll som\n' +
        '   inte kan falla mäter ingenting. Kontrollera schemats form.\n',
    )
    process.exit(1)
  }

  const failures = []
  const callSites = []
  for (const file of walk(SRC_DIR)) {
    const res = scanSource(readFileSync(file, 'utf8'), relative(REPO_ROOT, file), models)
    failures.push(...res.violations)
    callSites.push(...res.callSites)
  }
  failures.push(...checkOneCallSitePerModel(models, callSites))

  if (failures.length > 0) {
    console.error('\n=== NUMMERSERIENS ATOMICITET KRINGGÅNGEN (CI-guard, H1) ===\n')
    for (const f of failures) {
      // line === 0 betyder att platserna redan står uppräknade i `file` (R2, som
      // är en egenskap hos hela trädet och inte hos en enskild rad).
      const var_ = f.line === 0 ? f.file : `${f.file}:${f.line}`
      console.error(`❌ ${var_}\n   ${f.rule}\n   ${f.detail}`)
    }
    console.error(
      '\nÅtgärd: allokera via en increment-UPSERT på sekvensraden, i SAMMA\n' +
        '$transaction som raden skapas — se apps/api/src/invoices/invoice-number.ts\n' +
        'eller apps/api/src/avisering/rent-notice-number.ts. Radlåset är avsikten,\n' +
        'inte en bieffekt: bryts allokeringen ur transaktionen försvinner\n' +
        'serialiseringen mellan allokering och insert.\n',
    )
    process.exit(1)
  }

  console.log(
    `✅ ${models.length} nummerserier, ${callSites.length} anropsplatser — ` +
      'alla atomära increment-UPSERT, en per serie.',
  )
}

main()
