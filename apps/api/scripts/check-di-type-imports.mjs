#!/usr/bin/env node
/**
 * EN `import type` PÅ ETT INJICERAT BEROENDE GÖR APPEN OSTARTBAR — TYST FÖR SVITEN.
 *
 * ── VAD SOM HÄNDE (#739) ────────────────────────────────────────────────────
 *
 * `PiiCoherenceService` fick ett nytt konstruktorberoende, skrivet så här:
 *
 *     import type { ConfigService } from '@nestjs/config'
 *     …
 *     constructor(…, private readonly config: ConfigService, …) {}
 *
 * En typ-import RADERAS av TypeScript vid kompilering. `reflect-metadata` får
 * därför ingen klass att lägga i `design:paramtypes`, och Nest kan inte lösa
 * beroendet:
 *
 *     Nest can't resolve dependencies of the PiiCoherenceService
 *     (PrismaService, SigningCryptoService, ?, CronErrorSink).
 *
 * Det är samma regel som DTO-regeln i CLAUDE.md, fast på ett konstruktor-
 * beroende i stället för på en `ValidationPipe`-klass.
 *
 * ── VARFÖR EN VAKT OCH INTE BARA ETT PROV ───────────────────────────────────
 *
 * Sviten var GRÖN. Alla 32 prov på tjänsten passerade, eftersom de bygger den
 * med `new PiiCoherenceService(…)` och kringgår DI-containern helt — rätt sätt
 * att mäta mekaniken, men strukturellt blint för påkopplingen. Bara E2E såg
 * det, sist i kedjan och dyrast.
 *
 * Ett DI-kompileringsprov per modul hade också fångat det, och ett sådant finns
 * nu för just den modulen. Men det skyddar EN modul; formen kan återinföras i
 * vilken av de andra som helst. Vakten frågar i stället samma sak om HELA
 * trädet, på en sekund.
 *
 * ── VAD REGELN ÄR ───────────────────────────────────────────────────────────
 *
 *   R1  I varje klass med @Injectable() eller @Controller(): ingen
 *       konstruktorparameter får ha en typannotering vars BASNAMN kommer ur en
 *       `import type`-sats (eller ett `type`-märkt namn i en vanlig import) i
 *       samma fil.
 *   R2  Uppräkningen måste ha hittat något. Utan R2 är R1 grön av TOMHET den
 *       dag klassletningen slutar matcha.
 *
 * BASNAMNET, inte hela annoteringen: `design:paramtypes` bär den yttersta
 * konstruktorn, så `Repository<Entity>` emitterar `Repository`. Att fälla på
 * `Entity` hade varit ett falsklarm — generiska argument raderas ändå.
 *
 * ── VAD DEN INTE KAN SE ─────────────────────────────────────────────────────
 *
 * **Parametrar med en `Inject*`-dekorator** (`@Inject`, `@InjectQueue`,
 * `@InjectRepository`, `@InjectModel`, …). Där är token det som injiceras, inte
 * typen, och en typ-import är då fullt legitim — `@Inject(PSD2_PROVIDER)
 * private readonly p: BankDataProvider` ska INTE fällas. De hoppas därför över,
 * och det betyder att vakten inte kan se ett felaktigt TOKEN. Att token finns
 * och är rätt ägs av att appen bootar (E2E) och av DI-prov per modul.
 *
 * **`forwardRef`.** En cirkulär referens injiceras via `@Inject(forwardRef(…))`
 * och faller under samma undantag. Cykler i sig ägs av `check-module-cycles`.
 *
 * **Fabriker.** `useFactory` + `inject: [...]` tar inga konstruktortyper alls.
 * Ligger utanför formen den här vakten läser.
 *
 * Vakten säger alltså: ingen KLASS-injektion är typ-raderad. Den säger inget om
 * att beroendet finns i modulens kontext — det ser bara en boot.
 *
 * Kör med `--self-test` för kanariefåglarna.
 */
import { readdirSync, statSync, readFileSync } from 'node:fs'
import { join, resolve, relative } from 'node:path'
import { codeMask, kanariefåglar } from '../../../scripts/lib/source-scan.mjs'

const ROT = resolve(new URL('../../..', import.meta.url).pathname)
const SRC = join(ROT, 'apps', 'api', 'src')

/**
 * Identifierarform. `\p{L}`, aldrig `\w` — kodbasen namnger på svenska, och en
 * ASCII-klass hade tigit om `övervakning: Övervakare`. Ratcheten
 * (check-identifier-regex.mjs) fäller ASCII-former i nya vakter.
 */
const IDENT = '[\\p{L}\\p{N}_$]+'

/** Dekoratorerna som gör en klass DI-konstruerad. */
const DI_DEKORATORER = ['Injectable', 'Controller']

/** Minsta antal DI-klasser för att R1 ska betyda något. */
const MIN_DI_KLASSER = 100

// ── Analys av EN fil ─────────────────────────────────────────────────────────

/** Alla positioner där `namn` står som en fristående identifierare. */
function förekomster(kod, namn) {
  const re = new RegExp(`(?<![\\p{L}\\p{N}_$])${namn}(?![\\p{L}\\p{N}_$])`, 'gu')
  return [...kod.matchAll(re)].map((m) => m.index)
}

/**
 * Namn som importerats SOM TYP i filen — alltså raderade i runtime.
 *
 * Två former, båda måste med:
 *   import type { A, B } from '…'      hela satsen är typ
 *   import { type A, B } from '…'      enskilda specificerare är typ
 *
 * `import type Standard from '…'` (default) räknas också; ett default-importerat
 * namn kan lika gärna stå som konstruktortyp.
 */
export function typImporteradeNamn(kod) {
  const namn = new Set()

  // Hela satsen typ-märkt.
  const helSats = new RegExp(`import\\s+type\\s+([^;\\n]*?)\\s+from`, 'gu')
  for (const m of kod.matchAll(helSats)) {
    const del = m[1] ?? ''
    const klammer = /\{([^}]*)\}/u.exec(del)
    if (klammer) {
      for (const bit of (klammer[1] ?? '').split(',')) läggTill(namn, bit)
    } else {
      läggTill(namn, del)
    }
  }

  // Enskilda `type`-märkta specificerare i en vanlig import.
  const enskild = new RegExp(`import\\s+(?!type[\\s{])[^;\\n]*?\\{([^}]*)\\}\\s*from`, 'gu')
  for (const m of kod.matchAll(enskild)) {
    for (const bit of (m[1] ?? '').split(',')) {
      const t = bit.trim()
      if (/^type\s/u.test(t)) läggTill(namn, t.replace(/^type\s+/u, ''))
    }
  }

  return namn
}

/** Lägger till ett specificerarnamn, med `as`-alias upplöst till det LOKALA namnet. */
function läggTill(mängd, bit) {
  const t = bit.trim()
  if (!t) return
  const alias = new RegExp(`^${IDENT}\\s+as\\s+(${IDENT})$`, 'u').exec(t)
  const lokalt = alias ? alias[1] : t
  if (new RegExp(`^${IDENT}$`, 'u').test(lokalt)) mängd.add(lokalt)
}

/** Index efter den matchande stängningen, med start på ett öppningstecken. */
function matchaTill(kod, start, öppna, stäng) {
  let djup = 0
  for (let i = start; i < kod.length; i++) {
    const c = kod[i]
    if (c === öppna) djup++
    else if (c === stäng) {
      djup--
      if (djup === 0) return i
    }
  }
  return -1
}

/**
 * Klasserna som bär en DI-dekorator, med sin kropp.
 *
 * Ankaret är DEKORATORN, och klassen är nästa `class`-nyckelord efter den. Att
 * i stället leta bakåt från `class` hade krävt ett godtyckligt fönster — och en
 * fönsteravgränsare som inte är strukturell är exakt den defekt CLAUDE.md
 * beskriver.
 */
export function diKlasser(kod) {
  const start = new Set()
  for (const dek of DI_DEKORATORER) {
    for (const i of förekomster(kod, dek)) {
      // Måste stå som dekorator, alltså efter ett '@'.
      const före = kod.slice(0, i).trimEnd()
      if (!före.endsWith('@')) continue
      const klass = new RegExp(`(?<![\\p{L}\\p{N}_$])class\\s+(${IDENT})`, 'u').exec(kod.slice(i))
      if (klass && klass.index !== undefined) start.add(i + klass.index)
    }
  }

  const ut = []
  for (const s of [...start].sort((a, b) => a - b)) {
    const namn = new RegExp(`class\\s+(${IDENT})`, 'u').exec(kod.slice(s))
    const kroppStart = kod.indexOf('{', s)
    if (!namn || kroppStart === -1) continue
    const kroppSlut = matchaTill(kod, kroppStart, '{', '}')
    if (kroppSlut === -1) continue
    ut.push({ namn: namn[1], start: s, kropp: kod.slice(kroppStart, kroppSlut + 1), kroppStart })
  }
  return ut
}

/** Konstruktorns parameterlista, rå text mellan parenteserna. */
export function konstruktorParametrar(kropp) {
  const m = new RegExp(`(?<![\\p{L}\\p{N}_$])constructor\\s*\\(`, 'u').exec(kropp)
  if (!m || m.index === undefined) return null
  const öppna = kropp.indexOf('(', m.index)
  const stäng = matchaTill(kropp, öppna, '(', ')')
  if (stäng === -1) return null
  return kropp.slice(öppna + 1, stäng)
}

/** Delar en parameterlista på kommatecken som ligger på YTTERSTA nivån. */
export function delaParametrar(text) {
  const ut = []
  let djup = 0
  let nuvarande = ''
  for (const c of text) {
    if ('([{<'.includes(c)) djup++
    else if (')]}>'.includes(c)) djup--
    if (c === ',' && djup === 0) {
      ut.push(nuvarande)
      nuvarande = ''
    } else nuvarande += c
  }
  if (nuvarande.trim()) ut.push(nuvarande)
  return ut.filter((p) => p.trim())
}

/**
 * Typannoteringens BASNAMN för en parameter, eller null.
 *
 * `null` betyder "ingen klass-injektion att bedöma" — parametern har ingen
 * typ, är token-injicerad, eller annoteras med något som inte är ett namn.
 */
export function basTyp(param) {
  // TOKEN-DEKORATORER — typen är då irrelevant för DI och en typ-import är RÄTT.
  //
  // FORMEN, INTE EN UPPRÄKNING: varje dekorator vars namn börjar på `Inject`
  // levererar ett token. Det är Nest-ekosystemets konvention och den täcker
  // @Inject, @InjectQueue (bull), @InjectRepository/@InjectDataSource (typeorm),
  // @InjectModel (mongoose) och det som kommer härnäst. En namnlista hade blivit
  // röd första gången någon införde ett nytt bibliotek — och det hade sett ut som
  // en defekt i koden i stället för i vakten.
  //
  // Uppmätt varför detta INTE är en detalj: utan regeln gav den skarpa körningen
  // SJU falsklarm, alla `@InjectQueue(...) queue: Queue<…>` med korrekt
  // `import type { Queue } from 'bull'`. En vakt som fäller sju riktiga rader är
  // avstängd inom en vecka.
  if (new RegExp(`@\\s*Inject${IDENT.slice(0, -1)}*\\s*\\(`, 'u').test(param)) return null

  // Typen står efter det YTTERSTA kolonet. Modifierare och namn ligger före.
  let djup = 0
  let kolon = -1
  for (let i = 0; i < param.length; i++) {
    const c = param[i]
    if ('([{<'.includes(c)) djup++
    else if (')]}>'.includes(c)) djup--
    else if (c === ':' && djup === 0) {
      kolon = i
      break
    }
  }
  if (kolon === -1) return null

  const annotering = param.slice(kolon + 1)
  const namn = new RegExp(`^\\s*(${IDENT})`, 'u').exec(annotering)
  return namn ? namn[1] : null
}

/** @param {{rel: string, text: string}} fil */
export function granskaFil({ rel, text }) {
  const kod = codeMask(text)
  const typNamn = typImporteradeNamn(kod)
  const fel = []
  let klasser = 0

  for (const klass of diKlasser(kod)) {
    klasser++
    const params = konstruktorParametrar(klass.kropp)
    if (params === null) continue
    for (const p of delaParametrar(params)) {
      const bas = basTyp(p)
      if (bas === null || !typNamn.has(bas)) continue
      const rad = kod.slice(0, klass.kroppStart).split('\n').length
      fel.push(
        `${rel}:~${rad} ${klass.namn} — konstruktorparametern med typen \`${bas}\` är ` +
          'TYP-IMPORTERAD i samma fil. Typ-importer raderas i runtime, så ' +
          '`design:paramtypes` blir tomt och Nest kan inte lösa beroendet — appen ' +
          'startar inte. Byt till en vanlig värde-import. (Är det ett token-injicerat ' +
          'beroende ska parametern bära @Inject(...), och då är typ-importen rätt.)',
      )
    }
  }

  return { fel, klasser }
}

/** @param {Array<{rel: string, text: string}>} filer */
export function evaluate(filer) {
  const fel = []
  let klasser = 0
  for (const f of filer) {
    const r = granskaFil(f)
    fel.push(...r.fel)
    klasser += r.klasser
  }

  if (klasser < MIN_DI_KLASSER) {
    fel.push(
      `R2 uppräkningen hittade bara ${klasser} DI-klasser, tröskeln är ${MIN_DI_KLASSER}. ` +
        'R1 är då grön av TOMHET och inte av att trädet är rent — klassletningen har ' +
        'slutat matcha.',
    )
  }

  return { fel, mätt: { filer: filer.length, klasser } }
}

// ── Läsning från disk ────────────────────────────────────────────────────────

const HOPPA_ÖVER = new Set(['node_modules', 'dist', 'build', '.turbo'])

function gåIgenom(katalog, träffar = []) {
  for (const post of readdirSync(katalog)) {
    if (HOPPA_ÖVER.has(post)) continue
    const full = join(katalog, post)
    if (statSync(full).isDirectory()) gåIgenom(full, träffar)
    // Formen, inte ordet: `.ts` men inte `.d.ts`. Specar tas med — en spec kan
    // också bära en @Injectable-klass, och regeln gäller den lika mycket.
    else if (/\.ts$/u.test(post) && !/\.d\.ts$/u.test(post)) träffar.push(full)
  }
  return träffar
}

export function frånDisk() {
  return gåIgenom(SRC).map((full) => ({
    rel: relative(ROT, full),
    text: readFileSync(full, 'utf8'),
  }))
}

// ── Självtest ────────────────────────────────────────────────────────────────

function självtest() {
  const fel = []
  const kräv = (namn, filer, skaFälla) => {
    const r = evaluate([...filer, ...fyllnad()])
    const fällde = r.fel.some((f) => !f.startsWith('R2'))
    if (fällde !== skaFälla) {
      fel.push(
        `${namn}: väntade ${skaFälla ? 'RÖTT' : 'GRÖNT'}, fick ${fällde ? 'RÖTT' : 'GRÖNT'}. ` +
          JSON.stringify(r.fel.filter((f) => !f.startsWith('R2'))),
      )
    }
  }

  // Fyllnad så R2 (omfångsgolvet) inte skymmer R1 i kanariefåglarna.
  const fyllnad = () =>
    Array.from({ length: MIN_DI_KLASSER }, (_, i) => ({
      rel: `fyllnad/${i}.ts`,
      text: `@Injectable()\nexport class F${i} {\n  constructor() {}\n}\n`,
    }))

  // KANARIE A — fixturen ur #739. Exakt formen som gjorde appen ostartbar.
  kräv(
    'KANARIE A (#739: import type + konstruktorparameter)',
    [
      {
        rel: 'sond/a.ts',
        text:
          "import type { ConfigService } from '@nestjs/config'\n" +
          '@Injectable()\nexport class Sond {\n' +
          '  constructor(private readonly config: ConfigService) {}\n}\n',
      },
    ],
    true,
  )

  // KANARIE B — samma fil med VÄRDE-import. Fäller vakten även den är den
  // oanvändbar: varje korrekt beroende hade blivit ett falsklarm.
  kräv(
    'KANARIE B (vanlig import → grönt)',
    [
      {
        rel: 'sond/b.ts',
        text:
          "import { ConfigService } from '@nestjs/config'\n" +
          '@Injectable()\nexport class Sond {\n' +
          '  constructor(private readonly config: ConfigService) {}\n}\n',
      },
    ],
    false,
  )

  // KANARIE C — legitim typ-import som INTE står som konstruktorparameter.
  // Utan det här provet skulle vakten göra `import type` omöjligt i en
  // DI-klass, vilket är fel: typer i metodsignaturer SKA vara typ-importerade.
  kräv(
    'KANARIE C (typ-import utan konstruktorbruk → grönt)',
    [
      {
        rel: 'sond/c.ts',
        text:
          "import type { JwtPayload } from '@eken/shared'\n" +
          "import { ConfigService } from '@nestjs/config'\n" +
          '@Injectable()\nexport class Sond {\n' +
          '  constructor(private readonly config: ConfigService) {}\n' +
          '  läs(u: JwtPayload): void {}\n}\n',
      },
    ],
    false,
  )

  // KANARIE D — `import { type X }`, den andra formen. Missas den är halva
  // regeln blind, och blindheten syns inte: A är fortfarande grön.
  kräv(
    'KANARIE D (inline type-specificerare)',
    [
      {
        rel: 'sond/d.ts',
        text:
          "import { type ConfigService, Logger } from '@nestjs/config'\n" +
          '@Injectable()\nexport class Sond {\n' +
          '  constructor(private readonly config: ConfigService) {}\n}\n',
      },
    ],
    true,
  )

  // KANARIE E — @Inject-token gör typen irrelevant. Fälls den blir varje
  // token-injicerat beroende ett falsklarm, och vakten blir avstängd i praktiken.
  kräv(
    'KANARIE E (@Inject-token → grönt trots typ-import)',
    [
      {
        rel: 'sond/e.ts',
        text:
          "import type { BankDataProvider } from './typer'\n" +
          '@Injectable()\nexport class Sond {\n' +
          '  constructor(@Inject(PSD2_PROVIDER) private readonly p: BankDataProvider) {}\n}\n',
      },
    ],
    false,
  )

  // KANARIE E2 — @InjectQueue, den verkliga formen. Sju rader i trädet ser ut
  // precis så här, och alla är korrekta. Fälls de blir vakten oanvändbar.
  kräv(
    'KANARIE E2 (@InjectQueue → grönt trots typ-import)',
    [
      {
        rel: 'sond/e2.ts',
        text:
          "import { InjectQueue } from '@nestjs/bull'\n" +
          "import type { Queue } from 'bull'\n" +
          '@Injectable()\nexport class Sond {\n' +
          '  constructor(@InjectQueue(QUEUE_HIGH) private readonly k: Queue<Nyttolast>) {}\n}\n',
      },
    ],
    false,
  )

  // KANARIE F — @Controller ska bedömas som @Injectable.
  kräv(
    'KANARIE F (@Controller omfattas)',
    [
      {
        rel: 'sond/f.ts',
        text:
          "import type { AuthService } from './auth.service'\n" +
          "@Controller('auth')\nexport class Sond {\n" +
          '  constructor(private readonly auth: AuthService) {}\n}\n',
      },
    ],
    true,
  )

  // KANARIE G — generiskt argument får INTE fälla. `design:paramtypes` bär den
  // yttersta konstruktorn; `Entity` raderas ändå och är legitimt typ-importerad.
  kräv(
    'KANARIE G (generiskt argument typ-importerat → grönt)',
    [
      {
        rel: 'sond/g.ts',
        text:
          "import type { Entity } from './entity'\n" +
          "import { Repository } from 'typeorm'\n" +
          '@Injectable()\nexport class Sond {\n' +
          '  constructor(private readonly repo: Repository<Entity>) {}\n}\n',
      },
    ],
    false,
  )

  // KANARIE H — namnet står bara i en KOMMENTAR respektive en STRÄNG. Utan
  // codeMask hade båda räknats som kod, och vakten fällt en fil utan defekt.
  kräv(
    'KANARIE H (typ-import nämnd i kommentar/sträng → grönt)',
    [
      {
        rel: 'sond/h.ts',
        text:
          "import { ConfigService } from '@nestjs/config'\n" +
          '@Injectable()\nexport class Sond {\n' +
          '  // import type { ConfigService } fanns här förr\n' +
          "  hjälp = 'import type { ConfigService } from x'\n" +
          '  constructor(private readonly config: ConfigService) {}\n}\n',
      },
    ],
    false,
  )

  // KANARIE I — tom mängd. Utan R2 vore ALLT ovan grönt här.
  {
    const tom = evaluate([])
    if (!tom.fel.some((f) => f.startsWith('R2'))) {
      fel.push(`KANARIE I: R2 föll inte på tom mängd. Utfall: ${JSON.stringify(tom.fel)}`)
    }
  }

  // KANARIE J — den delade skannerns egna fällor. Bryts den blir DEN HÄR
  // vakten röd, inte bara source-scan.mjs egen körning.
  for (const f of kanariefåglar()) fel.push(`KANARIE J delad skanner: ${f}`)

  if (fel.length) {
    console.error('SJÄLVTEST RÖTT:\n  ' + fel.join('\n  '))
    process.exit(1)
  }
  console.warn(
    'SJÄLVTEST GRÖNT — 10 egna kanariefåglar: #739-fixturen fälls, värde-import går fri, ' +
      'legitim typ-import går fri, inline-`type` fälls, @Inject- och @InjectQueue-token går fria, @Controller ' +
      'omfattas, generiskt argument går fri, kommentar/sträng räknas inte, tom mängd fälls ' +
      'av R2. Plus den delade skannerns egna lägesprov.',
  )
}

const KÖRS_DIREKT = process.argv[1]?.endsWith('check-di-type-imports.mjs') ?? false
if (!KÖRS_DIREKT) {
  // importerad — kör ingenting
} else if (process.argv.includes('--self-test')) självtest()
else {
  const { fel, mätt } = evaluate(frånDisk())
  if (fel.length) {
    console.error(
      'Ett injicerat beroende är typ-importerat — appen startar inte:\n  ' + fel.join('\n  '),
    )
    process.exit(1)
  }
  console.warn(
    `Inga typ-raderade DI-beroenden — ${mätt.klasser} klasser med @Injectable/@Controller ` +
      `granskade i ${mätt.filer} filer, 0 träffar.`,
  )
}
