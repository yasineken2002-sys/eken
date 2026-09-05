#!/usr/bin/env node
/**
 * CI-VAKT 7 — ETT BEFINTLIGT VERKTYG SOM FÅR EN NY UTÅTRIKTAD FÖRMÅGA.
 *
 * ── DEFEKTEN DEN FINNS FÖR ──────────────────────────────────────────────────
 *
 * Vakt 1–6 är NAMNLISTOR. De mäter att ett verktyg är DEKLARERAT — att det står
 * i `ACTION_TOOLS`, att det har en effektklassificering, att det har en mänsklig
 * väg. Ingen av dem mäter vad verktyget GÖR. Ett verktyg som i dag bara skriver
 * i databasen och i morgon får en rad `await this.mailService.sendX(...)` passerar
 * allihop: namnet är oförändrat, deklarationen är oförändrad, och det enda som
 * ändrats är att en hyresgäst nu får ett mejl.
 *
 * Den luckan går inte att täppa med en lista, eftersom listan är precis det som
 * ingen kommer ihåg att uppdatera. Den här vakten HÄRLEDER i stället förmågorna
 * ur koden och jämför mot ett manifest — och en oanmäld skillnad, åt vilket håll
 * som helst, fäller bygget.
 *
 * ── VARFÖR METODNIVÅ OCH INTE TJÄNSTENIVÅ ───────────────────────────────────
 *
 * Uppmätt (CLAUDE.md, och gjord om här mot `f6b24cf`): på TJÄNSTENIVÅ — "vilka
 * klasser injicerar exekveraren" — ser 23 verktyg utåtriktade ut. På METODNIVÅ —
 * "vilken metod når anropskedjan faktiskt" — är det 7. Skillnaden är verktyg som
 * anropar `InvoicesService` för att läsa en faktura; en vakt på tjänstenivå hade
 * larmat om dem och blivit avstängd inom en vecka.
 *
 * ── REGLERNA ────────────────────────────────────────────────────────────────
 *
 * R1  TÄCKNING. Varje typ som injiceras i `ToolExecutorService` står antingen i
 *     `SÄNKOR` (med sitt slag) eller i `INÅT` (med ett skäl). En ny injektion —
 *     en `SmsService`, en `WebhookService` — fäller bygget INNAN någon hunnit
 *     anropa den. Det är den regeln som gör att sänkordlistan inte kan ruttna,
 *     och den är skälet till att det inte finns någon SMS-regel: noll träffar på
 *     `sms|twilio|46elks` i hela `src`, och en regel med tom mängd som aldrig kan
 *     fyra är en kommentar. R1 täcker fallet bättre än en död regex.
 *
 * R2  MANIFESTET STÄMMER, ÅT BÅDA HÅLLEN. En sänka som koden har men manifestet
 *     inte → NY FÖRMÅGA, rött. En sänka som manifestet har men koden inte längre
 *     → BORTTAGEN, rött. Att uppdatera manifestet är den AVSIKTLIGA handlingen.
 *
 * R3  FÖRENLIGHET. Ett verktyg med en utåtriktad sänka måste ha en
 *     effektdeklaration som säger det: `externalHandle !== 'EJ_TILLÄMPLIG'`, och
 *     är det `IDEMPOTENT` måste spåret BÄRA (`plats` får inte vara `INGET` eller
 *     `EJ_TILLÄMPLIG`). Ett utåtriktat verktyg utan bärande spår är ett löfte om
 *     idempotens som ingenting infriar. Dessutom: verktyget måste finnas i
 *     `HUMAN_PATHS` — en utåtriktad förmåga utan ställningstagande om den
 *     mänskliga vägen är precis den delmängdsregel #773 byggde.
 *
 * R4  OMFÅNG. Case-blocken, injektionerna och den funna sänkmängden får inte
 *     vara tomma. En vakt som mäter ingenting är grön för alltid.
 *
 * ── RÄCKVIDDEN, OCH DÄRMED GRÄNSEN ──────────────────────────────────────────
 *
 *     case-kropp
 *       → ett steg via en privat hjälpare i EXEKVERARENS egen fil
 *       → den anropade metodens kropp i den klassens egen fil
 *         → ett steg via en privat hjälpare DÄR
 *
 * Hoppet över injektionsgränsen behöver ingen typgraf: mottagarens typ står
 * skriven i konstruktorn (`private readonly mailService: MailService`), och
 * klassens fil hittas på klassnamnet. Djupare än så går den inte.
 *
 * Gränsen är MÄTT och inte vald på känsla. Ett svep som stannar i exekverarens
 * egen fil ger 12 kandidater och MISSAR `send_invoice_email`, vars kö ligger i
 * `invoices.service.ts:1611`. Att i stället klassa hela `InvoicesService` som
 * sänka hade fällt `create_invoice` och `mark_invoice_paid` — tillbaka till
 * tjänstenivån och dess 23.
 *
 * ── VAD DEN HÄR VAKTEN INTE KAN SE ──────────────────────────────────────────
 *
 * Tre saker, och alla tre är verkliga:
 *
 *   1. ANROP TVÅ STEG BORT. Når sänkan först i ett tredje led — verktyget
 *      anropar A, A anropar B, B mejlar — är den osynlig. `MailQueue` räknas
 *      därför som sänka i sig, så `MailService` inte behöver följas vidare.
 *   2. DYNAMISKA ANROP. `this[namn](...)`, en metod hämtad ur en map, ett
 *      strategy-objekt. Vakten läser bara `this.<prop>.<metod>(`.
 *   3. EN TJÄNST SOM BYTER BETEENDE UTAN ATT VERKTYGETS KOD ÄNDRAS. Får
 *      `CollectionExportService.markSentToCollection` en mejlrad någon gång, är
 *      det INTE verktygets fil som ändras — men anropet ligger inom räckvidden
 *      ovan, så just det fallet SYNS. Ändras något ett steg längre bort gör det
 *      inte det.
 *
 * Det som äger de tre är effektdeklarationens egen granskning och
 * `check-effect-idempotency.mjs`. Den här vakten mäter förmågan i koden; den
 * bevisar inte att koden är den enda vägen till effekten.
 *
 * Lokalt:    node apps/api/scripts/check-tool-outward-capabilities.mjs
 * Skriv om:  node apps/api/scripts/check-tool-outward-capabilities.mjs --skriv
 * Självtest: node apps/api/scripts/check-tool-outward-capabilities.mjs --self-test
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { codeMask, blankComments, kanariefåglar } from '../../../scripts/lib/source-scan.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..', 'src')
const EXEKVERARE = join(SRC, 'ai', 'tools', 'tool-executor.service.ts')
const DEKLARATIONER = join(SRC, 'ai', 'tools', 'effect-idempotency.ts')
const HUMAN_PATH = join(SRC, 'ai', 'tools', 'human-path.ts')
const VERKTYG = join(SRC, 'ai', 'tools', 'ai-tools.definition.ts')
const MANIFEST = join(HERE, 'tool-outward-capabilities.json')

/**
 * SÄNKORNA — mottagartyp → slag. Uppräknade UR KODEN, inte gissade:
 *
 *   MAIL         mail.service.ts:293 `constructor(queue: MailQueue)` → Bull
 *                → mail.worker → Resend
 *   LAGRING_R2   storage.service.ts — S3Client / PutObjectCommand
 *   SIGNERING    signing.service.ts:60 `this.provider.createRequest(`
 *   KÖ           invoices.service.ts:1611 `this.pdfQueue.enqueue({` — vägen
 *                till `send_invoice_email`
 */
export const SÄNKOR = {
  MailService: 'MAIL',
  MailQueue: 'MAIL',
  StorageService: 'LAGRING_R2',
  DocumentSigningProvider: 'SIGNERING',
  PdfQueue: 'KÖ',
  ContractScanBatchQueue: 'KÖ',
  LeaseActivationQueue: 'KÖ',
  // Bulls egen `Queue<T>` och R2:s klient. De är hur en sänkklass i sin tur når
  // ut, och gör att sänkorna kan prövas PER METOD i stället för per klass.
  Queue: 'KÖ',
  S3Client: 'LAGRING_R2',
}

/** Primitiver som är en sänka oavsett mottagartyp. */
const PRIMITIVER = [
  [/\bfetch\s*\(/, 'HTTP'],
  [/\baxios\s*\./, 'HTTP'],
  [/\bresend\s*\./i, 'MAIL'],
  [/\bPutObjectCommand\b/, 'LAGRING_R2'],
]

/**
 * INÅTRIKTADE injektioner — kvitterade MED SKÄL, inte tystnad. R1 kräver att
 * varje injicerad typ står här eller i `SÄNKOR`.
 */
export const INÅT = {
  PrismaService: 'Databasen. Historiens enda inåtriktade sänka värd namnet.',
  RedisService: 'Cache och lås. Nätverk, men inom systemet och utan mottagare.',
  AiAuditService: 'Skriver revisionsrader i databasen.',
  InvoicesService: 'Fakturadomänen. Mest CRUD — men `sendInvoiceEmail` når kön, vilket räckviddsregeln ser på metodnivå.',
  PdfService: 'Lokal Puppeteer-rendering. Producerar bytes, riktar sig inte mot någon.',
  TenantsService: 'CRUD på hyresgäster.',
  LeasesService: 'CRUD på avtal.',
  RentIncreasesService: 'CRUD på hyreshöjningar.',
  PropertiesService: 'CRUD på fastigheter.',
  UnitsService: 'CRUD på lägenheter.',
  AccountingService: 'Bokföring i databasen.',
  VerifikationsnummerService: 'Nummerserie i databasen.',
  MaintenanceService: 'Ärenden i databasen.',
  AviseringService: 'Avidomänen. `generateMonthlyNotices` skriver bara; sändningen är en EGEN metod, och räckviddsregeln skiljer dem åt.',
  InspectionsService: 'Besiktningar i databasen.',
  MaintenancePlanService: 'Underhållsplaner i databasen.',
  ReconciliationService: 'Avstämning i databasen.',
  CollectionExportService: 'Inkassoexport. Laddar upp till R2 i `exportForInvoice` — den sänkan syns via metodnivån, inte via typen.',
  PaymentReminderService: 'Påminnelsetillstånd i databasen.',
  DocumentDeliveryService: 'Portalleverans. `deliverToTenant` når mejlet via en privat hjälpare i sin egen fil.',
  SigningService: 'Signeringsdomänen. Providern är en EGEN injektion (`DocumentSigningProvider`) och är sänkan.',
  AccountingPeriodService: 'Periodstängning i databasen.',
}

// ── läsning ─────────────────────────────────────────────────────────────────

/** Balanserad klammermatchning från index `i`, där `{` står. */
export function block(text, i) {
  if (text[i] !== '{') return null
  let d = 0
  for (let j = i; j < text.length; j++) {
    if (text[j] === '{') d++
    else if (text[j] === '}') {
      d--
      if (d === 0) return [i, j + 1]
    }
  }
  return null
}

/**
 * Konstruktorns injektioner: `prop` → `Typ`.
 *
 * Läser BÅDE den vanliga formen och `@Inject(TOKEN) private readonly p: Typ` —
 * signeringsprovidern kommer den vägen, och en regex utan den hade tappat
 * kodbasens enda SIGNERING-sänka.
 */
export function injektioner(kod) {
  const ut = new Map()
  // (a) konstruktorparametrar
  const i = kod.indexOf('constructor(')
  if (i !== -1) {
    const slut = kod.indexOf(') {', i)
    const kropp = kod.slice(i, slut === -1 ? kod.length : slut)
    for (const m of kropp.matchAll(
      /(?:@Inject\([^)]*\)\s*)?(?:private|public|protected|readonly)[^,()]*?([\p{L}\p{N}_$]+)\s*:\s*([\p{L}\p{N}_$]+)/gu,
    ))
      ut.set(m[1], m[2])
  }
  // (b) KLASSFÄLT. `StorageService` bygger sin `S3Client` i konstruktorkroppen
  // och deklarerar den som `private readonly s3: S3Client` — inte som en
  // parameter. Utan den här halvan är R2-klienten osynlig, och då kan
  // `uploadFile` inte skiljas från `getPresignedUrl`.
  for (const m of kod.matchAll(
    /^\s{2}(?:private|public|protected)\s+(?:readonly\s+)?([\p{L}\p{N}_$]+)!?\s*:\s*([\p{L}\p{N}_$]+)/gmu,
  ))
    if (!ut.has(m[1])) ut.set(m[1], m[2])
  return ut
}

/**
 * `case '<namn>': { … }` — namnet ur RÅTEXTEN, blocket ur KODEN.
 *
 * VYN ÄR INTE UTBYTBAR. `codeMask` blankar stränginnehåll men bevarar längd och
 * offset, så positionen söks i masken och namnet läses på samma index i råtexten.
 * Med `blankComments` i stället blir en `case`-etikett inne i en kommentar ett
 * verktyg — och sänkorna, som är ANROP, börjar räknas i prosa. Självtestet
 * prövar exakt det bytet.
 */
export function caseBlock(rå, kod) {
  const ut = new Map()
  for (const m of kod.matchAll(/case\s+'[^']*':\s*\{/g)) {
    const namn = /^case\s+'([^']*)'/.exec(rå.slice(m.index, m.index + m[0].length))?.[1]
    const i = kod.indexOf('{', m.index + m[0].length - 1)
    const b = block(kod, i)
    if (namn && b) ut.set(namn, kod.slice(b[0], b[1]))
  }
  return ut
}

/** Balanserad matchning av ett godtyckligt par, från index `i` där öppnaren står. */
function par(text, i, öppna, stäng) {
  if (text[i] !== öppna) return null
  let d = 0
  for (let j = i; j < text.length; j++) {
    if (text[j] === öppna) d++
    else if (text[j] === stäng) {
      d--
      if (d === 0) return j + 1
    }
  }
  return null
}

/**
 * KROPPENS klammer, given index för metodnamnets `(`.
 *
 * RETURTYPEN KAN INNEHÅLLA `{`. Det är inte ett kantfall utan normalläget i den
 * här kodbasen: `async sendInvoiceEmail(...): Promise<{ jobId: string }> {`. Ett
 * naivt `indexOf('{', efterNamnet)` landar då i TYPEN, tar dess block som kropp,
 * och metoden ser ut att inte anropa någonting.
 *
 * Det var inte hypotetiskt: precis den buggen gjorde att `send_invoice_email`
 * saknades i första manifestet — svepet läste `{ jobId: string }` som kroppen
 * och hittade noll anrop. Regeln nedan hoppar över varje klammerblock som följs
 * av ett nytt `{`, och tar det sista.
 */
export function kroppsKlammer(kod, iParen) {
  const efterParams = par(kod, iParen, '(', ')')
  if (efterParams === null) return -1
  // Mellan `)` och kroppen står returtypen. Där är `<` alltid en generisk
  // parentes, aldrig mindre-än — vi är i typposition.
  let vinkel = 0
  let i = efterParams
  for (let varv = 0; varv < 200 && i < kod.length; varv++) {
    const c = kod[i]
    if (c === '<') { vinkel++; i++; continue }
    if (c === '>') { vinkel = Math.max(0, vinkel - 1); i++; continue }
    if (c !== '{') { i++; continue }
    const slut = par(kod, i, '{', '}')
    if (slut === null) return -1
    // Inuti en generisk parentes: `Promise<{ jobId: string }>` — en TYP.
    if (vinkel > 0) { i = slut; continue }
    // På djup 0: en objekttyp följs av kroppens `{`; kroppen gör det inte.
    if (/^\s*\{/.test(kod.slice(slut))) { i = slut; continue }
    return i
  }
  return -1
}

/** Ord som står på klassnivåns indrag utan att vara metoder. */
const EJ_METODNAMN = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'constructor'])

/** Metodkroppar på klassnivå (2 stegs indrag) i en fil: `namn` → kropp. */
export function metoder(kod) {
  const ut = new Map()
  for (const m of kod.matchAll(
    /^\s{2}(?:private\s+|public\s+|protected\s+)?(?:static\s+)?(?:async\s+)?([\p{L}\p{N}_$]+)\s*(?:<[^>]*>)?\(/gmu,
  )) {
    if (EJ_METODNAMN.has(m[1])) continue
    const iParen = kod.indexOf('(', m.index + m[0].length - 1)
    const k = kroppsKlammer(kod, iParen)
    const b = k >= 0 ? block(kod, k) : null
    if (b && !ut.has(m[1])) ut.set(m[1], kod.slice(b[0], b[1]))
  }
  return ut
}

/** `this.<prop>.<metod>(` och `this.<hjälpare>(` ur en kropp. */
export function anrop(kropp) {
  const via = []
  const egna = new Set()
  for (const m of kropp.matchAll(/this\.([\p{L}\p{N}_$]+)((?:\.[\p{L}\p{N}_$]+)+)\s*\(/gu))
    via.push({ prop: m[1], metod: m[2].replace(/^\./, '').split('.')[0] })
  for (const m of kropp.matchAll(/this\.([\p{L}\p{N}_$]+)\s*\(/gu)) egna.add(m[1])
  return { via, egna }
}

/** Sänkor ur PRIMITIVER i en kropp. */
function primitivsänkor(kropp) {
  const ut = new Set()
  for (const [re, slag] of PRIMITIVER) if (re.test(kropp)) ut.add(slag)
  return ut
}

/** Alla `.ts` under `src`, en gång. */
function allaKällfiler(rot) {
  const ut = []
  const gå = (d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n)
      if (statSync(p).isDirectory()) gå(p)
      else if (n.endsWith('.ts') && !n.endsWith('.spec.ts')) ut.push(p)
    }
  }
  gå(rot)
  return ut
}

/** Klassnamn → filens kodmask. Byggs en gång. */
export function klassindex(filer, läs) {
  const ut = new Map()
  for (const f of filer) {
    const rå = läs(f)
    if (!/\bclass\s+[\p{L}\p{N}_$]+/u.test(rå)) continue
    const kod = codeMask(rå)
    for (const m of kod.matchAll(/(?:export\s+)?(?:abstract\s+)?class\s+([\p{L}\p{N}_$]+)/gu))
      if (!ut.has(m[1])) ut.set(m[1], kod)
  }
  return ut
}

/**
 * NÅR EN SÄNKKLASSENS METOD FAKTISKT UT? — förfiningen som gör vakten användbar.
 *
 * `StorageService` är en sänkklass, men inte varje metod på den lämnar maskinen.
 * `uploadFile` gör `this.s3.send(new PutObjectCommand(…))`; `getPresignedUrl`
 * gör `getSignedUrl(this.s3, new GetObjectCommand(…))` — en LOKAL signering som
 * returnerar en sträng. Ingen byte lämnar processen, ingen mottagare finns.
 *
 * Utan den här förfiningen fälldes `update_maintenance_status`, som bara hämtar
 * en presignerad bild-URL. En vakt som larmar om det blir avstängd.
 *
 * FAIL-CLOSED när klassens fil inte går att läsa. `DocumentSigningProvider` är
 * ett INTERFACE — det finns ingen `class` att indexera — och då räknas anropet
 * som en sänka. Tystnad vore fel håll att fela åt: en oläsbar sänkklass är inte
 * ett belägg för att den är ofarlig.
 */
export function nårUt(typ, metod, klasser) {
  const kod = klasser.get(typ)
  if (!kod) return true // fail-closed: kan inte läsas → räknas
  const m = metoder(kod)
  const kropp = m.get(metod)
  if (!kropp) return true // metoden hittades inte → räknas
  const fält = injektioner(kod)
  const kroppar = [kropp]
  for (const h of anrop(kropp).egna) {
    const hk = m.get(h)
    if (hk) kroppar.push(hk)
  }
  for (const k of kroppar) {
    if (primitivsänkor(k).size > 0) return true
    for (const { prop } of anrop(k).via) {
      const t = fält.get(prop)
      if (t && SÄNKOR[t]) return true
    }
  }
  return false
}

// ── kärnan ──────────────────────────────────────────────────────────────────

/**
 * Sänkorna per verktyg. Exporterad så självtestet kör exakt samma kod som CI.
 *
 * @param exekverarKod  kodmask av tool-executor.service.ts
 * @param exekverarRå   råtexten (namnen bor i strängar)
 * @param klasser       Map<klassnamn, kodmask>
 */
export function sänkorPerVerktyg({ exekverarRå, exekverarKod, klasser, actionTools }) {
  const inj = injektioner(exekverarKod)
  const fall = caseBlock(exekverarRå, exekverarKod)
  const egnaMetoder = metoder(exekverarKod)
  const ut = new Map()

  for (const [verktyg, kropp] of fall) {
    if (actionTools && !actionTools.has(verktyg)) continue
    const träffar = new Map() // slag → Set<'prop.metod'>
    const lägg = (slag, hur) => {
      if (!träffar.has(slag)) träffar.set(slag, new Set())
      träffar.get(slag).add(hur)
    }

    // Steg 1: case-kroppen, plus ETT steg via en hjälpare i samma fil.
    const kroppar = [kropp]
    for (const h of anrop(kropp).egna) {
      const hk = egnaMetoder.get(h)
      if (hk) kroppar.push(hk)
    }

    for (const k of kroppar) {
      for (const slag of primitivsänkor(k)) lägg(slag, 'primitiv i verktygets kropp')
      for (const { prop, metod } of anrop(k).via) {
        const typ = inj.get(prop)
        if (!typ) continue
        // Mottagartypen ÄR en sänka — men bara om DEN METODEN når ut.
        if (SÄNKOR[typ]) {
          if (nårUt(typ, metod, klasser)) lägg(SÄNKOR[typ], `${prop}.${metod}`)
          continue
        }
        // Steg 2: hoppa över injektionsgränsen till klassens egen fil.
        const klassKod = klasser.get(typ)
        if (!klassKod) continue
        const klassMetoder = metoder(klassKod)
        const målKropp = klassMetoder.get(metod)
        if (!målKropp) continue
        const klassInj = injektioner(klassKod)
        const målKroppar = [målKropp]
        for (const h of anrop(målKropp).egna) {
          const hk = klassMetoder.get(h)
          if (hk) målKroppar.push(hk)
        }
        for (const mk of målKroppar) {
          for (const slag of primitivsänkor(mk)) lägg(slag, `${typ}.${metod} → primitiv`)
          for (const inre of anrop(mk).via) {
            const innerTyp = klassInj.get(inre.prop)
            if (innerTyp && SÄNKOR[innerTyp] && nårUt(innerTyp, inre.metod, klasser))
              lägg(SÄNKOR[innerTyp], `${typ}.${metod} → ${inre.prop}.${inre.metod}`)
          }
        }
      }
    }

    if (träffar.size > 0)
      ut.set(
        verktyg,
        Object.fromEntries([...träffar].sort().map(([s, v]) => [s, [...v].sort()])),
      )
  }
  return { sänkor: ut, antalCase: fall.size, antalInjektioner: inj.size }
}

/** `ACTION_TOOLS` ur definitionen — som KOD, namnen ur råtexten. */
export function parseActionTools(rå) {
  const kod = codeMask(rå)
  const i = kod.indexOf('ACTION_TOOLS')
  if (i === -1) return new Set()
  const start = kod.indexOf('[', i)
  const slut = kod.indexOf(']', start)
  if (start === -1 || slut === -1) return new Set()
  // `\p{Ll}\p{N}_` och inte `[a-z0-9_]`: verktygsnamnen är ASCII i dag, men en
  // ASCII-härledning av en identifierare KAPAR ett namn med svensk initial i
  // stället för att missa det, och antalet är då oförändrat. Se
  // check-identifier-regex.mjs.
  return new Set(
    [...rå.slice(start, slut).matchAll(/'([\p{Ll}\p{N}_]+)'/gu)].map((m) => m[1]),
  )
}

/** Effektdeklarationerna, de tre fält R3 behöver. */
export function parseDeklarationer(rå) {
  const text = blankComments(rå)
  const i = text.indexOf('EFFECT_DECLARATIONS')
  if (i === -1) return new Map()
  const yttre = block(text, text.indexOf('{', i))
  if (!yttre) return new Map()
  const kropp = text.slice(yttre[0], yttre[1])
  const ut = new Map()
  const nyckel = /(^|\n)\s{2}([\p{Ll}\p{N}_]+):\s*\{/gu
  let m
  while ((m = nyckel.exec(kropp)) !== null) {
    const b = block(kropp, m.index + m[0].length - 1)
    if (!b) continue
    const p = kropp.slice(b[0], b[1])
    ut.set(m[2], {
      externalHandle: (p.match(/externalHandle:\s*'([\p{Lu}_ÅÄÖ]+)'/u) ?? [])[1] ?? null,
      effectIdempotency: (p.match(/effectIdempotency:\s*'([\p{Lu}_]+)'/u) ?? [])[1] ?? null,
      plats: (p.match(/plats:\s*'([\p{Lu}_ÅÄÖ]+)'/u) ?? [])[1] ?? null,
    })
    nyckel.lastIndex = b[1]
  }
  return ut
}

/** Verktygsnamn som har en post i `HUMAN_PATHS` — som KOD, namn ur råtexten. */
export function parseHumanPaths(rå) {
  const kod = codeMask(rå)
  const i = kod.indexOf('HUMAN_PATHS')
  if (i === -1) return new Set()
  const b = block(kod, kod.indexOf('{', i))
  if (!b) return new Set()
  const ut = new Set()
  for (const m of kod.slice(b[0], b[1]).matchAll(/(^|\n)\s{2}([\p{Ll}\p{N}_]+):/gu)) ut.add(m[2])
  return ut
}

/** Spår som INTE bär ett utåtriktat löfte om idempotens. */
const SPÅR_UTAN_BÄRKRAFT = new Set(['INGET', 'EJ_TILLÄMPLIG'])

export function evaluate({
  exekverarRå,
  exekverarKod,
  klasser,
  actionTools,
  manifest,
  deklarationer,
  humanPaths,
}) {
  const problem = []
  const { sänkor, antalCase, antalInjektioner } = sänkorPerVerktyg({
    exekverarRå,
    exekverarKod,
    klasser,
    actionTools,
  })

  // ── R4 OMFÅNG ─────────────────────────────────────────────────────────────
  if (antalCase === 0)
    problem.push({
      regel: 'R4',
      detalj: 'NOLL case-block lästes ur tool-executor.service.ts. Svepet har gått blint; reglerna nedan hade varit gröna om allt.',
    })
  if (antalInjektioner === 0)
    problem.push({
      regel: 'R4',
      detalj: 'NOLL konstruktorinjektioner lästes. Utan mottagartyper kan ingen sänka kännas igen.',
    })
  if (sänkor.size === 0)
    problem.push({
      regel: 'R4',
      detalj: 'NOLL verktyg med sänkor. Kodbasen HAR utåtriktade verktyg — en tom mängd betyder att svepet slutat läsa.',
    })

  // ── R1 TÄCKNING ───────────────────────────────────────────────────────────
  const inj = injektioner(exekverarKod)
  for (const [prop, typ] of inj) {
    if (SÄNKOR[typ] || INÅT[typ]) continue
    problem.push({
      regel: 'R1',
      detalj:
        `Typen \`${typ}\` (this.${prop}) injiceras i ToolExecutorService men är varken ` +
        'klassad i SÄNKOR eller kvitterad i INÅT. Riktar den sig mot någon utanför ' +
        'organisationen? Lägg den i SÄNKOR med sitt slag. Gör den inte det? Kvittera ' +
        'den MED SKÄL. Ett nytt beroende får inte glida in oklassat.',
    })
  }

  // ── R2 MANIFESTET, ÅT BÅDA HÅLLEN ─────────────────────────────────────────
  const iKod = new Set(sänkor.keys())
  const iManifest = new Set(Object.keys(manifest.verktyg ?? {}))

  for (const [verktyg, slagen] of sänkor) {
    const m = manifest.verktyg?.[verktyg]
    if (!m) {
      problem.push({
        regel: 'R2',
        detalj:
          `NY UTÅTRIKTAD FÖRMÅGA: \`${verktyg}\` når ${Object.keys(slagen).join(', ')} ` +
          `(${Object.values(slagen).flat().join(' · ')}) men står inte i manifestet. ` +
          'Är det avsiktligt? Kör med --skriv och motivera i PR-texten.',
      })
      continue
    }
    for (const slag of Object.keys(slagen))
      if (!m[slag])
        problem.push({
          regel: 'R2',
          detalj:
            `NY SÄNKA: \`${verktyg}\` når \`${slag}\` (${slagen[slag].join(' · ')}) — ` +
            'manifestet känner den inte. Verktyget har fått en förmåga det inte hade.',
        })
    for (const slag of Object.keys(m))
      if (!slagen[slag])
        problem.push({
          regel: 'R2',
          detalj:
            `BORTTAGEN SÄNKA: manifestet säger att \`${verktyg}\` når \`${slag}\`, men koden ` +
            'gör det inte längre. Antingen är förmågan borta (uppdatera manifestet) eller så ' +
            'har svepet slutat se den — och då mäter vakten mindre än den påstår.',
        })
  }
  for (const verktyg of iManifest)
    if (!iKod.has(verktyg))
      problem.push({
        regel: 'R2',
        detalj:
          `OKÄNT VERKTYG: manifestet har \`${verktyg}\`, men svepet hittar ingen sänka för det. ` +
          'Ett omdöpt eller borttaget verktyg lämnar en post som ser ut att skydda något.',
      })

  // ── R3 FÖRENLIGHET ────────────────────────────────────────────────────────
  for (const [verktyg, slagen] of sänkor) {
    const d = deklarationer.get(verktyg)
    if (!d) {
      problem.push({
        regel: 'R3',
        detalj: `\`${verktyg}\` har en utåtriktad sänka men ingen post i EFFECT_DECLARATIONS.`,
      })
      continue
    }
    if (d.externalHandle === 'EJ_TILLÄMPLIG')
      problem.push({
        regel: 'R3',
        detalj:
          `\`${verktyg}\` når ${Object.keys(slagen).join(', ')} men deklarerar ` +
          '`externalHandle: EJ_TILLÄMPLIG`. Deklarationen säger att verktyget inte lämnar ' +
          'systemet; koden säger något annat. En av de två har fel.',
      })
    if (d.effectIdempotency === 'IDEMPOTENT' && SPÅR_UTAN_BÄRKRAFT.has(d.plats ?? 'INGET'))
      problem.push({
        regel: 'R3',
        detalj:
          `\`${verktyg}\` är utåtriktat OCH deklarerat IDEMPOTENT, men spårplatsen är ` +
          `\`${d.plats}\`. Ett utåtriktat verktyg vars spår inte bär är ett löfte om ` +
          'idempotens som ingenting infriar — den andra körningen skickar mejlet igen.',
      })
    if (!humanPaths.has(verktyg))
      problem.push({
        regel: 'R3',
        detalj:
          `\`${verktyg}\` har en utåtriktad förmåga men ingen post i HUMAN_PATHS. ` +
          'Delmängdsregeln (#773): varje agentverktyg måste ha ett ställningstagande om ' +
          'den mänskliga vägen, och en utåtriktad handling allra mest.',
      })
  }

  return { problem, sänkor, antalCase, antalInjektioner }
}

// ── körning ─────────────────────────────────────────────────────────────────

function läsAllt() {
  const exekverarRå = readFileSync(EXEKVERARE, 'utf8')
  const filer = allaKällfiler(SRC)
  return {
    exekverarRå,
    exekverarKod: codeMask(exekverarRå),
    klasser: klassindex(filer, (f) => readFileSync(f, 'utf8')),
    actionTools: parseActionTools(readFileSync(VERKTYG, 'utf8')),
    deklarationer: parseDeklarationer(readFileSync(DEKLARATIONER, 'utf8')),
    humanPaths: parseHumanPaths(readFileSync(HUMAN_PATH, 'utf8')),
  }
}

function skriv() {
  const indata = läsAllt()
  const { sänkor } = sänkorPerVerktyg(indata)
  const verktyg = {}
  for (const namn of [...sänkor.keys()].sort()) verktyg[namn] = sänkor.get(namn)
  const ut = {
    __doc__: [
      'HÄRLETT AV apps/api/scripts/check-tool-outward-capabilities.mjs — skriv aldrig för hand.',
      'Per verktyg: vilka utåtriktade sänkor dess anropskedja når, och hur de känns igen.',
      'Vakten diffar åt BÅDA hållen: en sänka i koden som saknas här är en NY FÖRMÅGA;',
      'en sänka här som koden inte har är en BORTTAGEN förmåga eller ett svep som gått blint.',
      'Uppdatering är en AVSIKTLIG handling: kör --skriv och motivera i PR-texten.',
    ],
    verktyg,
  }
  writeFileSync(MANIFEST, `${JSON.stringify(ut, null, 2)}\n`)
  console.warn(`✅ Manifest skrivet: ${Object.keys(verktyg).length} verktyg med utåtriktad förmåga.`)
  for (const n of Object.keys(verktyg)) console.warn(`   ${n.padEnd(28)} ${Object.keys(verktyg[n]).join(', ')}`)
}

function kör() {
  const indata = läsAllt()
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
  const { problem, sänkor, antalCase, antalInjektioner } = evaluate({ ...indata, manifest })

  if (problem.length > 0) {
    console.error('\n=== UTÅTRIKTADE FÖRMÅGOR STÄMMER INTE (CI-guard) ===\n')
    for (const p of problem) console.error(`❌ ${p.regel}\n   ${p.detalj}\n`)
    console.error(
      'Vakt 1–6 mäter att ett verktyg är DEKLARERAT. Den här mäter vad det GÖR.\n' +
        'Ett verktyg som i dag skriver i databasen och i morgon skickar mejl ska\n' +
        'fälla bygget utan att någon behöver komma ihåg en lista.\n',
    )
    process.exit(1)
  }

  const rader = [...sänkor]
    .map(([n, s]) => `${n} (${Object.keys(s).join('+')})`)
    .sort()
  console.warn(
    `✅ ${sänkor.size} verktyg med utåtriktad förmåga, alla i manifestet — ` +
      `${antalCase} case-block, ${antalInjektioner} injektioner klassade.\n   ${rader.join(' · ')}`,
  )
}

// ── självtest ───────────────────────────────────────────────────────────────

const EXEKVERARE_FIXTUR = `
export class ToolExecutorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mailService: MailService,
    private readonly invoicesService: InvoicesService,
    @Inject(SIGNING_PROVIDER) private readonly provider: DocumentSigningProvider,
  ) {}

  async executeTool(name: string) {
    switch (name) {
      case 'skriv_bara': {
        await this.prisma.invoice.update({ where: { id: '1' }, data: {} })
        return { success: true }
      }
      case 'mejla': {
        await this.mailService.sendCustomEmail('a@b.se')
        return { success: true }
      }
      case 'via_tjanst': {
        await this.invoicesService.sendInvoiceEmail('1')
        return { success: true }
      }
      case 'via_hjalpare': {
        await this.hjälparen()
        return { success: true }
      }
      case 'signera': {
        await this.provider.createRequest({})
        return { success: true }
      }
    }
  }

  private async hjälparen() {
    await this.mailService.sendOverdueReminder('x')
  }
}
`

const INVOICES_FIXTUR = `
export class InvoicesService {
  constructor(private readonly pdfQueue: PdfQueue) {}
  async sendInvoiceEmail(id: string) {
    const jobId = await this.pdfQueue.enqueue({ id })
    return { jobId }
  }
}
`

function selfTest() {
  let fel = 0
  const t = (namn, ok, extra = '') => {
    console.warn(`  ${ok ? '✅' : '❌'} ${namn}${extra ? ` — ${extra}` : ''}`)
    if (!ok) fel++
  }

  const klasser = new Map([
    ['InvoicesService', codeMask(INVOICES_FIXTUR)],
    ['MailService', codeMask('export class MailService { constructor(private readonly queue: MailQueue) {} }')],
  ])
  const actionTools = new Set(['skriv_bara', 'mejla', 'via_tjanst', 'via_hjalpare', 'signera'])
  const bas = () => ({
    exekverarRå: EXEKVERARE_FIXTUR,
    exekverarKod: codeMask(EXEKVERARE_FIXTUR),
    klasser,
    actionTools,
  })
  const kör = () => sänkorPerVerktyg(bas())

  // ── OMFÅNGSKANARIEFÅGLARNA ────────────────────────────────────────────────
  {
    const r = kör()
    t('OMFÅNG: case-blocken läses', r.antalCase === 5, `antalCase=${r.antalCase}`)
    t('OMFÅNG: injektionerna läses', r.antalInjektioner === 4, `antal=${r.antalInjektioner}`)
    t('OMFÅNG: sänkmängden är inte tom', r.sänkor.size > 0, `${r.sänkor.size}`)
  }

  // ── PRECISIONEN — den halva som gör vakten användbar ───────────────────────
  {
    const { sänkor } = kör()
    t('ett verktyg som BARA skriver i databasen har ingen sänka', !sänkor.has('skriv_bara'),
      JSON.stringify(sänkor.get('skriv_bara') ?? null))
    t('direkt mailanrop → MAIL', sänkor.get('mejla')?.MAIL?.length === 1, JSON.stringify(sänkor.get('mejla')))
    t('ETT STEG via privat hjälpare i samma fil följs → MAIL',
      sänkor.get('via_hjalpare')?.MAIL?.length === 1, JSON.stringify(sänkor.get('via_hjalpare')))
    t('ETT HOPP över injektionsgränsen följs → KÖ',
      sänkor.get('via_tjanst')?.['KÖ']?.length === 1, JSON.stringify(sänkor.get('via_tjanst')))
    t('@Inject(TOKEN)-formen läses → SIGNERING',
      sänkor.get('signera')?.SIGNERING?.length === 1, JSON.stringify(sänkor.get('signera')))
  }

  // ── REGELKANARIEFÅGELN: NY FÖRMÅGA PÅ ETT BEFINTLIGT VERKTYG ──────────────
  {
    const medMejl = EXEKVERARE_FIXTUR.replace(
      "await this.prisma.invoice.update({ where: { id: '1' }, data: {} })",
      "await this.prisma.invoice.update({ where: { id: '1' }, data: {} })\n        await this.mailService.sendCustomEmail('ny@förmåga.se')",
    )
    const manifest = { verktyg: { mejla: { MAIL: ['mailService.sendCustomEmail'] } } }
    const dekl = new Map([
      ['mejla', { externalHandle: 'INGET', effectIdempotency: 'DEDUPLICERBAR', plats: 'DATABAS_TILLSTÅND' }],
      ['skriv_bara', { externalHandle: 'EJ_TILLÄMPLIG', effectIdempotency: 'IDEMPOTENT', plats: 'DATABAS_INDEX' }],
    ])
    const hp = new Set(['mejla', 'skriv_bara'])
    const r = evaluate({
      exekverarRå: medMejl,
      exekverarKod: codeMask(medMejl),
      klasser,
      actionTools: new Set(['skriv_bara', 'mejla']),
      manifest,
      deklarationer: dekl,
      humanPaths: hp,
    })
    t('REGELKANARIE (a): mailanrop i ett DB-verktyg → RÖTT med namn och sänka',
      r.problem.some((p) => p.regel === 'R2' && p.detalj.includes('skriv_bara') && p.detalj.includes('MAIL')),
      JSON.stringify(r.problem.map((p) => p.regel)))
    t('REGELKANARIE (a2): och dess deklaration blir OFÖRENLIG',
      r.problem.some((p) => p.regel === 'R3' && p.detalj.includes('skriv_bara')),
      JSON.stringify(r.problem.filter((p) => p.regel === 'R3').map((p) => p.detalj.slice(0, 40))))
  }

  // ── REGELKANARIEFÅGELN (b): BORTTAGEN SÄNKA ───────────────────────────────
  {
    const utanMejl = EXEKVERARE_FIXTUR.replace("await this.mailService.sendCustomEmail('a@b.se')", 'void 0')
    const manifest = { verktyg: { mejla: { MAIL: ['mailService.sendCustomEmail'] } } }
    const r = evaluate({
      exekverarRå: utanMejl,
      exekverarKod: codeMask(utanMejl),
      klasser,
      actionTools: new Set(['mejla']),
      manifest,
      deklarationer: new Map(),
      humanPaths: new Set(),
    })
    t('REGELKANARIE (b): sänkan borta ur koden, manifestet orört → RÖTT',
      r.problem.some((p) => p.regel === 'R2' && p.detalj.includes('mejla')),
      JSON.stringify(r.problem.map((p) => p.detalj.slice(0, 30))))
  }

  // ── REGELKANARIEFÅGELN (b2): EN AV FLERA SÄNKOR FÖRSVINNER ────────────────
  //
  // (b) ovan tar bort verktygets ENDA sänka, och då faller verktyget ur den
  // svepta mängden helt — utfallet blir "OKÄNT VERKTYG". Grenen som fäller när
  // ett verktyg BEHÅLLER en sänka men tappar en annan är en EGEN kodväg, och
  // utan det här provet har ingen sett den falla.
  {
    const r = evaluate({
      ...bas(),
      actionTools: new Set(['mejla']),
      // Koden ger `mejla` bara MAIL. Manifestet påstår MAIL + LAGRING_R2.
      manifest: {
        verktyg: {
          mejla: { MAIL: ['mailService.sendCustomEmail'], LAGRING_R2: ['storage.uploadFile'] },
        },
      },
      deklarationer: new Map([
        ['mejla', { externalHandle: 'INGET', effectIdempotency: 'DEDUPLICERBAR', plats: 'DATABAS_TILLSTÅND' }],
      ]),
      humanPaths: new Set(['mejla']),
    })
    t('REGELKANARIE (b2): en av FLERA sänkor borta ur koden → RÖTT som BORTTAGEN',
      r.problem.some((p) => p.regel === 'R2' && p.detalj.includes('BORTTAGEN') && p.detalj.includes('LAGRING_R2')),
      JSON.stringify(r.problem.map((p) => p.detalj.slice(0, 34))))
    t('REGELKANARIE (b2): och den sänka som FINNS larmar inte',
      !r.problem.some((p) => p.detalj.includes('MAIL')),
      JSON.stringify(r.problem.map((p) => p.detalj.slice(0, 34))))
  }

  // ── REGELKANARIEFÅGELN (c): PÅHITTAT VERKTYG I MANIFESTET ─────────────────
  {
    const manifest = {
      verktyg: {
        mejla: { MAIL: ['mailService.sendCustomEmail'] },
        zz_sond_utan_motsvarighet: { MAIL: ['finns.inte'] },
      },
    }
    const r = evaluate({
      ...bas(),
      actionTools: new Set(['mejla']),
      manifest,
      deklarationer: new Map([['mejla', { externalHandle: 'INGET', effectIdempotency: 'DEDUPLICERBAR', plats: 'DATABAS_TILLSTÅND' }]]),
      humanPaths: new Set(['mejla']),
    })
    t('REGELKANARIE (c): påhittat verktygsnamn i manifestet → RÖTT',
      r.problem.some((p) => p.regel === 'R2' && p.detalj.includes('zz_sond_utan_motsvarighet')),
      JSON.stringify(r.problem.map((p) => p.regel)))
  }

  // ── R1: EN OKLASSAD INJEKTION FÄLLER ──────────────────────────────────────
  {
    const medNy = EXEKVERARE_FIXTUR.replace(
      'private readonly mailService: MailService,',
      'private readonly mailService: MailService,\n    private readonly zzSond: ZzSondService,',
    )
    const r = evaluate({
      exekverarRå: medNy,
      exekverarKod: codeMask(medNy),
      klasser,
      actionTools,
      manifest: { verktyg: {} },
      deklarationer: new Map(),
      humanPaths: new Set(),
    })
    t('R1: en NY oklassad injektion fäller innan någon hunnit anropa den',
      r.problem.some((p) => p.regel === 'R1' && p.detalj.includes('ZzSondService')),
      JSON.stringify(r.problem.filter((p) => p.regel === 'R1').map((p) => p.detalj.slice(0, 30))))
  }

  // ── R3: IDEMPOTENT UTAN BÄRANDE SPÅR ──────────────────────────────────────
  {
    const r = evaluate({
      ...bas(),
      actionTools: new Set(['mejla']),
      manifest: { verktyg: { mejla: { MAIL: ['mailService.sendCustomEmail'] } } },
      deklarationer: new Map([['mejla', { externalHandle: 'INGET', effectIdempotency: 'IDEMPOTENT', plats: 'INGET' }]]),
      humanPaths: new Set(['mejla']),
    })
    t('R3: utåtriktad + IDEMPOTENT + spår som inte bär → RÖTT',
      r.problem.some((p) => p.regel === 'R3' && p.detalj.includes('infriar')),
      JSON.stringify(r.problem.map((p) => p.regel)))
  }

  // ── R3: SAKNAD HUMAN_PATH ─────────────────────────────────────────────────
  {
    const r = evaluate({
      ...bas(),
      actionTools: new Set(['mejla']),
      manifest: { verktyg: { mejla: { MAIL: ['mailService.sendCustomEmail'] } } },
      deklarationer: new Map([['mejla', { externalHandle: 'INGET', effectIdempotency: 'DEDUPLICERBAR', plats: 'DATABAS_TILLSTÅND' }]]),
      humanPaths: new Set(),
    })
    t('R3: utåtriktad förmåga utan post i HUMAN_PATHS → RÖTT',
      r.problem.some((p) => p.regel === 'R3' && p.detalj.includes('HUMAN_PATHS')),
      JSON.stringify(r.problem.map((p) => p.regel)))
  }

  // ── VYKANARIEFÅGELN — codeMask är INTE utbytbar mot blankComments ──────────
  //
  // Skillnaden mellan de två vyerna är STRÄNGINNEHÅLLET: `blankComments` blankar
  // bara kommentarer, `codeMask` blankar kommentarer OCH stränginnehåll.
  // (Kommentarer är alltså blankade i BÅDA — den halvan skiljer dem inte åt, och
  // det är värt att veta innan man skriver provet.)
  //
  // Sänkorna är ANROP. Ett meddelande som NÄMNER en sänka — en felsträng, en
  // instruktion till modellen — är prosa, och måste förbli prosa. Med
  // `blankComments` börjar den räknas som kod, och verktyget får en förmåga det
  // inte har.
  //
  // Provet matar in exakt den formen och kräver att talen SKILJER SIG. Blir de
  // lika mäter vykravet ingenting, och då ska självtestet vara rött.
  {
    const medProsa = [
      'export class ToolExecutorService {',
      '  constructor(private readonly mailService: MailService) {}',
      '  async executeTool(name: string) {',
      '    switch (name) {',
      "      case 'zz_bara_prosa': {",
      '        await this.prisma.invoice.update({})',
      "        return { success: false, message: 'Anropa inte this.mailService.sendCustomEmail() direkt — köa i stället.' }",
      '      }',
      '    }',
      '  }',
      '}',
    ].join('\n')

    const at = new Set(['zz_bara_prosa'])
    const medCodeMask = sänkorPerVerktyg({
      exekverarRå: medProsa,
      exekverarKod: codeMask(medProsa),
      klasser,
      actionTools: at,
    })
    const medBlankComments = sänkorPerVerktyg({
      exekverarRå: medProsa,
      exekverarKod: blankComments(medProsa),
      klasser,
      actionTools: at,
    })
    t('VY: codeMask ser INGEN sänka — anropet står i en STRÄNG',
      medCodeMask.sänkor.size === 0,
      `sänkor=${medCodeMask.sänkor.size} case=${medCodeMask.antalCase}`)
    t('VY-NEGATIVKONTROLL: blankComments ger ANDRA tal — strängen räknas som kod',
      medBlankComments.sänkor.size !== medCodeMask.sänkor.size,
      `codeMask: sänkor=${medCodeMask.sänkor.size} · ` +
        `blankComments: sänkor=${medBlankComments.sänkor.size} ` +
        `${JSON.stringify([...medBlankComments.sänkor])}`)

    // ── OCH NAMNET MÅSTE KOMMA UR RÅTEXTEN ──────────────────────────────────
    // Under `codeMask` är `case '…'` blankat. Läses namnet ur masken i stället
    // för ur råtexten på samma offset heter varje verktyg tomma strängen, och
    // hela mängden kollapsar till EN post — tyst, och med rätt antal sänkor.
    const namnUrMasken = caseBlock(codeMask(EXEKVERARE_FIXTUR), codeMask(EXEKVERARE_FIXTUR))
    const namnUrRåtext = caseBlock(EXEKVERARE_FIXTUR, codeMask(EXEKVERARE_FIXTUR))
    t('VY: namnen läses ur RÅTEXTEN på maskens offset',
      namnUrRåtext.size === 5 && namnUrRåtext.has('mejla') && namnUrMasken.size < namnUrRåtext.size,
      `råtext=${namnUrRåtext.size} mask=${namnUrMasken.size} [${[...namnUrMasken.keys()].map((k) => JSON.stringify(k)).join(',')}]`)
  }

  // ── DEN DELADE KÄLLSKANNERNS EGNA KANARIEFÅGLAR ──────────────────────────
  // Vakten läser allt genom `codeMask`. Går skannern sönder blir VARJE konsument
  // röd, inte bara skannerns egen körning (#463). Kravet är dessutom mekaniskt:
  // check-guard-preprocessors.mjs R2 fäller en vakt som använder skannern utan
  // att pröva den.
  for (const f of kanariefåglar()) {
    fel++
    console.error(`  ❌ delad källskanner: ${f}`)
  }

  if (fel > 0) {
    console.error(`\nSJÄLVTEST: ${fel} kontroll(er) FÖLL.\n`)
    process.exit(1)
  }
  console.warn(
    '\n✅ Självtest grönt — omfångs-, regel-, R1-, R3- och VYkanariefåglarna fäller alla.\n',
  )
}

// ── main ────────────────────────────────────────────────────────────────────
//
// KÖRS BARA SOM PROGRAM, aldrig vid import. `check-self-tests-fail.mjs` och
// eventuella prov importerar filen för att kalla `evaluate` direkt; en main som
// kör vid import hade då startat en skarp granskning mitt i ett annat verktygs
// körning — och skrivit dess exitkod.
const ÄR_PROGRAM = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (ÄR_PROGRAM) {
  if (process.argv.includes('--self-test')) selfTest()
  else if (process.argv.includes('--skriv')) skriv()
  else kör()
}
