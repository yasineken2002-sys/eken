#!/usr/bin/env node
/**
 * CI-guard — VARJE cronjobb måste vara klassificerat, och klass B måste NAMNGE
 * sin invariant.
 *
 * ── VAD DEN SKYDDAR MOT ──────────────────────────────────────────────────────
 *
 * Bilden före den här kontrollen var att fyra jobb var låsta och att "övriga
 * skyddas av DB-invarianter, t.ex. @@unique([leaseId, year, month, type])".
 * Rimligt, oprövat, och giltigt för de jobb någon råkade tänka på. Mätningen gav
 * 25 jobb (inte 21), det indexet skyddade ETT av dem, och TRE var oskyddade:
 *
 *   processLifecycle  skapade två förnyelseavtal → dubbla avier → dubbel fordran
 *   dailyCheck        skapade två notisrader (mejlet var skyddat, inte raden)
 *   dailyBackup       två pg_dump mot prod, två R2-objekt, fel gallringsräknare
 *
 * Ett jobb som klassas B på magkänsla är värre än ett som klassas C, eftersom
 * det SER skyddat ut. Guarden tvingar därför fram ett namngivet skäl.
 *
 * ── REGLERNA ─────────────────────────────────────────────────────────────────
 *
 * R1  Varje @Cron härlett UR KODEN måste stå i cron-classification.ack.json.
 *     Härledningen är poängen: en handskriven lista missar nästa jobb.
 * R2  ÅT ANDRA HÅLLET: varje post i filen måste motsvara ett @Cron som finns.
 *     En klassificering som överlevt sitt jobb är inte en kontroll, den är en
 *     ursäkt.
 * R3  Klass A måste ha en lockKey, och den nyckeln måste faktiskt förekomma i
 *     jobbets fil. Ett "låst" jobb utan lås är den värsta klassificeringen av
 *     alla — den ser säkrast ut.
 * R4  Klass B måste ha ett invariantskäl på minst 30 tecken som NAMNGER en
 *     modell (versal identifierare) och ett villkor/index. Fraser som "skyddas
 *     av statusmaskinen" avvisas uttryckligen.
 * R5  Klass C är otillåten i filen. C betyder oskyddat, och ett oskyddat jobb
 *     ska LÅSAS, inte kvitteras. Att kunna skriva C hade gjort filen till en
 *     plats att parkera problem på.
 * R6  Klass B måste ha invarianten inskriven VID JOBBET i koden, inte bara i
 *     filen — annars är nästa läsare tillbaka i samma gissning.
 *
 * Rent statiskt (fs-only, inga beroenden, ingen DB) → eget CI-steg utan databas.
 * Lokalt:      node apps/api/scripts/check-cron-classification.mjs
 * Självtest:   node apps/api/scripts/check-cron-classification.mjs --self-test
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..', 'src')
const ACK_FILE = join(HERE, 'cron-classification.ack.json')

const MIN_SKAL = 30
/** Fraser som låter som en invariant utan att vara en. */
const TOMMA_SKAL = [
  'skyddas av statusmaskinen',
  'är idempotent',
  'behövs inte',
  'ofarligt',
  'no-op',
]

/** Alla .ts-filer under src, utom specar. */
function källfiler(dir = SRC, ut = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) källfiler(p, ut)
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts')) ut.push(p)
  }
  return ut
}

/**
 * Härled varje @Cron-jobb UR KODEN.
 *
 * Nyckeln är `<relativ fil>::<metodnamn>`. Metoden är den första deklarationen
 * efter dekoratorn — samma form som Nest självt binder på.
 */
export function findCronJobs(filer) {
  const jobb = []
  for (const { fil, text } of filer) {
    const re = /@Cron\(([^)]*)\)[\s\S]{0,500}?\n\s*(?:private |public )?(?:async )?(\w+)\s*\(/g
    let m
    while ((m = re.exec(text))) {
      jobb.push({ nyckel: `${fil}::${m[2]}`, fil, metod: m[2], text })
    }
  }
  return jobb
}

/** Kärnan. Exporterad så självtestet kör exakt samma kod som CI. */
export function evaluate({ jobb, ack }) {
  const problem = []
  const poster = ack.jobs ?? {}

  if (jobb.length === 0) {
    problem.push({
      rule: 'NOLL @Cron-jobb härleddes ur koden',
      detail: 'Skanningen har gått blind — en guard utan mätobjekt mäter ingenting.',
    })
    return problem
  }
  if (Object.keys(poster).length === 0) {
    problem.push({ rule: 'cron-classification.ack.json är tom', detail: 'Inget är klassificerat.' })
    return problem
  }

  const funna = new Set(jobb.map((j) => j.nyckel))

  // ── R1 — varje jobb är klassificerat ─────────────────────────────────────
  for (const j of jobb) {
    const post = poster[j.nyckel]
    if (!post) {
      problem.push({
        rule: `@Cron \`${j.nyckel}\` saknar klassificering`,
        detail:
          'Klassificera det som A (låst via LockService) eller B (skyddat av en NAMNGIVEN ' +
          'invariant) i cron-classification.ack.json. Är det oskyddat ska det LÅSAS.',
      })
      continue
    }
    // ── R3 — klass A ska ha ett lås som faktiskt finns i filen ─────────────
    if (post.class === 'A') {
      if (!post.lockKey) {
        problem.push({ rule: `\`${j.nyckel}\` är klass A utan lockKey`, detail: 'Namnge låsnyckeln.' })
      } else if (!j.text.includes(post.lockKey)) {
        problem.push({
          rule: `\`${j.nyckel}\` är klass A men låsnyckeln "${post.lockKey}" finns inte i filen`,
          detail:
            'Ett "låst" jobb utan lås är den värsta klassificeringen av alla — den ser ' +
            'säkrast ut och skyddar ingenting.',
        })
      }
      continue
    }
    // ── R4 + R6 — klass B ─────────────────────────────────────────────────
    if (post.class === 'B') {
      const skäl = String(post.invariant ?? '').trim()
      if (skäl.length < MIN_SKAL) {
        problem.push({
          rule: `\`${j.nyckel}\` är klass B med för kort invariant (${skäl.length} < ${MIN_SKAL})`,
          detail: 'Ett skäl som inte går att pröva är ingen invariant.',
        })
        continue
      }
      const tomt = TOMMA_SKAL.find((f) => skäl.toLowerCase().trim().startsWith(f))
      if (tomt) {
        problem.push({
          rule: `\`${j.nyckel}\` motiveras med "${tomt}" — det är ett påstående, inte en invariant`,
          detail: 'Namnge MODELLEN och INDEXET/VILLKORET som gör en dubbelkörning till en no-op.',
        })
        continue
      }
      if (!/\b[A-Z][a-zA-Z]{3,}\b/.test(skäl)) {
        problem.push({
          rule: `\`${j.nyckel}\`s invariant namnger ingen modell`,
          detail: 'Skälet ska innehålla modellnamnet, t.ex. `RentNotice` eller `PlatformInvoice`.',
        })
        continue
      }
      // R6 — invarianten ska stå VID jobbet i koden.
      if (!j.text.includes('KLASSIFICERING: B')) {
        problem.push({
          rule: `\`${j.nyckel}\` saknar invarianten i KODEN`,
          detail:
            'Klassificeringsfilen läses av CI, inte av nästa utvecklare. Skriv invarianten ' +
            'vid @Cron-raden — annars är nästa läsare tillbaka i samma gissning.',
        })
      }
      continue
    }
    // ── R5 — klass C är otillåten ─────────────────────────────────────────
    problem.push({
      rule: `\`${j.nyckel}\` är klassad "${post.class}"`,
      detail:
        'Endast A och B är giltiga. C betyder OSKYDDAT, och ett oskyddat jobb ska låsas — ' +
        'inte parkeras i kvitteringsfilen.',
    })
  }

  // ── R2 — ÅT ANDRA HÅLLET ─────────────────────────────────────────────────
  for (const nyckel of Object.keys(poster)) {
    if (!funna.has(nyckel)) {
      problem.push({
        rule: `klassificering för \`${nyckel}\`, som inte motsvarar något @Cron`,
        detail:
          'Jobbet är borttaget eller omdöpt. En lista som överlever sin egen sanning slutar ' +
          'vara en kontroll och blir en ursäkt.',
      })
    }
  }
  return problem
}

// ── självtest ────────────────────────────────────────────────────────────────
const FIL_A = {
  fil: 'x/a.service.ts',
  text: `
  @Cron('0 1 * * *')
  async jobbA(): Promise<void> {
    await this.locks.runIfUnlocked('cron:a', () => this.jobbAUnsafe())
  }`,
}
const FIL_B = {
  fil: 'x/b.service.ts',
  text: `
  // ── KLASSIFICERING: B — SKYDDAT AV INVARIANT ──
  @Cron('0 2 * * *')
  async jobbB(): Promise<void> {}`,
}
const ACK_OK = {
  jobs: {
    'x/a.service.ts::jobbA': { class: 'A', lockKey: 'cron:a' },
    'x/b.service.ts::jobbB': {
      class: 'B',
      invariant: 'RentNotice updateMany-claim på collectionStage=NONE gör andra körningen till en no-op.',
    },
  },
}

function selfTest() {
  let ok = true
  const fail = (m) => {
    ok = false
    console.error(`❌ ${m}`)
  }
  const grön = (label, r) =>
    r.length === 0 ? console.log(`✅ inget falsklarm: ${label}`) : fail(`FALSKLARM: ${label} → ${r[0].rule}`)
  const röd = (label, r, väntad) => {
    if (r.length === 0) return fail(`MISSADE: ${label}`)
    if (väntad && !r.some((x) => x.rule.includes(väntad))) {
      return fail(`${label} fälldes av FEL regel: "${r[0].rule}" — väntade "${väntad}"`)
    }
    console.log(`✅ fångad: ${label} (${r[0].rule})`)
  }
  const jobb = findCronJobs([FIL_A, FIL_B])
  const bas = { jobb, ack: ACK_OK }

  // ── KANARIEFÅGEL 1: härledningen måste ge utslag på känd indata ──────────
  if (jobb.length !== 2 || jobb[0].metod !== 'jobbA' || jobb[1].metod !== 'jobbB') {
    fail(`kanariefågel: härledningen gav ${JSON.stringify(jobb.map((j) => j.metod))}, väntade jobbA + jobbB`)
  } else console.log('✅ kanariefågel: härledningen hittar båda jobben i fixturen')

  // ── KANARIEFÅGEL 2: mot den RIKTIGA källan ──────────────────────────────
  const riktiga = findCronJobs(
    källfiler().map((p) => ({ fil: relative(SRC, p), text: readFileSync(p, 'utf8') })),
  )
  if (riktiga.length === 0) fail('kanariefågel: NOLL @Cron i den riktiga källan — skanningen har gått blind')
  else console.log(`✅ kanariefågel: ${riktiga.length} @Cron-jobb härledda ur den riktiga källan`)

  grön('paritet', evaluate(bas))

  // ── R1 — NYTT JOBB UTAN KLASSIFICERING (guardens kärna) ─────────────────
  röd(
    'nytt @Cron utan klassificering',
    evaluate({
      ...bas,
      jobb: [...jobb, { nyckel: 'x/c.service.ts::jobbC', fil: 'x/c.service.ts', metod: 'jobbC', text: '@Cron()' }],
    }),
    'saknar klassificering',
  )

  // ── R2 — KLASSIFICERING UTAN JOBB (andra hållet) ────────────────────────
  röd(
    'klassificering utan motsvarande jobb',
    evaluate({ ...bas, ack: { jobs: { ...ACK_OK.jobs, 'x/borta.ts::spoke': { class: 'A', lockKey: 'cron:x' } } } }),
    'som inte motsvarar något @Cron',
  )

  // ── R3 — "låst" utan lås ────────────────────────────────────────────────
  röd(
    'klass A vars låsnyckel inte finns i filen',
    evaluate({ ...bas, ack: { jobs: { ...ACK_OK.jobs, 'x/a.service.ts::jobbA': { class: 'A', lockKey: 'cron:finns-inte' } } } }),
    'finns inte i filen',
  )
  röd(
    'klass A utan lockKey',
    evaluate({ ...bas, ack: { jobs: { ...ACK_OK.jobs, 'x/a.service.ts::jobbA': { class: 'A' } } } }),
    'utan lockKey',
  )

  // ── R4 — B utan riktigt skäl ────────────────────────────────────────────
  röd(
    'klass B med för kort skäl',
    evaluate({ ...bas, ack: { jobs: { ...ACK_OK.jobs, 'x/b.service.ts::jobbB': { class: 'B', invariant: 'idempotent' } } } }),
    'för kort invariant',
  )
  röd(
    'klass B motiverad med "skyddas av statusmaskinen"',
    evaluate({
      ...bas,
      ack: { jobs: { ...ACK_OK.jobs, 'x/b.service.ts::jobbB': { class: 'B', invariant: 'skyddas av statusmaskinen och är därför ofarligt' } } },
    }),
    'påstående, inte en invariant',
  )
  röd(
    'klass B som inte namnger någon modell',
    evaluate({
      ...bas,
      ack: { jobs: { ...ACK_OK.jobs, 'x/b.service.ts::jobbB': { class: 'B', invariant: 'en andra körning skriver samma värde och gör därmed ingenting alls' } } },
    }),
    'namnger ingen modell',
  )
  röd(
    'klass B utan invarianten i KODEN',
    evaluate({
      ...bas,
      jobb: [jobb[0], { ...jobb[1], text: "@Cron('0 2 * * *')\n  async jobbB() {}" }],
    }),
    'saknar invarianten i KODEN',
  )

  // ── R5 — C är otillåten ─────────────────────────────────────────────────
  röd(
    'ett jobb parkerat som klass C',
    evaluate({ ...bas, ack: { jobs: { ...ACK_OK.jobs, 'x/b.service.ts::jobbB': { class: 'C', invariant: 'RentNotice oskyddad men vi tar det sen någon gång' } } } }),
    'är klassad "C"',
  )

  röd('inga jobb alls (blind skanning)', evaluate({ ...bas, jobb: [] }), 'NOLL @Cron-jobb')

  console.log(ok ? '\n✅ Självtest OK.' : '\n❌ Självtest misslyckades.')
  process.exit(ok ? 0 : 1)
}

// ── main ─────────────────────────────────────────────────────────────────────
function main() {
  if (process.argv.includes('--self-test')) return selfTest()

  const jobb = findCronJobs(
    källfiler().map((p) => ({ fil: relative(SRC, p), text: readFileSync(p, 'utf8') })),
  )
  const ack = JSON.parse(readFileSync(ACK_FILE, 'utf8'))
  const problem = evaluate({ jobb, ack })

  if (problem.length > 0) {
    console.error('\n=== OKLASSIFICERAT CRONJOBB ELLER OBELAGD INVARIANT (CI-guard) ===\n')
    for (const p of problem) console.error(`❌ ${p.rule}\n   ${p.detail}`)
    console.error(
      '\nRegeln: ett jobb som klassas B på magkänsla är värre än ett som klassas C, för\n' +
        'det SER skyddat ut. Se apps/api/scripts/cron-classification.ack.json.\n',
    )
    process.exit(1)
  }

  const per = { A: 0, B: 0 }
  for (const v of Object.values(ack.jobs)) per[v.class] = (per[v.class] ?? 0) + 1
  console.log(
    `✅ ${jobb.length} @Cron-jobb, alla klassificerade — ${per.A} låsta (A), ${per.B} med namngiven invariant (B).`,
  )
}

main()
