#!/usr/bin/env node
/**
 * VARJE @Cron MÅSTE NÅ EN VARAKTIG FELSÄNKA (#605).
 *
 * ── VAD SOM MÄTTES ──────────────────────────────────────────────────────────
 *
 * Mot `befee7b`, per METODKROPP och med `*Unsafe`-delegaten följd:
 *
 *     25 @Cron-jobb
 *      0  skriver till ErrorLog
 *     12  har någon varaktig rapportväg (Sentry direkt, runCronSafely,
 *         forEachOrgSafely)
 *     13  har ENDAST den lokala loggen
 *
 * En filnivå-mätning gav först 17 via `runCronSafely` — fel, eftersom
 * `notifications.service.ts` använder hjälparen för TVÅ ANDRA jobb än
 * morgonrapporten. Talet 12 gäller per jobb; skillnaden är hela poängen med att
 * mäta metodkroppen.
 *
 * Den lokala loggen överlever inte containern: 204 merges till main på 30 dagar
 * betyder minst lika många containerbyten. Ett cron-fel från förra veckan finns
 * ingenstans att fråga efter.
 *
 * ── DEN FARLIGA FORMEN ──────────────────────────────────────────────────────
 *
 * 5 av 25 fångar fel INUTI en loop, räknar upp en räknare, fortsätter, och
 * loggar sedan en summering på `log`-nivå:
 *
 *     reclassifyProbableLosses · escalateRemindedToInkassoReady
 *     sendMorningInsights · sendWeeklySummary · sendMonthlyReport
 *
 * Körningen rapporterar "3 skickade, 2 misslyckade" och SER LYCKAD UT. En kund
 * som slutat få sin morgonrapport syns som ett tal i en logg som roteras bort.
 *
 * ── VAD REGELN FRÅGAR ───────────────────────────────────────────────────────
 *
 * Inte "finns det felhantering" — det finns det, och den är just problemet.
 * Utan: NÅR jobbet sänkan? Alltså om jobbets kropp (eller dess `*Unsafe`-
 * delegat) skickar en `sink` till cron-hjälparna, eller anropar sänkans
 * rapportmetod direkt.
 *
 * BÅDE mängden cron-jobb OCH sänkans metodnamn HÄRLEDS ur koden. Ingen av dem
 * listas — samma läxa som #600: en uppräkning blir tyst grön den dag något
 * döps om eller läggs till.
 *
 * ── ANDRA VÄGEN: `@SinkIn`-DEKLARATIONEN (#619) ─────────────────────────────
 *
 * Ligger sänkan i den INRE tjänsten ser avgränsningen ovan den inte. Jobbet
 * pekar då ut målet med `@SinkIn(Tjänst, 'metod')`, och vakten SLÅR UPP det:
 * pekar deklarationen på en metod som inte når sänkan är den RÖD. En
 * deklaration som bara lästes hade flyttat kvitteringslistans defekt in i
 * syntaxen.
 *
 * Anropsföljning valdes bort, och det var en MÄTNING och inte en smak — talen
 * står i `src/common/cron/sink-in.decorator.ts`. Kort: den hade fångat 1 av 2
 * fall och gjort vaktens svar beroende av redigeringar i andra filer
 * (`MailService` anropas ur 5 cron-jobb, `LockService` ur 7).
 *
 * ── VAD DEN HÄR VAKTEN INTE KAN SE ──────────────────────────────────────────
 *
 * Den läser KÄLLTEXT och mäter att mekanismen är PÅKOPPLAD. Den kan inte se att
 * sänkan gör något i runtime: görs `CronErrorSink.report` till en no-op är den
 * här vakten fortfarande grön. Det ägs av `cron-error-sink.db.spec.ts` och de
 * riggar som skriver mot en riktig databas — uppmätt i #605.
 *
 * Deklarationsvägen har två egna gränser. Den följer EXAKT ett steg: når målet
 * sänkan via ännu en nivå syns det inte, och då krävs en `@SinkIn` som pekar
 * hela vägen. Och den matchar på KLASSNAMN, inte på injektionen — två
 * exporterade klasser med samma namn i olika filer ger den sista, vilket i dag
 * inte förekommer men inte är hindrat.
 *
 * Kör:        node apps/api/scripts/check-cron-error-sink.mjs
 * Självtest:  node apps/api/scripts/check-cron-error-sink.mjs --self-test
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { blankComments, codeMask, kanariefåglar } from '../../../scripts/lib/source-scan.mjs'
import { findCronJobs } from './check-cron-classification.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..', 'src')
const SINK_FILE = join(SRC, 'common', 'cron', 'cron-error-sink.ts')
const ACK_FILE = join(HERE, 'cron-error-sink.ack.json')
const MIN_SKÄL = 40

/** Identifierare är UNICODE, inte `\w` (#640). Samma form som i klassificeringsvakten. */
const IDENT = '[\\p{L}\\p{N}_$]+'

/**
 * HUR MAN UPPFYLLER REGELN — RÄTT.
 *
 * Det här är med flit den FÖRSTA texten en fällning visar, och kvitteringen
 * står sist. En vakt som bara dokumenterar hur man tystar den kommer att tystas:
 * nästa person läser under tidspress, och den enda vägen som står skriven är
 * den hen tar.
 *
 * Exemplet är den riktiga konverteringen av morgonrapporten (#605 batch 1).
 */
const RÄTT_VÄG = [
  'Ett fel här lever bara i containerns logg, som inte överlever nästa deploy.',
  '',
  'SÅ HÄR GÖR DU RÄTT — två vägar, båda beprövade i batch 1:',
  '',
  '  (1) Går jobbet redan via cron-hjälparna? Skicka sänkan som option:',
  '        await runCronSafely(namn, () => this.gör(), { logger, sink: this.cronErrors })',
  '        await forEachOrgSafely(namn, orgar, fn, { orgIdOf: o => o.id, sink: this.cronErrors })',
  '',
  '  (2) Fångar jobbet per organisation i en egen loop? Lägg rapporten BREDVID',
  '      den befintliga logger.error — aldrig i stället för:',
  '        } catch (err) {',
  '          this.logger.error(`… ${org.id}: ${String(err)}`)   // ← står kvar',
  '          await this.cronErrors.report(namn, err, {',
  '            organizationId: org.id,',
  '            detail: { steg: "generering" },',
  '          })',
  '          failed++',
  '        }',
  '',
  '  Injicera CronErrorSink i konstruktorn och importera CronErrorSinkModule i',
  '  modulen. Vakten härleder bindningen ur typen, så namnet spelar ingen roll.',
  '',
  'INGET FÅR BLI TYSTARE. Sänkan läggs TILL; den ersätter aldrig en logg. Byter',
  'du en synlig utskrift mot en rad ingen läser har du gjort saken värre.',
  '',
  'Går det verkligen inte nu: kvittera i cron-error-sink.ack.json med ett skäl',
  'som säger VARFÖR och VEM som äger konverteringen. Kvitteringen är den SÄMRE',
  'utvägen och listan fäller åt båda hållen — den dag jobbet når sänkan blir en',
  'kvarglömd post röd.',
].join('\n   ')

/** Alla .ts under src, utom specar. */
export function källfiler(dir = SRC, ut = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) källfiler(p, ut)
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts')) ut.push(p)
  }
  return ut
}

/**
 * Sänkans rapportmetod(er), HÄRLEDDA ur klassen.
 *
 * Formen: en publik `async`-metod på `CronErrorSink` vars första parameter är
 * `cronName: string`. Det är vad som gör en metod till en rapportväg, och det
 * går inte att råka uppfylla. Döps `report` om följer vakten med.
 */
export function härledSänkmetoder(sinkText) {
  const kod = codeMask(sinkText)
  // Unicode, inte `\w` (#640) — se IDENT-docblocket i check-cron-classification.mjs.
  const re = new RegExp(`\\basync\\s+(${IDENT})\\s*\\(\\s*cronName\\s*:\\s*string\\s*,`, 'gu')
  return [...kod.matchAll(re)].map((m) => m[1])
}

/**
 * Metodkroppen för `metod`, klammerbalanserad, ur en KOD-mask.
 *
 * ── VARFÖR DEN INTE FÅR LETA EFTER "FÖRSTA { EFTER NAMNET" (#619) ───────────
 *
 * Första lydelsen ankrade med `\\([^)]*\\)\\s*:[^{]*\\{` och tog sedan
 * `indexOf('{')`. Båda halvorna stannar för tidigt, och BÅDA gör det TYST —
 * utfallet är inte ett fel utan en för kort kropp, som en regel läser som
 * "mönstret finns inte här".
 *
 *   1. `[^{]*` stannar på en klammer i RETURTYPEN:
 *
 *        async runBackup(): Promise<{ key: string; bytes: number }> {
 *
 *      Kroppen blev de 46 tecknen `{ key: string; bytes: number }` — själva
 *      typen. Sänkanropet på rad 531 i backup.service.ts låg utanför, och
 *      vakten svarade "når inte sänkan" om ett jobb som når den.
 *
 *   2. `[^)]*` stannar på en parentes i en PARAMETERTYP, varpå reservankaret
 *      tar `indexOf('{')` — som då kan landa i en parameters objekttyp:
 *
 *        closePeriod(orgId: string, opts: { actorRole?: UserRole }): Promise<void> {
 *
 * UPPMÄTT över `apps/api/src` med den gamla lydelsen, där varje träff bevisats
 * genom att KÖRA funktionen och se att kroppen saknar radbrytning:
 *
 *     75 metoder i 46 filer  fick en TYP i stället för en kropp
 *      0 av vaktens dåvarande mätyta (26 cron-metoder + *Unsafe) drabbade
 *
 * Defekten var alltså latent: den hade aktiverats i samma stund vakten börjat
 * följa anrop ut ur cron-metoden. Se #619.
 *
 * ── VAD DEN HÄR LYDELSEN GÖR ────────────────────────────────────────────────
 *
 * Hoppar över parameterlistan BALANSERAT, och därefter över returtypen genom
 * att pröva varje `{`: bär den en typ följs dess matchande `}` av fortsatt
 * typsyntax (`>`, `|`, `&`, `[`, eller nästa `{`), och då är det inte kroppen.
 *
 * ── VAD DEN INTE KAN SE ─────────────────────────────────────────────────────
 *
 * Den mäter TEXT, inte typer. En returtyp som slutar på ett tecken utanför
 * mängden ovan skulle läsas som kroppens början. Den känner inte heller
 * överlagrade signaturer — första träffen på namnet vinner. Båda är kända och
 * otäckta; kanariefågeln i självtestet prövar den form som faktiskt fällde.
 */
export function metodkropp(kod, metod) {
  const TYPEN_FORTSÄTTER = new Set(['>', '|', '&', '[', '{'])

  /** Index efter den balanserade `(…)` som börjar på `från`, annars -1. */
  const efterParameterlistan = (från) => {
    let djup = 0
    for (let j = från; j < kod.length; j++) {
      if (kod[j] === '(') djup++
      else if (kod[j] === ')') {
        djup--
        if (djup === 0) return j + 1
      }
    }
    return -1
  }

  /** Index efter den balanserade `{…}` som börjar på `från`, annars -1. */
  const efterBlock = (från) => {
    let djup = 0
    for (let j = från; j < kod.length; j++) {
      if (kod[j] === '{') djup++
      else if (kod[j] === '}') {
        djup--
        if (djup === 0) return j + 1
      }
    }
    return -1
  }

  // VARJE förekomst av namnet prövas, och den FÖRSTA som ser ut som en
  // DEKLARATION vinner. Ett bart namn-ankare räcker inte:
  // `await this.runBackup()` står ofta före deklarationen i filen, och då
  // mäts fel kropp. Uppmätt under #619 — den lydelsen sänkte täckningen från
  // 24 till 18 jobb, alltså ett fel åt SAMMA håll som defekten den skulle laga.
  const träffar = [...kod.matchAll(new RegExp(`(?<![\\p{L}\\p{N}_$])${metod}\\s*\\(`, 'gu'))]
  for (const träff of träffar) {
    // Ett anrop: `this.metod(`, `x.metod(`. Aldrig en deklaration.
    if (/[.?]\s*$/.test(kod.slice(Math.max(0, träff.index - 2), träff.index))) continue

    let i = efterParameterlistan(kod.indexOf('(', träff.index))
    if (i < 0) continue

    // En DEKLARATION följs av `:` (returtyp) eller direkt av kroppens `{`.
    const efterParen = /\S/.exec(kod.slice(i))
    if (!efterParen || (efterParen[0] !== ':' && efterParen[0] !== '{')) continue

    // RETURTYPEN. Kroppens `{` är den vars matchande `}` INTE följs av
    // fortsatt typsyntax — det är den halvan som fällde `runBackup`.
    for (; i < kod.length; i++) {
      if (kod[i] !== '{') continue
      const slut = efterBlock(i)
      if (slut < 0) return kod.slice(i)
      const efter = /\S/.exec(kod.slice(slut))
      if (efter && TYPEN_FORTSÄTTER.has(efter[0])) {
        i = slut - 1
        continue
      }
      return kod.slice(i, slut)
    }
  }
  return ''
}

/**
 * Namnen som är BUNDNA till `CronErrorSink` i filen — härledda ur injektionen.
 *
 * ── VARFÖR INTE BARA LETA EFTER `.report(` ─────────────────────────────────
 *
 * Det var första versionen, och den gav ett FALSKT POSITIVT åt det farligaste
 * hållet. `ai-retention.service.ts` har en egen metod som heter `report`:
 *
 *     this.report(outcome)      ← tjänstens egen utfallsrapport, inte sänkan
 *
 * Vakten sa alltså "täckt" om ett jobb som inte var det. En vakt som ljuger åt
 * det hållet är värre än ingen vakt: den stänger frågan.
 *
 * Formen är därför BINDNINGEN: en konstruktorparameter eller ett fält vars typ
 * är `CronErrorSink`. Typnamnet härleds i sin tur ur sänkans egen fil, så en
 * omdöpning följer med.
 */
export function härledSänkbindningar(text, klassnamn) {
  const kod = codeMask(text)
  return [
    ...kod.matchAll(new RegExp(`(?:private|public|protected|readonly|\\s)\\s*(${IDENT})\\s*:\\s*${klassnamn}(?![\\p{L}\\p{N}_$])`, 'gu')),
  ].map((m) => m[1])
}

/** Klassnamnet på sänkan, härlett ur dess fil. */
export function härledSänkklass(sinkText) {
  const m = new RegExp(`export\\s+class\\s+(${IDENT})`, 'u').exec(codeMask(sinkText))
  return m ? m[1] : null
}

/**
 * Når jobbet sänkan?
 *
 * Kräver BÅDE att filen binder en `CronErrorSink` OCH att jobbets kropp
 * använder just den bindningen — som `sink:`-option till cron-hjälparna, eller
 * genom att anropa en av sänkans härledda rapportmetoder på den.
 *
 * Kroppen är jobbets metod PLUS dess `*Unsafe`-delegat i samma fil — det är dit
 * varje låst cron flyttar sitt riktiga arbete, och där felhanteringen bor.
 */
export function nårSänkan(text, metod, sänkmetoder, bindningar) {
  if (!bindningar || bindningar.length === 0) return false
  const kod = codeMask(text)
  const unsafe = `${metod}Unsafe`
  const allt = metodkropp(kod, metod) + '\n' + (kod.includes(unsafe) ? metodkropp(kod, unsafe) : '')
  for (const b of bindningar) {
    // …som option till en cron-hjälpare
    if (new RegExp(`(?<![\\p{L}\\p{N}_$])sink\\s*:\\s*[\\p{L}\\p{N}_$.]*(?<![\\p{L}\\p{N}_$])${b}(?![\\p{L}\\p{N}_$])`, 'u').test(allt)) return true
    // …eller genom ett direkt anrop på bindningen
    if (sänkmetoder.some((m) => new RegExp(`(?<![\\p{L}\\p{N}_$])${b}\\s*\\.\\s*${m}\\s*\\(`, 'u').test(allt))) return true
  }
  return false
}

/**
 * `@SinkIn(Klass, 'metod')` för ett givet jobb — HÄRLEDD UR KODEN.
 *
 * Formen är densamma som `findCronJobs` använder: dekoratorn måste sitta
 * INTILL metoden, inte någonstans i filen. En deklaration som får sväva fritt
 * är en kommentar med parenteser.
 *
 * ── TVÅ VYER, FÖR DEN HÄR FRÅGAN BEHÖVER BÅDA ──────────────────────────────
 *
 * Deklarationens två halvor bor på olika ställen, och en enda vy gör den ena
 * oläsbar:
 *
 *   KLASSNAMNET  är en identifierare  → bor i KOD      → `codeMask`
 *   METODNAMNET  är en strängliteral  → bor i STRÄNG   → `blankComments`
 *
 * Första lydelsen ställde båda frågorna mot `codeMask`, som blankar
 * stränginnehåll. Resultatet var inte ett fel utan ett TOMT metodnamn:
 *
 *     @SinkIn pekar på `BackupService::         `, som INTE når sänkan
 *
 * Vakten hade då fällt varje giltig deklaration — och åt det farligare hållet:
 * hade uppslaget i stället råkat lyckas på en tom sträng vore den grön om allt.
 * Fångad av vaktens egen paritetskontroll, inte av läsning.
 *
 * KOD-vyn är fortfarande rätt fråga för HITTANDET: en utkommenterad `@SinkIn`
 * ska inte räknas som en deklaration. Båda vyerna bevarar längd och
 * radbrytningar, så samma index gäller i båda — därför läses strängen ur
 * sträng-vyn på kod-vyns träffposition.
 */
export function härledSinkIn(text, metod) {
  const kod = codeMask(text)
  const strängar = blankComments(text)
  // IDENT ÄR UNICODE, INTE `\w`. `\w` är ASCII: `InreTjänst` och `Förvaltning`
  // matchas INTE, och utfallet är inte ett fel utan en deklaration som aldrig
  // hittas — alltså ett jobb som läses som osänkat. I en kodbas som skriver
  // svenska är det inte ett hörnfall. Fångat av kanariefågeln nedan, vars
  // fixturklasser heter `InreTjänst`/`TystTjänst` just därför.
  const IDENT = '[\\p{L}\\p{N}_$]+'
  const re = new RegExp(
    `@SinkIn\\(\\s*(${IDENT})\\s*,\\s*'([^']*)'\\s*\\)[\\s\\S]{0,200}?\\n\\s*(?:private |public )?(?:async )?(${IDENT})\\s*\\(`,
    'gu',
  )
  for (const m of kod.matchAll(re)) {
    if (m[3] !== metod) continue
    const iSträng = new RegExp(`@SinkIn\\(\\s*${IDENT}\\s*,\\s*'([^']*)'`, 'u').exec(
      strängar.slice(m.index, m.index + m[0].length),
    )
    // Tom sträng är INTE ett giltigt metodnamn. Utan det här faller vi tillbaka
    // på ett uppslag mot '' — som antingen fäller allt eller släpper igenom
    // allt, beroende på hur `metodkropp` råkar bete sig på tomma namn.
    const metodnamn = iSträng?.[1] ?? ''
    if (metodnamn.trim() === '') return { tjänst: m[1], metod: '', tomt: true }
    return { tjänst: m[1], metod: metodnamn }
  }
  return null
}

/**
 * Klassnamn → filtext, för att kunna SLÅ UPP en deklarations mål.
 *
 * Kollisioner: två klasser med samma namn i olika filer ger den sista. Det är
 * en känd gräns — men en `@SinkIn` som pekar på ett tvetydigt klassnamn är ett
 * problem i koden innan det är ett problem i vakten, och `tsc` fäller redan en
 * import som inte går ihop.
 */
export function klassindex(filer) {
  const index = new Map()
  for (const { text } of filer) {
    // Samma skäl som i `härledSinkIn`: `\w` är ASCII och hade tappat varje
    // klass med å/ä/ö — tyst, som en klass som "inte gick att slå upp".
    for (const m of codeMask(text).matchAll(/export\s+class\s+([\p{L}\p{N}_$]+)/gu)) {
      index.set(m[1], text)
    }
  }
  return index
}

/** Kärnan. Exporterad så självtestet kör exakt samma kod som CI. */
export function evaluate({ jobb, sänkmetoder, sänkklass = 'CronErrorSink', ack, index = new Map() }) {
  const problem = []
  const poster = ack?.jobs ?? {}

  if (jobb.length === 0) {
    problem.push({
      rule: 'NOLL @Cron-jobb härleddes ur koden',
      detail: 'Skanningen har gått blind — en vakt utan mätobjekt mäter ingenting.',
    })
    return problem
  }
  if (sänkmetoder.length === 0) {
    problem.push({
      rule: 'ingen rapportmetod kunde härledas ur cron-error-sink.ts',
      detail:
        'Regeln frågar efter en form och har då ingen form att fråga efter. Har ' +
        'CronErrorSink bytt filnamn, eller signaturen `cronName: string` som ' +
        'första parameter? Rätta härledningen — kvittera den inte.',
    })
    return problem
  }

  const utan = []
  for (const j of jobb) {
    const direkt = nårSänkan(j.text, j.metod, sänkmetoder, härledSänkbindningar(j.text, sänkklass))

    // ── DEKLARATIONEN VERIFIERAS, DEN TROS ALDRIG PÅ (#619) ─────────────────
    //
    // Hela poängen med att välja deklaration framför anropsföljning faller om
    // vakten bara läser att den finns. Då har vi flyttat kvitteringslistans
    // defekt in i syntaxen: ett påstående som gör sig självt sant.
    const dek = härledSinkIn(j.text, j.metod)
    let viaDeklaration = false
    if (dek) {
      const mål = index.get(dek.tjänst)
      if (direkt) {
        problem.push({
          rule: `\`${j.nyckel}\` har en @SinkIn men når sänkan DIREKT`,
          detail:
            'Deklarationen behövs inte och blir en påstådd koppling ingen läser om. ' +
            'Ta bort @SinkIn — eller, om sänkanropet i cron-metoden är det som ska ' +
            'bort, ta bort det i stället. Båda kan inte vara rätt: två sänkanrop för ' +
            'ETT fel ger två rader, och det var skälet till att sänkan lades en nivå ' +
            'ner från början.',
        })
      } else if (dek.tomt) {
        problem.push({
          rule: `\`${j.nyckel}\`: @SinkIn har ett TOMT metodnamn`,
          detail:
            'Andra argumentet är en tom sträng. Det är nästan alltid en trasig ' +
            'härledning i vakten och inte i koden — kontrollera att metodnamnet läses ' +
            'ur STRÄNG-vyn och inte ur kod-vyn, som blankar stränginnehåll.',
        })
      } else if (!mål) {
        problem.push({
          rule: `\`${j.nyckel}\`: @SinkIn pekar på \`${dek.tjänst}\`, som inte gick att slå upp`,
          detail:
            'Ingen `export class ' + dek.tjänst + '` finns i källträdet. Klassen är ' +
            'omdöpt, borttagen, eller namnet felstavat. En deklaration som pekar i ' +
            'tomma intet ser ut som en täckning och är ingen.',
        })
      } else if (
        !nårSänkan(mål, dek.metod, sänkmetoder, härledSänkbindningar(mål, sänkklass))
      ) {
        problem.push({
          rule: `\`${j.nyckel}\`: @SinkIn pekar på \`${dek.tjänst}::${dek.metod}\`, som INTE når sänkan`,
          detail:
            'Deklarationen är en PEKARE som vakten slår upp — inte ett påstående den ' +
            'litar på. Målet binder ingen CronErrorSink, eller anropar den inte i just ' +
            'den metoden.\n   Antingen pekar deklarationen fel, eller så är målet inte ' +
            'konverterat. Laga det som är fel — kvittera inte.',
        })
      } else {
        viaDeklaration = true
      }
    }

    if (direkt || viaDeklaration) {
      // ÅT ANDRA HÅLLET: en kvittering för ett jobb som REDAN nått sänkan är
      // inaktuell. Utan den halvan blir listan en tejpbit ingen tar bort.
      if (poster[j.nyckel]) {
        problem.push({
          rule: `\`${j.nyckel}\` är kvitterat men når REDAN sänkan`,
          detail:
            'Konverteringen är gjord — ta bort posten ur cron-error-sink.ack.json. ' +
            'En kvitteringslista som bara kan växa slutar vara en skuld och blir en ursäkt.',
        })
      }
      continue
    }
    utan.push(j.nyckel)
    // En TRASIG deklaration har redan gett ett precist fel ovan. Det generiska
    // "når ingen varaktig felsänka" ovanpå det pekar bort från orsaken.
    if (dek) continue
    const post = poster[j.nyckel]
    if (!post) {
      problem.push({
        rule: `\`${j.nyckel}\` når ingen varaktig felsänka`,
        detail: RÄTT_VÄG,
      })
    } else if ((post.reason ?? '').trim().length < MIN_SKÄL) {
      problem.push({
        rule: `\`${j.nyckel}\` har en kvittering med för tunt skäl (${
          (post.reason ?? '').trim().length
        } < ${MIN_SKÄL})`,
        detail:
          'En kvitteringslista utan skäl är en lista över saker ingen minns varför ' +
          'de står där.',
      })
    }
  }

  // Kvitteringar för jobb som inte finns kvar.
  const funna = new Set(jobb.map((j) => j.nyckel))
  for (const nyckel of Object.keys(poster)) {
    if (!funna.has(nyckel)) {
      problem.push({
        rule: `kvittering för \`${nyckel}\`, som inte motsvarar något @Cron`,
        detail: 'Jobbet är borttaget eller omdöpt. Ta bort posten.',
      })
    }
  }

  return problem.map((p) => ({ ...p, utan }))
}

/**
 * Källträdet som `{ fil, text }`.
 *
 * Jobben OCH klassindexet härleds ur SAMMA mängd — annars kan en deklaration
 * peka på en klass som finns i trädet men inte i indexet, och felet hade blivit
 * "gick inte att slå upp" om något som finns.
 */
function allaFiler() {
  return källfiler().map((p) => ({
    fil: relative(SRC, p).split('\\').join('/'),
    text: readFileSync(p, 'utf8'),
  }))
}

// ── självtest ────────────────────────────────────────────────────────────────
const SÄNKA_FIXTUR = `
@Injectable()
export class CronErrorSink {
  async report(cronName: string, err: unknown): Promise<void> {}
}
`
// FIXTURNAMNEN VAR ASCII AV TVÅNG — DET GÄLLER INTE LÄNGRE (#640).
//
// `findCronJobs` matchade metodnamnet med `\w`, som är ASCII: ett jobb som hette
// `medSänka` deriverades inte alls, och en fixtur som råkade utlösa det hade mätt
// sin egen stavning i stället för regeln. Härledningen använder nu
// `[\p{L}\p{N}_$]+` med `u`-flagga.
//
// Fixturen `JOBB_SVENSKT_NAMN` nedan bär med FLIT ett svenskt namn och är
// kanariefågeln för just det: går den sönder är formen tillbaka på ASCII, och då
// blir varje svensknamngivet @Cron osynligt för BÅDA cron-vakterna — inte
// ofullständigt mätt utan INTE MÄTT.
const JOBB_MED = {
  fil: 'x/med.service.ts',
  text: `
  constructor(private readonly sink: CronErrorSink) {}

  @Cron('0 1 * * *')
  async medSink(): Promise<void> {
    await runCronSafely('med', () => this.medSinkUnsafe(), { sink: this.sink })
  }
  private async medSinkUnsafe(): Promise<void> {}`,
}
const JOBB_UTAN = {
  fil: 'x/utan.service.ts',
  text: `
  @Cron('0 2 * * *')
  async utanSink(): Promise<void> {
    try {
      await this.gör()
    } catch (err) {
      this.logger.error('gick fel: ' + String(err))
    }
  }`,
}
const JOBB_DIREKT = {
  fil: 'x/direkt.service.ts',
  text: `
  constructor(private readonly sink: CronErrorSink) {}

  @Cron('0 3 * * *')
  async direkt(): Promise<void> {
    try {
      await this.gör()
    } catch (err) {
      await this.sink.report('direkt', err)
    }
  }`,
}

/**
 * Det UPPMÄTTA falsklarmet: en tjänst med en EGEN metod som heter `report`.
 * `ai-retention.service.ts` har `this.report(outcome)`. Utan bindningskravet sa
 * vakten "täckt" om ett jobb som inte var det — ett falskt positivt åt det
 * farligaste hållet, eftersom det STÄNGER frågan.
 */
/**
 * KANARIEFÅGELN FÖR `metodkropp` (#619).
 *
 * Returtypen bär en klammer OCH kroppen anropar sänkan. Med den gamla
 * lydelsen blev kroppen strängen `{ key: string; bytes: number }` och
 * sänkanropet försvann — vakten sa "når inte" om ett jobb som når.
 *
 * Formen är inte påhittad: den är kopierad från `backup.service.ts::runBackup`,
 * som är precis det fall som gjorde vakten blind.
 */
const JOBB_KLAMMER_I_RETURTYP = {
  fil: 'x/klammer.service.ts',
  text: `
  constructor(private readonly sink: CronErrorSink) {}

  @Cron('0 3 * * *')
  async klammer(): Promise<{ key: string; bytes: number }> {
    try {
      return await this.gör()
    } catch (err) {
      await this.sink.report('klammer', err)
      throw err
    }
  }`,
}

/**
 * ANDRA HALVAN AV SAMMA KANARIEFÅGEL: en klammer i en PARAMETERTYP.
 *
 * Den gamla lydelsens `\\([^)]*\\)` stannade på parentesen inne i
 * parametertypen, varpå reservankaret tog `indexOf('{')` och landade i
 * parameterns objekttyp. Utan den här prövas bara returtypshalvan.
 */
const JOBB_KLAMMER_I_PARAMETER = {
  fil: 'x/param.service.ts',
  text: `
  constructor(private readonly sink: CronErrorSink) {}

  @Cron('0 4 * * *')
  async param(opts: { torrkörning: boolean } = { torrkörning: false }): Promise<void> {
    try {
      await this.gör(opts)
    } catch (err) {
      await this.sink.report('param', err)
    }
  }`,
}

// ── FIXTURER FÖR @SinkIn-DEKLARATIONEN (#619) ──────────────────────────────
//
// Målklasserna först. De är vad `klassindex` slår upp, och skillnaden mellan
// dem är HELA frågan: den ena når sänkan, den andra gör det inte.

/** Når sänkan. Returtypen bär EN KLAMMER med flit — se #639. */
const TJÄNST_MED_SÄNKA = {
  fil: 'x/inre.service.ts',
  text: `
export class InreTjänst {
  constructor(private readonly sink: CronErrorSink) {}

  async gör(): Promise<{ nyckel: string; byte: number }> {
    try {
      return await this.arbeta()
    } catch (err) {
      await this.sink.report('inre', err)
      throw err
    }
  }
}`,
}

/** Når INTE sänkan. Binder ingen CronErrorSink alls. */
const TJÄNST_UTAN_SÄNKA = {
  fil: 'x/tyst.service.ts',
  text: `
export class TystTjänst {
  private readonly logger = new Logger(TystTjänst.name)

  async gör(): Promise<void> {
    try {
      await this.arbeta()
    } catch (err) {
      this.logger.error(String(err))
    }
  }
}`,
}

/** Deklarationen pekar rätt: målet når sänkan. Ska vara TYST. */
const JOBB_SINKIN_GILTIG = {
  fil: 'x/dekl-giltig.service.ts',
  text: `
  constructor(private readonly inre: InreTjänst) {}

  @Cron('0 3 * * *')
  @SinkIn(InreTjänst, 'gör')
  async deklGiltig(): Promise<void> {
    try {
      await this.inre.gör()
    } catch {
      // Redan rapporterat en nivå ner.
    }
  }`,
}

/** DEN AVGÖRANDE: deklarationen pekar på en metod UTAN sänka. Ska vara RÖD. */
const JOBB_SINKIN_UTAN_SÄNKA = {
  fil: 'x/dekl-tom.service.ts',
  text: `
  constructor(private readonly tyst: TystTjänst) {}

  @Cron('0 3 * * *')
  @SinkIn(TystTjänst, 'gör')
  async deklTom(): Promise<void> {
    try {
      await this.tyst.gör()
    } catch {
      // Ingenting rapporteras någonstans.
    }
  }`,
}

/** Deklarationen pekar på en klass som inte finns. Ska vara RÖD. */
const JOBB_SINKIN_OKÄND = {
  fil: 'x/dekl-okand.service.ts',
  text: `
  @Cron('0 3 * * *')
  @SinkIn(FinnsInteTjänst, 'gör')
  async deklOkand(): Promise<void> {
    try {
      await this.gör()
    } catch {
      // …
    }
  }`,
}

/** Jobbet når sänkan DIREKT och har ändå en deklaration. Ska vara RÖD. */
const JOBB_SINKIN_REDUNDANT = {
  fil: 'x/dekl-redundant.service.ts',
  text: `
  constructor(private readonly sink: CronErrorSink, private readonly inre: InreTjänst) {}

  @Cron('0 3 * * *')
  @SinkIn(InreTjänst, 'gör')
  async deklRedundant(): Promise<void> {
    try {
      await this.inre.gör()
    } catch (err) {
      await this.sink.report('redundant', err)
    }
  }`,
}

/** En UTKOMMENTERAD @SinkIn är ingen deklaration. Ska vara RÖD som ett jobb utan sänka. */
const JOBB_SINKIN_KOMMENTERAD = {
  fil: 'x/dekl-kommenterad.service.ts',
  text: `
  constructor(private readonly tyst: TystTjänst) {}

  @Cron('0 3 * * *')
  // @SinkIn(InreTjänst, 'gör')
  async deklKommenterad(): Promise<void> {
    try {
      await this.tyst.gör()
    } catch {
      // …
    }
  }`,
}

/** KANARIEFÅGEL (#640): svenskt metodnamn, i övrigt ett helt vanligt jobb. */
const JOBB_SVENSKT_NAMN = {
  fil: 'x/svensk.service.ts',
  text: `
  constructor(private readonly sink: CronErrorSink) {}

  @Cron('0 3 * * *')
  async städaGammaltUnderlag(): Promise<void> {
    try {
      await this.gör()
    } catch (err) {
      await this.sink.report('stada', err)
    }
  }`,
}

const JOBB_EGEN_REPORT = {
  fil: 'x/egen.service.ts',
  text: `
  @Cron('0 4 * * *')
  async egenReport(): Promise<void> {
    const outcome = await this.gör()
    this.report(outcome)
  }`,
}

function självtest() {
  let fel = 0
  const t = (namn, ok, extra = '') => {
    console.warn(`${ok ? '✅' : '❌'} ${namn}${extra ? '  → ' + extra : ''}`)
    if (!ok) fel++
  }

  // (0) Den delade skannerns kanariefåglar — metavaktens R2.
  const skanner = kanariefåglar()
  t(
    `delad skanner: kanariefåglarna gröna`,
    skanner.length === 0,
    skanner.join(' | '),
  )

  // (1) HÄRLEDNINGEN av sänkans metodnamn.
  const fixturMetoder = härledSänkmetoder(SÄNKA_FIXTUR)
  t('härleder rapportmetoden ur fixturen', fixturMetoder.join(',') === 'report', fixturMetoder.join(','))
  const riktigaMetoder = härledSänkmetoder(readFileSync(SINK_FILE, 'utf8'))
  t('härleder rapportmetoden ur den RIKTIGA sänkan', riktigaMetoder.length >= 1, riktigaMetoder.join(', '))

  // (2) REGELKANARIEFÅGELN — ett nytt jobb utan sänka MÅSTE fälla.
  const jobbMed = findCronJobs([JOBB_MED])
  const jobbUtan = findCronJobs([JOBB_UTAN])
  const jobbDirekt = findCronJobs([JOBB_DIREKT])
  t('fixturerna ger ett jobb var', jobbMed.length === 1 && jobbUtan.length === 1 && jobbDirekt.length === 1,
    `${jobbMed.length}/${jobbUtan.length}/${jobbDirekt.length}`)

  const utanFynd = evaluate({ jobb: jobbUtan, sänkmetoder: riktigaMetoder, ack: { jobs: {} } })
  t('REGEL: ett jobb utan sänka fälls', utanFynd.some((p) => p.rule.includes('når ingen varaktig felsänka')),
    utanFynd.map((p) => p.rule).join(' | '))

  const medFynd = evaluate({ jobb: jobbMed, sänkmetoder: riktigaMetoder, ack: { jobs: {} } })
  t('REGEL: ett jobb som skickar sink är tyst', medFynd.length === 0, medFynd.map((p) => p.rule).join(' | '))

  const direktFynd = evaluate({ jobb: jobbDirekt, sänkmetoder: riktigaMetoder, ack: { jobs: {} } })
  t('REGEL: ett jobb som anropar sänkan direkt är tyst', direktFynd.length === 0,
    direktFynd.map((p) => p.rule).join(' | '))

  // DET UPPMÄTTA FALSKLARMET — en egen metod som heter `report` är inte sänkan.
  const egen = findCronJobs([JOBB_EGEN_REPORT])
  const egenFynd = evaluate({ jobb: egen, sänkmetoder: riktigaMetoder, ack: { jobs: {} } })
  t('REGEL: en EGEN metod som heter report räknas INTE som sänkan',
    egenFynd.some((p) => p.rule.includes('når ingen varaktig felsänka')),
    egenFynd.map((p) => p.rule).join(' | '))

  // (2a2) IDENTIFIERARFORMEN (#640) — ett svenskt metodnamn ska härledas OCH
  //       mätas av regeln. Med `\w` (ASCII) fanns jobbet inte i mängden alls,
  //       och vakten var grön om ett jobb den aldrig sett.
  const svenska = findCronJobs([JOBB_SVENSKT_NAMN])
  t('IDENTIFIERARFORM: ett @Cron med svenskt metodnamn härleds',
    svenska.length === 1 && svenska[0].metod === 'städaGammaltUnderlag',
    `${svenska.length} jobb: ${svenska.map((j) => j.metod).join(',') || 'inga'}`)
  t('IDENTIFIERARFORM: …och regeln mäter det som vilket jobb som helst',
    svenska.length === 1 &&
      evaluate({ jobb: svenska, sänkmetoder: riktigaMetoder, ack: { jobs: {} } }).length === 0)

  // (2b) KANARIEFÅGELN FÖR KROPPSUTTAGET (#619).
  //
  // Utan den här är hela vakten tyst blind för varje metod vars signatur bär
  // en klammer: kroppen blir en TYP, mönstret hittas inte, och utfallet är
  // "når ingen varaktig felsänka" om ett jobb som når den. Prövas åt BÅDA
  // hållen — en kanariefågel som bara visar det positiva fallet skiljer inte
  // ett fungerande kroppsuttag från ett som råkar hitta rätt.
  for (const [namn, fixtur] of [
    ['returtypen', JOBB_KLAMMER_I_RETURTYP],
    ['parametertypen', JOBB_KLAMMER_I_PARAMETER],
  ]) {
    const j = findCronJobs([fixtur])
    t(`fixturen med klammer i ${namn} ger ett jobb`, j.length === 1, String(j.length))
    if (j.length !== 1) continue

    // (a) Kroppen är KROPPEN, inte signaturens typ. Mäts direkt, så ett fel
    //     pekar på kroppsuttaget och inte på regeln ovanpå det.
    const kropp = metodkropp(codeMask(fixtur.text), j[0].metod)
    t(
      `KROPPSUTTAG: klammer i ${namn} ger kroppen, inte typen`,
      kropp.includes('sink.report('),
      `${kropp.length} tecken: ${JSON.stringify(kropp.slice(0, 48))}`,
    )

    // (b) Och att regeln ovanpå den faktiskt blir tyst.
    const fynd = evaluate({ jobb: j, sänkmetoder: riktigaMetoder, ack: { jobs: {} } })
    t(`REGEL: jobbet med klammer i ${namn} är tyst`, fynd.length === 0,
      fynd.map((p) => p.rule).join(' | '))
  }

  // (2c) DEKLARATIONEN — @SinkIn (#619).
  //
  // Utan den RÖDA halvan här är deklarationen SJÄLVCERTIFIERANDE: den som
  // skriver @SinkIn får sitt jobb godkänt genom att påstå något, vilket är exakt
  // den defekt kvitteringslistan hade — fast med finare syntax och utan kravet
  // på ett skäl. Den positiva halvan ensam skiljer inte en vakt som VERIFIERAR
  // målet från en som bara ser att dekoratorn finns.
  const dekIndex = klassindex([TJÄNST_MED_SÄNKA, TJÄNST_UTAN_SÄNKA])
  const dekEval = (fixtur) =>
    evaluate({
      jobb: findCronJobs([fixtur]),
      sänkmetoder: riktigaMetoder,
      ack: { jobs: {} },
      index: dekIndex,
    })

  // (a) Metodnamnet läses ur STRÄNG-vyn, inte ur kod-vyn.
  //
  // Uppmätt när den här vakten byggdes: med `codeMask` för båda halvorna blev
  // metodnamnet BLANKAT till mellanslag, och varje giltig deklaration fälldes
  // med `InreTjänst::      `. Kontrollen finns för att det felet är osynligt i
  // regelutfallet — det ser ut som ett mål som inte når sänkan.
  const dekLäst = härledSinkIn(JOBB_SINKIN_GILTIG.text, 'deklGiltig')
  t('DEKLARATION: metodnamnet läses ur strängvyn, inte blankat',
    dekLäst?.tjänst === 'InreTjänst' && dekLäst?.metod === 'gör',
    JSON.stringify(dekLäst))

  // (b) Pekar rätt → tyst.
  t('DEKLARATION: en @SinkIn som pekar på en metod som NÅR sänkan är tyst',
    dekEval(JOBB_SINKIN_GILTIG).length === 0,
    dekEval(JOBB_SINKIN_GILTIG).map((p) => p.rule).join(' | '))

  // (c) DEN AVGÖRANDE: pekar på en metod utan sänka → RÖD.
  t('DEKLARATION: en @SinkIn som pekar på en metod UTAN sänka är RÖD',
    dekEval(JOBB_SINKIN_UTAN_SÄNKA).some((p) => p.rule.includes('som INTE når sänkan')),
    dekEval(JOBB_SINKIN_UTAN_SÄNKA).map((p) => p.rule).join(' | '))

  // (d) Pekar på en klass som inte finns → RÖD. En felstavning ska inte se ut
  //     som en täckning.
  t('DEKLARATION: en @SinkIn mot en okänd klass är RÖD',
    dekEval(JOBB_SINKIN_OKÄND).some((p) => p.rule.includes('inte gick att slå upp')),
    dekEval(JOBB_SINKIN_OKÄND).map((p) => p.rule).join(' | '))

  // (e) Redundant deklaration → RÖD. Samma skäl som en inaktuell kvittering:
  //     en lista som bara kan växa slutar betyda något.
  t('DEKLARATION: en @SinkIn på ett jobb som når sänkan DIREKT är RÖD',
    dekEval(JOBB_SINKIN_REDUNDANT).some((p) => p.rule.includes('når sänkan DIREKT')),
    dekEval(JOBB_SINKIN_REDUNDANT).map((p) => p.rule).join(' | '))

  // (f) KOD-halvan: en utkommenterad @SinkIn är ingen deklaration.
  t('DEKLARATION: en UTKOMMENTERAD @SinkIn räknas inte',
    härledSinkIn(JOBB_SINKIN_KOMMENTERAD.text, 'deklKommenterad') === null &&
      dekEval(JOBB_SINKIN_KOMMENTERAD).some((p) => p.rule.includes('når ingen varaktig felsänka')),
    dekEval(JOBB_SINKIN_KOMMENTERAD).map((p) => p.rule).join(' | '))

  // (g) INTEGRATIONEN MED #639: målets returtyp bär en klammer.
  //     `TJÄNST_MED_SÄNKA.gör()` returnerar `Promise<{ nyckel; byte }>` — exakt
  //     formen som gjorde `metodkropp` blind. Går (b) grön är kroppsuttaget
  //     lagat hela vägen genom deklarationsuppslaget, inte bara i sin egen spec.
  t('DEKLARATION: målet med KLAMMER I RETURTYPEN slås upp korrekt',
    nårSänkan(TJÄNST_MED_SÄNKA.text, 'gör', riktigaMetoder,
      härledSänkbindningar(TJÄNST_MED_SÄNKA.text, 'CronErrorSink')))

  // (3) KVITTERINGEN FÄLLER ÅT BÅDA HÅLLEN.
  const kvitterat = evaluate({
    jobb: jobbUtan,
    sänkmetoder: riktigaMetoder,
    ack: { jobs: { [jobbUtan[0].nyckel]: { reason: 'x'.repeat(MIN_SKÄL + 5) } } },
  })
  t('KVITTERING: ett kvitterat jobb utan sänka är tyst', kvitterat.length === 0,
    kvitterat.map((p) => p.rule).join(' | '))

  const inaktuell = evaluate({
    jobb: jobbMed,
    sänkmetoder: riktigaMetoder,
    ack: { jobs: { [jobbMed[0].nyckel]: { reason: 'x'.repeat(MIN_SKÄL + 5) } } },
  })
  t('KVITTERING: ett kvitterat jobb som REDAN når sänkan fälls',
    inaktuell.some((p) => p.rule.includes('kvitterat men når REDAN sänkan')),
    inaktuell.map((p) => p.rule).join(' | '))

  const tunt = evaluate({
    jobb: jobbUtan,
    sänkmetoder: riktigaMetoder,
    ack: { jobs: { [jobbUtan[0].nyckel]: { reason: 'kort' } } },
  })
  t('KVITTERING: för tunt skäl fälls', tunt.some((p) => p.rule.includes('för tunt skäl')))

  const spöke = evaluate({
    jobb: jobbMed,
    sänkmetoder: riktigaMetoder,
    ack: { jobs: { 'x/borta.ts::spöke': { reason: 'x'.repeat(MIN_SKÄL + 5) } } },
  })
  t('KVITTERING: en post utan motsvarande @Cron fälls',
    spöke.some((p) => p.rule.includes('inte motsvarar något @Cron')))

  // (4) FORMEN utan härledning ska vara RÖD, inte tyst grön.
  const utanForm = evaluate({ jobb: jobbUtan, sänkmetoder: [], ack: { jobs: {} } })
  t('utan härledd rapportmetod är vakten RÖD',
    utanForm.some((p) => p.rule.includes('ingen rapportmetod kunde härledas')))

  // (5) OMFÅNGSKANARIEFÅGELN — tom mängd fäller, och golven är MÄTTA.
  const tom = evaluate({ jobb: [], sänkmetoder: riktigaMetoder, ack: { jobs: {} } })
  t('OMFÅNG: en tom jobbmängd fälls', tom.some((p) => p.rule.includes('NOLL @Cron-jobb')))

  const riktigaFiler = allaFiler()
  const riktiga = findCronJobs(riktigaFiler)
  const riktigtIndex = klassindex(riktigaFiler)
  const direkta = riktiga.filter((j) =>
    nårSänkan(j.text, j.metod, riktigaMetoder, härledSänkbindningar(j.text, 'CronErrorSink')),
  )
  const deklarerade = riktiga.filter(
    (j) => !direkta.includes(j) && härledSinkIn(j.text, j.metod) !== null,
  )
  // MÄTT mot befee7b: 25 jobb i 14 filer, 13 utan varaktig sänka.
  const MIN_JOBB = 15
  const MIN_FILER = 200
  const antalFiler = källfiler().length
  t(`OMFÅNG: ${riktiga.length} @Cron-jobb härledda (golv ${MIN_JOBB})`, riktiga.length >= MIN_JOBB)
  t(`OMFÅNG: ${antalFiler} källfiler skannade (golv ${MIN_FILER})`, antalFiler >= MIN_FILER)

  // KANARIEFÅGEL FÖR DEKLARATIONSVÄGEN I DEN RIKTIGA KODBASEN.
  //
  // Deklarationsgrenen kan gå blind på precis det sätt som gjorde #619 till ett
  // ärende: den slutar hitta något och vakten förblir grön, eftersom en
  // deklaration som inte hittas bara betyder "ingen deklaration". Kräv därför
  // att mängden inte är TOM — samma form som omfångsgolven ovan.
  t(
    `DEKLARATION: ${deklarerade.length} jobb når sänkan via @SinkIn (golv 1)`,
    deklarerade.length >= 1,
    deklarerade.map((j) => j.nyckel).join(', '),
  )
  console.warn(
    `   mätt nu: ${riktiga.length} jobb, ${direkta.length} direkt, ` +
      `${deklarerade.length} via @SinkIn, ` +
      `${riktiga.length - direkta.length - deklarerade.length} utan`,
  )

  // (5b) SVENSKA IDENTIFIERARE I BINDNINGARNA (#713)
  //
  // Både bindningens NAMN och användningen av den härleds ur kod. Härledningen
  // gick via `\w` respektive `\b`, som är ASCII. Uppmätt mot origin/main —
  // två felformer, och den andra är den farliga:
  //
  //   MISSAD        `private ärendeSänka: CronErrorSink`  →  []
  //                 `private sänkaFörCron: CronErrorSink` →  []
  //                 Bindningen finns inte, jobbet läses som OSÄNKAT. Falsklarm.
  //
  //   FALSK GRÖN    kroppen `await denPåerrorSink.report('x')` med bindningen
  //                 `errorSink`  →  nårSänkan = TRUE
  //                 `\berrorSink\b` matchar inuti `denPåerrorSink`, eftersom
  //                 `å` inte är ett ordtecken. Jobbet rapporteras nå den
  //                 varaktiga felsänkan när det inte gör det.
  //
  // Den andra är värre än den första: hela vaktens uppgift (#619) är att inget
  // cron-fel ska försvinna med processen. En falsk grön där är precis den
  // tystnad vakten byggdes mot.
  {
    const bind = (kropp) => härledSänkbindningar(`class S {\n  ${kropp}\n}`, 'CronErrorSink')
    t('MISSAD (bindning med svensk INITIAL härleds)',
      bind('private ärendeSänka: CronErrorSink').join(',') === 'ärendeSänka',
      JSON.stringify(bind('private ärendeSänka: CronErrorSink')))
    t('MISSAD (bindning med svenskt tecken MITT i härleds)',
      bind('private sänkaFörCron: CronErrorSink').join(',') === 'sänkaFörCron',
      JSON.stringify(bind('private sänkaFörCron: CronErrorSink')))
    t('MOTPROV (ren ASCII härleds som förut)',
      bind('private errorSink: CronErrorSink').join(',') === 'errorSink',
      JSON.stringify(bind('private errorSink: CronErrorSink')))

    const kropp = (rad) => `class S {\n  async jobb() {\n    ${rad}\n  }\n}`
    t('FALSK GRÖN (svensk bokstav FÖRE bindningsnamnet är inte bindningen)',
      nårSänkan(kropp("await denPåerrorSink.report('x')"), 'jobb', ['report'], ['errorSink']) === false)
    t('MOTPROV (den ÄKTA användningen når fortfarande sänkan)',
      nårSänkan(kropp("await this.errorSink.report('x')"), 'jobb', ['report'], ['errorSink']) === true)
    t('MOTPROV (DELSTRÄNG med ASCII före räknas inte heller)',
      nårSänkan(kropp("await xerrorSink.report('x')"), 'jobb', ['report'], ['errorSink']) === false)
    t('MOTPROV (sink:-optionen når fortfarande sänkan)',
      nårSänkan(kropp('await körCron({ sink: this.errorSink })'), 'jobb', ['report'], ['errorSink']) === true)

    // SINK-OPTIONEN bar SAMMA fälla, i BÅDA riktningarna. Uppmätt:
    //
    //   { påsink: this.errorSink }      ascii=true  unicode=false
    //       `\bsink` matchar inuti `påsink` → en option som INTE heter sink
    //       godtogs som sänkoptionen. Falsk grön.
    //
    //   { sink: tjänst.errorSink }      ascii=false unicode=true
    //       sökvägsklassen `[\w.]*` kan inte korsa `ä`, så en bindning som nås
    //       via en svenskt namngiven egenskap syntes inte. Falsklarm — och
    //       `tjänst`/`förvaltning` som egenskapsnamn är inte ett hörnfall här.
    t('FALSK GRÖN (påsink: är inte sink:)',
      nårSänkan(kropp('await körCron({ påsink: this.errorSink })'), 'jobb', ['report'], ['errorSink']) === false)
    t('MISSAD (sökväg genom en svenskt namngiven egenskap ses)',
      nårSänkan(kropp('await körCron({ sink: tjänst.errorSink })'), 'jobb', ['report'], ['errorSink']) === true)
    t('MOTPROV (xsink: är inte sink:)',
      nårSänkan(kropp('await körCron({ xsink: this.errorSink })'), 'jobb', ['report'], ['errorSink']) === false)
  }

  // (6) Kodbasen i paritet med kvitteringen.
  const bas = evaluate({
    jobb: riktiga,
    sänkmetoder: riktigaMetoder,
    ack: JSON.parse(readFileSync(ACK_FILE, 'utf8')),
    index: riktigtIndex,
  })
  t('kodbasen är i paritet med kvitteringen', bas.length === 0,
    bas.map((p) => p.rule).slice(0, 3).join(' | '))

  console.warn(fel === 0 ? '\n✅ Självtest OK.' : `\n❌ Självtest: ${fel} fallerade.`)
  process.exit(fel === 0 ? 0 : 1)
}

function kör() {
  const filer = allaFiler()
  const jobb = findCronJobs(filer)
  const sinkText = readFileSync(SINK_FILE, 'utf8')
  const sänkmetoder = härledSänkmetoder(sinkText)
  const sänkklass = härledSänkklass(sinkText)
  const ack = JSON.parse(readFileSync(ACK_FILE, 'utf8'))
  const problem = evaluate({ jobb, sänkmetoder, sänkklass, ack, index: klassindex(filer) })

  if (problem.length > 0) {
    console.error('\n=== CRON-FEL UTAN VARAKTIG SÄNKA (CI-guard) ===\n')
    for (const p of problem) console.error(`❌ ${p.rule}\n   ${p.detail}`)
    console.error(
      '\nRegeln: containerns logg överlever inte nästa deploy. Ett cron-fel som bara\n' +
        'loggas lokalt finns ingenstans att fråga efter i morgon — och en tom ErrorLog\n' +
        'betyder då antingen "inget fel" eller "ingen sänka". Se #605.\n',
    )
    process.exit(1)
  }

  const utan = Object.keys(ack.jobs ?? {}).length
  console.warn(
    `✅ ${jobb.length} @Cron-jobb — ${jobb.length - utan} når den varaktiga felsänkan, ` +
      `${utan} kvitterade (rapportmetod härledd: ${sänkmetoder.join(', ')}).`,
  )
}

const körsDirekt = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (!körsDirekt) {
  // importerad — exportera bara
} else if (process.argv.includes('--self-test')) självtest()
else kör()
