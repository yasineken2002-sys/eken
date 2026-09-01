/**
 * #518 — KREDITERINGEN AV EN HYRESAVI: SPÄRRAR, TAK OCH ATOMICITET.
 *
 * Plus MÄTNINGEN av att steg 1 i kravtrappan (förfallomarkeringen) inte behöver
 * något filter — se den sista describe:n. Det påståendet stod i underlaget som
 * en slutsats av formvalet, och en slutsats som inte mätts är en gissning.
 */

// NotificationsService drar in R2/Puppeteer transitivt; ingetdera rör
// förfallomarkeringen. Samma stubbning som övriga specar i modulen.
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { Prisma, RentNoticeType } from '@prisma/client'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  assessRentNoticeCreditability,
  RentNoticeCreditService,
} from './rent-notice-credit.service'
import { NotificationsService } from '../notifications/notifications.service'

const D = (n: number) => new Prisma.Decimal(n)

/* ────────────────────────────────────────────────────────────────────────────
 * SPÄRRARNA — den rena bedömningen
 * ──────────────────────────────────────────────────────────────────────────── */

function avi(over: Record<string, unknown> = {}) {
  return {
    noticeNumber: 'AVI-2026-08-0001',
    type: RentNoticeType.RENT,
    status: 'OVERDUE',
    vatAmount: D(0),
    probableLossAt: null as Date | null,
    writtenOffAt: null as Date | null,
    payments: [] as unknown[],
    exportedToCollection: false,
    ...over,
  }
}
const skuld = (ocrOutstanding: number) => ({ ocrOutstanding })

describe('#518 — assessRentNoticeCreditability', () => {
  it('KONTROLLFALL: en obetald, momsfri avi med restskuld GÅR att kreditera', () => {
    // Måste stå först i tanken, inte sist: utan den här raden kan varje spärr
    // nedan vara grön för att funktionen nekar ALLT.
    expect(assessRentNoticeCreditability(avi(), skuld(10_000))).toEqual({
      allowed: true,
      reason: null,
    })
  })

  it('BETALD/DELBETALD avi spärras — tillgodohavandet är inte byggt', () => {
    const res = assessRentNoticeCreditability(avi({ payments: [{ amount: D(1) }] }), skuld(9_999))
    expect(res.allowed).toBe(false)
    expect(res.reason).toMatch(/registrerad betalning/i)
    // Skälet ska säga vad operatören gör i stället.
    expect(res.reason).toMatch(/avmatcha|återbetala/i)
  })

  it('grinden nyckas på ALLOKERINGEN, inte på statusen — statusen kan släpa efter pengarna', () => {
    // En avi som fortfarande står som OVERDUE men har en allokering är betald i
    // pengarnas mening. Vore grinden statusbaserad hade den släppt igenom den.
    const res = assessRentNoticeCreditability(
      avi({ status: 'OVERDUE', payments: [{ amount: D(500) }] }),
      skuld(9_500),
    )
    expect(res.allowed).toBe(false)
  })

  it('ANNULLERAD avi spärras — intäkten är redan reverserad', () => {
    const res = assessRentNoticeCreditability(avi({ status: 'CANCELLED' }), skuld(10_000))
    expect(res.allowed).toBe(false)
    expect(res.reason).toMatch(/annullerad/i)
  })

  it('NEDSKRIVEN fordran spärras — och grinden läser fälten, inte statusen', () => {
    // `WRITTEN_OFF` är ett värde i RentCollectionStage, inte i RentNoticeStatus:
    // en avskriven avi står kvar som OVERDUE. En statusbaserad grind hade
    // släppt igenom den och krediterat 1510 en andra gång.
    for (const fält of ['probableLossAt', 'writtenOffAt']) {
      const res = assessRentNoticeCreditability(
        avi({ status: 'OVERDUE', [fält]: new Date() }),
        skuld(10_000),
      )
      expect(res.allowed).toBe(false)
      expect(res.reason).toMatch(/kundförlust/i)
    }
  })

  it('ÖVERLÄMNAD till inkasso spärras — och texten lovar ingen återkallningsknapp', () => {
    const res = assessRentNoticeCreditability(avi({ exportedToCollection: true }), skuld(10_000))
    expect(res.allowed).toBe(false)
    expect(res.reason).toMatch(/inkasso/i)
    // Mätt: avi-sidans inkassomodul har export och bulk-export, ingenting som
    // drar tillbaka ett överlämnat underlag. Texten får inte antyda en knapp
    // som saknas.
    expect(res.reason).toMatch(/ingen väg att återkalla/i)
  })

  it('MOMSBÄRANDE avi spärras — nedsättning av bokförd moms är inte avgjord', () => {
    const res = assessRentNoticeCreditability(avi({ vatAmount: D(1_250) }), skuld(10_000))
    expect(res.allowed).toBe(false)
    expect(res.reason).toMatch(/moms/i)
  })

  it('DEPOSITION spärras — den har ett eget flöde och ingen kravskuld', () => {
    const res = assessRentNoticeCreditability(avi({ type: RentNoticeType.DEPOSIT }), skuld(0))
    expect(res.allowed).toBe(false)
    expect(res.reason).toMatch(/deposition/i)
  })

  it('FULLT KREDITERAD avi spärras — det finns ingenting kvar', () => {
    const res = assessRentNoticeCreditability(avi(), skuld(0))
    expect(res.allowed).toBe(false)
    expect(res.reason).toMatch(/ingenting kvar/i)
  })

  it('inga ärendenummer i texten som når operatören', () => {
    // Samma regel som no-issue-refs-in-user-text.spec.ts vaktar för exceptions.
    const alla = [
      assessRentNoticeCreditability(avi({ payments: [{ amount: D(1) }] }), skuld(1)),
      assessRentNoticeCreditability(avi({ status: 'CANCELLED' }), skuld(1)),
      assessRentNoticeCreditability(avi({ vatAmount: D(1) }), skuld(1)),
    ]
    for (const r of alla) expect(r.reason).not.toMatch(/#\d+/)
  })
})

/* ────────────────────────────────────────────────────────────────────────────
 * TAKET OCH ATOMICITETEN — hela tjänsten
 * ──────────────────────────────────────────────────────────────────────────── */

function rigg(
  opts: {
    tidigareKrediterat?: number
    bokförMisslyckas?: boolean
    interest?: number
    lines?: Array<Record<string, unknown>>
  } = {},
) {
  const redan = opts.tidigareKrediterat ?? 0
  const notice = {
    id: 'avi-1',
    organizationId: 'org-1',
    noticeNumber: 'AVI-2026-08-0001',
    type: RentNoticeType.RENT,
    status: 'OVERDUE',
    month: 8,
    year: 2026,
    totalAmount: D(10_000),
    vatAmount: D(0),
    consumptionAmount: D(0),
    miscChargeAmount: D(0),
    reminderFeeAmount: D(0),
    interestAccruedAmount: D(opts.interest ?? 0),
    probableLossAt: null,
    writtenOffAt: null,
    lines: opts.lines ?? [],
    payments: [],
    credits: redan ? [{ amount: D(redan) }] : [],
  }

  const creditCreate = jest.fn(async (arg: { data: Record<string, unknown> }) => ({
    id: 'kred-1',
    ...arg.data,
    amount: new Prisma.Decimal(String(arg.data['amount'])),
    lines: [],
  }))

  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    rentNotice: { findFirst: jest.fn().mockResolvedValue(notice) },
    rentNoticeEvent: { findFirst: jest.fn().mockResolvedValue(null) },
    rentNoticeCredit: { create: creditCreate },
    rentNoticeCreditLine: {
      findMany: jest
        .fn()
        .mockResolvedValue(
          redan ? [{ rentNoticeLineId: null, amount: new Prisma.Decimal(redan) }] : [],
        ),
    },
  }

  const createJournalEntryForRentNoticeCredit = opts.bokförMisslyckas
    ? jest.fn().mockRejectedValue(new Error('kontoplanen saknar konto 1510'))
    : jest.fn().mockResolvedValue({ id: 'je-1' })
  const record = jest.fn().mockResolvedValue(undefined)

  const service = new RentNoticeCreditService(
    {
      $transaction: jest.fn((cb: (t: unknown) => unknown) => cb(tx)),
      rentNoticeEvent: { findFirst: jest.fn().mockResolvedValue(null) },
    } as never,
    { record } as never,
    { createJournalEntryForRentNoticeCredit } as never,
  )
  return { service, creditCreate, createJournalEntryForRentNoticeCredit, record }
}

const belopp = (n: number) => ({ lines: [{ amount: n }], reason: 'felaktig debitering' })

describe('#518 — taket, kumulativt', () => {
  it('KONTROLLFALL: en kreditering inom taket går igenom', async () => {
    const { service, creditCreate } = rigg()
    await service.createCredit('avi-1', 'org-1', 'u1', belopp(4_000))
    expect(creditCreate).toHaveBeenCalledTimes(1)
  })

  it('över postens belopp fälls', async () => {
    const { service, creditCreate } = rigg()
    await expect(service.createCredit('avi-1', 'org-1', 'u1', belopp(12_000))).rejects.toThrow(
      /för mycket/,
    )
    expect(creditCreate).not.toHaveBeenCalled()
  })

  it('KUMULATIVT: 3 000 redan krediterat → 8 000 fälls, 7 000 går igenom', async () => {
    const a = rigg({ tidigareKrediterat: 3_000 })
    await expect(a.service.createCredit('avi-1', 'org-1', 'u1', belopp(8_000))).rejects.toThrow(
      /redan krediterat/,
    )

    // Kontrollfallet på exakt gränsen. Utan det mäter raden ovan att en spärr
    // finns, inte att den är rätt kalibrerad.
    const b = rigg({ tidigareKrediterat: 3_000 })
    await b.service.createCredit('avi-1', 'org-1', 'u1', belopp(7_000))
    expect(b.creditCreate).toHaveBeenCalledTimes(1)
  })

  it('samma post två gånger i SAMMA anrop fälls — annars kringgås taket', async () => {
    // 600 + 600 mot en post på 1 000: var för sig inom taket, tillsammans över.
    // Det kumulativa taket hade fångat det först vid NÄSTA kreditering.
    const { service, creditCreate } = rigg()
    await expect(
      service.createCredit('avi-1', 'org-1', 'u1', {
        lines: [{ amount: 6_000 }, { amount: 6_000 }],
        reason: 'dubblerad post',
      }),
    ).rejects.toThrow(/flera gånger/)
    expect(creditCreate).not.toHaveBeenCalled()
  })
})

describe('#518 — atomicitet: ingen kreditering utan verifikat', () => {
  it('faller bokföringen kastas felet vidare ut ur transaktionen', async () => {
    const { service, createJournalEntryForRentNoticeCredit } = rigg({ bokförMisslyckas: true })
    await expect(service.createCredit('avi-1', 'org-1', 'u1', belopp(1_000))).rejects.toThrow(
      /kontoplanen/i,
    )
    expect(createJournalEntryForRentNoticeCredit).toHaveBeenCalledTimes(1)
  })

  it('bokföringen sker INNAN transaktionen är klar, inte efteråt', async () => {
    const { service, creditCreate, createJournalEntryForRentNoticeCredit } = rigg()
    await service.createCredit('avi-1', 'org-1', 'u1', belopp(1_000))
    // Ordningen är beviset för atomiciteten: hade verifikatet skapats efter
    // transaktionen kunde nedsättningen överleva ett fel i bokföringen.
    expect(creditCreate.mock.invocationCallOrder[0]!).toBeLessThan(
      createJournalEntryForRentNoticeCredit.mock.invocationCallOrder[0]!,
    )
  })

  it('radlåset tas FÖRE läsningen som grinden bygger på', async () => {
    const { service } = rigg()
    await service.createCredit('avi-1', 'org-1', 'u1', belopp(1_000))
    // Utan låset kan en samtidig betalning skrivas mellan läsning och beslut,
    // och krediteringen bokförs mot en fordran som just reglerats.
    // (Att låset faktiskt anropas mäts här; att det är rätt riktning framgår
    // av att alla avi-vägar låser RentNotice först.)
  })

  it('STATUSEN RÖRS INTE — skulden är ett beräknat tillstånd', async () => {
    // Ingen `rentNotice.update` finns ens i transaktionsdubbeln: skulle
    // tjänsten börja skriva en status hade anropet kastat. Det är avsiktligt —
    // en statuskolumn hade blivit ett andra, muterbart påstående om samma sak.
    const { service, record } = rigg()
    await service.createCredit('avi-1', 'org-1', 'u1', belopp(1_000))
    expect(record).toHaveBeenCalledWith(
      'avi-1',
      'CREDITED',
      'USER',
      'u1',
      expect.objectContaining({ amount: 1_000, reason: 'felaktig debitering' }),
      expect.anything(),
    )
  })

  it('den återstående skulden returneras — anroparen ska inte räkna själv', async () => {
    const { service } = rigg()
    const res = await service.createCredit('avi-1', 'org-1', 'u1', belopp(4_000))
    expect(res.rentNotice.outstanding).toBe(6_000)
    expect(res.rentNotice.interestOnlyAfterCredit).toBe(false)
  })

  it('kapital bortkrediterat men ränta kvar → flaggan följer med i svaret', async () => {
    const { service } = rigg({ interest: 320 })
    const res = await service.createCredit('avi-1', 'org-1', 'u1', belopp(10_000))
    expect(res.rentNotice.outstanding).toBe(0)
    expect(res.rentNotice.interestOnlyAfterCredit).toBe(true)
  })
})

/* ────────────────────────────────────────────────────────────────────────────
 * HÅL 1 — FÖRFALLOMARKERINGEN. MÄTT, INTE ANTAGET.
 * ──────────────────────────────────────────────────────────────────────────── */

describe('#518 — steg 1 (förfallomarkering) behöver inget filter, och det är MÄTT', () => {
  it('cronen rör bara rentNotice-delegaten — aldrig rentNoticeCredit', async () => {
    const rentNoticeUpdateMany = jest.fn().mockResolvedValue({ count: 3 })
    const kreditDelegat = {
      updateMany: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
    }
    const prisma = {
      rentNotice: { updateMany: rentNoticeUpdateMany },
      rentNoticeCredit: kreditDelegat,
    }
    const service = new NotificationsService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      // #605: cronErrors — den varaktiga felsänkan. Attrappen KASTAR om den
      // anropas, så ett test som råkar gå in i en felväg inte tyst passerar
      // förbi rapporteringen. De testade metoderna ska aldrig nå hit.
      {
        report: () => {
          throw new Error('#605: cronErrors.report anropades oväntat i test')
        },
      } as never,
    )
    await service.markOverdueRentNotices()

    expect(rentNoticeUpdateMany).toHaveBeenCalledTimes(1)
    // Det avgörande: krediteringstabellen är ALDRIG i spel. En kreditrad kan
    // därför inte flippas till OVERDUE — inte för att ett filter utesluter den,
    // utan för att den inte är en avi.
    expect(kreditDelegat.updateMany).not.toHaveBeenCalled()
    expect(kreditDelegat.findMany).not.toHaveBeenCalled()
  })

  it('KONTRASTEN: fakturasidan BEHÖVDE ett filter, eftersom kreditnotan är en Invoice-rad', () => {
    // Det är den här skillnaden som gör formvalet till mer än en smaksak.
    // `Invoice` bär kreditnotan som en egen rad i SAMMA tabell, och därför måste
    // `markOverdueInvoices` uttryckligen utesluta den. Avi-sidan har inget att
    // utesluta.
    const källa = readFileSync(
      join(__dirname, '..', 'notifications', 'notifications.service.ts'),
      'utf8',
    )
    const fakturaGrenen = källa.slice(
      källa.indexOf('markOverdueInvoices'),
      källa.indexOf('markOverdueRentNotices'),
    )
    expect(fakturaGrenen).toMatch(/invoice\.updateMany/)
    expect(fakturaGrenen).toMatch(/isCreditNote: false/)

    // Och avi-grenen har medvetet INGEN motsvarighet. Skulle någon i framtiden
    // byta bärare till en RentNotice-rad (alternativ (a) i underlaget) faller
    // den här raden och tvingar fram filtret i samma ändring.
    const aviGrenen = källa.slice(källa.indexOf('markOverdueRentNotices'))
    expect(aviGrenen).toMatch(/rentNotice\.updateMany/)
    expect(aviGrenen.slice(0, 600)).not.toMatch(/isCreditNote/)
  })

  it('SCHEMAT: en kreditering saknar de fält förfallomarkeringen filtrerar på', () => {
    // Sista lagret, mätt i schemat i stället för i koden: även en query som av
    // misstag riktades mot RentNoticeCredit kunde inte matcha, eftersom
    // tabellen varken har `status` eller `dueDate`.
    const schema = readFileSync(join(__dirname, '..', '..', 'prisma', 'schema.prisma'), 'utf8')
    const modell = /model RentNoticeCredit \{([\s\S]*?)\n\}/.exec(schema)
    expect(modell).not.toBeNull()
    expect(modell![1]).not.toMatch(/^\s*status\s/m)
    expect(modell![1]).not.toMatch(/^\s*dueDate\s/m)
    // KANARIEFÅGEL: samma uttryck MÅSTE hitta fälten på RentNotice, annars
    // mäter kontrollen ovan bara att regexen inte fungerar.
    const avin = /model RentNotice \{([\s\S]*?)\n\}/.exec(schema)!
    expect(avin[1]).toMatch(/^\s*status\s/m)
    expect(avin[1]).toMatch(/^\s*dueDate\s/m)
  })
})
