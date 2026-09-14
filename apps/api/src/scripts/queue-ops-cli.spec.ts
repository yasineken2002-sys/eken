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

  it('A: ett QUERYNAMN i --redis-url läcker inte genom felhanteraren', () => {
    const { ut, exitkod } = körCli(`--redis-url=redis://h.example:6379/0?${SYNTETISK_HEMLIGHET}`)
    expect(exitkod).toBe(1)
    expect(ut).not.toContain(SYNTETISK_HEMLIGHET)
    // Operatören ska ändå se VILKEN adress som föll, och VARFÖR.
    expect(ut).toContain('h.example')
    expect(ut).toContain('queryparameter')
  })

  it('A: ett query-VÄRDE läcker inte heller, i någon av raderna', () => {
    const { ut, exitkod } = körCli(
      `--redis-url=redis://h.example:6379/0?password=${SYNTETISK_HEMLIGHET}`,
    )
    expect(exitkod).toBe(1)
    expect(ut).not.toContain(SYNTETISK_HEMLIGHET)
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

  it('KANARIEFÅGELN: en giltig --confirm ekas LÄSBAR — maskeringen är inte total', () => {
    // Annars vore varje prov ovan grönt av att felutskriften slutat säga något.
    const { ut } = körCli(
      '--redis-url=redis://h.example:6379/0',
      '--action=pause',
      '--confirm=redis://fel.example:6379/db0 prefix=bull',
    )
    expect(ut).toContain('fel.example')
  })
})
