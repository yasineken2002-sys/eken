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
 * ── VILKEN ZON PROVET MÄTER I — OCH VARFÖR DET INTE BYTS HÄR ────────────────
 *
 * Felet syns bara när processens zon INTE är svensk. Ett första utkast bytte
 * `process.env.TZ` inne i testet. Det är en attrapp: jest ger testet en EGEN
 * `process.env`, så tilldelningen når aldrig Node, och "tre zoner" kördes i en.
 * Uppmätt: det gamla uttrycket gav samma dag efter "bytet" till Stockholm.
 *
 * Provet mäter därför i processens egen zon, som i CI är UTC. Instanterna är
 * valda där UTC-dagen och den svenska dagen SKILJER sig, och den negativa
 * referensen visar vad en UTC-server skrev med det gamla uttrycket. Att
 * utskriften är densamma i flera zoner visas genom att köra FILEN med olika
 * `TZ` på jest-processen (T3-leveransens raw/f9-*.log), inte här.
 */

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

  it.each(fall)('%s → %s oavsett processens zon', async (instant, forvantat) => {
    jest.useFakeTimers({ now: new Date(instant), doNotFake: ['nextTick', 'setImmediate'] })
    expect(datumRad(await render())).toBe(forvantat)
  })

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
