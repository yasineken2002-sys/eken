/**
 * DRIFTVERKTYG FÖR BULL-KÖERNA — läser som standard, pausar bara på uttrycklig
 * order, och startar aldrig Nest/AppModule.
 *
 * ── VARFÖR ETT EGET VERKTYG ─────────────────────────────────────────────────
 *
 * Avskärmningsordningens steg 3 kräver en GLOBAL köpaus utan att appen startas.
 * Att boota `AppModule` för att komma åt köerna hade varit motsatsen till
 * avsikten: det startar Prisma, R2, Chromium — och i ett opausat läge även
 * konsumenterna, alltså precis det som ska stoppas. Repot hade inget sådant
 * verktyg (`src/scripts/` innehöll rotation, radering, backfill och
 * schemadrift), så det här är det minsta som gör jobbet.
 *
 * Formen är `rotate-pii-secrets.ts`:s: fristående nod-process, `--dry-run`-tänk
 * som DEFAULT snarare än som flagga, och ett kast i stället för en tyst
 * fallback när något inte går att klassificera.
 *
 * ── TRE SPÄRRAR MOT ATT RÖRA FEL SYSTEM ─────────────────────────────────────
 *
 * 1. `--redis-url` är OBLIGATORISK. Verktyget läser med flit INTE `REDIS_URL`
 *    ur miljön. En operatörs terminal bär ofta produktionens variabler, och ett
 *    verktyg som "bara kör mot det som råkade stå i miljön" antar produktion som
 *    standard — vilket uppdraget uttryckligen förbjuder.
 * 2. Muterande åtgärder kräver `--confirm=<mål>`, där `<mål>` måste vara exakt
 *    den måltext verktyget skriver ut (schema, värd, port, databasindex och
 *    prefix).
 *
 *    VAD DEN FAKTISKT ÄR: en stavfelsspärr och en ändringsspärr — INTE ett bevis
 *    för att operatören läst läsläget först. `describeTarget` är en ren funktion
 *    av `--redis-url` och `--prefix`, utan nonce och utan något från det levande
 *    systemet, så måltexten går att räkna ut i huvudet. Det den bevisligen
 *    fångar är ett stavfel i URL:en eller prefixet mellan läsning och åtgärd,
 *    och en URL som ändrats däremellan. Påstå inte mer än så.
 * 3. Inventeringen jämförs mot koden. Saknas en kö, eller finns det en kö i
 *    Redis som koden inte känner till, sätts `inventeringKomplett: false` och
 *    verktyget vägrar kalla utfallet verifierat. Ett tomt eller ofullständigt
 *    svar är den vanligaste formen av falskt lugn i den här operationen.
 *
 * ── VAD DET ALDRIG GÖR ──────────────────────────────────────────────────────
 *
 * Ingen `clean`, `empty`, `remove` eller `obliterate`. Inga jobb raderas, inga
 * markeras klara. Inga jobbpayloads, inga personuppgifter och inga credentials
 * skrivs ut — URL:en redigeras innan den visas, och bara ANTAL rapporteras.
 *
 * `resume` finns med därför att en återöppning ska vara ett lika uttryckligt och
 * lika spårat handgrepp som pausen — inte något som sker av sig självt vid en
 * omstart. Den bär samma `--confirm`-krav.
 *
 * ── ANVÄNDNING ──────────────────────────────────────────────────────────────
 *
 *   node -r ts-node/register src/scripts/queue-ops.ts \
 *     --redis-url=redis://HOST:PORT/DB [--prefix=bull] [--queues=a,b] [--json]
 *
 *   ... --action=pause  --confirm='<måltexten ur läsläget>'
 *   ... --action=resume --confirm='<måltexten ur läsläget>'
 *
 * Avgränsning som ska stå utskriven i varje rapport som använder verktyget: en
 * global paus stoppar KONSUMTION. Den stoppar inte producenter, inte HTTP-vägar
 * och inte en gammal process som redan håller ett aktivt jobb.
 */

import Bull from 'bull'
import type { Queue } from 'bull'
// Versionen läses ur paketets egen manifest, inte ur en literal här: ett
// hårdkodat '4.16.5' hade fortsatt påstå sig stämma efter en uppgradering,
// och just runtimeversionen är en av de saker rapporten ska kunna styrka.
import { version as BULL_VERSION } from 'bull/package.json'
import { ALLA_KONAMN } from '../common/ops/queue-inventory'

export type QueueAction = 'inspect' | 'pause' | 'resume'

export interface QueueReport {
  name: string
  /** Global pausflagga i Redis (`isPaused(false)`), inte den lokala. */
  pausedGlobally: boolean
  counts: Record<string, number>
  /** ANTAL återkommande jobb. Namn och payloads skrivs aldrig ut. */
  repeatableCount: number
}

export interface OpsResult {
  action: QueueAction
  /** Måltexten operatören måste kunna upprepa för en muterande åtgärd. */
  target: string
  bullVersion: string
  redisVersion: string
  /**
   * Sant bara när HELA kodens mängd begärdes, Redis inte bär någon kö utanför
   * den, OCH minst en av de begärda köerna faktiskt har spår under prefixet.
   *
   * Det sista ledet är tillagt efter ett granskningsfynd som reproducerades
   * skarpt: utan det svarade verktyget `inventering komplett: JA` mot ett HELT
   * TOMT prefix, och `--action=pause` rapporterade elva pausade köer som inte
   * fanns. Fel prefix, fel databasindex eller fel Redis hade alltså läst som en
   * verifierad avskärmning — exakt det utfall spärren finns för att stoppa.
   */
  inventeringKomplett: boolean
  /** Antal begärda köer som har spår under prefixet. Noll = fel mål. */
  funnaIRedis: number
  /**
   * Köer i koden som inte har ett enda spår under prefixet. Den OFARLIGA
   * riktningen: en kö som aldrig fått ett jobb har inga nycklar, och det finns
   * då heller ingenting att pausa. Rapporteras ändå — ett oväntat namn här
   * betyder oftast fel prefix.
   */
  utanSparIRedis: string[]
  /**
   * Köer som finns under prefixet men INTE i koden. Den FARLIGA riktningen: en
   * konsument som kodinventeringen missat, eller en gammal generation som skriver
   * mot samma Redis. Ett sådant fynd gör utfallet obrukbart som avskärmningsbevis.
   */
  okandaIRedis: string[]
  queues: QueueReport[]
  /** Vad som FAKTISKT skrevs. Tom lista i läsläge. */
  atgardade: string[]
}

/** Klipper bort lösenordet ur en redis-URL. Får aldrig kringgås i utskrift. */
export function redactRedisUrl(url: string): string {
  try {
    const u = new URL(url)
    if (u.password) u.password = '***'
    if (u.username) u.username = '***'
    return u.toString()
  } catch {
    // Går URL:en inte att tolka får ingenting skrivas ut — en oparserbar sträng
    // kan mycket väl vara en hel credential.
    return '(oparserbar redis-url — utelämnad)'
  }
}

/**
 * Måltexten. Den här strängen är BÅDE utskriften och det operatören måste
 * upprepa i `--confirm`, och det är avsiktligt en och samma funktion: två
 * formuleringar hade gjort bekräftelsen möjlig att uppfylla av misstag.
 */
export function describeTarget(redisUrl: string, prefix: string): string {
  let schema = '(okänt)'
  let host = '(okänd)'
  let port = '(okänd)'
  let db = '0'
  try {
    const u = new URL(redisUrl)
    // SCHEMAT MÅSTE MED. `redis://h:6379/0` och `rediss://u:pw@h:6379/0` är två
    // olika mål — ofta en oskyddad och en TLS-skyddad instans — och utan det här
    // ledet delade de samma måltext, alltså samma giltiga --confirm.
    schema = u.protocol.replace(/:$/, '')
    host = u.hostname
    port = u.port || '6379'
    const path = u.pathname.replace(/^\//, '')
    if (path) db = path
  } catch {
    /* måltexten blir då synligt ofullständig, vilket i sig stoppar --confirm */
  }
  return `${schema}://${host}:${port}/db${db} prefix=${prefix}`
}

function log(msg: string): void {
  // console.log är bannlyst i projektet.
  console.warn(`[queue-ops] ${msg}`)
}

async function readQueue(queue: Queue): Promise<QueueReport> {
  // `getJobCounts()` UTAN argument — Bull 4.16.5:s signatur. `isPaused(false)`
  // är den GLOBALA flaggan; `isPaused(true)` hade bara sagt något om den här
  // klienten, alltså om verktyget självt, vilket vore meningslöst.
  const [pausedGlobally, counts, repeatable] = await Promise.all([
    queue.isPaused(false),
    queue.getJobCounts(),
    queue.getRepeatableJobs(0, -1, true),
  ])
  return {
    name: queue.name,
    pausedGlobally,
    counts: counts as unknown as Record<string, number>,
    repeatableCount: repeatable.length,
  }
}

/**
 * Vilka könamn har faktiskt spår under prefixet? Läses ur Redis och inte ur
 * koden, så att en TOLFTE kö som ingen lagt till i inventeringen blir SYNLIG i
 * stället för att tyst saknas.
 *
 * ── SUFFIXEN ÄR MÄTTA, INTE GISSADE ─────────────────────────────────────────
 *
 * Bull 4.16.5 har ingen `:meta`-nyckel — det är BullMQ:s form, och en skanning
 * efter den ger NOLL mot varje verklig Bull-kö. Det är exakt det falska lugn
 * filen finns för att undvika, och det inträffade under utvecklingen av just den
 * här funktionen.
 *
 * Uppmätt mot en riktig, seedad Bull 4.16.5-instans skapas `:id` (jobbräknaren)
 * av första `add`, och `:wait`/`:delayed` av jobben. `:meta-paused` skapas av en
 * global paus — och den är med av ett eget skäl: en TOM men PAUSAD kö har inga
 * jobbnycklar alls, och skulle utan det suffixet försvinna ur inventeringen
 * precis när den är som mest intressant.
 */
export const KO_MARKORSUFFIX = ['id', 'wait', 'delayed', 'meta-paused'] as const

export async function scanQueueNames(
  client: { scan: (...a: unknown[]) => Promise<[string, string[]]> },
  prefix: string,
): Promise<string[]> {
  const found = new Set<string>()
  for (const suffix of KO_MARKORSUFFIX) {
    let cursor = '0'
    do {
      // SCAN och inte KEYS: KEYS blockerar hela Redis-instansen, och verktyget
      // är skrivet för att kunna riktas mot en produktionsinstans i LÄSLÄGE.
      const [next, keys] = await client.scan(cursor, 'MATCH', `${prefix}:*:${suffix}`, 'COUNT', 500)
      cursor = next
      for (const key of keys) {
        // `<prefix>:<könamn>:<suffix>` — könamnet kan självt innehålla kolon
        // (`mail:high`), så namnet skalas fram från ändarna i stället för att
        // splittas på kolon och tas på index 1.
        const utan = key.slice(prefix.length + 1, key.length - (suffix.length + 1))
        if (utan) found.add(utan)
      }
    } while (cursor !== '0')
  }
  return [...found].sort()
}

/**
 * ETT STAVFEL I `--queues` SKA AVBRYTA, inte "pausa" en kö som inte finns.
 *
 * `new Bull('mail-high', …).pause(false)` LYCKAS — Bulls pause-script sätter
 * `meta-paused` villkorslöst, även för ett namn ingen konsument lyssnar på.
 * Bindestreck i stället för kolon hade alltså gett raden
 * `mail-high: globalPaus=true`, operatören hade bockat av mejlköerna, och
 * `mail:high` hade konsumerat vidare.
 *
 * Egen exporterad funktion, inte en rad inuti `runQueueOps`, så att den går att
 * pröva utan att en Redis-anslutning öppnas — kontrollen ligger med flit FÖRE
 * anslutningen, och ett prov som måste ansluta för att nå den hade mätt
 * anslutningen i stället.
 *
 * @throws när något begärt namn saknas i kodens inventering.
 */
export function assertKnownQueues(begarda: readonly string[]): void {
  const okanda = begarda.filter((n) => !ALLA_KONAMN.includes(n))
  if (okanda.length > 0) {
    throw new Error(
      `--queues innehåller namn som inte finns i kodens inventering: ` +
        `${okanda.join(', ')}. Giltiga: ${ALLA_KONAMN.join(', ')}.`,
    )
  }
}

export interface RunOptions {
  redisUrl: string
  prefix: string
  action: QueueAction
  /** Begärda könamn. Utelämnad = kodens fulla mängd. */
  queues?: readonly string[]
  confirm?: string
}

export async function runQueueOps(opts: RunOptions): Promise<OpsResult> {
  const target = describeTarget(opts.redisUrl, opts.prefix)
  const begarda = opts.queues && opts.queues.length > 0 ? [...opts.queues].sort() : [...ALLA_KONAMN]

  assertKnownQueues(begarda)

  if (opts.action !== 'inspect') {
    if (opts.confirm !== target) {
      throw new Error(
        `--action=${opts.action} kräver --confirm med EXAKT måltexten.\n` +
          `  förväntat: ${target}\n` +
          `  angivet:   ${opts.confirm ?? '(inget)'}\n` +
          'Kör först utan --action och läs måltexten ur rapporten.',
      )
    }
  }

  const koer = begarda.map((name) => new Bull(name, opts.redisUrl, { prefix: opts.prefix }))
  const atgardade: string[] = []
  try {
    await Promise.all(koer.map((q) => q.isReady()))

    const client = koer[0]!.client as unknown as {
      scan: (...a: unknown[]) => Promise<[string, string[]]>
      info: (section: string) => Promise<string>
    }
    const redisInfo = await client.info('server')
    const redisVersion = /redis_version:([^\r\n]+)/.exec(redisInfo)?.[1]?.trim() ?? '(okänd)'

    const iRedis = await scanQueueNames(client, opts.prefix)
    const kodensMangd = new Set(ALLA_KONAMN)
    const utanSparIRedis = ALLA_KONAMN.filter((n) => !iRedis.includes(n))
    const okandaIRedis = iRedis.filter((n) => !kodensMangd.has(n))
    const allaBegarda = begarda.length === ALLA_KONAMN.length
    const funnaIRedis = begarda.filter((n) => iRedis.includes(n)).length
    // ASYMMETRIN ÄR AVSIKTLIG. En ENSKILD kö utan spår i Redis kan inte
    // konsumera något — den är ofarlig, och en kö som aldrig fått ett jobb har
    // inga nycklar. En kö i Redis som koden inte känner till är motsatsen: den
    // kan ha en konsument vi inte inventerat.
    //
    // MEN NOLL FUNNA ÄR INTE SAMMA SAK SOM ELVA OFARLIGA. Hittas ingen enda av
    // de begärda köerna är den överlägset troligaste förklaringen fel prefix,
    // fel databasindex eller fel Redis — inte att produktionen aldrig kört ett
    // jobb. Utan det ledet svarade verktyget "komplett: JA" mot ett tomt
    // prefix, vilket ett granskningsfynd visade skarpt.
    const inventeringKomplett = allaBegarda && okandaIRedis.length === 0 && funnaIRedis > 0

    if ((opts.action === 'pause' || opts.action === 'resume') && funnaIRedis === 0) {
      // VÄGRA, i stället för att lyckas. Bulls `pause(false)` sätter
      // `meta-paused` villkorslöst och lyckas alltid — även för ett könamn som
      // inte finns. En paus mot fel mål är därför inte ett fel som märks; den
      // ser ut som elva pausade köer. Enda sättet att skilja fallen åt är att
      // kräva att målet bevisligen BÄR köerna.
      throw new Error(
        `ingen av de ${begarda.length} begärda köerna har spår under ` +
          `${target}. Bull:s pause/resume lyckas även mot ett könamn som inte finns, ` +
          'så en åtgärd här hade rapporterat framgång mot fel prefix, fel ' +
          'databasindex eller fel Redis. Kontrollera målet i läsläge först.',
      )
    }

    if (opts.action === 'pause' || opts.action === 'resume') {
      for (const q of koer) {
        // GLOBAL (`false`), inte lokal. En lokal paus hade bara gällt den här
        // kortlivade processen och varit verkningslös i samma ögonblick
        // verktyget avslutas.
        if (opts.action === 'pause') await q.pause(false)
        else await q.resume(false)
        atgardade.push(q.name)
      }
    }

    // Läses EFTER åtgärden, så rapporten visar utfallet och inte avsikten.
    const queues: QueueReport[] = []
    for (const q of koer) queues.push(await readQueue(q))

    return {
      action: opts.action,
      target,
      bullVersion: BULL_VERSION,
      redisVersion,
      inventeringKomplett,
      funnaIRedis,
      utanSparIRedis,
      okandaIRedis,
      queues,
      atgardade,
    }
  } finally {
    await Promise.all(koer.map((q) => q.close()))
  }
}

/* istanbul ignore next -- entry point; logiken provas via runQueueOps */
function parseArgs(argv: readonly string[]): RunOptions {
  const get = (namn: string): string | undefined =>
    argv.find((a) => a.startsWith(`--${namn}=`))?.slice(namn.length + 3)

  const redisUrl = get('redis-url')
  if (!redisUrl) {
    throw new Error(
      '--redis-url saknas. Verktyget läser med flit INTE REDIS_URL ur ' +
        'miljön — ett verktyg som kör mot "det som råkade stå i miljön" antar ' +
        'produktion som standard.',
    )
  }
  const action = (get('action') ?? 'inspect') as QueueAction
  if (!['inspect', 'pause', 'resume'].includes(action)) {
    throw new Error(`okänd --action='${action}'. Giltiga: inspect | pause | resume.`)
  }
  const queues = get('queues')
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  return {
    redisUrl,
    prefix: get('prefix') ?? 'bull',
    action,
    ...(queues ? { queues } : {}),
    ...(get('confirm') !== undefined ? { confirm: get('confirm')! } : {}),
  }
}

/* istanbul ignore next -- entry point */
async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const opts = parseArgs(argv)
  log(`redis=${redactRedisUrl(opts.redisUrl)} prefix=${opts.prefix} action=${opts.action}`)
  const result = await runQueueOps(opts)

  if (argv.includes('--json')) {
    console.warn(JSON.stringify(result, null, 2))
  } else {
    log(`mål: ${result.target}`)
    log(`bull ${result.bullVersion} · redis ${result.redisVersion}`)
    log(
      `inventering komplett: ${result.inventeringKomplett ? 'JA' : 'NEJ'}` +
        ` · köer med spår: ${result.funnaIRedis}/${result.queues.length}` +
        (result.utanSparIRedis.length
          ? ` · utan spår i Redis: ${result.utanSparIRedis.join(', ')}`
          : '') +
        (result.okandaIRedis.length ? ` · okända i Redis: ${result.okandaIRedis.join(', ')}` : ''),
    )
    for (const q of result.queues) {
      const c = q.counts
      log(
        `${q.name}: globalPaus=${q.pausedGlobally} waiting=${c.waiting ?? 0} ` +
          `active=${c.active ?? 0} delayed=${c.delayed ?? 0} paused=${c.paused ?? 0} ` +
          `completed=${c.completed ?? 0} failed=${c.failed ?? 0} repeatable=${q.repeatableCount}`,
      )
    }
    if (result.atgardade.length > 0)
      log(`${result.action} utförd på: ${result.atgardade.join(', ')}`)
    else log('läsläge — ingenting skrevs')
  }

  if (!result.inventeringKomplett) {
    log(
      'OBS: inventeringen är INTE komplett. Utfallet får inte redovisas som en ' +
        'verifierad produktionsavskärmning.',
    )
  }
}

/* istanbul ignore next */
if (require.main === module) {
  main().catch((err: unknown) => {
    console.error('[queue-ops] AVBRUTEN:', err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
