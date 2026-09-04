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
 * ── TRE VYER, EN PER FRÅGA ──────────────────────────────────────────────────
 *
 * Vakten läste råtexten, och R3 blev då den värsta sortens blind — den som
 * bekräftar sin egen sämsta klassificering. `j.text.includes(post.lockKey)`
 * uppfylldes av en KOMMENTAR som nämner låsnyckeln. Filens egen huvudkommentar
 * säger att "ett 'låst' jobb utan lås är den värsta klassificeringen av alla,
 * den ser säkrast ut" — och regeln som skulle hindra det kunde uppfyllas av
 * prosa som PÅSTOD att låset fanns.
 *
 * Att bara byta till codeMask hade brutit två av tre regler, så varje fråga får
 * sin vy:
 *
 *   kod           = codeMask       R1: härledningen av @Cron. En utkommenterad
 *                                  dekorator är inget jobb.
 *   strängar      = blankComments  R3: låsnyckeln ÄR en stränglitteral
 *                                  (`'cron:a'`). codeMask hade blankat den och
 *                                  gjort regeln omöjlig att uppfylla; råtext lät
 *                                  en kommentar uppfylla den.
 *   kommentarer   = tokenize       R6: markören `KLASSIFICERING: B` står MED
 *                                  FLIT i en kommentar vid jobbet. Den ska läsas
 *                                  där — inte i kod, och inte i en sträng som
 *                                  råkar innehålla texten.
 *
 * Rent statiskt (fs-only, inga beroenden, ingen DB) → eget CI-steg utan databas.
 * Lokalt:      node apps/api/scripts/check-cron-classification.mjs
 * Självtest:   node apps/api/scripts/check-cron-classification.mjs --self-test
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { codeMask, blankComments, tokenize, kanariefåglar, KANARIEFÅGEL_LÄGEN } from '../../../scripts/lib/source-scan.mjs'

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

/**
 * Låstjänstens källa. Metodnamnen HÄRLEDS ur den — de listas aldrig här.
 *
 * Skälet är #600: en regel som räknar upp kända namn blir tyst grön den dag
 * någon döper om `runIfUnlocked` eller lägger till en tredje låsmetod. Samma
 * läxa som formregeln i check-guard-preprocessors: fråga efter FORMEN, inte
 * efter en uppräkning.
 */
const LOCK_SERVICE = join(SRC, 'common', 'redis', 'lock.service.ts')

/**
 * Låsmetodernas namn, härledda ur LockService.
 *
 * Formen är "en metod vars FÖRSTA parameter är `key: string`" — det är exakt
 * det som gör en metod till en låsmetod, och det är inte något man kan råka
 * uppfylla. Uppmätt mot 084363b: `runWithLock` och `runIfUnlocked`.
 */
/**
 * IDENTIFIERARE ÄR UNICODE, INTE `\\w` (#640).
 *
 * `\\w` är ASCII i JavaScript: `[A-Za-z0-9_]`. Ett metodnamn med å, ä eller ö
 * matchar inte — och utfallet är inte ett fel utan TYSTNAD. Ett `@Cron` som heter
 * `städaGammalt` härleds då inte alls, vilket betyder att jobbet inte är
 * OFULLSTÄNDIGT mätt utan INTE MÄTT: både klassificeringsvakten och
 * felsänkevakten förblir gröna, eftersom mängden de mäter aldrig innehöll det.
 *
 * Omfångsgolvet fångar det inte — det fäller bara om mängden nästan försvinner,
 * inte om den tappar ETT jobb.
 *
 * Kodbasen namnger redan metoder på svenska (mätt 2026-09-02: `hämtaBefintligAvi`,
 * `avierPerMånad`, `underhållsplan`, `utrustningLivslängd`), och CLAUDE.md
 * föreskriver svenska i allt utom skalvariabler. Det är alltså inte ett hörnfall
 * utan en fråga om när.
 */
const IDENT = '[\\p{L}\\p{N}_$]+'

export function härledLåsmetoder(lockServiceText) {
  const kod = codeMask(lockServiceText)
  const re = new RegExp(`\\basync\\s+(${IDENT})\\s*(?:<[^>]*>)?\\s*\\(\\s*key\\s*:\\s*string\\s*,`, 'gu')
  return [...kod.matchAll(re)].map((m) => m[1])
}

/** Regex-säker version av en godtycklig sträng. */
const rx = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * ── #600: FRÅGAN ÄR OM LÅSET ANROPAS, INTE OM NYCKELN NÄMNS ────────────────
 *
 * R3 frågade tidigare `vyer(j.text).strängar.includes(post.lockKey)`. Det var
 * strikt bättre än råtext — en KOMMENTAR som påstod att låset fanns dög inte
 * längre — men det räckte inte, och det gick inte att laga med en mask:
 * låsnyckeln ÄR en stränglitteral också i det äkta anropet, så ingen vy skiljer
 * de två förekomsterna åt.
 *
 * Uppmätt mot 084363b: VARJE klass-A-nyckel förekommer exakt TVÅ gånger i sin
 * fil — en gång som låsargument, en gång i en loggsträng:
 *
 *     leases.service.ts:1362   'cron:leases-lifecycle',                    ← låset
 *     leases.service.ts:1371   `[cron:leases-lifecycle] Kördes redan …`    ← loggen
 *
 * Loggraden ensam uppfyllde alltså den gamla regeln. Tas låsanropet bort men
 * loggen står kvar — den troliga refaktoreringen — blev vakten grön om ett jobb
 * som klassats "låst" och inte längre är det.
 *
 * Regeln frågar därför efter ANROPSFORMEN: nyckeln måste stå som FÖRSTA
 * ARGUMENT till en av låsmetoderna. En loggsträng har inget `.runIfUnlocked(`
 * framför sig.
 *
 * Nyckeln får vara en literal, eller en KONSTANT som binds till nyckeln i samma
 * fil. Det andra fallet finns inte i koden i dag, men en regel som fäller det
 * hade varit ett falsklarm som väntade på att hända — och en cron-vakt som
 * larmar på legitim kod blir avstängd, varefter ALLA jobb är oskyddade.
 */
/**
 * Ett MODELLNAMN i invariantens skäl: PascalCase, minst fyra bokstäver.
 *
 * Exporterad och namngiven av ett skäl (#713): kanariefågeln ska pröva
 * VAKTENS mönster, inte en kopia av det. En sond som skriver om regexen på
 * nytt mäter sin egen rad och kan inte falla när vakten ändras.
 *
 * `\\p{Lu}` och inte `[A-Z]`: `Ärende` och `Förvaltning` är modellnamn, och
 * med ASCII-klassen sa vakten "invarianten namnger ingen modell" om ett skäl
 * som namnger en — ett falsklarm som BLOCKERAR en legitim klassificering.
 */
export const MODELLNAMN_RE = /(?<![\p{L}\p{N}_$])\p{Lu}\p{L}{3,}(?![\p{L}\p{N}_$])/u

export function harLåsanrop(text, lockKey, låsmetoder) {
  if (låsmetoder.length === 0) return false // ingen härledd form → inget att pröva
  const { strängar } = vyer(text)

  // Nyckeln som literal, direkt i anropet.
  const literal = `['"\`]${rx(lockKey)}['"\`]`
  for (const m of låsmetoder) {
    if (new RegExp(`\\.\\s*${rx(m)}\\s*(?:<[^>]*>)?\\s*\\(\\s*${literal}\\s*,`).test(strängar)) return true
  }

  // …eller via en konstant som binds till nyckeln i SAMMA fil.
  const bindningar = [
    ...strängar.matchAll(new RegExp(`(?:const|let|var)\\s+([\\p{L}\\p{N}_$]+)[^=\\n]*=\\s*${literal}`, 'gu')),
  ].map((m) => m[1])
  for (const namn of bindningar) {
    for (const m of låsmetoder) {
      if (new RegExp(`\\.\\s*${rx(m)}\\s*(?:<[^>]*>)?\\s*\\(\\s*${rx(namn)}\\s*,`).test(strängar)) return true
    }
  }
  return false
}

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
    const re = new RegExp(
      `@Cron\\(([^)]*)\\)[\\s\\S]{0,500}?\\n\\s*(?:private |public )?(?:async )?(${IDENT})\\s*\\(`,
      'gu',
    )
    let m
    // Härleds ur KOD: en utkommenterad @Cron-dekorator är inget jobb, och ett
    // `@Cron` i ett kodexempel i prosa ska inte kräva en klassificering.
    while ((m = re.exec(codeMask(text)))) {
      jobb.push({ nyckel: `${fil}::${m[2]}`, fil, metod: m[2], text })
    }
  }
  return jobb
}

/**
 * De tre vyerna av en filtext, memoiserade per text.
 *
 * Varför inte en enda mask: se huvudkommentaren. R3 letar efter en STRÄNG och
 * R6 efter en KOMMENTAR — en gemensam vy hade gjort minst en av dem omöjlig att
 * uppfylla, vilket är samma tystnad som att göra den alltid uppfylld.
 */
const vyCache = new Map()
export function vyer(text) {
  let v = vyCache.get(text)
  if (!v) {
    v = {
      kod: codeMask(text),
      strängar: blankComments(text),
      kommentarer: tokenize(text)
        .filter((t) => t.kind === 'line-comment' || t.kind === 'block-comment')
        .map((t) => text.slice(t.bodyStart, t.bodyEnd))
        .join('\n'),
    }
    vyCache.set(text, v)
  }
  return v
}

/** Kärnan. Exporterad så självtestet kör exakt samma kod som CI. */
export function evaluate({ jobb, ack, låsmetoder = [] }) {
  const problem = []
  const poster = ack.jobs ?? {}

  // Utan härledda låsmetoder kan R3 inte pröva någonting — och en regel som
  // inte kan pröva något ska vara RÖD, inte tyst grön.
  if (jobb.length > 0 && låsmetoder.length === 0) {
    problem.push({
      rule: 'inga låsmetoder kunde härledas ur lock.service.ts',
      detail:
        'R3 frågar efter anropsformen och har då ingen form att fråga efter. ' +
        'Har LockService bytt filnamn, eller signaturen `key: string` som första ' +
        'parameter? Rätta härledningen — kvittera den inte.',
    })
    return problem
  }

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
      } else if (!harLåsanrop(j.text, post.lockKey, låsmetoder)) {
        problem.push({
          rule: `\`${j.nyckel}\` är klass A men låset ANROPAS aldrig med "${post.lockKey}"`,
          detail:
            'Ett "låst" jobb utan lås är den värsta klassificeringen av alla — den ser ' +
            'säkrast ut och skyddar ingenting. Regeln frågar efter ANROPSFORMEN: nyckeln ' +
            `ska stå som FÖRSTA ARGUMENT till en av låsmetoderna (${låsmetoder.join(', ')}), ` +
            'eller till en konstant som binds till den i samma fil. Att nyckeln NÄMNS i ' +
            'filen räcker inte — en loggrad med nyckeln i är inget lås (#600).',
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
      if (!MODELLNAMN_RE.test(skäl)) {
        problem.push({
          rule: `\`${j.nyckel}\`s invariant namnger ingen modell`,
          detail: 'Skälet ska innehålla modellnamnet, t.ex. `RentNotice` eller `PlatformInvoice`.',
        })
        continue
      }
      // R6 — invarianten ska stå VID jobbet i koden.
      if (!vyer(j.text).kommentarer.includes('KLASSIFICERING: B')) {
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
/**
 * KANARIEFÅGELN FÖR IDENTIFIERARFORMEN (#640).
 *
 * Ett `@Cron` vars metodnamn bär å, ä eller ö. Med `\w` — ASCII — härleddes det
 * INTE ALLS, och utfallet var tystnad: jobbet fanns inte i mängden, båda
 * cron-vakterna förblev gröna, och ingen klassificering krävdes för ett jobb som
 * kör i produktion.
 *
 * Namnet är med FLIT svenskt. Kodbasen namnger redan metoder så (mätt: fyra
 * stycken), och CLAUDE.md föreskriver svenska i allt utom skalvariabler.
 */
const FIL_SVENSKT_NAMN = {
  fil: 'x/svensk.service.ts',
  text: `
  // ── KLASSIFICERING: B — SKYDDAT AV INVARIANT ──
  @Cron('0 3 * * *')
  async städaGammaltUnderlag(): Promise<void> {}`,
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
  // ── #713: DE TVÅ STÄLLEN SOM BYTTES ─────────────────────────────────────
  //
  // Båda är FALSKLARM-riktningen, och båda blockerar en legitim klassificering.
  {
    const f = fail // VAKTENS egen fail — en lokal hade skrivit ❌ utan att fälla
    // (1) BINDNINGEN till låsnyckeln. `const ärendeLås = 'cron:x'` följt av
    //     `withLock(ärendeLås, …)` — namnet härleds med \w och försvann, så
    //     jobbet lästes som OLÅST fast låset finns.
    const lås = ['withLock']
    const medSvenskt = "const ärendeLås = 'cron:x'\nawait this.lock.withLock(ärendeLås, () => 1)"
    if (!harLåsanrop(medSvenskt, 'cron:x', lås))
      f('#713 (1) MISSAD: låsbindning med svensk initial hittas inte — jobbet läses som olåst')
    else console.log('✅ #713 (1) MISSAD: låsbindning med svensk initial hittas')
    const medASCII = "const jobbLas = 'cron:x'\nawait this.lock.withLock(jobbLas, () => 1)"
    if (!harLåsanrop(medASCII, 'cron:x', lås)) f('#713 (1) MOTPROV: ASCII-bindning slutade hittas')
    const utan = "const annat = 'cron:y'\nawait this.lock.withLock(annat, () => 1)"
    if (harLåsanrop(utan, 'cron:x', lås)) f('#713 (1) MOTPROV: en bindning till en ANNAN nyckel räknades')

    // (2) MODELLNAMNET i invariantens skäl. `\b[A-Z][a-zA-Z]{3,}\b` kräver ett
    //     PascalCase-ord. Ett svenskt modellnamn matchar inte:
    //       "unikt index på Ärende(orgId)"        \b[A-Z]… → false   FALSKLARM
    //       "unikt index på Förvaltning(orgId)"                false   FALSKLARM
    //     Vakten säger då "invarianten namnger ingen modell" om ett skäl som
    //     namnger en, och blockerar klassificeringen.
    const modellRe = MODELLNAMN_RE // VAKTENS mönster, inte en kopia — en sond som
    // skriver om regexen mäter sin egen rad och kan inte falla när vakten ändras.
    for (const skäl of ['unikt index på Ärende(orgId)', 'unikt index på Förvaltning(orgId)'])
      if (!modellRe.test(skäl)) f(`#713 (2) MISSAD: svenskt modellnamn känns inte igen — ${JSON.stringify(skäl)}`)
    console.log('✅ #713 (2) MISSAD: svenska modellnamn i invariantens skäl känns igen')
    if (!modellRe.test('unikt index på RentNotice(orgId)'))
      f('#713 (2) MOTPROV: ASCII-modellnamn slutade kännas igen')
    if (modellRe.test('gör inte om det'))
      f('#713 (2) MOTPROV: en mening utan modellnamn godtogs')
    if (modellRe.test('Två ord'))
      f('#713 (2) MOTPROV: ett för kort versalt ord godtogs (tröskeln {3,} tappad)')
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
  const LÅSMETODER = härledLåsmetoder(readFileSync(LOCK_SERVICE, 'utf8'))

  // ── KANARIEFÅGEL: IDENTIFIERARFORMEN (#640) ────────────────────────────────
  //
  // Utan den här slinker ett @Cron med svenskt metodnamn igenom OSYNLIGT — inte
  // ofullständigt mätt utan INTE MÄTT. Omfångsgolvet fångar det inte; det fäller
  // bara om mängden nästan försvinner, inte om den tappar ETT jobb.
  const svenska = findCronJobs([FIL_SVENSKT_NAMN])
  if (svenska.length === 1 && svenska[0].metod === 'städaGammaltUnderlag') {
    console.log('✅ härleder ett @Cron med svenskt metodnamn (städaGammaltUnderlag)')
  } else {
    fail(
      `IDENTIFIERARFORM: ett @Cron med å/ä/ö härleddes inte — ` +
        `fick ${svenska.length} jobb (${svenska.map((j) => j.metod).join(',') || 'inga'}). ` +
        `Är regexen tillbaka på \\w (ASCII)?`,
    )
  }
  // …och det ska KRÄVA en klassificering som alla andra, inte bara synas.
  //
  // ⚠️ ACKEN ÄR ICKE-TOM, OCH REGELN NAMNGES. Första lydelsen skickade
  // `{ jobs: {} }` och lät `röd()` acceptera vilken regel som helst. Den var grön
  // — men i negativkontrollen (IDENT tillbaka till `\w`) blev den grön av FEL
  // regel: med noll härledda jobb fällde "NOLL @Cron-jobb härleddes" i stället,
  // och provet såg ut att hålla medan det mätte något annat. Ett prov som kan bli
  // grönt av en annan orsak än sin egen mäter inte det dess namn påstår.
  röd(
    'ett svensknamngivet @Cron utan klassificering fälls',
    evaluate({
      jobb: svenska,
      ack: { jobs: { 'x/annan.service.ts::annat': { class: 'B', invariant: 'x' } } },
      låsmetoder: LÅSMETODER,
    }),
    'saknar klassificering',
  )
  const bas = { jobb, ack: ACK_OK, låsmetoder: LÅSMETODER }

  // ── DEN DELADE SKANNERNS KANARIEFÅGLAR (metavaktens R2) ──────────────────
  const skanner = kanariefåglar()
  if (skanner.length) fail(`DEN DELADE SKANNERN ÄR TRASIG: ${skanner.join(' | ')}`)
  else console.log(`✅ delad skanner: kanariefåglarna gröna över ${KANARIEFÅGEL_LÄGEN.length} lägen`)

  // ── VYERNAS SEMANTIK ─────────────────────────────────────────────────────
  //
  // Tre prov, ett per vy. Alla tre var fel i råtextversionen.
  {
    // R3, den farliga: låsnyckeln nämnd bara i en KOMMENTAR. Ett "låst" jobb
    // vars enda lås är ett PÅSTÅENDE om ett lås.
    const påstårLås = {
      fil: 'x/a.service.ts',
      text: `
  // körs under låset 'cron:a' — se LockService
  @Cron('0 1 * * *')
  async jobbA(): Promise<void> {
    await this.jobbAUnsafe()
  }`,
    }
    röd(
      'VY: låsnyckeln nämnd bara i en KOMMENTAR är inget lås',
      evaluate({ jobb: findCronJobs([påstårLås]), ack: ACK_OK, låsmetoder: LÅSMETODER }),
      'låset ANROPAS aldrig',
    )

    // R1: en utkommenterad dekorator är inget jobb — annars kräver vakten en
    // klassificering av kod som inte körs.
    grön(
      'VY: en UTKOMMENTERAD @Cron är inget jobb',
      (() => {
        const j = findCronJobs([
          ...[FIL_A, FIL_B],
          { fil: 'x/d.service.ts', text: "  // @Cron('0 3 * * *')\n  // async jobbD(): Promise<void> {}" },
        ])
        if (j.length !== 2) fail(`VY: härledningen gav ${j.length} jobb, väntade 2`)
        return evaluate({ jobb: j, ack: ACK_OK, låsmetoder: LÅSMETODER })
      })(),
    )

    // R6: markören i en STRÄNG är inte markören. Den ska stå som kommentar
    // VID jobbet, vilket är hela poängen med regeln.
    röd(
      'VY: `KLASSIFICERING: B` i en STRÄNG uppfyller inte R6',
      evaluate({
        ...bas,
        jobb: [
          jobb[0],
          {
            ...jobb[1],
            text: `const d = 'KLASSIFICERING: B'\n  @Cron('0 2 * * *')\n  async jobbB() {}`,
          },
        ],
      }),
      'saknar invarianten i KODEN',
    )
  }

  // ── KANARIEFÅGEL 1: härledningen måste ge utslag på känd indata ──────────
  if (jobb.length !== 2 || jobb[0].metod !== 'jobbA' || jobb[1].metod !== 'jobbB') {
    fail(`kanariefågel: härledningen gav ${JSON.stringify(jobb.map((j) => j.metod))}, väntade jobbA + jobbB`)
  } else console.log('✅ kanariefågel: härledningen hittar båda jobben i fixturen')

  // ── KANARIEFÅGEL 2: mot den RIKTIGA källan ──────────────────────────────
  const riktiga = findCronJobs(
    källfiler().map((p) => ({ fil: relative(SRC, p), text: readFileSync(p, 'utf8') })),
  )
  // ── #600: DE TRE NEGATIVA KONTROLLERNA ──────────────────────────────────
  //
  // Den FÖRSTA är hela ärendet. Faller den inte är ingenting byggt: det var
  // exakt det fallet som passerade tyst före den här ändringen.
  {
    const metoder = härledLåsmetoder(readFileSync(LOCK_SERVICE, 'utf8'))
    const NYCKEL = 'cron:qqlock-prov'
    const äkta =
      `  @Cron('0 9 * * *')\n` +
      `  async jobb(): Promise<void> {\n` +
      `    const result = await this.locks.runIfUnlocked(\n` +
      `      '${NYCKEL}',\n` +
      `      () => this.jobbUnsafe(),\n` +
      `      { ttlSec: 3600 },\n` +
      `    )\n` +
      `    if (!result.ran) this.logger.warn('[${NYCKEL}] Kördes redan av en annan replik.')\n` +
      `  }`
    // 1. Låsanropet borta — men loggraden med nyckeln står kvar. DEN TROLIGA
    //    refaktoreringen, och den som slapp igenom före #600.
    const baraLogg = äkta.replace(`      '${NYCKEL}',\n`, `      'cron:nagot-annat',\n`)
    // 2. Nyckeln helt borta.
    const heltBorta = äkta.replaceAll(NYCKEL, 'cron:nagot-annat')

    const prov = [
      ['#600 (1) låsanropet borta, nyckeln kvar i en LOGGSTRÄNG → ska fälla', baraLogg, false],
      ['#600 (2) låsanropet borta, nyckeln helt borta → ska fälla', heltBorta, false],
      ['#600 (3) äkta låsanrop → ska vara tyst', äkta, true],
    ]
    for (const [namn, text, väntat] of prov) {
      const har = harLåsanrop(text, NYCKEL, metoder)
      if (har !== väntat) fail(`${namn} — fick ${har ? 'TYST' : 'FÄLLER'}`)
      else console.log(`✅ ${namn}`)
    }
    // Och att prov 1 verkligen BÄR nyckeln — annars mäter det inget.
    const kvar = baraLogg.split(NYCKEL).length - 1
    if (kvar !== 1) fail(`#600 (1): sonden bär ${kvar} förekomster av nyckeln, väntade 1 (loggraden)`)
    else console.log(`✅ #600 (1): sonden bär nyckeln ${kvar} gång — i loggraden, inte i anropet`)

    // Konstantformen ska också godtas: en regel som fäller den vore ett
    // falsklarm som väntar på att hända.
    const viaKonstant =
      `const QQ_LAS = '${NYCKEL}'\n` +
      `  async jobb() { await this.locks.runIfUnlocked(QQ_LAS, () => this.x(), { ttlSec: 60 }) }`
    if (!harLåsanrop(viaKonstant, NYCKEL, metoder)) fail('#600: nyckeln via en KONSTANT fälls — falsklarm')
    else console.log('✅ #600: nyckeln via en konstant i samma fil godtas')
  }

  // ── #600: FALSKLARM ÄR VÄRRE ÄN VANLIGT HÄR ─────────────────────────────
  //
  // En cron-vakt som larmar på legitim kod blir avstängd, och då är ALLA jobb
  // oskyddade. Talet skrivs ut: noll falsklarm är ett påstående som ska gå att
  // läsa av, inte något man litar på.
  {
    const metoder = härledLåsmetoder(readFileSync(LOCK_SERVICE, 'utf8'))
    const ack = JSON.parse(readFileSync(ACK_FILE, 'utf8'))
    const aJobb = Object.entries(ack.jobs ?? {}).filter(([, v]) => v.class === 'A')
    let godkända = 0
    const falsklarm = []
    for (const [nyckel, v] of aJobb) {
      const fil = join(SRC, ...nyckel.split('::')[0].split('/'))
      if (harLåsanrop(readFileSync(fil, 'utf8'), v.lockKey, metoder)) godkända++
      else falsklarm.push(`${v.lockKey} (${nyckel.split('::')[0]})`)
    }
    // Alla låsanrop i trädet, inte bara cron-jobbens — regeln får inte heller
    // ändra betydelse för dem.
    const anropsRe = new RegExp(`\\.\\s*(${metoder.join('|')})\\s*\\(`, 'g')
    let alla = 0
    for (const f of källfiler()) alla += (codeMask(readFileSync(f, 'utf8')).match(anropsRe) ?? []).length

    if (falsklarm.length) fail(`#600 FALSKLARM på legitim kod: ${falsklarm.join(', ')}`)
    else
      console.log(
        `✅ #600 falsklarm: 0 av ${aJobb.length} legitima klass-A-lås fälls ` +
          `(${alla} låsanrop totalt i koden, ${metoder.length} härledda låsmetoder: ${metoder.join(', ')})`,
      )
    // Omfång: mängderna får inte krympa tyst. MÄTT mot 084363b: 2 låsmetoder,
    // 7 klass-A-jobb, 8 låsanrop i icke-spec-kod (27 om specar räknas med).
    if (metoder.length < 2) fail(`omfång: ${metoder.length} härledda låsmetoder, golv 2`)
    if (aJobb.length < 4) fail(`omfång: ${aJobb.length} klass-A-jobb, golv 4`)
    // MÄTT mot samma mängd som räknas: källfiler() UTESLUTER specar, så talet är
    // 8 — inte de 27 man får om man räknar alla .ts. Ett golv mätt mot en annan
    // mängd än den man asserterar på är ett golv som fäller av fel skäl.
    if (alla < 5) fail(`omfång: ${alla} låsanrop i icke-spec-kod, golv 5`)
  }

  // OMFÅNGSGOLV, inte "fler än noll". En härledning som krympt från 25 till 2
  // mäter nästan ingenting men klarar ett nollgolv — och de 25 är just talet
  // som en gång visade att den handskrivna listan om 21 var fel.
  // MÄTT mot e9aea18: 447 källfiler, 25 @Cron-jobb.
  const MIN_KÄLLFILER = 300
  const MIN_CRONJOBB = 15
  const antalKällfiler = källfiler().length
  if (antalKällfiler < MIN_KÄLLFILER) {
    fail(`omfång: ${antalKällfiler} källfiler skannade, golv ${MIN_KÄLLFILER}`)
  } else if (riktiga.length < MIN_CRONJOBB) {
    fail(
      `omfång: ${riktiga.length} @Cron-jobb härledda ur den riktiga källan, golv ` +
        `${MIN_CRONJOBB} — skanningen har gått blind eller mängden har krympt`,
    )
  } else {
    console.log(
      `✅ omfång: ${antalKällfiler} källfiler (golv ${MIN_KÄLLFILER}), ` +
        `${riktiga.length} @Cron-jobb härledda (golv ${MIN_CRONJOBB})`,
    )
  }

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
    'låset ANROPAS aldrig',
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
  const låsmetoder = härledLåsmetoder(readFileSync(LOCK_SERVICE, 'utf8'))
  const problem = evaluate({ jobb, ack, låsmetoder })

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

/**
 * CLI-skyddet är inte kosmetik: filen EXPORTERAR `findCronJobs`, och utan det
 * här körde hela vakten som en bieffekt av att någon importerade härledningen.
 * Uppmätt när `check-cron-error-sink.mjs` importerade den — den andra vaktens
 * utskrift dök upp mitt i den förstas självtest.
 */
const körsDirekt = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (körsDirekt) main()
