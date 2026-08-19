/**
 * #363 — påminnelseavgiften måste flytta `subtotal` tillsammans med `total`.
 *
 * INVARIANTEN SOM BRÖTS är inte påhittad här; den står nedskriven i
 * `invoices.service.ts` (`computeInvoiceAmounts`): "Σ rader = total" och
 * "subtotal + moms = total" ska alltid hålla EXAKT. Faktura-PDF:en skriver ut
 * alla tre som egna poster:
 *
 *     Netto exkl. moms   ${subtotal}
 *     Moms               ${vatTotal}
 *     Att betala         ${total}
 *
 * Påminnelsevägen räknade bara upp `total`. Efter en formell påminnelse
 * summerade de två första därför inte längre till den tredje — de skiljde exakt
 * avgiftsbeloppet. Ett dokument som inte går ihop aritmetiskt, i handen på
 * hyresgästen.
 *
 * VARFÖR `vatTotal` INTE SKA RÖRAS: avgiftsraden skrivs med `vatRate: 0`
 * (payment-reminder.service.ts) och bokförs 1510 D / 3593 K utan momskonto.
 * Avgiften är alltså momsfri, och hela beloppet hör till nettot. Rör man
 * `vatTotal` bryter man invarianten i andra riktningen.
 *
 * TRE YTOR, inte en. Avgiften läggs på ett ställe och tas bort på två:
 *
 *   1. PaymentReminderService.sendFormalReminder  — `increment` (lägger på)
 *   2. InvoicesService.transitionStatus → VOID     — `decrement` (makulering)
 *   3. InvoicesService.reverseReminderFee          — absolut (strykning)
 *
 * Yta 2 och 3 är syskonparet: en fix som bara lagar påläggningen lämnar
 * borttagningen skev åt andra hållet, och felet hade blivit osynligt eftersom
 * det bara uppstår efter en makulering. (Läxan från #326.)
 *
 * DISKRIMINERANDE DATA: momsen (1 800) är varken lika med avgiften (60) eller
 * med nettot (7 200), och avgiften är inte en jämn andel av något av dem. Vore
 * talen släktingar kunde testet inte se VILKET fält som rörts.
 *
 * VAD DE HÄR TESTERNA INTE BEVISAR: att databasen faktiskt hamnar i det
 * tillståndet. `$transaction` är en attrapp och kan inte rulla tillbaka något.
 * De bevakar att koden fortsätter BEGÄRA rätt skrivning — samma avgränsning som
 * payment-reminder-fee-atomicity.spec.ts anger för sin del.
 */

jest.mock('./pdf.service', () => ({ PdfService: class {} }))
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { Prisma } from '@prisma/client'

import { InvoicesService } from './invoices.service'
import { PaymentReminderService } from '../notifications/payment-reminder.service'
import { REMINDER_FEE_LINE_DESCRIPTION } from './reminder-fee-line'

const INVOICE_ID = 'inv-1'
// 7 200 netto + 1 800 moms (25 %) = 9 000. Momspliktig lokalhyra med frivillig
// skattskyldighet — fallet där en felaktig momsbas är ett innehållsfel i
// fakturan, inte bara kosmetik.
const SUBTOTAL = 7200
const VAT_TOTAL = 1800
const TOTAL = 9000
const AVGIFT = 60

// ── Yta 1: påläggningen ──────────────────────────────────────────────────────

function makeReminderService() {
  const invoice = {
    id: INVOICE_ID,
    organizationId: 'org-1',
    invoiceNumber: 'F-2026-000001',
    total: TOTAL,
    subtotal: SUBTOTAL,
    vatTotal: VAT_TOTAL,
    dueDate: new Date('2026-05-01'),
    ocrNumber: '1234567',
    payments: [],
    creditNotes: [],
    paymentReminders: [],
    issueDate: new Date('2026-05-01'),
    lease: { reminderFeeTermsFrom: new Date('2020-01-01') },
    tenant: { type: 'INDIVIDUAL', firstName: 'Hyres', lastName: 'Gäst', email: 'hg@example.se' },
    customer: null,
    organization: {
      id: 'org-1',
      name: 'Värd AB',
      remindersEnabled: true,
      reminderFeeSek: AVGIFT,
      reminderFormalDay: 14,
      reminderCollectionDay: 30,
      bankgiro: '123-4567',
    },
  }

  const invoiceUpdateMany = jest.fn().mockResolvedValue({ count: 1 })
  const txClient = {
    paymentReminder: {
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    invoiceLine: { create: jest.fn().mockResolvedValue({ id: 'line-1' }) },
    invoice: {
      update: jest.fn().mockResolvedValue(invoice),
      updateMany: invoiceUpdateMany,
      findMany: jest.fn().mockResolvedValue([invoice]),
    },
    invoiceEvent: { create: jest.fn().mockResolvedValue({ id: 'ev-1' }) },
  }
  const prisma = {
    invoice: { findMany: jest.fn().mockResolvedValue([invoice]) },
    // Skrivs EFTER commit (messageId på markören) — ligger avsiktligt utanför
    // transaktionen i produktionskoden, så attrappen måste ha den här också.
    paymentReminder: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    $transaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(txClient)),
  }

  // Konstruktorordning: prisma, mail, notifications, accounting.
  const service = new PaymentReminderService(
    prisma as never,
    { sendReminderFormal: jest.fn().mockResolvedValue('msg-1') } as never,
    { createForAllOrgUsers: jest.fn(), create: jest.fn() } as never,
    { bookReminderFee: jest.fn().mockResolvedValue({ id: 'je-1' }) } as never,
  )

  return { service, invoice, invoiceUpdateMany }
}

/** Kör den privata sendFormalReminder direkt — cron-urvalet är inte det som mäts. */
async function kör(h: ReturnType<typeof makeReminderService>): Promise<void> {
  const priv = h.service as unknown as {
    sendFormalReminder: (inv: unknown, email: string, days: number) => Promise<void>
  }
  await priv.sendFormalReminder(h.invoice, 'hg@example.se', 20)
}

// ── Yta 2 + 3: borttagningen ─────────────────────────────────────────────────

function makeInvoicesService() {
  const invoiceRow = {
    id: INVOICE_ID,
    status: 'OVERDUE',
    invoiceNumber: 'F-2026-0001',
    total: new Prisma.Decimal(TOTAL + AVGIFT),
    subtotal: new Prisma.Decimal(SUBTOTAL + AVGIFT),
    vatTotal: new Prisma.Decimal(VAT_TOTAL),
  }
  const feeLines = [{ id: 'line-fee', total: AVGIFT }]

  const invoiceUpdate = jest.fn().mockResolvedValue(invoiceRow)
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    invoice: { findFirst: jest.fn().mockResolvedValue(invoiceRow), update: invoiceUpdate },
    invoicePayment: { findMany: jest.fn().mockResolvedValue([]) },
    invoiceLine: {
      findMany: jest.fn((args: { where: { description?: string } }) =>
        Promise.resolve(
          args.where.description === REMINDER_FEE_LINE_DESCRIPTION
            ? feeLines
            : // Yta 3 härleder totalen ur de KVARVARANDE raderna: hyresraden
              // (9 000 brutto) finns kvar när avgiftsraden är borta.
              [{ total: new Prisma.Decimal(TOTAL) }],
        ),
      ),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    consumptionCharge: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    deposit: { findFirst: jest.fn().mockResolvedValue(null) },
  }
  // Yta 3 läser fakturan UTANFÖR transaktionen innan den stryker avgiften.
  // Fakturan bär två rader: hyran (9 000 brutto) och avgiften (60, momsfri).
  const prisma = {
    invoice: {
      findFirst: jest.fn().mockResolvedValue({
        ...invoiceRow,
        lines: [
          { id: 'line-rent', description: 'Hyra maj 2026', total: new Prisma.Decimal(TOTAL) },
          {
            id: 'line-fee',
            description: REMINDER_FEE_LINE_DESCRIPTION,
            total: new Prisma.Decimal(AVGIFT),
          },
        ],
        payments: [],
        creditNotes: [],
      }),
    },
    $transaction: jest.fn((cb: (t: unknown) => unknown) => cb(tx)),
  }

  const service = new InvoicesService(
    prisma as never,
    { record: jest.fn().mockResolvedValue(undefined) } as never,
    {} as never,
    {} as never,
    {
      reverseJournalEntryForInvoice: jest.fn().mockResolvedValue(undefined),
      reverseJournalEntryForReminderFee: jest.fn().mockResolvedValue(undefined),
      reverseJournalEntryForDepositAccrual: jest.fn().mockResolvedValue(undefined),
    } as never,
    { createForAllOrgUsers: jest.fn().mockResolvedValue(undefined) } as never,
    {} as never,
    {} as never,
  )

  return { service, invoiceUpdate }
}

/** Det `invoice.update`/`updateMany`-anrop som rör beloppen — inte statusflippen. */
function beloppsSkrivning(mock: jest.Mock): Record<string, unknown> | undefined {
  for (const call of mock.mock.calls) {
    const arg = call[0] as { data?: Record<string, unknown> }
    if (arg.data && ('total' in arg.data || 'subtotal' in arg.data)) return arg.data
  }
  return undefined
}

const relativt = (v: unknown): number | undefined => {
  const d = v as { increment?: Prisma.Decimal; decrement?: Prisma.Decimal } | undefined
  if (d?.increment != null) return Number(d.increment)
  if (d?.decrement != null) return Number(d.decrement)
  return undefined
}

describe('#363 · yta 1 — påläggningen flyttar subtotal med total', () => {
  it('subtotal räknas upp med EXAKT avgiften, tillsammans med total', async () => {
    const h = makeReminderService()
    const { invoiceUpdateMany } = h

    await kör(h)

    const data = beloppsSkrivning(invoiceUpdateMany)
    expect(data).toBeDefined()
    expect(relativt(data!['total'])).toBe(AVGIFT)
    // Utan den här raden summerar PDF:ens tre poster inte längre.
    expect(relativt(data!['subtotal'])).toBe(AVGIFT)
  })

  it('vatTotal rörs INTE — avgiften är momsfri (vatRate 0, konto 3593)', async () => {
    const h = makeReminderService()
    const { invoiceUpdateMany } = h

    await kör(h)

    const data = beloppsSkrivning(invoiceUpdateMany)
    expect(data).toBeDefined()
    expect(data!['vatTotal']).toBeUndefined()
  })

  it('INVARIANTEN: subtotal + vatTotal = total efter påläggningen', async () => {
    const h = makeReminderService()
    const { invoiceUpdateMany } = h

    await kör(h)

    const data = beloppsSkrivning(invoiceUpdateMany)!
    const nySubtotal = SUBTOTAL + (relativt(data['subtotal']) ?? 0)
    const nyTotal = TOTAL + (relativt(data['total']) ?? 0)
    expect(nySubtotal + VAT_TOTAL).toBe(nyTotal)
  })
})

describe('#363 · yta 2 — VOID drar av subtotal med total', () => {
  it('subtotal minskas med EXAKT avgiften när avgiftsraden plockas bort', async () => {
    const { service, invoiceUpdate } = makeInvoicesService()

    await service.transitionStatus(INVOICE_ID, 'org-1', 'VOID', 'user-1', 'USER')

    const data = beloppsSkrivning(invoiceUpdate)
    expect(data).toBeDefined()
    expect(relativt(data!['total'])).toBe(AVGIFT)
    expect(relativt(data!['subtotal'])).toBe(AVGIFT)
    // Diskriminerande: avgiften, inte totalen.
    expect(relativt(data!['subtotal'])).not.toBe(TOTAL)
  })
})

describe('#363 · yta 3 — strykning av avgiften drar av subtotal', () => {
  it('total härleds ur kvarvarande rader OCH subtotal minskas med avgiften', async () => {
    const { service, invoiceUpdate } = makeInvoicesService()

    await service.reverseReminderFee(
      INVOICE_ID,
      'org-1',
      'Avgiften togs på felaktig grund',
      'user-1',
    )

    const data = beloppsSkrivning(invoiceUpdate)
    expect(data).toBeDefined()
    // Totalen sätts ABSOLUT ur raderna: hyresraden 9 000 är allt som är kvar.
    expect(Number(data!['total'])).toBe(TOTAL)
    // Nettot räknas RELATIVT — se kommentaren i invoices.service.ts.
    expect(relativt(data!['subtotal'])).toBe(AVGIFT)
    expect(data!['vatTotal']).toBeUndefined()
  })

  it('INVARIANTEN: subtotal + vatTotal = total efter strykningen', async () => {
    const { service, invoiceUpdate } = makeInvoicesService()

    await service.reverseReminderFee(
      INVOICE_ID,
      'org-1',
      'Avgiften togs på felaktig grund',
      'user-1',
    )

    const data = beloppsSkrivning(invoiceUpdate)!
    // Utgångsläget är fakturan MED avgift: netto 7 260, moms 1 800, total 9 060.
    const nySubtotal = SUBTOTAL + AVGIFT - (relativt(data['subtotal']) ?? 0)
    expect(nySubtotal + VAT_TOTAL).toBe(Number(data['total']))
  })
})
