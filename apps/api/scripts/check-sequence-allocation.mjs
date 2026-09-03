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
import {
  codeMask,
  blankComments,
  kanariefåglar,
  KANARIEFÅGEL_LÄGEN,
} from '../../../scripts/lib/source-scan.mjs'
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
  // Klammervandringen körs mot codeMask. Ett `'{'` eller `'}'` i en
  // stränglitteral flyttade annars funktionsgränsen, och R3:s fråga "innehåller
  // ALLOKERARFUNKTIONEN en count()" besvarades mot fel kropp — åt båda hållen:
  // för stor kropp ger falsklarm på en grannmetod, för liten döljer defekten.
  // Masken bevarar längd och radbrytningar, så `start` och radnumren stämmer.
  text = codeMask(text)
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
      let isFunction =
        /\bfunction\b/.test(header) ||
        /=>\s*$/.test(header) ||
        /\b[\w$]+\s*\([^)]*\)\s*(:[^{]*)?$/.test(header)

      // FLERRADIG SIGNATUR. De tre proven ovan läser EN rad. Bryts parameter-
      // listan över flera rader står bara `): Promise<string> {` kvar på raden
      // med klammern — inget namn, ingen öppningsparentes — så ingen av dem
      // matchar, vandringen fortsätter utåt förbi klassen, och R3 får HELA
      // FILEN som kropp. Uppmätt på en fyrradig signatur: kropp 192 av 192
      // tecken, och grannmetodens count() fällde allokeraren.
      //
      // Felet är ett falsklarm, inte en tystnad, men det är samma blindhet som
      // den filbreda R3:an hade — och inget prov stod emot det: fixturen
      // "count() i en GRANNMETOD" har enradig signatur och kan inte nå hit.
      // Namnet står på raden där `(` öppnades; balansera bakåt dit och ställ
      // samma fråga där.
      // `(:.*)?$` och inte `(:[^{]*)?$`: returtypen kan själv innehålla en
      // objekttyp — `): Promise<{ invoiceNumber: string }> {` — och den
      // uteslutningen gjorde parsern blind för allocateInvoiceNumber, som låg
      // i trädet redan. Raden kan ändå inte förväxlas med ett blockslut: den
      // måste BÖRJA med `)`, vilket `  })` inte gör.
      if (!isFunction && /^\s*\)\s*(:.*)?$/.test(header)) {
        let d = 0
        for (let j = lineStart + header.indexOf(')'); j >= 0; j--) {
          if (text[j] === ')') d++
          else if (text[j] === '(') {
            d--
            if (d === 0) {
              const sigStart = text.lastIndexOf('\n', j) + 1
              const sigHeader = text.slice(sigStart, j)
              isFunction = /\bfunction\b/.test(sigHeader) || /\b[\w$]+\s*$/.test(sigHeader)
              break
            }
          }
        }
      }
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
  // Kommentarerna bort — en UTKOMMENTERAD modell är ingen modell, och skulle
  // annars kräva en anropsplats som inte finns. `blankComments` och inte
  // `codeMask`: schemat är inte TypeScript, och den enda region vi vill bli av
  // med är kommentaren. Mätt: rå, blankComments och codeMask ger i dag samma
  // åtta modeller — bytet ändrar inget utfall, bara vad som KAN hända.
  schemaText = blankComments(schemaText)
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

  // ALLA tre reglerna frågar KOD. Före migreringen läste R1 råtext (en
  // utkommenterad `.upsert(` räknades som en anropsplats och kunde uppfylla
  // R2:s krav på exakt en), sliceCall räknade parenteser utan strängkännedom,
  // och R3 filtrerade bort kommentarer med en egen radregex — som bara kände
  // rader som BÖRJAR med `*` eller `//`, alltså inte en efterhängd kommentar.
  const kod = codeMask(text)

  for (const model of models) {
    const accessor = accessorOf(model)
    // \b…\. binder till accessorn: `tx.invoiceNumberSequence.upsert(` matchar,
    // men `tx.invoice.` gör det inte — och omvänt matchar `.invoice.` aldrig
    // sekvensmodellen, så en modell som är prefix till en annan blir inte
    // förväxlad.
    const re = new RegExp(`\\b${accessor}\\s*\\.\\s*(\\w+)\\s*\\(`, 'g')
    let m
    while ((m = re.exec(kod))) {
      const method = m[1]
      const line = lineOf(kod, m.index)
      callSites.push({ model, file: relPath, line, method, idx: m.index })
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

      const call = sliceCall(kod, kod.indexOf('(', m.index + m[0].length - 1))
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
      // Ingen egen kommentarfiltrering längre. `enclosingFunction` returnerar
      // en kropp ur codeMask, så kommentarerna är redan blanka — inklusive de
      // efterhängda, som den gamla radregexen (`^\s*(\*|\/\/)`) inte kunde se.
      if (!/\.count\s*\(|\.aggregate\s*\(|\b_max\b/.test(ln)) return
      violations.push({
        line: lineOf(kod, start) + i,
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

/**
 * R4 — ALLOKERAREN TAR SIN TRANSAKTION AV TYPEN, INTE AV VANA.
 *
 * R1–R3 prövar upsertens FORM. Ingen av dem kan se om anroparen omsluter den:
 * ett `Sequence`-anrop på poolen uppfyller alla tre. Uppmätt i #M3 var det
 * fyra av åtta serier som hade minst en pool-väg, i fyra olika former:
 *
 *   1. POOLEN SKICKAD        allocateRentNoticeNumber(this.prisma, …)
 *   2. HÅRDKOPPLAD           upserten läser this.prisma direkt i allokeraren
 *   3. VALFRI TX             allocate(tx?: Prisma.TransactionClient) med
 *                            `tx ?? this.prisma` som reserv
 *   4. UTELÄMNAD PÅ EN AV N  tre anropsplatser skickade tx, den fjärde inte
 *
 * Form 3 är den tysta: signaturen ser säker ut, och bara den som läser
 * anropsplatsen ser att reserven används. Form 4 är dess följd — den är möjlig
 * bara därför att form 3 finns, och faller därför bort när form 3 spärras.
 *
 * Regeln, i fyra led:
 *   R4.1  allokerarens signatur har en parameter av typ Prisma.TransactionClient
 *   R4.2  den parametern är INTE valfri (`tx?:`)
 *   R4.3  upserten skriver på DEN parametern, inte på `this.<något>`
 *   R4.4  ingen anropsplats skickar `this.<något>` i den parameterns position,
 *         och ingen utelämnar den
 *
 * ── VAD DEN INTE KAN SE ─────────────────────────────────────────────────────
 *
 * Den läser TYPEN och ANROPSPLATSENS UTTRYCK. Den kan inte se om den
 * transaktion vars klient skickas in faktiskt omsluter inserten av raden
 * numret hör till: en `$transaction` som allokerar och sedan skriver raden
 * UTANFÖR sig själv passerar R4 utan anmärkning. Den egenskapen bärs av
 * `rent-notice-number.db.spec.ts`, som rullar tillbaka en riktig transaktion
 * mot riktig Postgres och kräver att sekvensen är oförändrad efteråt.
 *
 * Den kan inte heller se ett dynamiskt anrop (`obj[namn](…)`) eller en
 * allokerare som nås via ett alias.
 */
export function checkAllocatorTxTyping(filer, callSites) {
  const violations = []
  const sedda = new Set()

  for (const site of callSites) {
    if (site.method !== 'upsert') continue
    const fil = filer.find((f) => f.rel === site.file)
    if (!fil) continue
    const nyckel = `${site.file}:${site.line}`
    if (sedda.has(nyckel)) continue
    sedda.add(nyckel)

    const kod = codeMask(fil.text)
    const { start } = enclosingFunction(kod, site.idx)
    const info = allocatorInfo(kod, start)
    if (!info) {
      violations.push({
        file: site.file,
        line: site.line,
        rule: 'R4: kunde inte läsa allokerarens signatur',
        detail:
          'En regel som inte hittar sitt mätobjekt mäter ingenting. Står ' +
          'allokeringen på toppnivå eller i en form parsern inte känner ska ' +
          'den flyttas in i en namngiven funktion.',
      })
      continue
    }

    // R4.3 — vem skriver upserten på?
    const klient = klientUttryck(kod, site.idx)
    if (klient && /^this\b/.test(klient)) {
      violations.push({
        file: site.file,
        line: site.line,
        rule: `R4: allokeraren skriver på ${klient}, inte på en transaktionsklient`,
        detail:
          'Sekvensen ökas då på poolen. Ett fel i inserten av raden numret hör ' +
          'till kan inte längre rulla tillbaka ökningen — numret är förbrukat. ' +
          'Ta klienten som obligatoriskt argument (Prisma.TransactionClient).',
      })
    }

    // En allokerare som äger sin egen transaktion har ingen anropsplats att
    // ställa krav på — R4.3 ovan är hela regeln för den.
    if (info.egenTransaktion) continue

    // R4.1 / R4.2 — signaturen
    if (info.txIndex === -1) {
      violations.push({
        file: site.file,
        line: site.line,
        rule: `R4: ${info.namn}() saknar en parameter av typ Prisma.TransactionClient`,
        detail:
          'Kravet på transaktion ska bäras av typen, inte av en mening i ett ' +
          'docblock. Utan parametern finns ingen väg att skicka in den.',
      })
      continue
    }
    if (info.valfri) {
      violations.push({
        file: site.file,
        line: site.line,
        rule: `R4: ${info.namn}() tar transaktionsklienten som VALFRI (${info.txNamn}?:)`,
        detail:
          'En valfri transaktion är den tysta varianten av felet: signaturen ' +
          'ser säker ut, reserven används på anropsplatsen, och ingen får veta. ' +
          'Gör parametern obligatorisk — då avvisar tsc den utelämnande ' +
          'anropsplatsen åt oss.',
      })
    }

    // R4.4 — anropsplatserna
    violations.push(...anroparePasserarPoolen(filer, info, site))
  }

  return violations
}

/** Uttrycket omedelbart före `.<accessor>` på en upsert-rad. */
function klientUttryck(kod, idx) {
  const radStart = kod.lastIndexOf('\n', idx) + 1
  const före = kod.slice(radStart, idx)
  const m = före.match(/([\w$.]+)\s*\.\s*$/)
  return m ? m[1] : null
}

/**
 * Läs allokerarens namn, parameterlista och ägande klass, givet indexet för
 * dess öppningsklammer. Signaturen ligger FÖRE klammern; parameterlistan
 * balanseras bakåt så att en flerradig signatur läses lika bra som en enradig.
 */
export function allocatorInfo(kod, start) {
  let d = 0
  let parenClose = -1
  for (let j = start; j >= 0; j--) {
    if (kod[j] === ')') {
      parenClose = j
      break
    }
  }
  // Notera att `{` INTE avbryter. Returtypen kan innehålla en objekttyp —
  // `): Promise<{ invoiceNumber: string }> {` — och en avbrytande klammer
  // gjorde parsern blind för exakt den signaturen. Den låg i trädet redan
  // (invoice-number.ts), så felet syntes direkt som "kunde inte läsa
  // signaturen"; att låta det passera hade varit värre.
  if (parenClose === -1) return null
  let parenOpen = -1
  for (let j = parenClose; j >= 0; j--) {
    if (kod[j] === ')') d++
    else if (kod[j] === '(') {
      d--
      if (d === 0) {
        parenOpen = j
        break
      }
    }
  }
  if (parenOpen === -1) return null

  const params = kod.slice(parenOpen + 1, parenClose)
  const föreNamn = kod.slice(Math.max(0, parenOpen - 200), parenOpen)
  const nm = föreNamn.match(/([\w$]+)\s*$/)
  if (!nm) return null
  const namn = nm[1]

  const delar = splitTopLevel(params)
  let txIndex = -1
  let txNamn = null
  let valfri = false
  delar.forEach((p, i) => {
    if (!/Prisma\s*\.\s*TransactionClient/.test(p)) return
    if (txIndex !== -1) return
    txIndex = i
    const pm = p.match(/([\w$]+)\s*(\?)?\s*:/)
    txNamn = pm ? pm[1] : null
    valfri = Boolean(pm && pm[2])
  })

  // Öppnar allokeraren sin EGEN transaktion? Då är den inbyggda arrow-
  // funktionens `tx` klienten, det finns ingen anroparkontrakt att pröva, och
  // R4.1/R4.2/R4.4 har inget mätobjekt. R4.3 gäller fortfarande: skrivningen
  // måste gå på arrow-parametern och inte på this.prisma. Mönstret är
  // legitimt och används av ocr.service.ts.
  const egenTransaktion = /\$transaction\s*\(\s*(async\s*)?$/.test(
    kod.slice(Math.max(0, parenOpen - 80), parenOpen),
  )

  // Obligatorisk aritet: parametrar utan `?` och utan default. Behövs för att
  // se form 4 — ett anrop som utelämnar transaktionsklienten HAR ett argument i
  // dess position (nästa parameters), så "saknas" går inte att se på positionen
  // ensam. Antalet argument mot antalet krävda parametrar ser det.
  const minArity = delar.filter((d) => !/[\w$]\s*\?\s*:/.test(d) && !/=/.test(d)).length

  return {
    namn,
    params,
    txIndex,
    txNamn,
    valfri,
    minArity,
    egenTransaktion,
    klass: ägandeKlass(kod, parenOpen),
    arity: delar.length,
  }
}

/** Namnet på klassen vars kropp omsluter `idx`, eller null för en fri funktion. */
function ägandeKlass(kod, idx) {
  const re = /\bclass\s+([\w$]+)[^{]*\{/g
  let m
  let träff = null
  while ((m = re.exec(kod))) {
    const öppning = kod.indexOf('{', m.index)
    let d = 0
    for (let j = öppning; j < kod.length; j++) {
      if (kod[j] === '{') d++
      else if (kod[j] === '}') {
        d--
        if (d === 0) {
          if (öppning < idx && idx < j) träff = m[1]
          break
        }
      }
    }
  }
  return träff
}

/** Dela en parameter-/argumentlista på toppnivåns kommatecken. */
export function splitTopLevel(text) {
  const ut = []
  let d = 0
  let cur = ''
  for (const ch of text) {
    if ('([{<'.includes(ch)) d++
    else if (')]}>'.includes(ch)) d--
    if (ch === ',' && d === 0) {
      ut.push(cur.trim())
      cur = ''
      continue
    }
    cur += ch
  }
  if (cur.trim()) ut.push(cur.trim())
  return ut
}

/**
 * R4.4 — leta anropsplatser för allokeraren och pröva argumentet i
 * transaktionsklientens position.
 *
 * En metod nås som `this.<prop>.<namn>(`, där `<prop>` deklareras med
 * allokerarklassens typ i den anropande filen. En fri funktion nås på sitt
 * namn. Båda formerna läses ur codeMask, så ett anrop i en kommentar eller i
 * en sträng aldrig kan uppfylla eller bryta regeln.
 */
function anroparePasserarPoolen(filer, info, allokerarSite) {
  const violations = []
  for (const fil of filer) {
    const kod = codeMask(fil.text)
    const mönster = []
    if (info.klass) {
      const propRe = new RegExp(
        `(?:readonly|private|public|protected)\\s+([\\w$]+)\\s*:\\s*${info.klass}\\b`,
        'g',
      )
      let pm
      while ((pm = propRe.exec(kod))) {
        mönster.push(new RegExp(`\\bthis\\s*\\.\\s*${pm[1]}\\s*\\.\\s*${info.namn}\\s*\\(`, 'g'))
      }
    } else {
      mönster.push(new RegExp(`(?<![\\p{L}\\p{N}_$.])${info.namn}\\s*\\(`, 'gu'))
    }

    for (const re of mönster) {
      let m
      while ((m = re.exec(kod))) {
        const öppning = kod.indexOf('(', m.index + m[0].length - 1)
        // definitionen själv är ingen anropsplats
        if (
          fil.rel === allokerarSite.file &&
          /\b(function|async)\s*$/.test(kod.slice(Math.max(0, m.index - 20), m.index))
        )
          continue
        let d = 0
        let slut = -1
        for (let j = öppning; j < kod.length; j++) {
          if (kod[j] === '(') d++
          else if (kod[j] === ')') {
            d--
            if (d === 0) {
              slut = j
              break
            }
          }
        }
        if (slut === -1) continue
        const args = splitTopLevel(kod.slice(öppning + 1, slut))
        const line = lineOf(kod, m.index)
        // definitionsraden (parametrar, inte argument) hoppas över
        if (args.some((a) => /Prisma\s*\.\s*TransactionClient/.test(a))) continue

        const arg = args[info.txIndex]
        if (args.length < info.minArity) {
          violations.push({
            file: fil.rel,
            line,
            rule: `R4: ${info.namn}() anropas med ${args.length} argument, ${info.minArity} krävs`,
            detail:
              'Transaktionsklienten är utelämnad. Det är den form som uppstår ' +
              'när EN av flera anropsplatser missas — de andra ser rätt ut, och ' +
              'ingenting blir rött förrän numret bränns i produktion.',
          })
        } else if (arg === undefined) {
          violations.push({
            file: fil.rel,
            line,
            rule: `R4: ${info.namn}() anropas utan transaktionsklient`,
            detail:
              'Argumentet i transaktionsklientens position saknas, så ' +
              'allokeringen hamnar på reserven. Skicka tx från den ' +
              '$transaction som skriver raden numret hör till.',
          })
        } else if (/^this\b/.test(arg)) {
          violations.push({
            file: fil.rel,
            line,
            rule: `R4: ${info.namn}() anropas med ${arg} i transaktionsklientens position`,
            detail:
              'Det är poolen, inte en transaktion. Sekvensökningen kan då inte ' +
              'rulla tillbaka med inserten av raden numret hör till.',
          })
        }
      }
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
    // Flerradig signatur DÄR RETURTYPEN INNEHÅLLER `{`. Den formen låg redan i
    // trädet (allocateInvoiceNumber) och gjorde parsern blind.
    'flerradig signatur med objekttyp i returtypen',
    `export async function allocateInvoiceNumber(
  tx,
  organizationId,
) {
  const row = await tx.invoiceNumberSequence.upsert({
    where: { organizationId },
    create: { organizationId, lastNumber: 1 },
    update: { lastNumber: { increment: 1 } },
  })
  return { invoiceNumber: row.lastNumber }
}

async function annan(organizationId) {
  return this.prisma.invoice.count({ where: { organizationId } })
}`,
  ],
  [
    // Samma form som fixturen nedan, men med FLERRADIG signatur — den form som
    // gjorde enclosingFunction blind och gav R3 hela filen som kropp.
    // Enradsfixturen kan inte nå den vägen, så utan det här provet är
    // lagningen oprövad.
    'count() i en grannmetod när allokeraren har FLERRADIG signatur',
    `class S {
  private async generateTicketNumber(
    tx,
    organizationId,
  ) {
    const row = await tx.tenantOcrSequence.upsert({
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
    // Motprovet till GOOD-fixturen ovan: lagningen får inte göra kroppen för
    // LITEN heller. En count() i allokerarens EGEN flerradiga kropp ska fälla.
    'count() i SAMMA funktion, FLERRADIG signatur',
    `async function allocate(
  tx,
  organizationId,
) {
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

  // ── DEN DELADE SKANNERNS KANARIEFÅGLAR (metavaktens R2) ───────────────────
  const skanner = kanariefåglar()
  if (skanner.length) fail(`DEN DELADE SKANNERN ÄR TRASIG: ${skanner.join(' | ')}`)
  else
    console.log(`✅ delad skanner: kanariefåglarna gröna över ${KANARIEFÅGEL_LÄGEN.length} lägen`)

  // ── MASKENS SEMANTIK ──────────────────────────────────────────────────────
  //
  // Fyra prov, alla fel i råtextversionen.
  {
    const p = (namn, kod, väntadRöd, regel) => {
      const { violations } = scanSource(kod, 'mask.ts', MODELS)
      const röd = violations.length > 0
      if (röd !== väntadRöd) {
        fail(`MASK: ${namn} → ${röd ? 'RÖD' : 'GRÖN'}, väntade ${väntadRöd ? 'RÖD' : 'GRÖN'}`)
      } else if (röd && regel && !violations.some((v) => v.rule.includes(regel))) {
        fail(`MASK: ${namn} fälldes av FEL regel: ${violations[0].rule}`)
      } else console.log(`✅ MASK: ${namn}`)
    }

    // R1: en utkommenterad anropsplats är ingen anropsplats. Den räknades förr
    // in i callSites och kunde uppfylla R2:s krav på exakt en — alltså dölja
    // att den RIKTIGA allokeraren saknades.
    p(
      'en UTKOMMENTERAD sekvensskrivning är ingen anropsplats',
      '// await tx.tenantOcrSequence.upsert({ where: { organizationId }, update: { lastNumber: { increment: 1 } } })',
      false,
    )

    // R1: `increment:` fick inte kunna intygas av en kommentar inne i anropet.
    p(
      '`increment` bara i en KOMMENTAR inne i upsert:en',
      `await tx.tenantOcrSequence.upsert({\n  where: { organizationId },\n  // update: { lastNumber: { increment: 1 } }\n  update: { lastNumber: nästa },\n  create: { organizationId },\n})`,
      true,
      'utan { lastNumber: { increment: N } }',
    )

    // sliceCall: ett `)` i en stränglitteral stängde anropet för tidigt, så
    // `increment:` efter den punkten blev osynligt — falsklarm på legitim kod.
    p(
      'ett `)` i en sträng stänger inte upsert-anropet',
      `await tx.tenantOcrSequence.upsert({ where: { organizationId, label: 'serie (ocr)' }, update: { lastNumber: { increment: 1 } }, create: { organizationId } })`,
      false,
    )

    // R3: den gamla radregexen kände bara rader som BÖRJAR med * eller //.
    // En efterhängd kommentar som nämner count() gav därför falsklarm.
    p(
      'en EFTERHÄNGD kommentar som nämner count() är inget anrop',
      `async function alloc(tx) {\n  const n = await tx.tenantOcrSequence.upsert({ where: { organizationId }, update: { lastNumber: { increment: 1 } }, create: { organizationId } }) // förr: .count()\n  return n\n}`,
      false,
    )
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
  if (derived.includes('NotASequenceAtAll'))
    fail('härledning: en modell utan Sequence-suffix togs med')

  // ── KANARIEFÅGEL 2: härledningen mot det RIKTIGA schemat ──────────────────
  // Fixturen ovan bevisar att parsern fungerar; den här bevisar att den pekar
  // på verkligheten. Går schemat inte att läsa, eller byter det form, ska
  // guarden falla i stället för att tyst mäta noll modeller.
  // OMFÅNGSGOLV, inte "fler än noll": en härledning som krympt från 8 modeller
  // till 1 mäter nästan ingenting men klarar ett nollgolv. Talen är MÄTTA mot
  // e9aea18: 447 källfiler, 8 sekvensmodeller, 8 anropsplatser.
  const MIN_KÄLLFILER = 300
  const MIN_MODELLER = 5
  const MIN_ANROPSPLATSER = 5
  const real = deriveSequenceModels(readFileSync(SCHEMA, 'utf8'))
  const alla = [...walk(SRC_DIR)]
  const riktigaAnrop = alla.flatMap(
    (f) => scanSource(readFileSync(f, 'utf8'), relative(REPO_ROOT, f), real).callSites,
  )
  if (alla.length < MIN_KÄLLFILER) {
    fail(`omfång: ${alla.length} källfiler skannade, golv ${MIN_KÄLLFILER}`)
  } else if (real.length < MIN_MODELLER) {
    fail(
      `omfång: ${real.length} sekvensmodeller härledda ur schema.prisma, golv ${MIN_MODELLER} ` +
        '— parsern har gått blind eller schemat bytt form',
    )
  } else if (riktigaAnrop.length < MIN_ANROPSPLATSER) {
    fail(
      `omfång: ${riktigaAnrop.length} anropsplatser i KOD, golv ${MIN_ANROPSPLATSER} ` +
        '— R1 och R3 loopar över nästan tomhet',
    )
  } else {
    console.log(
      `✅ omfång: ${alla.length} källfiler (golv ${MIN_KÄLLFILER}), ${real.length} sekvensmodeller ` +
        `(golv ${MIN_MODELLER}), ${riktigaAnrop.length} anropsplatser (golv ${MIN_ANROPSPLATSER})`,
    )
  }

  // ── R1/R3: inga falsklarm på legitim kod ──────────────────────────────────
  for (const [label, code] of GOOD) {
    const { violations } = scanSource(code, `good:${label}`, MODELS)
    if (violations.length !== 0)
      fail(`FALSKLARM på legitim kod: "${label}" → ${violations.map((v) => v.rule).join(', ')}`)
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
  if (zero.length === 0)
    fail('R2 fällde inte NOLL anropsplatser — en blind skanning skulle passera')
  else console.log(`✅ R2 fäller noll anropsplatser (${zero[0].rule})`)

  const one = checkOneCallSitePerModel(
    ['X'],
    [{ model: 'X', file: 'a.ts', line: 1, method: 'upsert' }],
  )
  if (one.length !== 0) fail('R2 falsklarmade på exakt EN anropsplats')
  else console.log('✅ R2 släpper igenom exakt en anropsplats')

  // ── R4: DE FYRA FORMERNA ──────────────────────────────────────────────────
  //
  // Varje form är en verklig kodform som fanns i trädet före #M3, inte en
  // påhittad. Alla fyra ska ge minst en R4-anmärkning; den femte fixturen ska
  // ge NOLL, annars mäter regeln inte skillnaden utan bara närvaro.
  {
    const R4_MODELS = ['TenantOcrSequence']
    const kör = (filer) => {
      const cs = []
      for (const f of filer) cs.push(...scanSource(f.text, f.rel, R4_MODELS).callSites)
      return checkAllocatorTxTyping(filer, cs)
    }

    const FORM_1_POOLEN = [
      {
        rel: 'a.ts',
        text: `export async function allocateOcr(tx: Prisma.TransactionClient, orgId: string) {
  return tx.tenantOcrSequence.upsert({ where: { orgId }, update: { lastNumber: { increment: 1 } } })
}`,
      },
      {
        rel: 'b.ts',
        text: `class S {
  async gör(orgId: string) {
    const n = await allocateOcr(this.prisma, orgId)
    return n
  }
}`,
      },
    ]

    const FORM_2_HÅRDKOPPLAD = [
      {
        rel: 'a.ts',
        text: `class S {
  private async generate(orgId: string): Promise<string> {
    const row = await this.prisma.tenantOcrSequence.upsert({ where: { orgId }, update: { lastNumber: { increment: 1 } } })
    return String(row.lastNumber)
  }
}`,
      },
    ]

    const FORM_3_VALFRI = [
      {
        rel: 'a.ts',
        text: `class CustomerNumberService {
  async allocate(tx?: Prisma.TransactionClient): Promise<string> {
    const client = tx ?? this.prisma
    const row = await client.tenantOcrSequence.upsert({ where: { id: 'GLOBAL' }, update: { lastNumber: { increment: 1 } } })
    return String(row.lastNumber)
  }
}`,
      },
    ]

    const FORM_4_UTELÄMNAD = [
      {
        rel: 'a.ts',
        text: `export async function allocateOcr(tx: Prisma.TransactionClient, orgId: string) {
  return tx.tenantOcrSequence.upsert({ where: { orgId }, update: { lastNumber: { increment: 1 } } })
}`,
      },
      {
        rel: 'b.ts',
        text: `class S {
  async ett(orgId: string, tx: Prisma.TransactionClient) { return allocateOcr(tx, orgId) }
  async två(orgId: string, tx: Prisma.TransactionClient) { return allocateOcr(tx, orgId) }
  async tre(orgId: string, tx: Prisma.TransactionClient) { return allocateOcr(tx, orgId) }
  async fyra(orgId: string) { return allocateOcr(orgId) }
}`,
      },
    ]

    const REN = [
      {
        rel: 'a.ts',
        text: `export async function allocateOcr(tx: Prisma.TransactionClient, orgId: string) {
  return tx.tenantOcrSequence.upsert({ where: { orgId }, update: { lastNumber: { increment: 1 } } })
}`,
      },
      {
        rel: 'b.ts',
        text: `class S {
  async gör(orgId: string) {
    return this.prisma.$transaction(async (tx) => allocateOcr(tx, orgId), PRISMA_DEFAULT_TX_LIMITS)
  }
}`,
      },
    ]

    for (const [namn, filer] of [
      ['form 1 — poolen skickad till allokeraren', FORM_1_POOLEN],
      ['form 2 — allokeraren hårdkopplad till this.prisma', FORM_2_HÅRDKOPPLAD],
      ['form 3 — transaktionsklienten VALFRI (tx?)', FORM_3_VALFRI],
      ['form 4 — utelämnad på EN av fyra anropsplatser', FORM_4_UTELÄMNAD],
    ]) {
      const v = kör(filer)
      if (v.length === 0) fail(`R4 SÅG INTE ${namn}`)
      else console.log(`✅ R4 fäller ${namn} (${v[0].rule})`)
    }

    const rena = kör(REN)
    if (rena.length > 0) fail(`R4 FALSKLARM på ren kod: ${rena.map((x) => x.rule).join(' | ')}`)
    else
      console.log(
        '✅ R4 släpper igenom en allokerare som tar tx av typen och anropas i en $transaction',
      )
  }

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
  // Filerna behålls i minnet: R4 är en egenskap hos HELA trädet (allokeraren
  // står i en fil, dess anropsplatser i andra) och kan inte avgöras per fil.
  const filer = []
  for (const file of walk(SRC_DIR)) {
    const text = readFileSync(file, 'utf8')
    const rel = relative(REPO_ROOT, file)
    filer.push({ rel, text })
    const res = scanSource(text, rel, models)
    failures.push(...res.violations)
    callSites.push(...res.callSites)
  }
  failures.push(...checkOneCallSitePerModel(models, callSites))
  failures.push(...checkAllocatorTxTyping(filer, callSites))

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
      'alla atomära increment-UPSERT, en per serie, och varje allokerare tar sin\n' +
      '   transaktionsklient av typen (R4).',
  )
}

main()
