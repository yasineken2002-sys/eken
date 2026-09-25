/**
 * F-9 — avins datumrad är RENDERINGSDATUMET i svensk kalender, oberoende av
 * serverns tidszon. F-10 — avsändaradressen skrivs aldrig som en ensam
 * separator.
 *
 * ── VAD SOM VAR FEL ─────────────────────────────────────────────────────────
 *
 * Raden skrev `Datum: ${new Date().toLocaleDateString('sv-SE')}`. Utan
 * `timeZone` läser det SERVERNS zon: i en UTC-container blev instanten
 * 2026-07-01T22:30Z "2026-07-01", trots att det redan var den 2 juli i Sverige.
 * Etiketten "Datum" lät dessutom som ett utställnings- eller utskicksdatum,
 * fast `RentNotice` inte har något sådant fält och PDF:en renderas om vid varje
 * nedladdning. Etiketten är nu "Utskriftsdatum".
 *
 * ── ZONEN ÄR EN FÖRUTSÄTTNING — OCH DEN MÄTS, DEN ANTAS INTE (A3) ──────────
 *
 * Felet syns bara när processens zon INTE är svensk. `process.env.TZ = …` inne
 * i ett test är en attrapp: jest ger testet en EGEN `process.env`, så
 * tilldelningen når aldrig Node (uppmätt — env-strängen ändras, `Intl` och
 * `getHours()` gör det inte). Ett prov som bara körde i processens egen zon
 * hade dessutom varit grönt i en Stockholmsprocess med det GAMLA uttrycket.
 *
 * Därför renderar provet avin i BARNPROCESSER (`notice-render-date.barn.ts`),
 * startade med `TZ` satt i barnets miljö: UTC och America/New_York. Varje barn
 * rapporterar sin faktiska zon och sin offset för varje instant, och
 * `kravZon` VÄGRAR datumet om de inte är de begärda — kanariefågeln. Att den
 * kan neka visas med ett barn i Europe/Stockholm som påstås vara New York.
 *
 * Provet beror alltså inte på vilken zon CI-runnern har: barnens zon sätts
 * explicit, och jest-processens egen zon spelar ingen roll för utfallet.
 *
 * Fallen i processens egen zon (nedan) står kvar som ett snabbt prov, men
 * bevisar ingenting om zonberoendet — det gör barnen.
 */

import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))

import { AviseringService } from './avisering.service'

function buildNotice() {
  return {
    type: 'RENT',
    isProrated: false,
    ocrNumber: '1234567890',
    noticeNumber: 'AVI-2026-0001',
    dueDate: new Date('2026-07-31T00:00:00Z'),
    year: 2026,
    month: 8,
    amount: 10000,
    totalAmount: 10000,
    vatAmount: 0,
    consumptionAmount: 0,
    reminderFeeAmount: 0,
    credits: [],
    totalDays: null,
    daysCharged: null,
    periodStart: null,
    periodEnd: null,
    tenant: {
      type: 'INDIVIDUAL',
      firstName: 'Anna',
      lastName: 'Andersson',
      companyName: null,
      email: 'anna@example.invalid',
      phone: null,
    },
    lease: {
      monthlyRent: 10000,
      unit: {
        unitNumber: '1101',
        name: 'Lägenhet',
        property: { street: 'Storgatan 1', name: 'F' },
      },
    },
    lines: [],
  }
}

const ORG = {
  name: 'Värd AB',
  street: 'Kungsgatan 2',
  postalCode: '111 22',
  city: 'Stockholm',
  email: 'kontakt@example.invalid',
  bankgiro: '5050-1055',
  invoiceColor: null,
  brandSecondaryColor: null,
  brandFont: null,
  logoStorageKey: null,
}

function render(org: Record<string, unknown> = ORG): Promise<string> {
  const noop = {}
  const service = new AviseringService(
    noop as never,
    noop as never,
    noop as never,
    noop as never,
    noop as never,
    noop as never,
    noop as never,
    noop as never,
    noop as never,
    { ensureDepositForNotice: jest.fn().mockResolvedValue({ created: false }) } as never,
    {} as never,
  )
  return (
    service as unknown as { buildNoticePdfHtml: (n: unknown, o: unknown) => Promise<string> }
  ).buildNoticePdfHtml(buildNotice(), org)
}

const datumRad = (html: string) => /Utskriftsdatum: <span>([^<]*)<\/span>/.exec(html)?.[1]

describe('F-9 · avins utskriftsdatum i svensk kalender', () => {
  afterEach(() => jest.useRealTimers())

  const fall: Array<[string, string]> = [
    // [instant, svenskt kalenderdatum]
    ['2026-07-01T21:59:59Z', '2026-07-01'], // 23:59:59 sommartid
    ['2026-07-01T22:00:00Z', '2026-07-02'], // 00:00:00 sommartid
    ['2026-07-01T22:30:00Z', '2026-07-02'],
    ['2026-12-31T22:59:59Z', '2026-12-31'], // 23:59:59 vintertid
    ['2026-12-31T23:30:00Z', '2027-01-01'], // 00:30 vintertid, nytt år
  ]

  it.each(fall)(
    '%s → %s i processens egen zon (snabbprov, ej zonbevis)',
    async (instant, forvantat) => {
      jest.useFakeTimers({ now: new Date(instant), doNotFake: ['nextTick', 'setImmediate'] })
      expect(datumRad(await render())).toBe(forvantat)
    },
  )

  it('negativ referens: vid dygnsgränsen skrev en UTC-server med det GAMLA uttrycket fel dag', () => {
    // Det gamla uttrycket, med UTC-servern uttryckt explicit så att referensen
    // inte beror på den här processens zon.
    const gammaltIUtc = (s: string) => new Date(s).toLocaleDateString('sv-SE', { timeZone: 'UTC' })
    expect(gammaltIUtc('2026-07-01T22:30:00Z')).toBe('2026-07-01')
    expect(gammaltIUtc('2026-12-31T23:30:00Z')).toBe('2026-12-31')
    // …medan rätt svar (fallen ovan) är 2026-07-02 och 2027-01-01.
  })

  it('etiketten påstår inte ett utskicks- eller utställningsdatum', async () => {
    const html = await render()
    expect(html).toContain('Utskriftsdatum:')
    expect(html).not.toMatch(/>\s*Datum:/)
  })
})

// ── BARNPROCESSERNA: DET BINDANDE ZONPROVET ────────────────────────────────

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

describe('F-10 · avins avsändaradress', () => {
  const orgDetails = (html: string) =>
    /<div class="org-details">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? ''

  it('komplett adress skrivs ut', async () => {
    expect(orgDetails(await render())).toContain('Kungsgatan 2, 111 22 Stockholm<br>')
  })

  it('historisk organisation (tomma fält): ingen adressrad, ingen ensam separator', async () => {
    const block = orgDetails(await render({ ...ORG, street: '', postalCode: '', city: '' }))
    expect(block).not.toMatch(/(^|>)\s*,/)
    expect(block).not.toContain(', <br>')
    expect(block).toContain('E-post: kontakt@example.invalid')
  })

  it('gata utan postnummer/ort: ingen avslutande separator', async () => {
    const block = orgDetails(await render({ ...ORG, postalCode: '', city: '' }))
    expect(block).toContain('Kungsgatan 2<br>')
    expect(block).not.toContain('Kungsgatan 2,')
  })
})
