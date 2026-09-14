/**
 * HELA CLI:T, INKLUSIVE FELHANTERAREN — stdout OCH stderr.
 *
 * ── VARFÖR EN BARNPROCESS ───────────────────────────────────────────────────
 *
 * Filen kom till av två granskningsfynd som inget enhetsprov kunde se, därför
 * att de inte låg i en exporterad funktion utan i vägen MELLAN dem:
 *
 *   A.  --redis-url=redis://h:6379/0?SYNTHETIC_TEST_VALUE
 *       parserns eget fel dolde värdet korrekt, men `main`:s felhanterare
 *       loggade därefter
 *         [queue-ops] avvisad --redis-url: redis://h:6379/0?SYNTHETIC_TEST_VALUE=***
 *       Ett queryled utan `=` blir ett NAMN med tomt värde, så maskeringen av
 *       VÄRDEN lämnade hemligheten orörd.
 *
 *   B.  --confirm=REDIS://user:SYNTHETIC_TEST_VALUE@h:6379/0
 *       ekades ordagrant, eftersom adressmaskeringens mönster inte var
 *       skiftlägesokänsligt.
 *
 * Proven i `queue-ops.spec.ts` läste funktionernas returvärden och kastade fel.
 * Båda läckorna låg i UTSKRIFTEN. Ett prov som inte kör processen kan inte se
 * dem — och det är hela skälet att den här filen betalar för en barnprocess.
 *
 * NÄTVERKSFRITT. Båda fallen avvisas före `new Bull(...)`: A av
 * `parseRedisTarget`, B av confirm-spärren. Ingen anslutning öppnas, och
 * `--redis-url` pekar dessutom på en port ingenting lyssnar på.
 */

import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

/** Endast syntetiska värden. Inget här är en riktig hemlighet. */
const SYNTETISK_HEMLIGHET = 'SYNTHETIC_TEST_VALUE'

const VERKTYG = join(__dirname, 'queue-ops.ts')
const TS_NODE = require.resolve('ts-node/register/transpile-only')

interface Körning {
  ut: string
  exitkod: number
}

/** Kör verktyget som en riktig process och slår ihop stdout och stderr. */
function körCli(...args: string[]): Körning {
  try {
    const ut = execFileSync(process.execPath, ['-r', TS_NODE, VERKTYG, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
      // Miljön rensas med flit: verktyget ska inte kunna plocka upp en
      // REDIS_URL som råkar stå i skalet, och provet ska inte kunna bli grönt
      // av att det körde mot något annat än flaggorna säger.
      env: { PATH: process.env['PATH'] ?? '', NODE_ENV: 'test' },
    })
    return { ut, exitkod: 0 }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number }
    return { ut: `${e.stdout ?? ''}${e.stderr ?? ''}`, exitkod: e.status ?? -1 }
  }
}

describe('queue-ops som CLI', () => {
  jest.setTimeout(120_000)

  it('KANARIEFÅGELN: processen kör, skriver något och faller på en känd spärr', () => {
    // Utan den här raden vore varje `not.toContain` nedan grönt av att
    // processen aldrig startade eller aldrig skrev en rad.
    const { ut, exitkod } = körCli('--redis-url=redis://h.example:6379/0', '--action=pause')
    expect(exitkod).toBe(1)
    expect(ut).toContain('--confirm')
    expect(ut.length).toBeGreaterThan(50)
  })

  /**
   * ── INGET UR QUERYN, OAVSETT FORM ─────────────────────────────────────────
   *
   * Regeln höll först tillbaka bara led UTAN `=`, med resonemanget att namnet på
   * ett `namn=värde`-par är säkert. Slutgranskningen visade att det var fel:
   *
   *   --redis-url=redis://h.example:6379/0?SYNTHETIC_TEST_VALUE=
   *     [queue-ops] AVBRUTEN: --redis-url bär 1 queryparameter(rar)
   *                           (SYNTHETIC_TEST_VALUE). …
   *
   * Ett likhetstecken gör inte namnet betrott. Tabellen nedan täcker tomt värde,
   * icke-tomt värde, hemligheten i NAMNET, hemligheten i VÄRDET, flera led och
   * formen helt utan `=`.
   *
   * Varje rad kräver TRE saker, inte bara frånvaron av hemligheten: rätt
   * exitkod, rätt felorsak, och att måltexten fortfarande går att läsa. Utan de
   * två första hade ett trasigt startförlopp — verktyget som kraschar innan det
   * hinner skriva något — gett falskt grönt.
   */
  it.each([
    ['tomt värde, hemlighet i namnet', `?${SYNTETISK_HEMLIGHET}=`, 1],
    ['icke-tomt värde, hemlighet i namnet', `?${SYNTETISK_HEMLIGHET}=x`, 1],
    ['hemlighet i värdet', `?password=${SYNTETISK_HEMLIGHET}`, 1],
    ['utan likhetstecken', `?${SYNTETISK_HEMLIGHET}`, 1],
    ['flera led', `?a=1&${SYNTETISK_HEMLIGHET}=2&b=3`, 3],
    ['led utan värde bland flera', `?a=1&${SYNTETISK_HEMLIGHET}&b=3`, 3],
  ])('A: %s läcker inte genom någon utskriftsväg', (_namn, query, antal) => {
    const { ut, exitkod } = körCli(`--redis-url=redis://h.example:6379/0${query}`)

    // 1. Hemligheten finns ingenstans i stdout eller stderr.
    expect(ut).not.toContain(SYNTETISK_HEMLIGHET)
    // 2. Rätt exitkod — inte en krasch som råkar bli tyst.
    expect(exitkod).toBe(1)
    // 3. Rätt felorsak, med antalet led, och måltexten fortfarande läsbar.
    expect(ut).toContain(`bär ${antal} queryparameter(rar)`)
    expect(ut).toContain('Namn och värden återges inte')
    expect(ut).toContain('h.example')
  })

  it('A: ett FRAGMENT läcker inte', () => {
    const { ut } = körCli(`--redis-url=redis://h.example:6379/0#${SYNTETISK_HEMLIGHET}`)
    expect(ut).not.toContain(SYNTETISK_HEMLIGHET)
  })

  it('B: en VERSAL adress i --confirm maskeras', () => {
    // Nära till hands: --confirm och --redis-url bär båda en redis://-sträng.
    const { ut, exitkod } = körCli(
      '--redis-url=redis://h.example:6379/0',
      '--action=pause',
      `--confirm=REDIS://user:${SYNTETISK_HEMLIGHET}@h.example:6379/0`,
    )
    expect(exitkod).toBe(1)
    expect(ut).not.toContain(SYNTETISK_HEMLIGHET)
    expect(ut).toContain('--confirm')
  })

  it.each([
    ['gemener', 'redis'],
    ['versaler', 'REDIS'],
    ['blandat', 'ReDiS'],
    ['TLS blandat', 'ReDiSS'],
  ])('B: skiftläget %s i --confirm maskeras', (_namn, schema) => {
    const { ut } = körCli(
      '--redis-url=redis://h.example:6379/0',
      '--action=pause',
      `--confirm=${schema}://user:${SYNTETISK_HEMLIGHET}@h.example:6379/0`,
    )
    expect(ut).not.toContain(SYNTETISK_HEMLIGHET)
  })

  it('B: en credential i --confirm som INTE ser ut som en redis-adress maskeras också', () => {
    // Måltexten bär aldrig ett `@`. En userinfo-sekvens i --confirm är därför
    // per definition inte måltext — och kan vara en credential.
    const { ut } = körCli(
      '--redis-url=redis://h.example:6379/0',
      '--action=pause',
      `--confirm=//user:${SYNTETISK_HEMLIGHET}@h.example:6379/db0 prefix=bull`,
    )
    expect(ut).not.toContain(SYNTETISK_HEMLIGHET)
  })

  it('en OPARSERBAR --redis-url skrivs inte ut alls', () => {
    const { ut } = körCli(`--redis-url=inte-en-url-${SYNTETISK_HEMLIGHET}`)
    expect(ut).not.toContain(SYNTETISK_HEMLIGHET)
  })

  it('en FELAKTIG --confirm återges inte som rå text — men den FÖRVÄNTADE syns', () => {
    // `--confirm` ekades tidigare ordagrant, och maskeringen täckte bara
    // adressformade strängar. Ekot behövs inte: det operatören måste se är
    // vilken text som FÖRVÄNTADES, och den är per konstruktion credentialfri.
    const { ut, exitkod } = körCli(
      '--redis-url=redis://h.example:6379/0',
      '--action=pause',
      '--confirm=redis://fel.example:6379/db0 prefix=bull',
    )
    expect(exitkod).toBe(1)
    expect(ut).not.toContain('fel.example')
    // KANARIEFÅGELN: utskriften säger fortfarande något användbart. Utan de två
    // raderna vore varje `not.toContain` ovan grönt av ren tystnad.
    expect(ut).toContain('förväntat: redis://h.example:6379/db0 prefix=bull')
    expect(ut).toContain('en adress angavs')
  })

  it('en BAR hemlighet i --confirm återges inte heller', () => {
    // Formen maskeraAdresser aldrig täckte: inte adressformad alls.
    const { ut, exitkod } = körCli(
      '--redis-url=redis://h.example:6379/0',
      '--action=pause',
      `--confirm=${SYNTETISK_HEMLIGHET}`,
    )
    expect(exitkod).toBe(1)
    expect(ut).not.toContain(SYNTETISK_HEMLIGHET)
    expect(ut).toContain('inte ens är en redis-adress')
  })

  /**
   * Understreck är inte giltigt i ett URL-schema, så `new URL()` avvisar
   * `SYNTHETIC_TEST_VALUE:x` som oparserbar. Ett schema som GÅR att tolka måste
   * därför stavas med bindestreck — och det är just den formen som tidigare
   * återgavs i sin helhet, eftersom `redactRedisUrl` bara rörde användare,
   * lösenord, query och fragment.
   */
  const SCHEMAHEMLIGHET = SYNTETISK_HEMLIGHET.toLowerCase().replace(/_/gu, '-')

  it.each([
    [
      'sökvägen',
      `redis://h.example:6379/${SYNTETISK_HEMLIGHET}`,
      SYNTETISK_HEMLIGHET,
      'databasindex',
    ],
    ['schemat', `${SCHEMAHEMLIGHET}:x`, SCHEMAHEMLIGHET, 'schema som inte stöds'],
  ])('en hemlighet i %s återges inte i någon rad', (_namn, url, hemlighet, orsak) => {
    const { ut, exitkod } = körCli(`--redis-url=${url}`)
    expect(ut).not.toContain(hemlighet)
    expect(exitkod).toBe(1)
    expect(ut).toContain(orsak)
  })
})
