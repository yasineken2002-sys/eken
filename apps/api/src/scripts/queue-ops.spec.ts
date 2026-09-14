/**
 * DRIFTVERKTYGETS SPÄRRAR — de delar som måste hålla INNAN verktyget rör Redis.
 *
 * Bulls faktiska beteende (global paus, bevarade jobb, återöppning) mäts mot en
 * riktig server i `common/ops/automation-pause-queue.db.spec.ts`, som också kör
 * `runQueueOps` skarpt. Den här filen mäter det som ska stoppa en körning innan
 * en enda anslutning öppnas — alltså de spärrar som avgör om verktyget kan
 * riktas mot fel system.
 *
 * ── TVÅ SAKER HÄR ÄR INTE STRÄNGJÄMFÖRELSER, OCH DET ÄR POÄNGEN ─────────────
 *
 * 1. MÅLET mäts på FÅNGADE KLIENTOPTIONER. Fyndet som föranledde filen var
 *    precis att måltexten och anslutningen räknades fram ur TVÅ tolkningar av
 *    samma sträng. Ett prov som jämför vår utskrift mot vår egen parser hade
 *    varit grönt hela tiden — det hade mätt den ena tolkningen mot sig själv.
 *    Här matas i stället `bullQueueOptions` in i en riktig Bull-kö, och de
 *    optioner Bull FAKTISKT skickar vidare till klienten fångas via `createClient`.
 *
 * 2. SCAN-ATTRAPPEN har en TROGEN globmodell. Den gamla attrappen översatte bara
 *    `*` till `.*` och kände varken `?`, teckenklasser eller escape. Den kunde
 *    därför inte pröva fyndet om globtecken i prefix: den var per konstruktion
 *    grön. Modellen nedan är en radvis port av Redis egen `stringmatchlen`, och
 *    den har egna kanariefåglar mot UPPMÄTTA utfall från riktig Redis 7.4.8.
 */

import Bull from 'bull'
import { EventEmitter } from 'node:events'
import {
  assertKnownQueues,
  assertScanSafePrefix,
  bullQueueOptions,
  describeTarget,
  parseRedisTarget,
  redactRedisUrl,
  runQueueOps,
  scanQueueNames,
  type RedisTarget,
} from './queue-ops'
import { ALLA_KONAMN } from '../common/ops/queue-inventory'

/** Endast syntetiska värden i den här filen. Inget är en riktig hemlighet. */
const SYNTETISK_HEMLIGHET = 'SYNTHETIC_TEST_VALUE'

const mal = (url: string, prefix = 'bull'): RedisTarget => parseRedisTarget(url, prefix)

describe('redactRedisUrl', () => {
  it('klipper bort lösenord OCH användarnamn', () => {
    const ut = redactRedisUrl('redis://default:s3cr3t@redis.internal:6379/2')
    expect(ut).not.toContain('s3cr3t')
    expect(ut).not.toContain('default')
    expect(ut).toContain('redis.internal')
  })

  it('MASKERAR ÄVEN ?password= — Bull tar den formen som credential', () => {
    // Fyndet, ordagrant: `new URL()` lägger inte queryn i `u.password`, så den
    // gamla maskeringen återgav den här raden OFÖRÄNDRAD. Bull 4.16.5 spretar
    // in hela queryn i klientoptionerna och använder värdet som lösenord.
    const ut = redactRedisUrl(`redis://example:6379/0?password=${SYNTETISK_HEMLIGHET}`)
    expect(ut).not.toContain(SYNTETISK_HEMLIGHET)
  })

  it('maskerar VARJE queryvärde, inte bara de parameternamn vi känner igen', () => {
    // En lista över "hemliga namn" åldras vid nästa biblioteksversion. Provet
    // använder med flit ett namn ingen skulle sätta på en sådan lista.
    const ut = redactRedisUrl(`redis://example:6379/0?sentinelPassword=${SYNTETISK_HEMLIGHET}`)
    expect(ut).not.toContain(SYNTETISK_HEMLIGHET)
  })

  it('maskerar fragmentet', () => {
    expect(redactRedisUrl(`redis://example:6379/0#${SYNTETISK_HEMLIGHET}`)).not.toContain(
      SYNTETISK_HEMLIGHET,
    )
  })

  /**
   * UTDATA KONSTRUERAS, DEN SERIALISERAS INTE.
   *
   * Den bärande egenskapen efter opaque-path-fyndet. Serialiserar man
   * URL-objektet i stället blir svaret procentkodat —
   * `redis://h.example:6379/(ej%20%C3%A5tergivet)` — och, viktigare, varje
   * URL-form vars maskering är en tyst no-op återges oförändrad. Den exakta
   * jämförelsen nedan faller på båda.
   */
  it.each([
    ['ren adress', 'redis://h.example:6379/3', 'redis://h.example:6379/3'],
    ['utan port och db', 'redis://h.example', 'redis://h.example:6379/0'],
    [
      'credentials sammanfattas',
      'redis://anv:hem@h.example:6379/1',
      'redis://***:***@h.example:6379/1',
    ],
    [
      'okänd sökväg, OPROCENTKODAD',
      'redis://h.example:6379/SYNTHETIC_TEST_VALUE',
      'redis://h.example:6379/(ej återgivet)',
    ],
    ['IPv6 behåller klamrarna', 'redis://[::1]:6379/2', 'redis://[::1]:6379/2'],
    [
      'query och fragment sammanfattas',
      'redis://h.example:6379/0?a=1&b=2#f',
      'redis://h.example:6379/0 (+2 queryparameter(rar) utelämnade) (+fragment utelämnat)',
    ],
    ['opaque path utan värd', 'redis:SYNTHETIC_TEST_VALUE', '(redis-url utan värd — utelämnad)'],
    [
      'opaque path med userinfo',
      'rediss:user:SYNTHETIC_TEST_VALUE@h.example:6379',
      '(redis-url utan värd — utelämnad)',
    ],
    ['hierarkisk MEN utan värd', 'redis:///0', '(redis-url utan värd — utelämnad)'],
    ['främmande schema', 'https://h.example/0', '(inte en redis-url — utelämnad)'],
  ])('redactRedisUrl bygger svaret ur accepterade fält — %s', (_namn, url, förväntat) => {
    expect(redactRedisUrl(url)).toBe(förväntat)
  })

  /**
   * ── VÄRDEN ÄR EN OPAQUE HOST ──────────────────────────────────────────────
   *
   * `redis:` är inget special scheme, så procentkodning i värden avkodas aldrig
   * och `:`/`@` kan kodas in där. En hel credential hamnar då i `u.hostname`
   * medan `u.username`/`u.password` är TOMMA — och formen ACCEPTERADES, stod i
   * måltexten och gick vidare till anslutning. Samma sträng med `http://`
   * avvisas av Node; skillnaden är bara att `http` är ett special scheme.
   */
  it.each([
    ['procentkodad userinfo', `redis://user%3A${SYNTETISK_HEMLIGHET}%40h.example:6379/0`],
    ['semikolon', `redis://h.example;${SYNTETISK_HEMLIGHET}/0`],
    ['citattecken', `redis://'${SYNTETISK_HEMLIGHET}'/0`],
    ['skiljetecken', `redis://${SYNTETISK_HEMLIGHET}$%&()*+=~/0`],
  ])('AVVISAR en värd som inte är en värd — %s', (_namn, url) => {
    expect(() => mal(url)).toThrow('värd som inte är ett värdnamn')
    try {
      mal(url)
    } catch (err) {
      expect((err as Error).message).not.toContain(SYNTETISK_HEMLIGHET)
    }
    // Och redaktorn håller tillbaka den även om den ändå skulle skrivas ut.
    expect(redactRedisUrl(url)).not.toContain(SYNTETISK_HEMLIGHET)
    expect(redactRedisUrl(url)).toContain('(värd ej återgiven)')
  })

  it.each([
    ['värdnamn', 'redis://h.example:6379/0'],
    ['understreck i tjänstenamn', 'redis://redis_service:6379/0'],
    ['bindestreck', 'redis://eken-redis-1:6379/0'],
    ['IPv4', 'redis://127.0.0.1:6379/0'],
    ['IPv6', 'redis://[::1]:6379/0'],
    ['localhost', 'redis://localhost:6379/0'],
  ])('KANARIEFÅGELN: en VERKLIG värd passerar — %s', (_namn, url) => {
    // Utan de här raderna vore proven ovan uppfyllda av att varje värd avvisas.
    expect(() => mal(url)).not.toThrow()
    expect(redactRedisUrl(url)).not.toContain('ej återgiven')
  })

  it('KANARIEFÅGELN: värd och port är fortfarande LÄSBARA efter maskeringen', () => {
    // Utan den här raden vore proven ovan gröna av att funktionen returnerade
    // tomt — alltså av att den slutat säga något alls.
    const ut = redactRedisUrl(`redis://u:${SYNTETISK_HEMLIGHET}@h.example:6380/3?x=y`)
    expect(ut).toContain('h.example')
    expect(ut).toContain('6380')
  })

  it('en URL utan credentials lämnas läsbar', () => {
    expect(redactRedisUrl('redis://127.0.0.1:6379')).toContain('127.0.0.1:6379')
  })

  it('en OPARSERBAR sträng skrivs inte ut alls', () => {
    // Felriktningen: en sträng vi inte kan tolka kan mycket väl VARA en hel
    // credential. Att gissa och skriva ut den är värre än att utelämna den.
    const ut = redactRedisUrl('detta-ar-inte-en-url-men-kanske-en-hemlighet')
    expect(ut).not.toContain('hemlighet')
  })
})

describe('parseRedisTarget — EN tolkning, eller inget mål alls', () => {
  it('bär schema, värd, port, databas och prefix', () => {
    expect(mal('redis://h.example:6380/3', 'p')).toMatchObject({
      schema: 'redis',
      host: 'h.example',
      port: 6380,
      db: 3,
      prefix: 'p',
      tls: false,
    })
  })

  it('saknad port och saknad databas blir Redis default, inte tomt', () => {
    expect(mal('redis://h.example')).toMatchObject({ port: 6379, db: 0 })
  })

  it('rediss:// ger tls i den validerade formen', () => {
    expect(mal('rediss://h.example:6380/0').tls).toBe(true)
  })

  it('credentials procentavkodas EN gång', () => {
    const t = mal(`redis://anv%C3%A4ndare:a%40b@h.example:6379/0`)
    expect(t.username).toBe('användare')
    expect(t.password).toBe('a@b')
  })

  it('IPv6 bärs utan klamrar till klienten men MED klamrar i måltexten', () => {
    const t = mal('redis://[::1]:6379/0')
    expect(t.host).toBe('::1')
    expect(describeTarget(t)).toBe('redis://[::1]:6379/db0 prefix=bull')
  })

  // ── AVVISNINGARNA ────────────────────────────────────────────────────────
  it.each([
    ['värd', 'redis://display.example:6379/0?host=actual.example'],
    ['port', 'redis://display.example:6379/0?port=6381'],
    ['databas', 'redis://display.example:6379/0?db=2'],
    ['prefix', 'redis://display.example:6379/0?keyPrefix=actual-prefix'],
  ])('AVVISAR en query som kan ersätta %s', (_vad, url) => {
    // Uppmätt mot oförändrad Bull 4.16.5: varje sådan parameter vinner över det
    // måltexten visade, för `queue.js:352-354` spretar in queryn EFTER
    // värd/port/db. `?keyPrefix=` är den farligaste — SCAN läser ett nyckelrum
    // och Bull muterar ett annat, rakt igenom tommålsspärren.
    expect(() => mal(url)).toThrow('queryparameter')
  })

  /**
   * INGENTING UR QUERYN ÅTERGES — varken namn eller värde.
   *
   * Filen krävde tidigare motsatsen för namnet: `toContain('password')`, med
   * resonemanget att namnet på ett `namn=värde`-par är säkert att visa. Det var
   * fel, och provet var därför ett mothåll mot rätt rättning. Ett likhetstecken
   * gör inte namnet betrott — den som klistrar en credential i fel flagga kan
   * lika gärna få med ett efterföljande `=`, eller ha hemligheten i namnet.
   */
  it.each([
    ['hemligheten i NAMNET, tomt värde', `?${SYNTETISK_HEMLIGHET}=`],
    ['hemligheten i NAMNET, med värde', `?${SYNTETISK_HEMLIGHET}=x`],
    ['hemligheten i VÄRDET', `?password=${SYNTETISK_HEMLIGHET}`],
    ['hemligheten utan likhetstecken', `?${SYNTETISK_HEMLIGHET}`],
    ['hemligheten bland flera led', `?a=1&${SYNTETISK_HEMLIGHET}=2&b=3`],
  ])('felet bär varken namn eller värde ur queryn — %s', (_namn, query) => {
    try {
      mal(`redis://h:6379/0${query}`)
      throw new Error('skulle ha avvisats')
    } catch (err) {
      const text = (err as Error).message
      expect(text).not.toContain(SYNTETISK_HEMLIGHET)
      expect(text).toContain('queryparameter')
      expect(text).toContain('Namn och värden återges inte')
    }
  })

  it('KANARIEFÅGELN: felet säger ANTALET, så det inte blivit stumt', () => {
    // Annars vore proven ovan gröna av att meddelandet slutat säga något alls.
    expect(() => mal('redis://h:6379/0?a=1&b=2&c=3')).toThrow('bär 3 queryparameter(rar)')
    expect(() => mal('redis://h:6379/0?a=1')).toThrow('bär 1 queryparameter(rar)')
  })

  it('AVVISAR ett fragment', () => {
    expect(() => mal('redis://h:6379/0#x')).toThrow('fragment')
  })

  it.each([['http://h:6379/0'], ['rediss+sentinel://h:6379/0'], ['unix:///tmp/redis.sock']])(
    'AVVISAR schemat i %s — ingen tyst nedgradering',
    (url) => {
      expect(() => mal(url)).toThrow(/Endast redis:\/\/ och rediss:\/\//)
    },
  )

  it('AVVISAR ett databasindex som inte är ett heltal', () => {
    expect(() => mal('redis://h:6379/noll')).toThrow('databasindex')
  })

  it('AVVISAR en sträng som inte är en URL — utan att återge den', () => {
    expect(() => mal(`inte-en-url-${SYNTETISK_HEMLIGHET}`)).toThrow(/går inte att tolka/)
    try {
      mal(`inte-en-url-${SYNTETISK_HEMLIGHET}`)
    } catch (err) {
      expect((err as Error).message).not.toContain(SYNTETISK_HEMLIGHET)
    }
  })

  it.each([['bu?l'], ['bul*'], ['b[ua]ll'], ['bull\\']])('AVVISAR globprefixet %s', (prefix) => {
    expect(() => mal('redis://h:6379/0', prefix)).toThrow('metatecken')
  })

  it('AVVISAR ett tomt prefix', () => {
    expect(() => mal('redis://h:6379/0', '')).toThrow('--prefix är tomt')
  })

  it('KANARIEFÅGELN: normala mål passerar — annars vore avvisningarna gröna av att allt faller', () => {
    expect(() => mal('redis://localhost:6379/0', 'bull')).not.toThrow()
    expect(() => mal('rediss://user:pw@h.example:6380/2', 'test:driftpaus:1')).not.toThrow()
  })
})

describe('describeTarget', () => {
  it('bär schema, värd, port, databasindex och prefix', () => {
    expect(describeTarget(mal('redis://h.example:6380/3', 'bull'))).toBe(
      'redis://h.example:6380/db3 prefix=bull',
    )
  })

  it('saknad port och saknat db-index blir Redis default, inte tomt', () => {
    expect(describeTarget(mal('redis://h.example', 'p'))).toBe(
      'redis://h.example:6379/db0 prefix=p',
    )
  })

  it('SCHEMAT skiljer två mål åt — TLS och icke-TLS får inte dela --confirm', () => {
    expect(describeTarget(mal('redis://h:6379/0'))).not.toBe(
      describeTarget(mal('rediss://h:6379/0')),
    )
  })

  it('måltexten skiljer två prefix åt — annars vore --confirm meningslös', () => {
    expect(describeTarget(mal('redis://h:6379', 'bull'))).not.toBe(
      describeTarget(mal('redis://h:6379', 'x')),
    )
  })

  it('måltexten bär ALDRIG lösenordet — den skrivs ut och upprepas av en operatör', () => {
    expect(describeTarget(mal(`redis://u:${SYNTETISK_HEMLIGHET}@h:6379/1`))).not.toContain(
      SYNTETISK_HEMLIGHET,
    )
  })
})

/**
 * ── DE FAKTISKA KLIENTOPTIONERNA ────────────────────────────────────────────
 *
 * `createClient` är Bulls egen krok, och den får `_.assign({}, options.redis)`
 * EFTER att Bull räknat färdigt (`queue.js:290-310`). Det är alltså exakt det
 * objekt ioredis hade konstruerats med. Ingen anslutning öppnas: kroken
 * returnerar attrappen nedan i stället för en riktig klient.
 */
class AttrappKlient extends EventEmitter {
  status = 'ready'
  options: Record<string, unknown> = {}
  defineCommand(): void {}
  /** Bulls konstruktor läser serverversionen direkt (`queue.js:1397`). */
  async info(): Promise<string> {
    return 'redis_version:0.0.0-attrapp\r\n'
  }
  async quit(): Promise<string> {
    this.status = 'end'
    return 'OK'
  }
  async disconnect(): Promise<void> {
    this.status = 'end'
  }
}

interface Fangst {
  optioner: Record<string, unknown>
  keyPrefix: string
}

async function fangaKlientoptioner(t: RedisTarget): Promise<Fangst> {
  const fangade: Record<string, unknown>[] = []
  const ko = new Bull('fangst', {
    ...bullQueueOptions(t),
    createClient: (_typ, config) => {
      fangade.push({ ...(config as Record<string, unknown>) })
      return new AttrappKlient() as never
    },
  })
  void ko.client
  const keyPrefix = (ko as unknown as { keyPrefix: string }).keyPrefix
  await ko.close(true)
  return { optioner: fangade[0] ?? {}, keyPrefix }
}

describe('bullQueueOptions — måltexten och anslutningen är SAMMA tolkning', () => {
  it('värd, port och databas i de FÅNGADE optionerna är de måltexten visar', async () => {
    const t = mal('redis://h.example:6380/3', 'bull')
    const { optioner } = await fangaKlientoptioner(t)
    expect(describeTarget(t)).toBe('redis://h.example:6380/db3 prefix=bull')
    expect(optioner).toMatchObject({ host: 'h.example', port: 6380, db: 3 })
  })

  it('PREFIXET som Bull muterar är det SCAN läser', async () => {
    // Fyndets farligaste halva. `?keyPrefix=` kunde tidigare skilja de två åt;
    // formen är avvisad, och det här är beviset att den kvarvarande vägen håller.
    const t = mal('redis://h.example:6379/0', 'test-prefix')
    const { keyPrefix, optioner } = await fangaKlientoptioner(t)
    expect(keyPrefix).toBe('test-prefix')
    expect(optioner['keyPrefix']).toBeUndefined()
  })

  it('rediss:// ger FAKTISK tls i klientoptionerna, med certifikatverifiering kvar', async () => {
    // Före rättningen: rapporten sa `rediss`, optionerna saknade `tls`, och
    // ioredis valde vanlig nätverksanslutning — en tyst nedgradering i det enda
    // läge verktyget påstår sig vara skyddat.
    const { optioner } = await fangaKlientoptioner(mal('rediss://secure.example:6380/0'))
    expect(optioner['tls']).toEqual({ servername: 'secure.example', rejectUnauthorized: true })
  })

  it('rediss:// mot en IP sätter INGEN servername — men behåller certifikatkravet', async () => {
    // RFC 6066 tillåter inte SNI för en IP-adress; Node varnar (DEP0123) och
    // aviserar att värdet kommer att ignoreras. Identitetskontrollen faller då
    // tillbaka på IP-SAN i certifikatet, vilket är rätt beteende.
    const { optioner } = await fangaKlientoptioner(mal('rediss://10.1.2.3:6380/0'))
    expect(optioner['tls']).toEqual({ rejectUnauthorized: true })
  })

  it('rediss:// mot ett VÄRDNAMN sätter servername — annars vore provet ovan stumt', async () => {
    const { optioner } = await fangaKlientoptioner(mal('rediss://h.example:6380/0'))
    expect(optioner['tls']).toEqual({ servername: 'h.example', rejectUnauthorized: true })
  })

  it('redis:// ger INGEN tls — annars vore provet ovan grönt av att allt är TLS', async () => {
    const { optioner } = await fangaKlientoptioner(mal('redis://plain.example:6379/0'))
    expect(optioner['tls']).toBeUndefined()
  })

  it('credentials når klienten avkodade', async () => {
    const { optioner } = await fangaKlientoptioner(
      mal(`redis://anv:${SYNTETISK_HEMLIGHET}@h.example:6379/0`),
    )
    expect(optioner).toMatchObject({ username: 'anv', password: SYNTETISK_HEMLIGHET })
  })

  it('KANARIEFÅGELN: fångsten kan visa en AVVIKELSE — den är inte blind', async () => {
    // Utan den här raden vore proven ovan gröna även om `createClient` aldrig
    // anropades och `optioner` alltid var tomt: `toMatchObject({})` mot {} är
    // sant. Här krävs att jämförelsen FALLER när målen skiljer sig.
    const { optioner } = await fangaKlientoptioner(mal('redis://h.example:6380/3'))
    expect(optioner).not.toMatchObject({ host: 'annan.example' })
    expect(Object.keys(optioner).length).toBeGreaterThan(0)
  })
})

describe('fel mål ger NOLL åtgärder', () => {
  it('en URL med query avvisas FÖRE anslutningen — inget skrivs', async () => {
    // Värden är oåtkomlig med flit. Skulle avvisningen ligga efter anslutningen
    // hade provet hängt i stället för att avvisa omedelbart.
    await expect(
      runQueueOps({
        redisUrl: 'redis://127.0.0.1:1/0?host=annan.example',
        prefix: 'bull',
        action: 'pause',
        confirm: 'redis://127.0.0.1:1/db0 prefix=bull',
      }),
    ).rejects.toThrow('queryparameter')
  })

  it('ett globprefix avvisas FÖRE anslutningen — inget skrivs', async () => {
    await expect(
      runQueueOps({ redisUrl: 'redis://127.0.0.1:1/0', prefix: 'bu?l', action: 'inspect' }),
    ).rejects.toThrow('metatecken')
  })
})

describe('confirm-spärren', () => {
  const url = 'redis://127.0.0.1:1/0' // pekar ingenstans; spärren ska slå före anslutning

  it.each([
    ['utan confirm', undefined],
    ['med fel confirm', 'något annat'],
    ['med confirm som bara liknar', '127.0.0.1:1/db0 prefix=fel'],
  ])('pause %s avbryts', async (_namn, confirm) => {
    await expect(
      runQueueOps({
        redisUrl: url,
        prefix: 'bull',
        action: 'pause',
        ...(confirm !== undefined ? { confirm } : {}),
      }),
    ).rejects.toThrow('--confirm')
  })

  it('resume bär SAMMA spärr — en återöppning är lika mycket en åtgärd som en paus', async () => {
    await expect(runQueueOps({ redisUrl: url, prefix: 'bull', action: 'resume' })).rejects.toThrow(
      '--confirm',
    )
  })

  it.each([
    ['en adress med lösenord', `redis://anv:${SYNTETISK_HEMLIGHET}@h.example:6379/0`],
    ['en VERSAL adress', `REDIS://anv:${SYNTETISK_HEMLIGHET}@h.example:6379/0`],
    ['en bar hemlighet', SYNTETISK_HEMLIGHET],
    ['userinfo utan schema', `//anv:${SYNTETISK_HEMLIGHET}@h.example:6379`],
  ])('--confirm återges inte som rå text — %s', async (_namn, felpastad) => {
    // `--confirm` och `--redis-url` bär båda en redis://-sträng, så en förväxling
    // är nära till hands. Maskeringen täckte bara ADRESSFORMADE strängar; en bar
    // hemlighet ekades oförändrad. Innehållet återges därför inte alls.
    try {
      await runQueueOps({ redisUrl: url, prefix: 'bull', action: 'pause', confirm: felpastad })
      throw new Error('skulle ha avvisats')
    } catch (err) {
      const text = (err as Error).message
      expect(text).not.toContain(SYNTETISK_HEMLIGHET)
      expect(text).toContain('--confirm')
      // KANARIEFÅGELN: den FÖRVÄNTADE måltexten står kvar, läsbar.
      expect(text).toContain('förväntat: redis://127.0.0.1:1/db0 prefix=bull')
    }
  })

  it('felmeddelandet visar den förväntade måltexten så operatören kan läsa den', async () => {
    await expect(runQueueOps({ redisUrl: url, prefix: 'bull', action: 'pause' })).rejects.toThrow(
      'redis://127.0.0.1:1/db0 prefix=bull',
    )
  })
})

describe('--queues valideras mot kodens inventering', () => {
  it('ETT STAVFEL avbryter i stället för att pausa en kö som inte finns', () => {
    // `new Bull('mail-high').pause(false)` LYCKAS — bindestreck i stället för
    // kolon hade gett raden `mail-high: globalPaus=true`, operatören hade
    // bockat av mejlköerna, och `mail:high` hade konsumerat vidare.
    expect(() => assertKnownQueues(['mail-high'])).toThrow('mail-high')
  })

  it('felet räknar upp de giltiga namnen, så rättelsen inte kräver en till körning', () => {
    expect(() => assertKnownQueues(['psd2_sync'])).toThrow('mail:high')
  })

  it('UPPREPADE namn avvisas — elva `pdf` är en kö, inte elva', () => {
    // Uppmätt före rättningen i ett nätverksfritt anrop av verkliga runQueueOps:
    // inventeringKomplett=true, funnaIRedis=11, åtgärdade = pdf elva gånger,
    // och de tio andra köerna orörda.
    expect(() => assertKnownQueues(Array(11).fill('pdf'))).toThrow('upprepade namn')
    expect(() => assertKnownQueues(Array(11).fill('pdf'))).toThrow('pdf (x11)')
  })

  it('KANARIEFÅGELN: giltiga namn passerar — annars vore proven ovan gröna av att allt avbryts', () => {
    expect(() => assertKnownQueues(['mail:high', 'psd2-sync'])).not.toThrow()
    expect(() => assertKnownQueues(ALLA_KONAMN)).not.toThrow()
    expect(() => assertKnownQueues([])).not.toThrow()
  })

  it('kontrollen ligger FÖRE anslutningen — den når aldrig nätverket', async () => {
    // URL:en pekar ingenstans. Skulle namnkontrollen ligga efter anslutningen
    // hade provet hängt i stället för att avvisa på tre millisekunder.
    await expect(
      runQueueOps({
        redisUrl: 'redis://127.0.0.1:1/0',
        prefix: 'bull',
        action: 'inspect',
        queues: ['mail-high'],
      }),
    ).rejects.toThrow('--queues')
  })
})

/**
 * ── EN TROGEN MODELL AV REDIS GLOBMATCHNING ─────────────────────────────────
 *
 * Radvis port av `stringmatchlen` i Redis `util.c`. Den gamla attrappen
 * översatte bara `*` till `.*` och kunde därför inte pröva fyndet om globtecken
 * i prefix — den var per konstruktion grön om just den frågan.
 *
 * Modellen är fortfarande en modell. Därför två saker: den har kanariefåglar mot
 * UPPMÄTTA utfall från isolerad riktig Redis 7.4.8 (nedan), och samma egenskap
 * mäts dessutom mot en riktig server i
 * `common/ops/automation-pause-queue.db.spec.ts`.
 */
function redisGlobMatch(monster: string, strang: string): boolean {
  let p = 0
  let s = 0
  while (p < monster.length && s < strang.length) {
    const tecken = monster[p]!
    if (tecken === '*') {
      while (monster[p + 1] === '*') p += 1
      if (p + 1 === monster.length) return true
      for (let i = s; i <= strang.length; i += 1) {
        if (redisGlobMatch(monster.slice(p + 1), strang.slice(i))) return true
      }
      return false
    }
    if (tecken === '?') {
      s += 1
    } else if (tecken === '[') {
      p += 1
      const negerad = monster[p] === '^'
      if (negerad) p += 1
      let traff = false
      for (;;) {
        if (monster[p] === '\\' && p + 1 < monster.length) {
          p += 1
          if (monster[p] === strang[s]) traff = true
        } else if (monster[p] === ']') {
          break
        } else if (p >= monster.length) {
          p -= 1
          break
        } else if (p + 2 < monster.length && monster[p + 1] === '-') {
          let start = monster[p]!.codePointAt(0)!
          let slut = monster[p + 2]!.codePointAt(0)!
          if (start > slut) [start, slut] = [slut, start]
          const c = strang[s]?.codePointAt(0) ?? -1
          p += 2
          if (c >= start && c <= slut) traff = true
        } else if (monster[p] === strang[s]) {
          traff = true
        }
        p += 1
      }
      if (negerad ? traff : !traff) return false
      s += 1
    } else {
      if (tecken === '\\' && p + 1 < monster.length) p += 1
      if (monster[p] !== strang[s]) return false
      s += 1
    }
    p += 1
    if (s === strang.length) {
      while (monster[p] === '*') p += 1
      break
    }
  }
  return p === monster.length && s === strang.length
}

describe('redisGlobMatch — modellen mot UPPMÄTTA Redis-utfall', () => {
  // Varje rad nedan är körd mot isolerad riktig Redis 7.4.8 (egen container,
  // port 6399, tom databas) innan den skrevs här. Utan de här raderna är
  // modellen bara en andra åsikt om samma sak som SCAN-attrappen.
  it.each([
    ['bull:*:id', 'bull:pdf:id', true],
    ['bu?l:*:id', 'bull:pdf:id', true],
    ['bul*:*:id', 'bull:pdf:id', true],
    ['b[ua]ll:*:id', 'bull:pdf:id', true],
    ['b[^u]ll:*:id', 'bull:pdf:id', false],
    ['bu\\?l:*:id', 'bull:pdf:id', false],
    ['bu\\?l:*:id', 'bu?l:pdf:id', true],
    ['bull:*:id', 'annat:pdf:id', false],
    ['bull:*:id', 'bull:mail:high:id', true],
  ])('%s mot %s → %s', (monster, nyckel, forvantat) => {
    expect(redisGlobMatch(monster, nyckel)).toBe(forvantat)
  })
})

describe('scanQueueNames', () => {
  /** SCAN-attrapp med TROGEN globmatchning och cursor 0. */
  function fakeClient(keys: readonly string[]) {
    return {
      scan: async (...a: unknown[]): Promise<[string, string[]]> => {
        const monster = String(a[2])
        return ['0', keys.filter((k) => redisGlobMatch(monster, k))]
      },
    }
  }

  it('läser ut könamnet ur nyckeln', async () => {
    const namn = await scanQueueNames(fakeClient(['bull:psd2-sync:id', 'bull:pdf:wait']), 'bull')
    expect(namn).toEqual(['pdf', 'psd2-sync'])
  })

  it('KOLON I KÖNAMNET överlever — mail:high får inte bli "mail"', async () => {
    // Den formen är verklig (`mail:high`, `mail:normal`, `mail:low`) och är
    // skälet att namnet skalas fram från ändarna i stället för att splittas.
    const namn = await scanQueueNames(
      fakeClient(['bull:mail:high:id', 'bull:mail:low:wait']),
      'bull',
    )
    expect(namn).toEqual(['mail:high', 'mail:low'])
  })

  it('en TOM men PAUSAD kö syns via meta-paused — den har inga jobbnycklar alls', async () => {
    // Utan det suffixet hade en kö försvunnit ur inventeringen precis när den är
    // som mest intressant: pausad, tömd på väntande jobb, men fortfarande där.
    const namn = await scanQueueNames(fakeClient(['bull:ai-shadow:meta-paused']), 'bull')
    expect(namn).toEqual(['ai-shadow'])
  })

  it('namn under ETT ANNAT prefix plockas inte upp', async () => {
    const namn = await scanQueueNames(fakeClient(['annat:pdf:id', 'bull:pdf:id']), 'bull')
    expect(namn).toEqual(['pdf'])
  })

  it.each([['bu?l'], ['bul*'], ['b[ua]ll'], ['bull\\'], ['']])(
    'AVVISAR prefixet %s i stället för att skanna ett annat nyckelrum',
    async (prefix) => {
      // Mot riktig Redis 7.4.8 TRÄFFAR `bu?l:*:id` nycklarna under `bull:`,
      // medan Bull muterar det BOKSTAVLIGA prefixet `bu?l`. Före rättningen
      // återrapporterades pdf och mail:high; `b[ua]ll` gav dessutom stympade
      // namn ("2-sync", "l:high"), eftersom namnet skalas fram med prefix.length.
      // Dagens loop filtrerar bort träffarna bokstavligt, så den vägen ger nu
      // tomt — men `--allow-empty-target` hade ändå släppt fram en paus under
      // det bokstavliga globprefixet. Därför avvisas formen här, före allt.
      await expect(scanQueueNames(fakeClient(['bull:pdf:id']), prefix)).rejects.toThrow(
        /metatecken|--prefix är tomt/,
      )
    },
  )

  it('BOKSTAVLIG kontroll per träff — en klient som svarar brett ignoreras', async () => {
    // Mothållet mot att vår bild av Redis globregler är fel. Klienten här
    // returnerar nycklar som INTE ligger under prefixet; de ska falla bort även
    // om mönstret enligt någon tolkning skulle ha matchat dem.
    const lögnaktig = {
      scan: async (): Promise<[string, string[]]> => [
        '0',
        ['annat:pdf:id', 'bull:riktig:id', 'bullx:fel:id', 'bull:fel:wrongsuffix'],
      ],
    }
    expect(await scanQueueNames(lögnaktig, 'bull')).toEqual(['riktig'])
  })
})

describe('köinventeringen', () => {
  it('bär alla elva köer appen registrerar', () => {
    // Talet står här som en KANARIEFÅGEL, inte som sanningskälla: mängden
    // härleds i queue-inventory.ts ur könamnens egna konstanter, och att koden
    // och den filen inte glidit isär bevakas av check-automation-pause.mjs.
    // Ändras antalet ska någon behöva titta.
    expect(ALLA_KONAMN).toHaveLength(11)
    expect(new Set(ALLA_KONAMN).size).toBe(ALLA_KONAMN.length)
  })

  it('innehåller de fyra som avskärmningsordningen namnger vid namn', () => {
    for (const namn of ['psd2-sync', 'mail:high', 'mail:normal', 'mail:low']) {
      expect(ALLA_KONAMN).toContain(namn)
    }
  })
})

describe('assertScanSafePrefix', () => {
  it('KANARIEFÅGELN: verkliga prefix passerar', () => {
    expect(() => assertScanSafePrefix('bull')).not.toThrow()
    expect(() => assertScanSafePrefix('test:driftpaus:123:456')).not.toThrow()
  })
})
