/**
 * PÅKOPPLINGEN: `markAsPaidManually` FRÅGAR dubblettfönstret, och frågar rätt.
 *
 * ── DELNINGEN ───────────────────────────────────────────────────────────────
 *
 * `common/payments/duplicate-payment-window.db.spec.ts` äger MEKANIKEN — vad
 * som räknas som en dubblett, mot riktig Postgres. Den här filen äger
 * PÅKOPPLINGEN: att betalvägen konsulterar den alls, att den gör det innanför
 * transaktionen, och att ett utslag stoppar skrivningen i stället för att bara
 * logga.
 *
 * Delningen är inte kosmetisk. En mekanik som fungerar men inte är inkopplad
 * ser precis ut som en mekanik som är inkopplad: båda ger gröna prov, och bara
 * det ena skyddar något.
 *
 * ── VARFÖR "INNANFÖR TRANSAKTIONEN" ÄR ETT EGET PROV ────────────────────────
 *
 * `markAsPaidManually` tar `SELECT … FOR UPDATE` på fakturan först. Ställs
 * frågan mot `tx` serialiseras två samtidiga registreringar och den andra ser
 * den förstas rad. Ställs den mot den YTTRE klienten är den en läsning före en
 * skrivning, och två samtidiga anrop passerar båda — samma defekt som #597,
 * och osynlig i ett sekventiellt prov.
 *
 * Attrappen ger därför `tx` och `prisma` SKILDA mockar. En attrapp där
 * `tx === prisma` kan per konstruktion inte skilja de två fallen åt.
 */
jest.mock('./pdf.service', () => ({ PdfService: class {} }))
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { ConflictException } from '@nestjs/common'
import { Prisma } from '@prisma/client'

import { InvoicesService } from './invoices.service'

const TOTAL = 20_000
const DELBETALNING = 5_000

function makeService(opts: { nyligenIdentisk?: boolean } = {}) {
  const invoiceRow = {
    id: 'inv-1',
    status: 'SENT',
    invoiceNumber: 'F-2026-0001',
    total: new Prisma.Decimal(TOTAL),
  }

  const träff = opts.nyligenIdentisk
    ? {
        id: 'alloc-tidigare',
        amount: new Prisma.Decimal(DELBETALNING),
        createdAt: new Date(Date.now() - 20_000),
      }
    : null

  const txFindFirst = jest.fn().mockResolvedValue(träff)
  const txCreate = jest.fn().mockResolvedValue({ id: 'alloc-1' })
  // Den YTTRE klientens findFirst ska aldrig användas för den här frågan.
  // Returnerar den `null` skulle en felplacerad kontroll se ut att fungera —
  // därför får den kasta i stället, så ett felplacerat anrop blir synligt.
  const yttreFindFirst = jest.fn(() => {
    throw new Error('Dubblettfrågan ställdes UTANFÖR transaktionen — låset skyddar den inte då.')
  })

  const tx = {
    invoice: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(invoiceRow),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    invoicePayment: {
      findFirst: txFindFirst,
      findMany: jest.fn().mockResolvedValue([]),
      create: txCreate,
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    $queryRaw: jest.fn().mockResolvedValue([]),
  }

  const prisma = {
    invoice: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(invoiceRow),
      findFirstOrThrow: jest.fn().mockResolvedValue(invoiceRow),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    invoicePayment: {
      findFirst: yttreFindFirst,
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    $transaction: undefined as unknown as jest.Mock,
    $queryRaw: jest.fn().mockResolvedValue([]),
  }
  prisma.$transaction = jest.fn((cb: (t: unknown) => unknown) => cb(tx))

  const service = new InvoicesService(
    prisma as never,
    { record: jest.fn().mockResolvedValue(undefined) } as never,
    {} as never,
    {} as never,
    {
      createJournalEntryForInvoiceManualPayment: jest.fn().mockResolvedValue({ id: 'je-1' }),
    } as never,
    { createForAllOrgUsers: jest.fn().mockResolvedValue(undefined) } as never,
    {} as never,
    {} as never,
  )

  const betala = () =>
    service.markAsPaidManually('inv-1', 'org-1', 'BANK', 'user-1', 'USER', {
      enteredAmount: DELBETALNING,
    })

  return { betala, txFindFirst, txCreate, yttreFindFirst, tx }
}

describe('markAsPaidManually — påkopplingen av dubblettfönstret', () => {
  it('FRÅGAR fönstret, och frågar INNANFÖR transaktionen', async () => {
    const { betala, txFindFirst, yttreFindFirst } = makeService()
    await betala()

    expect(txFindFirst).toHaveBeenCalledTimes(1)
    expect(yttreFindFirst).not.toHaveBeenCalled()
  })

  it('frågan är avgränsad till fakturan, beloppet, MANUAL och ett tidsfönster', async () => {
    // Alla fyra villkoren måste vara med. Tappas beloppet blockerar varje ny
    // delbetalning; tappas tidsfönstret blockerar en betalning från i fjol;
    // tappas källan blockerar en bankmatchad rad en manuell registrering.
    const { betala, txFindFirst } = makeService()
    await betala()

    const where = txFindFirst.mock.calls[0]![0].where as {
      invoiceId: string
      amount: Prisma.Decimal
      source: string
      createdAt: { gt: Date }
    }
    expect(where.invoiceId).toBe('inv-1')
    expect(new Prisma.Decimal(where.amount).toNumber()).toBe(DELBETALNING)
    expect(where.source).toBe('MANUAL')
    expect(where.createdAt.gt).toBeInstanceOf(Date)
    expect(Date.now() - where.createdAt.gt.getTime()).toBeGreaterThan(0)
  })

  it('en träff STOPPAR skrivningen — den loggas inte bara', async () => {
    const { betala, txCreate } = makeService({ nyligenIdentisk: true })

    await expect(betala()).rejects.toBeInstanceOf(ConflictException)
    // Det här är skillnaden mellan en spärr och en varning.
    expect(txCreate).not.toHaveBeenCalled()
  })

  it('MOTPROV: utan träff går betalningen igenom — spärren fäller inte allt', async () => {
    const { betala, txCreate } = makeService()
    await expect(betala()).resolves.toBeDefined()
    expect(txCreate).toHaveBeenCalledTimes(1)
  })
})
