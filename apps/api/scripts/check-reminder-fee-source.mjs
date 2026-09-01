#!/usr/bin/env node
/**
 * CI-guard (G2 + G3) — skyddar BELOPPET på påminnelseavgiften.
 *
 * Två regler avgör vad som får krävas, och båda bor i `resolveReminderFee`
 * (apps/api/src/accounting/reminder-fee.ts):
 *
 *   AVTALSGRUND  — avgift får inte debiteras utan avtalsvillkor, och villkoret
 *                  binder bara framåt (2 § lagen 1981:739). Regeln själv bor i
 *                  `isReminderFeeContractuallyAllowed`.
 *   TAKET        — beloppet är lagstadgat och tvingande, också mot
 *                  näringsidkare (4 § och 6 § 1 st). Talet bor i
 *                  `REMINDER_FEE_MAX_SEK`.
 *
 * ── VARFÖR TYPSYSTEMET INTE RÄCKER ──────────────────────────────────────────
 *
 * `bookReminderFee` kräver `debtOrigin: DebtOriginDate | null` och `termsFrom`,
 * så BOKFÖRINGSSIDAN är skyddad av kompilatorn: en anropare som glömmer dem
 * kompilerar inte. Den klampar dessutom mot taket.
 *
 * Men avgiften skrivs på FLER ställen än verifikatet, och reskontran skrivs
 * FÖRST — utan att gå via `bookReminderFee`:
 *
 *   RentNotice.reminderFeeAmount   avi-vägens anspråk
 *   PaymentReminder.feeAmount      fakturavägens anspråk. Summeras rakt in i
 *                                  inkassounderlagets avgiftskolumn
 *                                  (collection-export.service.ts) — alltså ett
 *                                  krav mot hyresgästen, inte en notering.
 *   avgiftsraden på fakturan       det hyresgästen ser och ska betala
 *
 * En anropare som skriver något av dessa utan resolvern får ingen varning alls.
 * Utan avtalsgrund kräver reskontran en avgift huvudboken inte bär; utan
 * klampning kräver den ETT ANNAT BELOPP än huvudboken bokför. Båda är samma
 * divergens som #357 stängde, med omvänt tecken — den andra var mätt i en
 * bevisrigg innan resolvern fanns.
 *
 * ── VARFÖR RESOLVERN OCH INTE PREDIKATET ────────────────────────────────────
 *
 * Guarden krävde tidigare `isReminderFeeContractuallyAllowed`. Det kravet var
 * uppfyllt av en anropare som frågade om avtalsgrunden men skrev ett oklampat
 * belopp — vilket är precis vad båda anroparna gjorde. Att kräva resolvern är
 * strikt starkare: den anropar predikatet internt, så avtalsgrunden är kvar,
 * och den bär dessutom taket. En regel, ett anrop, en kontroll.
 *
 * Guarden matchar HOTET, inte en exakt sträng:
 *   • `rentNotice.create/createMany/update/updateMany/upsert` vars data sätter
 *     `reminderFeeAmount:` → MÅSTE föregås av `resolveReminderFee(`.
 *   • `paymentReminder.<samma verb>` vars data sätter `feeAmount:` → samma krav.
 *   • `invoiceLine.create/createMany` vars data bär
 *     `REMINDER_FEE_LINE_DESCRIPTION` → samma krav.
 *   • rå SQL som rör något av avgiftsfälten → kan inte verifieras statiskt.
 *
 * NOLLSTÄLLNING ÄR ALLTID TILLÅTEN. Att sätta avgiften till 0 kan aldrig
 * överdebitera någon — det är refuseringsvägen, annulleringens nollning
 * (`avisering.service.ts`) och de påminnelsetyper som aldrig bär avgift
 * (REMINDER_FRIENDLY, READY_FOR_COLLECTION). `: 0`, `new Prisma.Decimal(0)`
 * och `'0'` passerar därför utan resolver.
 *
 * ── VAD GUARDEN INTE TÄCKER ─────────────────────────────────────────────────
 *
 * Fakturans `total`-uppräkning granskas inte. Den sker med
 * `total: { increment: … }`, ett uttryck som används legitimt på flera håll, och
 * en generell regel där hade gett falsklarm utan att fånga något guarden inte
 * redan tar via avgiftsraden — uppräkningen ligger alltid i samma block som
 * raden. Skrivs total upp UTAN en avgiftsrad är det ett annat fel (total ≠ Σ
 * rader) och hör inte hemma här.
 *
 * ── TVÅ MASKER, OCH VARFÖR NOLLSTÄLLNINGEN KRÄVER DEN ANDRA ────────────────
 *
 * Guarden gick på råtexten, och närhetskontrollen var den känsligaste punkten:
 * `before.includes('resolveReminderFee(')` uppfylldes av en KOMMENTAR. Just den
 * här filen är full av kommentarblock som nämner resolvern — huvudkommentaren
 * ovan gör det ett dussin gånger — så en skrivning som glömt resolvern men
 * ligger efter ett stycke prosa OM den hade passerat tyst. Det är precis
 * förbiseendet vakten finns för.
 *
 * Men codeMask ensam hade gjort en LEGITIM skrivning röd. `isZeroing` känner
 * igen nollställningen även i strängform (`feeAmount: '0'`), och codeMask
 * blankar stränginnehåll — `'0'` blir `' '`, nollställningen försvinner och
 * refuseringsvägen hade börjat falla.
 *
 * Därför två masker, båda POSITIONSBEVARANDE, så samma index kan användas i
 * bägge:
 *
 *   kod            = codeMask       mutatoranropen, parentesmatchningen,
 *                                    fältnamnen, `REMINDER_FEE_LINE_DESCRIPTION`
 *                                    och närhetsfönstret.
 *   utanKommentarer = blankComments nollställningen (`'0'` är en sträng) och
 *                                    regel (3), rå SQL.
 *
 * Rent statiskt (fs-only, inga beroenden, ingen DB) → eget CI-steg utan databas.
 * Lokalt:      node apps/api/scripts/check-reminder-fee-source.mjs
 * Självtest:   node apps/api/scripts/check-reminder-fee-source.mjs --self-test
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { codeMask, blankComments, kanariefåglar } from '../../../scripts/lib/source-scan.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC_DIR = join(HERE, '..', 'src')

const RESOLVER = 'resolveReminderFee'
const FEE_LINE_CONST = 'REMINDER_FEE_LINE_DESCRIPTION'
// Hur långt före skrivningen resolvern måste synas (samma tx/funktionsblock).
//
// MÄTT, INTE GISSAT. Avståndet hos de tre legitima skrivarna:
//   avi-sidan        (rent-reminder.service.ts)        ~700 tecken
//   fakturamarkören  (payment-reminder.service.ts)    ~1 900 tecken
//   avgiftsraden     (payment-reminder.service.ts)    ~4 600 tecken
//
// Avgiftsradens avstånd är stort för att beloppet måste avgöras FÖRE anspråket
// medan raden skrivs EFTER det, med utförliga kommentarblock däremellan. 6000
// ger marginal utan att spänna över en typisk funktionsgräns — vid 4000 föll
// den legitima skrivaren, vilket är hur siffran hittades.
//
// ⚠️ VAD NÄRHETSKONTROLLEN INTE KAN — LÄS INNAN DU LITAR PÅ DEN.
//
// Regeln är "resolvern syns någonstans i de föregående 6000 tecknen", inte
// "resolverns svar styr just den här skrivningen". Den har därför en
// FALSK-GODKÄNN-RIKTNING: en skrivare som kringgår resolvern men råkar ligga
// inom fönstret från ett ORELATERAT resolver-anrop passerar tyst.
//
// Vakten fångar alltså FÖRBISEENDET — någon lägger till en avgiftsskrivning i
// en ny fil eller ett nytt block och glömmer beloppsreglerna. Den fångar inte
// ett kringgående som råkar hamna nära ett befintligt anrop, och den är inget
// skydd mot uppsåt. Samma avgränsning som brandet på DebtOriginDate: skydd mot
// misstaget, inte mot avsikten.
//
// ⚠️ VILL NÅGON HÖJA TALET ÄR DET ETT SYMTOM, INTE EN LÖSNING. Växer avståndet
// mellan resolvern och skrivningen betyder det att de glidit isär i koden —
// och ju större fönstret blir, desto fler orelaterade anrop kan råka godkänna
// en skrivning. Flytta koden så att beslutet och skrivningen står nära
// varandra. Höj inte fönstret för att slippa göra det.
const PRECEDING_WINDOW = 6000 // tecken

/**
 * Slutindex (exklusivt) för anropet som börjar vid `openParenIdx`.
 *
 * Körs ENBART mot codeMask-utdata, där ett `')'` i en literal är blankat och
 * inte längre kan stänga anropet. Att returnera ett INTERVALL i stället för en
 * delsträng är avsiktligt: samma index gäller i `blankComments`-masken, som är
 * lika lång, så nollställningen kan läsas ur strängvyn av exakt samma anrop.
 */
function callEnd(kod, openParenIdx) {
  let depth = 0
  for (let i = openParenIdx; i < kod.length; i++) {
    const ch = kod[i]
    if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth === 0) return i + 1
    }
  }
  return kod.length
}

const lineOf = (text, idx) => text.slice(0, idx).split('\n').length

/** Sätts avgiften till noll? Då kan den aldrig överdebitera. */
function isZeroing(call, field) {
  return (
    new RegExp(`\\b${field}\\s*:\\s*0\\b`).test(call) ||
    new RegExp(`\\b${field}\\s*:\\s*new\\s+Prisma\\.Decimal\\(\\s*0\\s*\\)`).test(call) ||
    new RegExp(`\\b${field}\\s*:\\s*['"]0(\\.0+)?['"]`).test(call)
  )
}

/**
 * Reskontraskrivningarna: modell + fält som bär ett avgiftsbelopp.
 *
 * `true` i `select`/`include` matchar samma fältnamn men står aldrig i en
 * skrivnings `data` — och en läsning kan inte överdebitera. Träffas ändå ett
 * `select` inne i en `update`-call räddas den av nollställningsregeln bara om
 * värdet är 0; annars är det ett falsklarm att fixa här, inte att tysta.
 */
const LEDGER_WRITES = [
  {
    model: 'rentNotice',
    field: 'reminderFeeAmount',
    detail:
      'Avgiften får inte krävas i reskontran utan avtalsgrund, och aldrig med ett ' +
      'belopp över det lagstadgade taket — grinden i bookReminderFee hinner inte ' +
      'stoppa det, markeringen skrivs före bokföringen.',
  },
  {
    model: 'paymentReminder',
    field: 'feeAmount',
    detail:
      'PaymentReminder.feeAmount summeras rakt in i inkassounderlagets ' +
      'avgiftskolumn (collection-export.service.ts) — det är ett krav mot ' +
      'hyresgästen och måste bära samma belopp som verifikatet.',
  },
]

/**
 * Skanna EN källfils text → lista med regelbrott. Exporterad så självtestet kör
 * exakt samma kod som CI.
 */
export function scanSource(text, relPath) {
  const violations = []
  let m

  // Två masker, samma längd och samma index. Se huvudkommentaren.
  const kod = codeMask(text)
  const utanKommentarer = blankComments(text)

  // (1) reskontramarkeringarna på avin och på påminnelsen.
  for (const { model, field, detail } of LEDGER_WRITES) {
    const re = new RegExp(`\\b${model}\\s*\\.\\s*(create|createMany|update|updateMany|upsert)\\s*\\(`, 'g')
    while ((m = re.exec(kod))) {
      const method = m[1]
      const openParen = kod.indexOf('(', m.index + m[0].length - 1)
      const slut = callEnd(kod, openParen)
      const call = kod.slice(openParen, slut)
      if (!new RegExp(`\\b${field}\\s*:`).test(call)) continue
      // Nollställningen läses ur STRÄNGVYN: `feeAmount: '0'` är en sträng, och
      // i codeMask är den blankad. Samma index — maskerna är lika långa.
      if (isZeroing(utanKommentarer.slice(openParen, slut), field)) continue

      // Närhetsfönstret i KOD: en kommentar som nämner resolvern är inget anrop.
      const before = kod.slice(Math.max(0, m.index - PRECEDING_WINDOW), m.index)
      if (!before.includes(`${RESOLVER}(`)) {
        violations.push({
          line: lineOf(kod, m.index),
          rule: `${model}.${method}() sätter ${field} utan ${RESOLVER}(...)`,
          detail,
        })
      }
    }
  }

  // (2) avgiftsraden på fakturan.
  const lineRe = /\binvoiceLine\s*\.\s*(create|createMany)\s*\(/g
  while ((m = lineRe.exec(kod))) {
    const method = m[1]
    const openParen = kod.indexOf('(', m.index + m[0].length - 1)
    const call = kod.slice(openParen, callEnd(kod, openParen))
    if (!call.includes(FEE_LINE_CONST)) continue

    const before = kod.slice(Math.max(0, m.index - PRECEDING_WINDOW), m.index)
    if (!before.includes(`${RESOLVER}(`)) {
      violations.push({
        line: lineOf(kod, m.index),
        rule: `invoiceLine.${method}() skriver avgiftsraden utan ${RESOLVER}(...)`,
        detail:
          'Fakturan får inte kräva en påminnelseavgift utan avtalsgrund, och aldrig ' +
          'ett belopp över taket. Låt resolvern avgöra beloppet före anspråket.',
      })
    }
  }

  // (3) rå SQL som rör något av avgiftsfälten.
  // Kolumnnamnen står i en SQL-sträng — därför strängvyn, inte codeMask.
  const rawFields = LEDGER_WRITES.map((w) => w.field.toLowerCase())
  utanKommentarer.split('\n').forEach((ln, i) => {
    const lower = ln.toLowerCase()
    if (
      /\$(executeRaw|executeRawUnsafe|queryRaw|queryRawUnsafe)/.test(ln) &&
      rawFields.some((f) => lower.includes(f))
    ) {
      violations.push({
        line: i + 1,
        rule: 'rå SQL mot ett avgiftsfält',
        detail: 'Rå SQL kan inte verifieras statiskt — gå via Prisma och resolvern.',
      })
    }
  })

  return violations.map((v) => ({ ...v, file: relPath }))
}

function* walk(dir) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name)
    if (ent.isDirectory()) yield* walk(p)
    else if (ent.name.endsWith('.ts') && !ent.name.endsWith('.spec.ts')) yield p
  }
}

// ── självtest ────────────────────────────────────────────────────────────────
const GOOD = [
  [
    'avi-markering med resolvern före',
    `const safeFee = ${RESOLVER}(fee, debtOrigin, termsFrom).amount\n` +
      `await tx.rentNotice.updateMany({ where: { id }, data: { reminderFeeAmount: new Prisma.Decimal(safeFee.toFixed(2)) } })`,
  ],
  [
    'påminnelsemarkör med resolvern före',
    `const safeFee = ${RESOLVER}(fee, debtOrigin, termsFrom).amount\n` +
      `await tx.paymentReminder.createMany({ data: [{ invoiceId, type: 'REMINDER_FORMAL', feeAmount: new Prisma.Decimal(safeFee.toFixed(2)) }] })`,
  ],
  [
    'avgiftsrad med resolvern före',
    `const safeFee = ${RESOLVER}(fee, debtOrigin, termsFrom).amount\n` +
      `await tx.invoiceLine.create({ data: { description: ${FEE_LINE_CONST}, total: safeFee } })`,
  ],
  [
    'nollställning utan resolver (kan aldrig överdebitera)',
    `await tx.rentNotice.updateMany({ where: { id }, data: { reminderFeeAmount: 0 } })`,
  ],
  [
    'nollställning via Decimal',
    `await tx.rentNotice.update({ where: { id }, data: { reminderFeeAmount: new Prisma.Decimal(0) } })`,
  ],
  [
    'påminnelse utan avgift (REMINDER_FRIENDLY)',
    `await this.prisma.paymentReminder.create({ data: { invoiceId, type: 'REMINDER_FRIENDLY', feeAmount: 0 } })`,
  ],
  [
    'läsning av avgiften',
    `const fee = Number(notice.reminderFeeAmount)\nselect: { reminderFeeAmount: true }`,
  ],
  [
    'annan avi-skrivning utan avgiften',
    `await tx.rentNotice.updateMany({ where: { id }, data: { status: 'CANCELLED' } })`,
  ],
  [
    'leveranskorrelation utan avgiften',
    `await this.prisma.paymentReminder.updateMany({ where: { invoiceId }, data: { emailMessageId: key } })`,
  ],
  [
    'annan fakturarad',
    `await tx.invoiceLine.create({ data: { description: 'Hyra juli', total: 7355 } })`,
  ],
]

const BAD = [
  [
    'avi-markering utan resolver',
    `await tx.rentNotice.updateMany({ where: { id }, data: { collectionStage: 'REMINDED', reminderFeeAmount: new Prisma.Decimal(60) } })`,
  ],
  [
    'avi-create med avgift utan resolver',
    `await tx.rentNotice.create({ data: { reminderFeeAmount: fee, totalAmount } })`,
  ],
  [
    'påminnelsemarkör med avgift utan resolver',
    `await tx.paymentReminder.createMany({ data: [{ invoiceId, type: 'REMINDER_FORMAL', feeAmount: new Prisma.Decimal(fee) }] })`,
  ],
  [
    'avgiftsrad utan resolver',
    `await tx.invoiceLine.create({ data: { description: ${FEE_LINE_CONST}, total: fee } })`,
  ],
  [
    'rå SQL mot avi-avgiften',
    `await this.prisma.$executeRawUnsafe('UPDATE "RentNotice" SET "reminderFeeAmount" = 60')`,
  ],
  [
    'rå SQL mot påminnelseavgiften',
    `await this.prisma.$executeRawUnsafe('UPDATE "PaymentReminder" SET "feeAmount" = 500')`,
  ],
  [
    // Kärnan i G3: predikatet ensamt räckte förr, och just den formen skrev
    // reskontran med ett oklampat belopp. Den får inte passera igen.
    'predikatet ensamt — avtalsgrund utan tak',
    `const safeFee = isReminderFeeContractuallyAllowed(debtOrigin, termsFrom) ? begärd : 0\n` +
      `await tx.rentNotice.updateMany({ where: { id }, data: { reminderFeeAmount: new Prisma.Decimal(safeFee) } })`,
  ],
  // ── MASKEN: fyra fall som RÅTEXTVERSIONEN klassade fel ────────────────────
  [
    'MASK: resolvern nämns bara i en KOMMENTAR före skrivningen',
    `// beloppet är redan klampat av resolveReminderFee( ovan i anroparen\n` +
      `await tx.rentNotice.updateMany({ where: { id }, data: { reminderFeeAmount: new Prisma.Decimal(60) } })`,
  ],
  [
    'MASK: skrivningen efter en sträng som innehåller `)`',
    `await tx.paymentReminder.create({ data: { note: 'avgift (lagstadgad)', feeAmount: new Prisma.Decimal(60) } })`,
  ],
  [
    'MASK: rå SQL i en MALLSTRÄNG — skärpan får inte försvinna',
    'await this.prisma.$executeRawUnsafe(`UPDATE "RentNotice" SET "reminderFeeAmount" = 60`)',
  ],
  [
    'MASK: skrivning efter en regex-literal med citattecken',
    `const e = s.replace(/"/g, '&quot;')\n` +
      `await tx.rentNotice.create({ data: { reminderFeeAmount: fee } })`,
  ],
]

// Fall som ska förbli GRÖNA och som isolerar den andra riktningen: en mask för
// mycket gör en LEGITIM skrivning röd.
const MASK_GOOD = [
  [
    'MASK: nollställning i STRÄNGFORM (codeMask ensam hade fällt den)',
    `await tx.rentNotice.updateMany({ where: { id }, data: { reminderFeeAmount: '0' } })`,
  ],
  [
    'MASK: nollställning i strängform med decimaler',
    `await tx.paymentReminder.create({ data: { invoiceId, feeAmount: '0.00' } })`,
  ],
  [
    'MASK: en UTKOMMENTERAD överträdelse är ingen överträdelse',
    `// await tx.rentNotice.create({ data: { reminderFeeAmount: fee } })  — ALDRIG utan resolvern`,
  ],
  [
    'MASK: ett fältnamn i en loggsträng är ingen skrivning',
    `this.logger.warn('kunde inte sätta reminderFeeAmount: saknar avtalsgrund')`,
  ],
]

// ── OMFÅNGSKANARIEFÅGEL ─────────────────────────────────────────────────────
//
// Lärdomen av R5. Brottmängden är tom i friskt läge och duger inte som bevis.
// Tre mängder kan krympa tyst och lämnar vakten grön:
//
//   • filerna `walk` hittar,
//   • reskontramutatorerna regeln alls granskar,
//   • resolveranropen. Noll av dem betyder att sanningskällan försvunnit —
//     och då vaktar regeln en invariant ingen längre håller.
//
// Golv MÄTTA mot e9aea18: 447 filer, 35 mutatorer, 3 resolveranrop.
const MIN_FILER = 300
const MIN_MUTATORER = 15
const MIN_RESOLVERANROP = 2

function omfångskanariefågel() {
  let filer = 0
  let mutatorer = 0
  let resolveranrop = 0
  const mutRe = new RegExp(
    `\\b(${LEDGER_WRITES.map((w) => w.model).join('|')})\\s*\\.\\s*(create|createMany|update|updateMany|upsert)\\s*\\(`,
    'g',
  )
  for (const f of walk(SRC_DIR)) {
    filer++
    const kod = codeMask(readFileSync(f, 'utf8'))
    mutatorer += (kod.match(mutRe) ?? []).length
    resolveranrop += (kod.match(new RegExp(`\\b${RESOLVER}\\(`, 'g')) ?? []).length
  }
  const fel = []
  if (filer < MIN_FILER) fel.push(`omfång: ${filer} filer skannade, golv ${MIN_FILER}`)
  if (mutatorer < MIN_MUTATORER)
    fel.push(`omfång: ${mutatorer} reskontramutatorer i KOD, golv ${MIN_MUTATORER}`)
  if (resolveranrop < MIN_RESOLVERANROP)
    fel.push(`omfång: ${resolveranrop} ${RESOLVER}-anrop i KOD, golv ${MIN_RESOLVERANROP}`)
  return { fel, mätt: { filer, mutatorer, resolveranrop } }
}

function selfTest() {
  let ok = true

  // (0) Den delade skannerns kanariefåglar — metavaktens R2.
  const skanner = kanariefåglar()
  if (skanner.length) {
    ok = false
    console.error(`✗ DEN DELADE SKANNERN ÄR TRASIG: ${skanner.join(' | ')}`)
  }

  for (const [label, code] of [...GOOD, ...MASK_GOOD]) {
    const v = scanSource(code, `good:${label}`)
    if (v.length !== 0) {
      ok = false
      console.error(`✗ GOOD "${label}" gav ${v.length} falsklarm:`, v)
    }
  }
  for (const [label, code] of BAD) {
    const v = scanSource(code, `bad:${label}`)
    if (v.length === 0) {
      ok = false
      console.error(`✗ BAD "${label}" fångades INTE — guarden har inga tänder där`)
    }
  }
  const omf = omfångskanariefågel()
  if (omf.fel.length) {
    ok = false
    console.error(`✗ OMFÅNGET HAR KRYMPT: ${omf.fel.join(' | ')}`)
  }

  if (!ok) process.exit(1)
  console.log(
    `✓ självtest: ${GOOD.length + MASK_GOOD.length} tillåtna, ${BAD.length} otillåtna — alla klassade rätt; ` +
      'skannerns 7 kanariefåglar gröna',
  )
  console.log(
    `✓ omfång: ${omf.mätt.filer} filer (golv ${MIN_FILER}), ${omf.mätt.mutatorer} reskontramutatorer ` +
      `(golv ${MIN_MUTATORER}), ${omf.mätt.resolveranrop} resolveranrop (golv ${MIN_RESOLVERANROP})`,
  )
}

if (process.argv.includes('--self-test')) {
  selfTest()
} else {
  const alla = []
  for (const file of walk(SRC_DIR)) {
    alla.push(...scanSource(readFileSync(file, 'utf8'), relative(join(HERE, '..', '..', '..'), file)))
  }
  if (alla.length > 0) {
    console.error('\nPÅMINNELSEAVGIFT MED OPRÖVAT BELOPP — skrivare som kringgår resolvern:\n')
    for (const v of alla) {
      console.error(`  ${v.file}:${v.line}\n    ${v.rule}\n    ${v.detail}\n`)
    }
    console.error(
      `Avgiftens belopp ska alltid komma ur ${RESOLVER}(...) — den bär både\n` +
        'avtalsgrunden (2 §) och det lagstadgade taket (4 §, 6 § 1 st).\n' +
        'Reglerna bor i apps/api/src/accounting/reminder-fee.ts och ska bara uttryckas där.\n',
    )
    process.exit(1)
  }
  console.log('✓ varje skrivare av påminnelseavgiften går genom resolvern (avtalsgrund + tak)')
}
