#!/usr/bin/env node
/**
 * INGEN ODEKLARERAD CYKEL I MODULGRAFEN.
 *
 * ── VARFÖR DEN FINNS ────────────────────────────────────────────────────────
 *
 * #605 batch 1 kopplade `CronErrorSinkModule` till `NotificationsModule` och
 * slöt därmed en ring:
 *
 *     NotificationsModule → CronErrorSinkModule → PlatformModule
 *                         → InvoicesModule → NotificationsModule
 *
 * Utfallet var att API:t inte startade alls. Nest sa det ordagrant:
 *
 *     Scope [AppModule -> LeasesModule -> NotificationsModule
 *            -> CronErrorSinkModule -> PlatformModule]
 *
 * ── VAD SOM GJORDE DET DYRT ─────────────────────────────────────────────────
 *
 * `Tests` var GRÖNT på 340 sviter och 3486 tester samtidigt. Varje spec
 * konstruerar sina tjänster för hand — `new NotificationsService(prisma, …)` —
 * och rör därför aldrig DI-grafen. Det gällde även db-riggen mot riktig
 * Postgres, som byggdes som det starkaste beviset: den prövar att raden skrivs
 * och överlever processen, men inte att applikationen går att starta.
 *
 * Det var `E2E` som fångade det, och bara som en SIDOEFFEKT av att det jobbet
 * startar API:t. Fyra minuters CI och en jobblogg är fel instrument för något
 * som går att mäta statiskt på en sekund.
 *
 * ── VAD REGELN FRÅGAR ───────────────────────────────────────────────────────
 *
 * Grafen HÄRLEDS ur `*.module.ts`: varje `@Module({ imports: [...] })` ger
 * kanter, och identifierarna slås upp mot filens egna import-satser. Ingen
 * uppräkning, ingen lista att glömma.
 *
 * En cykel är ett fel bara om INGEN kant i den är en `forwardRef`. Nest stöder
 * cykler som är DEKLARERADE — det som fäller här är den som ingen tagit
 * ställning till. Kodbasen har 3 forwardRef-kanter i dag och de ska förbli
 * gröna.
 *
 * Kör:        node apps/api/scripts/check-module-cycles.mjs
 * Självtest:  node apps/api/scripts/check-module-cycles.mjs --self-test
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { codeMask, kanariefåglar } from '../../../scripts/lib/source-scan.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = resolve(HERE, '..', 'src')

/** Alla `*.module.ts` under src. */
export function modulfiler(dir = SRC, ut = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) modulfiler(p, ut)
    else if (e.name.endsWith('.module.ts')) ut.push(p)
  }
  return ut
}

/**
 * `imports: [...]`-arrayens innehåll ur `@Module({...})`, i KOD.
 *
 * Ankaret är `@Module(` och inte första `imports:` i filen — en modul kan ha
 * ett `imports` i ett annat objekt (t.ex. en `JwtModule.registerAsync`-config),
 * och då hade fönstret börjat på fel ställe.
 */
export function importsBlock(text) {
  const kod = codeMask(text)
  const dek = kod.indexOf('@Module(')
  if (dek === -1) return null
  const m = /imports\s*:\s*\[/.exec(kod.slice(dek))
  if (!m) return ''
  const start = kod.indexOf('[', dek + m.index)
  let djup = 0
  for (let j = start; j < kod.length; j++) {
    if (kod[j] === '[') djup++
    else if (kod[j] === ']') {
      djup--
      if (djup === 0) return kod.slice(start + 1, j)
    }
  }
  return kod.slice(start + 1)
}

/**
 * Kanterna ur en modulfil: `{ namn, forwardRef }`.
 *
 * `forwardRef(() => X)` markeras som DEKLARERAD. Allt annat är en hård kant.
 */
export function kanter(text) {
  const inne = importsBlock(text)
  if (inne === null) return []
  const ut = []
  for (const m of inne.matchAll(/(?<![\p{L}\p{N}_$])(\p{Lu}[\p{L}\p{N}_$]*Module)(?![\p{L}\p{N}_$])/gu)) {
    const före = inne.slice(Math.max(0, m.index - 40), m.index)
    ut.push({ namn: m[1], forwardRef: /forwardRef\s*\(\s*\(\s*\)\s*=>\s*$/.test(före) })
  }
  return ut
}

/** Var bor `Namn`? Slås upp i filens EGNA import-satser; null = extern. */
export function slåUpp(text, namn, filväg) {
  const kod = codeMask(text)
  const re = new RegExp(`import\\s*\\{[^}]*(?<![\\p{L}\\p{N}_$])${namn}(?![\\p{L}\\p{N}_$])[^}]*\\}\\s*from\\s*['"\`]`, 'u')
  const m = re.exec(kod)
  if (!m) return null
  // Sökvägen är stränginnehåll — läs den ur RÅTEXTEN på samma index.
  const q = text.slice(m.index + m[0].length)
  const slut = q.search(/['"`]/)
  const sökväg = q.slice(0, slut)
  if (!sökväg.startsWith('.')) return null // node_modules
  return resolve(dirname(filväg), sökväg) + '.ts'
}

/** Härled hela grafen. Nycklar är src-relativa sökvägar. */
export function byggGraf(filer) {
  const graf = new Map()
  for (const { fil, text } of filer) {
    const nyckel = relative(SRC, fil).split('\\').join('/')
    const ut = []
    for (const k of kanter(text)) {
      const mål = slåUpp(text, k.namn, fil)
      if (!mål) continue // extern modul (@nestjs/*, o.d.)
      ut.push({ till: relative(SRC, mål).split('\\').join('/'), forwardRef: k.forwardRef, namn: k.namn })
    }
    graf.set(nyckel, ut)
  }
  return graf
}

/**
 * Cykler i grafen, räknat ENBART på hårda kanter.
 *
 * Returnerar varje cykel som en väg `[a, b, c, a]`. En cykel där någon kant är
 * `forwardRef` finns inte i den här grafen och rapporteras alltså aldrig.
 */
export function hittaCykler(graf) {
  const VIT = 0, GRÅ = 1, SVART = 2
  const färg = new Map()
  const stack = []
  const cykler = []
  const sedda = new Set()

  const besök = (nod) => {
    färg.set(nod, GRÅ)
    stack.push(nod)
    for (const kant of graf.get(nod) ?? []) {
      if (kant.forwardRef) continue
      const n = kant.till
      if (!graf.has(n)) continue
      const f = färg.get(n) ?? VIT
      if (f === GRÅ) {
        const i = stack.indexOf(n)
        const väg = [...stack.slice(i), n]
        const id = [...väg].sort().join('|')
        if (!sedda.has(id)) { sedda.add(id); cykler.push(väg) }
      } else if (f === VIT) besök(n)
    }
    stack.pop()
    färg.set(nod, SVART)
  }
  for (const nod of graf.keys()) if ((färg.get(nod) ?? VIT) === VIT) besök(nod)
  return cykler
}

const RÄTT_VÄG = [
  'En odeklarerad cykel gör att API:t inte startar — Nest kan inte instansiera',
  'någon av modulerna i ringen. Enhetstester ser det INTE: de konstruerar sina',
  'tjänster för hand och rör aldrig DI-grafen.',
  '',
  'SÅ HÄR GÖR DU RÄTT, i den ordningen:',
  '',
  '  (1) BRYT CYKELN. Behöver modulen bara EN tjänst ur den andra, och den',
  '      tjänsten har få beroenden? Tillhandahåll den lokalt i stället för att',
  '      importera hela modulen. Så löstes #605 batch 1:',
  '        // CronErrorSinkModule',
  '        imports: [PrismaModule],                    // ← inte PlatformModule',
  '        providers: [PlatformErrorsService, CronErrorSink],',
  '      PlatformErrorsService behöver bara PrismaService, så ingen cykel uppstår.',
  '      Skriv i modulen VARFÖR — en andra instans av en tjänst ska vara ett',
  '      medvetet val, och det duger bara om tjänsten är TILLSTÅNDSLÖS.',
  '',
  '  (2) FLYTTA DET DELADE. Är beroendet ömsesidigt på riktigt hör det som delas',
  '      ofta hemma i en tredje modul som båda importerar.',
  '',
  '  (3) forwardRef() — SIST, och bara när cykeln är avsiktlig. Den TYSTAR den',
  '      här vakten, så använd den när du kan förklara varför ringen ska finnas,',
  '      inte för att bli av med ett rött CI-jobb. Kodbasen har 3 sådana kanter.',
].join('\n   ')

export function evaluate(graf) {
  const problem = []
  if (graf.size === 0) {
    problem.push({
      rule: 'NOLL modulfiler hittades',
      detail: 'Skanningen har gått blind — en vakt utan mätobjekt mäter ingenting.',
    })
    return problem
  }
  for (const väg of hittaCykler(graf)) {
    problem.push({ rule: `odeklarerad modulcykel: ${väg.join(' → ')}`, detail: RÄTT_VÄG })
  }
  return problem
}

function allaFiler() {
  return modulfiler().map((fil) => ({ fil, text: readFileSync(fil, 'utf8') }))
}

// ── självtest ────────────────────────────────────────────────────────────────
function självtest() {
  let fel = 0
  const t = (namn, ok, extra = '') => {
    console.warn(`${ok ? '✅' : '❌'} ${namn}${extra ? '  → ' + extra : ''}`)
    if (!ok) fel++
  }

  // ── #713: DE TVÅ STÄLLEN SOM BYTTES ─────────────────────────────────────
  //
  // Båda HÄRLEDER modulnamn ur källtext, och båda var ASCII. Följden är att en
  // modul med svenskt namn inte finns i grafen — och en cykel som går GENOM
  // den kan då inte hittas. Vakten är grön om en cykel den aldrig sett.
  {
    const src =
      "import { ÄrendeModule } from './a'\nimport { FörvaltningModule } from './b'\n" +
      "import { AviModule } from './c'\n@Module({ imports: [ÄrendeModule, FörvaltningModule, AviModule] })\nexport class X {}"
    // (1) KANTERNA. `\b[A-Z]\w*Module\b` matchar inte `Ä`, och `FörvaltningModule`
    //     har `ö` inuti — `\w*` stannar där och `Module` följer inte.
    //     Uppmätt mot origin/main: ["AviModule"] i stället för alla tre.
    const namn = kanter(src).map((k) => k.namn)
    t('#713 (1) MISSAD+KAPAD: modulnamn med svenska tecken blir kanter',
      namn.join() === 'ÄrendeModule,FörvaltningModule,AviModule', JSON.stringify(namn))
    // (2) UPPSLAGET av var modulen bor.
    t('#713 (2) MISSAD: uppslaget hittar en modul med svensk initial',
      slåUpp(src, 'ÄrendeModule', '/x.ts') === '/a.ts', JSON.stringify(slåUpp(src, 'ÄrendeModule', '/x.ts')))
    // MOTPROVEN — avgränsningen får inte bli en delsträngssökning, och en
    // klass som inte slutar på Module är ingen modul.
    t('#713 MOTPROV: `XAviModule` slås inte upp som `AviModule`',
      slåUpp(src, 'XAviModule', '/x.ts') === null, JSON.stringify(slåUpp(src, 'XAviModule', '/x.ts')))
    t('#713 MOTPROV: en klass utan Module-suffix blir ingen kant',
      kanter("import { Ärende } from './a'\n@Module({ imports: [Ärende] })").length === 0)
    t('#713 MOTPROV: gemen initial blir ingen kant',
      kanter("import { ärendeModule } from './a'\n@Module({ imports: [ärendeModule] })").length === 0)
  }

  // (0) Den delade skannerns kanariefåglar — metavaktens R2.
  const skanner = kanariefåglar()
  t('delad skanner: kanariefåglarna gröna', skanner.length === 0, skanner.join(' | '))

  const filer = allaFiler()
  const graf = byggGraf(filer)

  // (1) REGELKANARIEFÅGELN — en SYNTETISK cykel måste fälla.
  {
    const g = new Map(graf)
    g.set('qq/a.module.ts', [{ till: 'qq/b.module.ts', forwardRef: false, namn: 'QqBModule' }])
    g.set('qq/b.module.ts', [{ till: 'qq/a.module.ts', forwardRef: false, namn: 'QqAModule' }])
    const p = evaluate(g)
    t('REGEL: en injicerad cykel fälls', p.some((x) => x.rule.includes('qq/a.module.ts')),
      p.map((x) => x.rule).join(' | ').slice(0, 120))
  }
  // …och en LÄNGRE ring, så regeln inte bara känner igen tvåcykler.
  {
    const g = new Map(graf)
    g.set('qq/x.module.ts', [{ till: 'qq/y.module.ts', forwardRef: false, namn: 'QqYModule' }])
    g.set('qq/y.module.ts', [{ till: 'qq/z.module.ts', forwardRef: false, namn: 'QqZModule' }])
    g.set('qq/z.module.ts', [{ till: 'qq/x.module.ts', forwardRef: false, namn: 'QqXModule' }])
    t('REGEL: en trestegs-ring fälls också', evaluate(g).some((x) => x.rule.includes('qq/x.module.ts')))
  }
  // (2) …och en DEKLARERAD cykel får INTE fälla — annars fäller vakten legitim kod.
  {
    const g = new Map(graf)
    g.set('qq/c.module.ts', [{ till: 'qq/d.module.ts', forwardRef: true, namn: 'QqDModule' }])
    g.set('qq/d.module.ts', [{ till: 'qq/c.module.ts', forwardRef: false, namn: 'QqCModule' }])
    t('REGEL: en forwardRef-cykel fälls INTE', !evaluate(g).some((x) => x.rule.includes('qq/c')))
  }

  // (3) DEN RIKTIGA CYKELN FRÅN #605 — regeln ska känna igen just den formen.
  {
    const g = new Map(graf)
    const n = 'notifications/notifications.module.ts'
    const c = 'common/cron/cron-error-sink.module.ts'
    if (g.has(n) && g.has(c)) {
      g.set(c, [...(g.get(c) ?? []), { till: 'platform/platform.module.ts', forwardRef: false, namn: 'PlatformModule' }])
      t('REGEL: #605:s verkliga cykel återinförd → fälls',
        evaluate(g).some((x) => x.rule.includes('cron-error-sink.module.ts')),
        evaluate(g).map((x) => x.rule)[0]?.slice(0, 140) ?? '')
    } else t('REGEL: #605:s cykel — modulerna finns', false, `${n}/${c} saknas`)
  }

  // (4) OMFÅNGSKANARIEFÅGELN — tom mängd fäller, och golven är MÄTTA.
  t('OMFÅNG: en tom graf fälls', evaluate(new Map()).some((x) => x.rule.includes('NOLL modulfiler')))
  // MÄTT mot 23dc84b MED DEN HÄR VAKTENS EGEN RÄKNING: 54 modulfiler, 179 hårda
  // kanter, 3 forwardRef.
  //
  // En grovräkning på `imports:`-arrayerna gav först 199. Skillnaden är EXTERNA
  // moduler — JwtModule, ConfigModule och liknande — som inte slås upp till en
  // lokal fil och därför inte är kanter i den här grafen. Golvet måste mätas mot
  // samma mängd som asserteras, annars fäller det av fel skäl.
  const MIN_MODULER = 35
  const MIN_KANTER = 120
  let hårda = 0, forward = 0
  for (const ut of graf.values()) for (const k of ut) (k.forwardRef ? forward++ : hårda++)
  t(`OMFÅNG: ${graf.size} modulfiler (golv ${MIN_MODULER})`, graf.size >= MIN_MODULER)
  t(`OMFÅNG: ${hårda} hårda kanter (golv ${MIN_KANTER})`, hårda >= MIN_KANTER)
  t(`OMFÅNG: ${forward} forwardRef-kanter — kodbasen HAR deklarerade cykler`, forward >= 1)

  // (5) Kodbasen själv.
  const bas = evaluate(graf)
  t('kodbasen har inga odeklarerade cykler', bas.length === 0,
    bas.map((x) => x.rule).join(' | ').slice(0, 200))

  console.warn(fel === 0 ? '\n✅ Självtest OK.' : `\n❌ Självtest: ${fel} fallerade.`)
  process.exit(fel === 0 ? 0 : 1)
}

function kör() {
  const graf = byggGraf(allaFiler())
  const problem = evaluate(graf)
  if (problem.length > 0) {
    console.error('\n=== ODEKLARERAD MODULCYKEL (CI-guard) ===\n')
    for (const p of problem) console.error(`❌ ${p.rule}\n   ${p.detail}`)
    console.error('')
    process.exit(1)
  }
  let hårda = 0, forward = 0
  for (const ut of graf.values()) for (const k of ut) (k.forwardRef ? forward++ : hårda++)
  console.warn(
    `✅ ${graf.size} moduler, ${hårda} hårda kanter — inga odeklarerade cykler ` +
      `(${forward} forwardRef-kanter, alltså deklarerade och tillåtna).`,
  )
}

const körsDirekt = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (!körsDirekt) {
  // importerad — exportera bara
} else if (process.argv.includes('--self-test')) självtest()
else kör()
