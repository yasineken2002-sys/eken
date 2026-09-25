/**
 * BARNPROCESS för `avisering.notice-render-date.spec.ts` (F-9, A3).
 *
 * Varför en egen process: jest ger testet en egen `process.env`, så
 * `process.env.TZ = …` inne i ett test når aldrig Node (uppmätt). Den enda
 * pålitliga vägen att pröva avins datum i en BESTÄMD zon är att starta en ny
 * process med `TZ` satt i dess miljö. Specen gör det — den här filen är det
 * processen kör.
 *
 * Kontrakt (miljö in, en JSON-rad ut på stdout):
 *   TZ                  zonen processen ska köra i (sätts av specen)
 *   NOTICE_INSTANTS     kommaseparerade ISO-instanter; "nu" flyttas till var och en
 *   ut                  { zon, rader: [{ instant, offsetMin, datum }] }
 *
 * `zon` och `offsetMin` är KANARIEFÅGELN: de mäts här, i processen som
 * renderar, och specen vägrar lita på datumet om de inte är de begärda.
 *
 * Den här filen importeras aldrig av produktkoden. Den byggs in i `dist` på
 * samma sätt som specfilerna.
 */
import { AviseringService } from './avisering.service'

interface Rad {
  instant: string
  offsetMin: number
  datum: string | null
}

const RealDate = Date

/** Flyttar "nu" till `mal` — bara `new Date()` utan argument och `Date.now()`. */
function sattNu(mal: string): void {
  const t = new RealDate(mal).getTime()
  class RiggDate extends RealDate {
    constructor(...a: ConstructorParameters<typeof RealDate> | []) {
      if (a.length === 0) super(t)
      else super(...(a as ConstructorParameters<typeof RealDate>))
    }
    static override now(): number {
      return t
    }
  }
  globalThis.Date = RiggDate as DateConstructor
}

function notice(): Record<string, unknown> {
  return {
    type: 'RENT',
    isProrated: false,
    ocrNumber: '1234567890',
    noticeNumber: 'AVI-2026-0001',
    dueDate: new RealDate('2026-07-31T00:00:00Z'),
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

async function main(): Promise<void> {
  const instants = (process.env.NOTICE_INSTANTS ?? '').split(',').filter(Boolean)
  const beroenden: unknown[] = Array.from({ length: 11 }, () => ({}))
  beroenden[9] = { ensureDepositForNotice: async () => ({ created: false }) }
  const service = Reflect.construct(AviseringService, beroenden) as unknown as {
    buildNoticePdfHtml: (n: unknown, o: unknown) => Promise<string>
  }

  const rader: Rad[] = []
  for (const instant of instants) {
    sattNu(instant)
    const html = await service.buildNoticePdfHtml(notice(), ORG)
    rader.push({
      instant,
      offsetMin: new RealDate(instant).getTimezoneOffset(),
      datum: /Utskriftsdatum: <span>([^<]*)<\/span>/.exec(html)?.[1] ?? null,
    })
  }
  globalThis.Date = RealDate
  const zon = Intl.DateTimeFormat().resolvedOptions().timeZone
  process.stdout.write(JSON.stringify({ zon, rader }) + '\n')
}

main().catch((err: unknown) => {
  process.stderr.write(
    `[barn] ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  )
  process.exit(1)
})
