/**
 * #517 — KREDITNOTA PÅ OBETALD FAKTURA.
 *
 * Vad testerna ska diskriminera, och varför just de valen:
 *
 *   • DELKREDITERING mot HELKREDITERING. Alla belopp nedan är olika från
 *     varandra (10 000 / 3 000 / 7 000), så en implementation som råkar
 *     kreditera hela fakturan oavsett indata faller. Ett test där krediteringen
 *     är lika med fakturans total kan inte skilja de två fallen åt — samma
 *     fälla som delbetalningarna gick i före C4/C5.
 *
 *   • SPÄRRARNA MÄTS PÅ FAKTISKA ALLOKERINGAR, inte på status. En faktura med
 *     status SENT men en registrerad betalning ska falla; annars vore grinden
 *     bara en statuskontroll med en annan formulering.
 */

jest.mock('./pdf.service', () => ({ PdfService: class {} }))

import { Prisma } from '@prisma/client'
import { BadRequestException } from '@nestjs/common'
import { CreditNoteService } from './credit-note.service'

const D = (n: number | string) => new Prisma.Decimal(n)

const ORIGINAL_LINE = {
  id: 'line-1',
  description: 'Hyra januari',
  quantity: D(1),
  unitPrice: D(10_000),
  vatRate: 0,
  total: D(10_000),
}

function makeService(
  overrides: {
    status?: string
    isCreditNote?: boolean
    payments?: number[]
    creditNotes?: number[]
    lines?: Array<Record<string, unknown>>
    tidigareRadkrediteringar?: Array<[string, number]>
    /** Fakturans EGET verifikat är rättat av en operatör (riktning 2 av paret). */
    verifikatRattat?: boolean
  } = {},
) {
  const original = {
    id: 'inv-1',
    organizationId: 'org-1',
    invoiceNumber: 'F-2026-0001',
    type: 'RENT',
    status: overrides.status ?? 'SENT',
    isCreditNote: overrides.isCreditNote ?? false,
    tenantId: 'tenant-1',
    customerId: null,
    leaseId: 'lease-1',
    total: D(10_000),
    lines: overrides.lines ?? [ORIGINAL_LINE],
    payments: (overrides.payments ?? []).map((a) => ({ amount: D(a) })),
    creditNotes: (overrides.creditNotes ?? []).map((t) => ({ total: D(t) })),
  }

  const invoiceCreate = jest.fn((arg: { data: Record<string, unknown> }) =>
    Promise.resolve({
      id: 'credit-1',
      ...arg.data,
      total: D(arg.data.total as number),
      lines: [],
    }),
  )

  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    invoice: { findFirst: jest.fn().mockResolvedValue(original), create: invoiceCreate },
    // Tidigare kreditnotors rader, som radtaket summerar kumulativt.
    invoiceLine: {
      findMany: jest.fn().mockResolvedValue(
        (overrides.tidigareRadkrediteringar ?? []).map(([lineId, total]) => ({
          creditedInvoiceLineId: lineId,
          total: D(total),
        })),
      ),
    },
    invoiceNumberSequence: {
      upsert: jest.fn().mockResolvedValue({ lastNumber: 42 }),
    },
    // Fakturans eget verifikat. `reversedBy` != null betyder att en operatör
    // rättat det — riktning 2 av spärrparet.
    journalEntry: {
      findFirst: jest
        .fn()
        .mockResolvedValue(
          overrides.verifikatRattat ? { reversedBy: { series: 'A', verNumber: 12 } } : null,
        ),
    },
  }
  const prisma = {
    $transaction: jest.fn((cb: (t: unknown) => unknown) => cb(tx)),
  }

  const createJournalEntryForCreditNote = jest.fn().mockResolvedValue({ id: 'je-credit-1' })
  const record = jest.fn().mockResolvedValue(undefined)

  const service = new CreditNoteService(
    prisma as never,
    { record } as never,
    { createJournalEntryForCreditNote } as never,
  )
  return { service, invoiceCreate, createJournalEntryForCreditNote, record, tx }
}

const line = (quantity: number, unitPrice: number) => ({
  invoiceLineId: 'line-1',
  quantity,
  unitPrice,
})

describe('#517 — helkreditering av obetald faktura', () => {
  it('skapar kreditnota kopplad till originalet, utan OCR, och bokför verifikatet', async () => {
    const { service, invoiceCreate, createJournalEntryForCreditNote } = makeService()

    const res = await service.createCreditNote('inv-1', 'org-1', 'user-1', {
      lines: [line(1, 10_000)],
      reason: 'Perioden avbeställd av hyresgästen',
    })

    const data = invoiceCreate.mock.calls[0]![0].data
    expect(data.isCreditNote).toBe(true)
    expect(data.creditedInvoiceId).toBe('inv-1')
    // Inget betal-OCR: en kreditnota ska inte gå att betala in på.
    expect(data.ocrNumber).toBeNull()
    expect(data.total).toBe(10_000)
    // Numret kommer ur den DELADE fakturasekvensen, ingen egen kreditserie.
    expect(data.invoiceNumber).toBe('F-2026-0042')
    // Verifikatet skapas i samma transaktion som dokumentet.
    expect(createJournalEntryForCreditNote).toHaveBeenCalledTimes(1)
    // Fordran är borta.
    expect(res.creditedInvoice.outstanding).toBe(0)
  })

  it('händelsen skrivs på ORIGINALET — det är där någon letar efter varför fordran krympte', async () => {
    const { service, record } = makeService()

    await service.createCreditNote('inv-1', 'org-1', 'user-1', {
      lines: [line(1, 10_000)],
      reason: 'Perioden avbeställd',
    })

    const påOriginalet = record.mock.calls.find((c) => c[1] === 'CREDIT_NOTE_CREATED')
    expect(påOriginalet?.[0]).toBe('inv-1')
    expect(påOriginalet?.[4]).toMatchObject({ amount: 10_000, reason: 'Perioden avbeställd' })
  })
})

describe('#517 — delkreditering', () => {
  it('krediterar 3 000 av 10 000 → restskulden blir 7 000, inte 0', async () => {
    const { service, invoiceCreate } = makeService()

    const res = await service.createCreditNote('inv-1', 'org-1', 'user-1', {
      lines: [line(1, 3_000)],
      reason: 'Prisavdrag för utebliven städning',
    })

    expect(invoiceCreate.mock.calls[0]![0].data.total).toBe(3_000)
    expect(res.creditedInvoice.outstanding).toBe(7_000)
  })

  it('en andra kreditering räknas ovanpå den första', async () => {
    // 10 000 med 3 000 redan krediterat → högst 7 000 kvar.
    const { service } = makeService({ creditNotes: [3_000] })

    const res = await service.createCreditNote('inv-1', 'org-1', 'user-1', {
      lines: [line(1, 7_000)],
      reason: 'Resten krediteras också',
    })
    expect(res.creditedInvoice.outstanding).toBe(0)
  })

  it('momssatsen ÄRVS från originalraden och kan inte sättas av klienten', async () => {
    const { service, invoiceCreate } = makeService({
      lines: [{ ...ORIGINAL_LINE, vatRate: 25, total: D(12_500) }],
    })

    await service.createCreditNote('inv-1', 'org-1', 'user-1', {
      lines: [line(1, 1_000)],
      reason: 'Delvis kreditering av momspliktig lokal',
    })

    const skapade = invoiceCreate.mock.calls[0]![0].data as {
      vatTotal: number
      lines: { createMany: { data: Array<{ vatRate: number }> } }
    }
    expect(skapade.lines.createMany.data[0]!.vatRate).toBe(25)
    expect(skapade.vatTotal).toBe(250)
  })
})

describe('#517 — spärrarna', () => {
  it('faktura med registrerad betalning: nekas, och skälet nämner tillgodohavandet', async () => {
    const { service, invoiceCreate } = makeService({ payments: [500] })

    await expect(
      service.createCreditNote('inv-1', 'org-1', 'user-1', {
        lines: [line(1, 1_000)],
        reason: 'Försök att kreditera delbetald',
      }),
    ).rejects.toThrow(BadRequestException)

    // Statusen är SENT — grinden nyckas alltså på allokeringen, inte på status.
    await expect(
      service.createCreditNote('inv-1', 'org-1', 'user-1', {
        lines: [line(1, 1_000)],
        reason: 'Försök att kreditera delbetald',
      }),
    ).rejects.toThrow(/tillgodohavande/i)
    expect(invoiceCreate).not.toHaveBeenCalled()
  })

  it('kreditering över obetalt belopp: nekas med båda talen i texten', async () => {
    const { service, invoiceCreate } = makeService({ creditNotes: [8_000] })

    await expect(
      service.createCreditNote('inv-1', 'org-1', 'user-1', {
        lines: [line(1, 5_000)],
        reason: 'För mycket',
      }),
    ).rejects.toThrow(/5000.00 kr.*2000.00 kr|5 000.*2 000/s)
    expect(invoiceCreate).not.toHaveBeenCalled()
  })

  it('makulerad faktura: nekas — intäkten är redan reverserad', async () => {
    const { service, createJournalEntryForCreditNote } = makeService({ status: 'VOID' })

    await expect(
      service.createCreditNote('inv-1', 'org-1', 'user-1', {
        lines: [line(1, 100)],
        reason: 'Försök på makulerad',
      }),
    ).rejects.toThrow(/makulerad/i)
    expect(createJournalEntryForCreditNote).not.toHaveBeenCalled()
  })

  it('en kreditnota kan inte krediteras', async () => {
    const { service } = makeService({ isCreditNote: true })

    await expect(
      service.createCreditNote('inv-1', 'org-1', 'user-1', {
        lines: [line(1, 100)],
        reason: 'Kreditering av kreditering',
      }),
    ).rejects.toThrow(/redan en kreditnota/i)
  })

  it('fullt krediterad faktura: nekas', async () => {
    const { service } = makeService({ creditNotes: [10_000] })

    await expect(
      service.createCreditNote('inv-1', 'org-1', 'user-1', {
        lines: [line(1, 1)],
        reason: 'Inget kvar',
      }),
    ).rejects.toThrow(/fullt krediterad/i)
  })

  it('rad som inte finns på fakturan: nekas', async () => {
    const { service } = makeService()

    await expect(
      service.createCreditNote('inv-1', 'org-1', 'user-1', {
        lines: [{ invoiceLineId: 'line-finns-ej', quantity: 1, unitPrice: 100 }],
        reason: 'Fel rad',
      }),
    ).rejects.toThrow(/finns inte på faktura/i)
  })
})

describe('#517 — radlåset tas före beslutet', () => {
  it('FOR UPDATE körs innan fakturan läses', async () => {
    const { service, tx } = makeService()
    await service.createCreditNote('inv-1', 'org-1', 'user-1', {
      lines: [line(1, 100)],
      reason: 'Liten kreditering',
    })
    // Utan låset kan en samtidig betalning landa mellan grinden och skrivningen,
    // och krediteringen bokförs då mot en fordran som just reglerats.
    const låsOrdning = tx.$queryRaw.mock.invocationCallOrder[0]!
    const läsOrdning = tx.invoice.findFirst.mock.invocationCallOrder[0]!
    expect(låsOrdning).toBeLessThan(läsOrdning)
  })
})

describe('#517 — radnivå-taket', () => {
  it('kreditering över radens belopp nekas, med radens namn och överskottet i texten', async () => {
    // Fakturan har EN rad på 10 000. Ett försök att kreditera 12 000 på den
    // ryms inte i raden, oavsett vad fakturans total säger.
    const { service, invoiceCreate } = makeService({
      lines: [{ ...ORIGINAL_LINE, unitPrice: D(10_000), total: D(10_000) }],
      creditNotes: [],
    })

    await expect(
      service.createCreditNote('inv-1', 'org-1', 'user-1', {
        lines: [line(1, 12_000)],
        reason: 'Mer än raden',
      }),
    ).rejects.toThrow(/Hyra januari/)
    expect(invoiceCreate).not.toHaveBeenCalled()
  })

  it('meddelandet namnger raden OCH hur mycket för mycket det är', async () => {
    const { service } = makeService()
    await expect(
      service.createCreditNote('inv-1', 'org-1', 'user-1', {
        lines: [line(1, 12_000)],
        reason: 'Mer än raden',
      }),
    ).rejects.toThrow(/"Hyra januari".*12000\.00 kr.*10000\.00 kr.*2000\.00 kr för mycket/s)
  })

  it('KUMULATIVT: en andra kreditering av SAMMA rad räknas mot vad som redan krediterats', async () => {
    // 3 000 av radens 10 000 är redan krediterat. Ytterligare 8 000 ryms inte,
    // trots att 8 000 < 10 000 sett för sig.
    const { service } = makeService({
      creditNotes: [3_000],
      tidigareRadkrediteringar: [['line-1', 3_000]],
    })

    await expect(
      service.createCreditNote('inv-1', 'org-1', 'user-1', {
        lines: [line(1, 8_000)],
        reason: 'Andra krediteringen',
      }),
    ).rejects.toThrow(/redan krediterat.*1000\.00 kr för mycket/s)
  })

  it('DISKRIMINERANDE: exakt det som återstår på raden går igenom', async () => {
    // Kontrollfallet till testet ovan. Faller båda samtidigt mäter de ingenting.
    const { service, invoiceCreate } = makeService({
      creditNotes: [3_000],
      tidigareRadkrediteringar: [['line-1', 3_000]],
    })

    await service.createCreditNote('inv-1', 'org-1', 'user-1', {
      lines: [line(1, 7_000)],
      reason: 'Resten av raden',
    })
    expect(invoiceCreate.mock.calls[0]![0].data.total).toBe(7_000)
  })

  it('kreditnotans rader bär kopplingen till originalraden', async () => {
    const { service, invoiceCreate } = makeService()
    await service.createCreditNote('inv-1', 'org-1', 'user-1', {
      lines: [line(1, 1_000)],
      reason: 'Delkreditering',
    })

    const rader = (
      invoiceCreate.mock.calls[0]![0].data as {
        lines: { createMany: { data: Array<{ creditedInvoiceLineId: string }> } }
      }
    ).lines.createMany.data
    // Utan kopplingen kan radtaket inte räkna kumulativt.
    expect(rader[0]!.creditedInvoiceLineId).toBe('line-1')
  })
})

describe('#517 — överlämnad till inkasso', () => {
  it('nekas, och meddelandet säger var kravet måste hanteras', async () => {
    const { service, invoiceCreate, createJournalEntryForCreditNote } = makeService({
      status: 'SENT_TO_COLLECTION',
    })

    await expect(
      service.createCreditNote('inv-1', 'org-1', 'user-1', {
        lines: [line(1, 1_000)],
        reason: 'Försök kreditera inkassofordran',
      }),
    ).rejects.toThrow(/inkasso/i)
    await expect(
      service.createCreditNote('inv-1', 'org-1', 'user-1', {
        lines: [line(1, 1_000)],
        reason: 'Försök kreditera inkassofordran',
      }),
    ).rejects.toThrow(/hanteras hos inkassobolaget/i)

    expect(invoiceCreate).not.toHaveBeenCalled()
    expect(createJournalEntryForCreditNote).not.toHaveBeenCalled()
  })

  it('meddelandet lovar ingen återkallningsväg — för det finns ingen', async () => {
    const { service } = makeService({ status: 'SENT_TO_COLLECTION' })
    await expect(
      service.createCreditNote('inv-1', 'org-1', 'user-1', {
        lines: [line(1, 1)],
        reason: 'Försök',
      }),
    ).rejects.toThrow(/ingen väg att återkalla/i)
  })
})
