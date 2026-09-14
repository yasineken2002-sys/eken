/**
 * ETT ENDA PÅSTÅENDE: `runQueueOps` ger Bull ett OPTIONSOBJEKT — aldrig URL-strängen.
 *
 * ── VARFÖR EN EGEN FIL, OCH VARFÖR EN ATTRAPP ───────────────────────────────
 *
 * Filen kom till av en NEGATIVKONTROLL som gick fel väg. Rättningen av fynd 1
 * har två halvor: att den snäva URL-formen avvisar query och fragment, och att
 * Bull aldrig får tolka strängen en andra gång. Den första halvan var mätt på
 * sju ställen. Den andra var inte mätt alls — när raden
 *
 *     new Bull(name, bullOpts)
 *
 * byttes tillbaka mot
 *
 *     new Bull(name, opts.redisUrl, { prefix: opts.prefix })
 *
 * förblev alla 74 proven i `queue-ops.spec.ts` GRÖNA. Rättningen fanns alltså
 * i koden utan att någonting höll fast den.
 *
 * Påståendet handlar om ANROPETS FORM och inte om Bulls beteende, och därför är
 * `jest.mock('bull')` rätt verktyg här: det som mäts är exakt vad vår kod
 * skickar. Bulls FAKTISKA tolkning av det objektet mäts på två andra ställen —
 * `queue-ops.spec.ts` fångar de verkliga klientoptionerna genom Bulls egen
 * `createClient`-krok, och `common/ops/automation-pause-queue.db.spec.ts` kör
 * hela verktyget mot en riktig server. Ingen av de två kan se den här frågan,
 * och den här filen kan inte se deras.
 *
 * Egen fil därför att mocken är modulbred: `queue-ops.spec.ts` behöver RIKTIG
 * Bull, och de två kan inte samsas i samma fil utan att det ena provet tyst
 * börjar mäta det andras attrapp.
 */

jest.mock('bull', () => {
  const anrop: unknown[][] = []
  /** Den databas attrappens `CLIENT INFO` påstår sig stå i. Sätts per prov. */
  const läge = { db: 0 }

  const skapaKö = (namn: string): Record<string, unknown> => ({
    name: namn,
    isReady: async () => undefined,
    client: {
      info: async () => 'redis_version:0.0.0-attrapp\r\n',
      // `CLIENT INFO` — verktyget verifierar databasindexet mot den levande
      // anslutningen. Attrappen svarar db=0, vilket är vad proven här ansluter mot.
      client: async () => `id=1 addr=127.0.0.1:0 db=${läge.db} name= `,
      scan: async () => ['0', []],
    },
    isPaused: async () => false,
    getJobCounts: async () => ({}),
    getRepeatableJobs: async () => [],
    pause: async () => undefined,
    resume: async () => undefined,
    close: async () => undefined,
  })

  function BullAttrapp(this: unknown, ...args: unknown[]): Record<string, unknown> {
    anrop.push(args)
    return skapaKö(args[0] as string)
  }
  BullAttrapp.__anrop = anrop
  BullAttrapp.__läge = läge

  return { __esModule: true, default: BullAttrapp }
})

import Bull from 'bull'
import { bullQueueOptions, parseRedisTarget, runQueueOps } from './queue-ops'
import { ALLA_KONAMN } from '../common/ops/queue-inventory'

const anrop = (Bull as unknown as { __anrop: unknown[][] }).__anrop
const läge = (Bull as unknown as { __läge: { db: number } }).__läge

const URL_MED_ALLT = 'redis://anv:SYNTHETIC_TEST_VALUE@h.example:6380/3'
const PREFIX = 'bull'

describe('runQueueOps → new Bull(...)', () => {
  beforeEach(() => {
    anrop.length = 0
    // Verktyget verifierar databasen mot den levande anslutningen, så attrappen
    // måste svara med den databas provets URL pekar ut. Prov som använder en
    // annan URL sätter om den själv.
    läge.db = 3
  })

  it('andra argumentet är ett OPTIONSOBJEKT, inte URL-strängen', async () => {
    await runQueueOps({ redisUrl: URL_MED_ALLT, prefix: PREFIX, action: 'inspect' })

    // KANARIEFÅGELN först: hade inspelningen varit tom vore varje påstående
    // nedan sant om ingenting.
    expect(anrop).toHaveLength(ALLA_KONAMN.length)

    for (const args of anrop) {
      expect(args).toHaveLength(2)
      expect(typeof args[0]).toBe('string')
      expect(typeof args[1]).toBe('object')
      expect(args[1]).toEqual(bullQueueOptions(parseRedisTarget(URL_MED_ALLT, PREFIX)))
    }
  })

  it('URL-STRÄNGEN når aldrig Bull — i något argument, i någon form', async () => {
    await runQueueOps({ redisUrl: URL_MED_ALLT, prefix: PREFIX, action: 'inspect' })

    // Den bärande raden. `new Bull(name, url, { prefix })` hade lagt strängen
    // som argument 1, och Bull hade då tolkat den med sin egen parser — alltså
    // en andra tolkning, som kan ge ett annat mål än måltexten visade.
    const platt = JSON.stringify(anrop)
    expect(platt).not.toContain(URL_MED_ALLT)
    expect(anrop.flat()).not.toContain(URL_MED_ALLT)
  })

  it('prefixet står i optionsobjektet, inte i en tredje parameter', async () => {
    await runQueueOps({ redisUrl: URL_MED_ALLT, prefix: 'annat-prefix', action: 'inspect' })
    for (const args of anrop) {
      expect(args[2]).toBeUndefined()
      expect(args[1]).toMatchObject({ prefix: 'annat-prefix' })
    }
  })

  it('DATABASEN verifieras mot den LEVANDE anslutningen, inte mot måltexten', async () => {
    // Formkontrollen säger bara att db-ledet ÄR ett tal. ioredis kör SELECT i
    // sin connectHandler och SVÄLJER felet (silentEmit), så anslutningen blir
    // ready på db 0 ändå. Uppmätt mot riktig Redis före rättningen:
    // `redis://…/99` gav måltext db99, funnaIRedis=2 och "komplett: JA" — mot
    // nycklar som låg i db 0.
    läge.db = 0
    await expect(
      runQueueOps({ redisUrl: 'redis://h.example:6379/7', prefix: PREFIX, action: 'inspect' }),
    ).rejects.toThrow('måltexten säger db7, men anslutningen står i db0')
  })

  it('KANARIEFÅGELN: stämmer databasen passerar läsningen', async () => {
    läge.db = 7
    await expect(
      runQueueOps({ redisUrl: 'redis://h.example:6379/7', prefix: PREFIX, action: 'inspect' }),
    ).resolves.toMatchObject({ target: 'redis://h.example:6379/db7 prefix=bull' })
  })

  it('kan CLIENT INFO inte läsas VÄGRAR verktyget — en spärr som inte mäter är ingen spärr', async () => {
    läge.db = Number.NaN
    await expect(
      runQueueOps({ redisUrl: 'redis://h.example:6379/0', prefix: PREFIX, action: 'inspect' }),
    ).rejects.toThrow('CLIENT INFO')
  })

  it('TLS-flaggan följer med in i anropet för rediss://', async () => {
    läge.db = 0
    await runQueueOps({ redisUrl: 'rediss://h.example:6380/0', prefix: PREFIX, action: 'inspect' })
    expect(anrop.length).toBeGreaterThan(0)
    for (const args of anrop) {
      expect(args[1]).toMatchObject({
        redis: { tls: { servername: 'h.example', rejectUnauthorized: true } },
      })
    }
  })
})
