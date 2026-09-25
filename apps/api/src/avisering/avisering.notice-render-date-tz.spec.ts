/**
 * F-9 / A3 — det BINDANDE zonprovet för avins utskriftsdatum.
 *
 * Felet (serverns zon styrde datumet) syns bara i en process som INTE kör
 * svensk tid. `process.env.TZ = …` inne i jest når aldrig Node (jest ger testet
 * en egen `process.env`; uppmätt: env-strängen ändras, `Intl` och
 * `getHours()` gör det inte). Ett prov i processens egen zon hade dessutom
 * varit grönt i en Stockholmsprocess med det GAMLA uttrycket.
 *
 * Därför renderar provet avin i BARNPROCESSER (`notice-render-date.barn.ts`),
 * startade med `TZ` satt i barnets miljö: UTC och America/New_York. Varje barn
 * rapporterar sin faktiska zon och sin offset per instant, och `kravZon` VÄGRAR
 * datumet om de inte är de begärda — kanariefågeln. Att den kan neka visas med
 * en Stockholmsprocess som påstås vara New York, och med en fel offset.
 *
 * Utfallet beror inte på CI-runnerns zon: barnens zon sätts explicit.
 *
 * ── VARFÖR EN EGEN FIL ─────────────────────────────────────────────────────
 *
 * Den här filen importerar INTE tjänsten. Jest-processen förblir då liten, och
 * bara barnet laddar avins importgraf. I samma fil som de övriga avi-proven
 * låg jest på ~900 MB och barnet på ~300 MB till; på en maskin med lite ledigt
 * minne dödades körningen utifrån (exit 143) när barnet startade.
 */
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

interface BarnUtfall {
  zon: string
  rader: Array<{ instant: string; offsetMin: number; datum: string | null }>
}

const BARN = join(__dirname, 'notice-render-date.barn.ts')

/** Startar en NY node-process med `TZ` i dess miljö och låter den rendera avin. */
function korBarn(tz: string, instants: string[]): BarnUtfall {
  const ut = execFileSync(process.execPath, ['-r', 'ts-node/register', BARN], {
    cwd: join(__dirname, '..', '..'),
    env: {
      ...process.env,
      TZ: tz,
      TS_NODE_TRANSPILE_ONLY: 'true',
      NOTICE_INSTANTS: instants.join(','),
    },
    encoding: 'utf8',
    timeout: 90_000,
  })
  return JSON.parse(ut.trim().split('\n').pop() ?? '{}') as BarnUtfall
}

/** Mäter zonen i en ny process utan att rendera något (billig, för nekandeprovet). */
function matZon(tz: string, instants: string[]): BarnUtfall {
  const ut = execFileSync(
    process.execPath,
    [
      '-e',
      'const i=process.env.NOTICE_INSTANTS.split(",");' +
        'process.stdout.write(JSON.stringify({zon:Intl.DateTimeFormat().resolvedOptions().timeZone,' +
        'rader:i.map(x=>({instant:x,offsetMin:new Date(x).getTimezoneOffset(),datum:null}))}))',
    ],
    { env: { ...process.env, TZ: tz, NOTICE_INSTANTS: instants.join(',') }, encoding: 'utf8' },
  )
  return JSON.parse(ut) as BarnUtfall
}

/**
 * KANARIEFÅGELN. Kastar om processen som mätte inte är i den begärda zonen med
 * de förväntade offseten. Ett datum från en process i fel zon bevisar ingenting
 * och får inte räknas som grönt.
 */
function kravZon(utfall: BarnUtfall, zon: string, offsetMin: Record<string, number>): void {
  if (utfall.zon !== zon) {
    throw new Error(`FÖRUTSÄTTNING NEKAD: processen körde i ${utfall.zon}, provet kräver ${zon}`)
  }
  for (const r of utfall.rader) {
    if (r.offsetMin !== offsetMin[r.instant]) {
      throw new Error(
        `FÖRUTSÄTTNING NEKAD: offset ${r.offsetMin} min vid ${r.instant}, ` +
          `provet kräver ${offsetMin[r.instant]} (${zon})`,
      )
    }
  }
}

const GRANS = [
  // [instant, svenskt kalenderdatum] — alla där UTC- och NY-dagen skiljer sig
  // från den svenska, utom kontrollfallet 21:59:59Z.
  ['2026-07-01T21:59:59Z', '2026-07-01'],
  ['2026-07-01T22:00:00Z', '2026-07-02'],
  ['2026-07-01T22:30:00Z', '2026-07-02'],
  ['2026-12-31T23:30:00Z', '2027-01-01'],
] as const
const INSTANTS = GRANS.map(([i]) => i)

describe('F-9 · utskriftsdatumet i barnprocesser med bestämd zon (A3)', () => {
  it.each([
    [
      'UTC',
      {
        '2026-07-01T21:59:59Z': 0,
        '2026-07-01T22:00:00Z': 0,
        '2026-07-01T22:30:00Z': 0,
        '2026-12-31T23:30:00Z': 0,
      },
    ],
    [
      'America/New_York',
      {
        '2026-07-01T21:59:59Z': 240,
        '2026-07-01T22:00:00Z': 240,
        '2026-07-01T22:30:00Z': 240,
        '2026-12-31T23:30:00Z': 300,
      },
    ],
  ])(
    'TZ=%s: kanariefågeln bekräftar zonen, och datumet är den svenska dagen',
    (tz, offset) => {
      const utfall = korBarn(tz, [...INSTANTS])
      kravZon(utfall, tz, offset)
      expect(utfall.rader.map((r) => [r.instant, r.datum])).toEqual(GRANS.map(([i, d]) => [i, d]))
    },
    120_000,
  )

  it('kanariefågeln NEKAR fel förutsättning: en Stockholmsprocess godtas inte som New York', () => {
    const fel = matZon('Europe/Stockholm', [...INSTANTS])
    expect(fel.zon).toBe('Europe/Stockholm')
    expect(() =>
      kravZon(fel, 'America/New_York', {
        '2026-07-01T21:59:59Z': 240,
        '2026-07-01T22:00:00Z': 240,
        '2026-07-01T22:30:00Z': 240,
        '2026-12-31T23:30:00Z': 300,
      }),
    ).toThrow(/FÖRUTSÄTTNING NEKAD: processen körde i Europe\/Stockholm/)
    // …och offsetgrenen nekar även när zonnamnet råkar stämma men offseten inte gör det.
    const utc = matZon('UTC', ['2026-07-01T22:30:00Z'])
    expect(() => kravZon(utc, 'UTC', { '2026-07-01T22:30:00Z': 120 })).toThrow(
      /FÖRUTSÄTTNING NEKAD: offset 0 min/,
    )
  })
})
