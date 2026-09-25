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
 * ── VARFÖR PROCESSENS ZON BYTS I PROVET ─────────────────────────────────────
 *
 * Felet syns bara när serverns zon INTE är svensk. Kör provet på en maskin i
 * Europe/Stockholm hade den gamla raden varit grön. Provet sätter därför
 * `process.env.TZ` (Node läser om den vid tilldelning) och kräver SAMMA
 * utskrift i tre zoner för samma instant — och den gamla uttrycksformen står
 * kvar som negativ referens, så att det syns att zonbytet faktiskt biter.
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
      unit: { unitNumber: '1101', name: 'Lägenhet', property: { street: 'Storgatan 1', name: 'F' } },
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
  const ursprungligZon = process.env.TZ

  afterEach(() => {
    jest.useRealTimers()
    if (ursprungligZon === undefined) delete process.env.TZ
    else process.env.TZ = ursprungligZon
  })

  it.each([
    // [instant, svenskt kalenderdatum]
    ['2026-07-01T21:59:59Z', '2026-07-01'], // 23:59:59 sommartid
    ['2026-07-01T22:00:00Z', '2026-07-02'], // 00:00:00 sommartid
    ['2026-07-01T22:30:00Z', '2026-07-02'],
    ['2026-12-31T22:59:59Z', '2026-12-31'], // 23:59:59 vintertid
    ['2026-12-31T23:30:00Z', '2027-01-01'], // 00:30 vintertid, nytt år
  ])('%s → %s i UTC, Europe/Stockholm och America/New_York', async (instant, forvantat) => {
    const utfall: Record<string, string | undefined> = {}
    for (const zon of ['UTC', 'Europe/Stockholm', 'America/New_York']) {
      process.env.TZ = zon
      jest.useFakeTimers({ now: new Date(instant), doNotFake: ['nextTick', 'setImmediate'] })
      utfall[zon] = datumRad(await render())
      jest.useRealTimers()
    }
    expect(utfall).toEqual({
      UTC: forvantat,
      'Europe/Stockholm': forvantat,
      'America/New_York': forvantat,
    })
  })

  it('negativ referens: det GAMLA uttrycket ger fel dag i en UTC-process', () => {
    // Visar att zonbytet i provet biter — annars hade raden ovan kunnat vara
    // grön av att processen redan råkade stå i svensk zon.
    process.env.TZ = 'UTC'
    expect(new Date('2026-07-01T22:30:00Z').toLocaleDateString('sv-SE')).toBe('2026-07-01')
    process.env.TZ = 'Europe/Stockholm'
    expect(new Date('2026-07-01T22:30:00Z').toLocaleDateString('sv-SE')).toBe('2026-07-02')
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
