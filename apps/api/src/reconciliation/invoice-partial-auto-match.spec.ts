jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
/**
 * M1 — en delbetalning på fakturavägen matchas, men BARA på en entydig identitet.
 *
 * En hyresgäst som betalade halva sin faktura fick ingenting matchat: pengarna
 * blev en omatchad transaktion, fakturan stod kvar obetald i sin helhet, och
 * kravtrappan räknade på en större fordran än den verkliga. Samma betalning hade
 * matchats om den avsett en hyresavi.
 *
 * ── VAD VARJE GRUPP SKULLE FÄLLA ─────────────────────────────────────────────
 *
 * (1) KÄRNAN         faller om förkontrollen på `invoice.total` återinförs.
 * (2) GISSNINGEN     faller om partial öppnas på fritext- eller fuzzy-grenen —
 *                    alltså om vi byggt en gissningsmaskin. KANARIEFÅGEL åt
 *                    motsatt håll: utan den är (1) grön av att allt släpps igenom.
 * (3) H4             faller om överbetalning kan allokera via den NYA vägen.
 * (4) OFÖRÄNDRAT     faller om full betalning slutat fungera.
 * (5) SLUTBETALNING  faller om en delbetald faktura inte kan regleras klart.
 *
 * ── VARFÖR RIGGEN SER UT SÅ HÄR ──────────────────────────────────────────────
 *
 * `applyMatchToInvoice` klassificerar mot restskulden INNANFÖR radlåset. Riggen
 * matar därför `invoicePayment.findMany` med tidigare allokeringar och läser
 * utfallet ur `invoicePayment.create` (belopp) och `invoice.updateMany` (status).
 * Utfallet är diskriminerande: ingen allokering skriven = ingen matchning.
 */

import { Decimal } from '@prisma/client/runtime/library'
import { ReconciliationService } from './reconciliation.service'
import {
  ALLOKERINGSSKRIVARE,
  ENTYDIGA_MATCHNINGSVAGAR,
  PARTIAL_ALDRIG_VID_GISSNING,
  PARTIAL_VID_ENTYDIG_IDENTITET,
} from './partial-match-identity'

const dec = (v: string | number) => new Decimal(v)

interface RiggOpt {
  /** Hur fakturan hittas: via systemtilldelat OCR, via fritextreferens, eller inte alls. */
  träff?: 'ocr' | 'reference' | 'invoice-number' | 'ingen'
  /** Tidigare allokeringar på fakturan (restskuld = total − Σ). */
  tidigare?: number[]
  total?: number
  status?: string
}

function rigg(opt: RiggOpt = {}) {
  const total = opt.total ?? 10_000
  const träff = opt.träff ?? 'ocr'
  const faktura = {
    id: 'inv-1',
    invoiceNumber: 'F-2026-001',
    status: opt.status ?? 'SENT',
    total: dec(total),
  }

  const txMock = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    invoice: {
      findFirst: jest.fn().mockResolvedValue({
        status: opt.status ?? 'SENT',
        invoiceNumber: 'F-2026-001',
      }),
      findMany: jest.fn().mockResolvedValue([]), // inga kreditnotor
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    invoicePayment: {
      findMany: jest.fn().mockResolvedValue((opt.tidigare ?? []).map((a) => ({ amount: dec(a) }))),
      create: jest.fn().mockResolvedValue({ id: 'alloc-1' }),
    },
    bankTransaction: { update: jest.fn().mockResolvedValue({}) },
    // Depositionssynken körs bara vid FULL reglering (#41): en delbetald
    // deposition är inte betald.
    deposit: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
  }

  const prisma = {
    // OCR-grenen: identitetsuppslaget träffar bara vid 'ocr'.
    invoice: {
      findFirst: jest.fn().mockImplementation(({ where }: { where: Record<string, unknown> }) => {
        if (where.ocrNumber !== undefined) return Promise.resolve(träff === 'ocr' ? faktura : null)
        if (where.reference !== undefined)
          return Promise.resolve(träff === 'reference' ? faktura : null)
        if (where.invoiceNumber !== undefined)
          return Promise.resolve(träff === 'invoice-number' ? faktura : null)
        return Promise.resolve(null)
      }),
      findMany: jest.fn().mockResolvedValue([]), // inga fuzzy-kandidater
    },
    tenant: { findFirst: jest.fn().mockResolvedValue(null) },
    rentNotice: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
    },
    $transaction: jest.fn((cb: (t: unknown) => unknown) => cb(txMock)),
  }

  const invoices = {
    // `claimed` är BÄRANDE: applyMatchToInvoice returnerar null på `!claim.claimed`.
    // Utan fältet blir varje FULL betalning falskt omatchad, och testerna röda av
    // ett riggfel som ser ut som en regression.
    claimPaidWithinTx: jest.fn().mockResolvedValue({ claimed: true, invoiceNumber: 'F-2026-001' }),
    // Notisen skickas EFTER transaktionen och bara vid full reglering.
    notifyInvoicePaid: jest.fn(),
  }
  const service = new ReconciliationService(
    prisma as never,
    invoices as never,
    { record: jest.fn() } as never,
    { createJournalEntryForPayment: jest.fn().mockResolvedValue({ id: 'je-1' }) } as never,
    { recordPaymentDataThrough: jest.fn().mockResolvedValue({}) } as never,
    { record: jest.fn().mockResolvedValue({}) } as never,
  )
  return { service, prisma, txMock, invoices }
}

/** Banktransaktion. `viaOcr=false` lägger fakturanumret i beskrivningen i stället. */
const tx = (belopp: number, opt: { ocr?: string | null; beskrivning?: string } = {}) => ({
  id: 'bt-1',
  rawOcr: opt.ocr === undefined ? '00000000019' : opt.ocr,
  amount: dec(belopp),
  date: new Date('2026-06-20'),
  description: opt.beskrivning ?? '',
  reference: '',
})

/** Vad skrevs? Diskriminerande utfall: allokeringsbelopp + statusövergång. */
function utfall(txMock: ReturnType<typeof rigg>['txMock']) {
  const alloc = txMock.invoicePayment.create.mock.calls[0]?.[0]?.data
  const statusSkrivning = txMock.invoice.updateMany.mock.calls[0]?.[0]?.data
  return {
    allokerad: alloc ? Number(alloc.amount) : null,
    nyStatus: statusSkrivning?.status ?? null,
    fullBetalning: txMock.invoice.findFirst.mock.calls.length > 0,
  }
}

// ── konstanterna måste skilja sig åt ─────────────────────────────────────────

describe('KANARIEFÅGEL — de två konstanterna är inte samma värde', () => {
  it('PARTIAL_VID_ENTYDIG_IDENTITET !== PARTIAL_ALDRIG_VID_GISSNING', () => {
    // Sätts båda till samma värde blir hela klassificeringen dekoration: varje
    // anropsställe skickar då samma sak och registret mäter ingenting.
    expect(PARTIAL_VID_ENTYDIG_IDENTITET).toBe(true)
    expect(PARTIAL_ALDRIG_VID_GISSNING).toBe(false)
    expect(PARTIAL_VID_ENTYDIG_IDENTITET).not.toBe(PARTIAL_ALDRIG_VID_GISSNING)
  })

  it('registren är icke-tomma — ett tomt register gör guarden vakuöst grön', () => {
    expect(ENTYDIGA_MATCHNINGSVAGAR.length).toBeGreaterThan(0)
    expect(ALLOKERINGSSKRIVARE.length).toBeGreaterThan(0)
  })
})

// ── (1) KÄRNAN ───────────────────────────────────────────────────────────────

describe('(1) delbetalning med ENTYDIGT OCR → matchas, fakturan blir delbetald', () => {
  it('4 000 kr på en faktura om 10 000 kr allokeras och ger PARTIAL', async () => {
    const { service, txMock } = rigg({ träff: 'ocr', total: 10_000 })
    const ok = await service.matchTransaction(tx(4_000) as never, 'org-1')

    expect(ok).toBe(true)
    const r = utfall(txMock)
    expect(r.allokerad).toBe(4_000) // det FAKTISKT mottagna, inte fakturans total
    expect(r.nyStatus).toBe('PARTIAL')
  })

  it('restskulden efter är 6 000 kr — händelsen bär outstandingAfter', async () => {
    const { service, invoices } = rigg({ träff: 'ocr', total: 10_000 })
    const events = { record: jest.fn() }
    ;(service as unknown as { events: typeof events }).events = events

    await service.matchTransaction(tx(4_000) as never, 'org-1')

    // PAYMENT_PARTIAL-händelsen: restskulden EFTER betalningen.
    const partial = events.record.mock.calls.find((c) => c[1] === 'PAYMENT_PARTIAL')
    expect(partial).toBeDefined()
    expect(partial?.[4]).toMatchObject({ amount: 4_000, outstandingAfter: 6_000 })
    // Full-betalningsvägen får INTE ha använts.
    expect(invoices.claimPaidWithinTx).not.toHaveBeenCalled()
  })

  it('fakturanummer i beskrivningen är också entydigt → delbetalning tillåts', async () => {
    const { service, txMock } = rigg({ träff: 'invoice-number', total: 10_000 })
    const ok = await service.matchTransaction(
      tx(4_000, { ocr: null, beskrivning: 'Betalning F-2026-001' }) as never,
      'org-1',
    )

    expect(ok).toBe(true)
    expect(utfall(txMock).allokerad).toBe(4_000)
  })
})

// ── (2) GISSNINGEN — den avgörande säkerhetsregeln ───────────────────────────

describe('(2) NEGATIVKONTROLL — samma belopp UTAN entydig identitet matchas INTE', () => {
  it('träff via FRITEXTREFERENS → delbetalning avvisas, ingen allokering', async () => {
    // `Invoice.reference` är fritext från klienten (#554) — en FÖRHOPPNING, inte
    // en identitet. Ett belopp mindre än fakturan är inget svagare bevis för
    // SAMMA faktura; det kan vara full betalning av en annan, mindre.
    const { service, txMock } = rigg({ träff: 'reference', total: 10_000 })
    const ok = await service.matchTransaction(tx(4_000) as never, 'org-1')

    expect(ok).toBe(false)
    expect(txMock.invoicePayment.create).not.toHaveBeenCalled()
    expect(txMock.invoice.updateMany).not.toHaveBeenCalled()
  })

  it('men fritextgrenen får fortfarande reglera FULLT — funktionen är kvar', async () => {
    // Att stänga delbetalningen får inte råka stänga hela grenen. Ett OCR ur ett
    // gammalt system (Vitec/Momentum) i `reference` ska fortsätta matcha.
    const { service, invoices } = rigg({ träff: 'reference', total: 10_000 })
    const ok = await service.matchTransaction(tx(10_000) as never, 'org-1')

    expect(ok).toBe(true)
    expect(invoices.claimPaidWithinTx).toHaveBeenCalled()
  })
})

// ── (3) H4 — överbetalning via den NYA vägen ─────────────────────────────────

describe('(3) NEGATIVKONTROLL — överbetalning avvisas på den nya vägen', () => {
  it('12 000 kr på en faktura om 10 000 kr → ingen allokering, ingen negativ fordran', async () => {
    const { service, txMock } = rigg({ träff: 'ocr', total: 10_000 })
    const ok = await service.matchTransaction(tx(12_000) as never, 'org-1')

    expect(ok).toBe(false)
    expect(txMock.invoicePayment.create).not.toHaveBeenCalled()
  })

  it('överbetalning mot RESTSKULDEN: 7 000 kr när bara 6 000 kr återstår → avvisas', async () => {
    // Det skarpa fallet för den NYA vägen: fakturan är redan delbetald, så
    // överbetalningen syns bara om klassificeringen sker mot restskulden. Mäts
    // den mot totalen ser 7 000 < 10 000 ut som en oskyldig delbetalning — och
    // då skulle 1510 krediteras 1 000 kr för mycket. Det är H4, återinförd genom
    // en dörr som inte fanns när spärren skrevs.
    const { service, txMock } = rigg({ träff: 'ocr', total: 10_000, tidigare: [4_000] })
    const ok = await service.matchTransaction(tx(7_000) as never, 'org-1')

    expect(ok).toBe(false)
    expect(txMock.invoicePayment.create).not.toHaveBeenCalled()
  })
})

// ── (4) OFÖRÄNDRAT ───────────────────────────────────────────────────────────

describe('(4) NEGATIVKONTROLL — full betalning beter sig oförändrat', () => {
  it('10 000 kr på en faktura om 10 000 kr → PAID-vägen, som förr', async () => {
    const { service, invoices, txMock } = rigg({ träff: 'ocr', total: 10_000 })
    const ok = await service.matchTransaction(tx(10_000) as never, 'org-1')

    expect(ok).toBe(true)
    expect(invoices.claimPaidWithinTx).toHaveBeenCalled()
    expect(txMock.invoice.updateMany).not.toHaveBeenCalled() // ingen PARTIAL-flip
    expect(utfall(txMock).allokerad).toBe(10_000)
  })

  it('öresavrundning inom en krona räknas fortfarande som full reglering', async () => {
    const { service, invoices, txMock } = rigg({ träff: 'ocr', total: 10_000 })
    const ok = await service.matchTransaction(tx(9_999.5) as never, 'org-1')

    expect(ok).toBe(true)
    expect(invoices.claimPaidWithinTx).toHaveBeenCalled()
    // Hela restskulden allokeras, inte det inbetalda — ingen öresskuld lämnas kvar.
    expect(utfall(txMock).allokerad).toBe(10_000)
  })
})

// ── (5) SLUTBETALNING — hålet förkontrollen dolde ────────────────────────────

describe('(5) en senare restbetalning tar fakturan hela vägen till PAID', () => {
  it('6 000 kr när 4 000 kr redan allokerats → full reglering, inte ny delbetalning', async () => {
    // Det här fallet matchade INTE före M1, trots att uppslaget uttryckligen
    // hämtar status PARTIAL: förkontrollen mätte 10 000 − 6 000 = 4 000 > 1 kr.
    // Grenen kunde alltså hämta en delbetald faktura och aldrig reglera den.
    const { service, invoices, txMock } = rigg({
      träff: 'ocr',
      total: 10_000,
      tidigare: [4_000],
      status: 'PARTIAL',
    })
    const ok = await service.matchTransaction(tx(6_000) as never, 'org-1')

    expect(ok).toBe(true)
    expect(invoices.claimPaidWithinTx).toHaveBeenCalled()
    expect(utfall(txMock).allokerad).toBe(6_000)
  })

  it('och en tredje delbetalning klassas mot den UPPDATERADE restskulden', async () => {
    // Två delbetalningar i samma import: den andra läser `priorAllocations`
    // innanför radlåset och ser den första. 2 000 kr av 6 000 kr kvar → PARTIAL.
    const { service, txMock } = rigg({ träff: 'ocr', total: 10_000, tidigare: [4_000] })
    const ok = await service.matchTransaction(tx(2_000) as never, 'org-1')

    expect(ok).toBe(true)
    const r = utfall(txMock)
    expect(r.allokerad).toBe(2_000)
    expect(r.nyStatus).toBe('PARTIAL')
  })
})
