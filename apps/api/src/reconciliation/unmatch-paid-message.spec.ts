/**
 * #519 — PAID-SPÄRRENS MEDDELANDE FÅR INTE PEKA PÅ EN VÄG SOM INTE FINNS.
 *
 * Spärren själv är riktig och rörs inte: `PAID` är terminal i statusmaskinen,
 * och den bokförda allokeringen ligger kvar. Det som var fel var TEXTEN — den
 * sa "Skapa en kreditnota för att häva betalningen" mot ett flöde som inte
 * existerar (`'invoice.credit_note_created'` är deklarerad utan en enda
 * skrivare; underlaget ligger i #517, byggt är det inte).
 *
 * VAD DET HÄR TESTET SKYDDAR MOT, precist: att någon återinför en HÄNVISNING
 * till kreditnota som ÅTGÄRD. Det är avsiktligt inte ett förbud mot ordet —
 * meddelandet nämner kreditfakturan, och ska få göra det, så länge den beskrivs
 * som obyggd i stället för som en knapp att trycka på. Skillnaden mellan de två
 * är hela poängen med ärendet, så det är den skillnaden testet mäter.
 *
 * Bevisar:
 *   • PAID nekas, med rätt feltyp, och INGENTING skrivs
 *   • meddelandet konstaterar att vägen saknas
 *   • meddelandet innehåller ingen uppmaning att skapa/använda en kreditnota
 *   • spärren är PAID-specifik — en PARTIAL-faktura passerar den
 */

jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { BadRequestException } from '@nestjs/common'
import { Decimal } from '@prisma/client/runtime/library'
import { ReconciliationService } from './reconciliation.service'
import { InvoiceEventsService } from '../invoices/invoice-events.service'

/**
 * UPPMANINGEN, inte ordet. Varje form som gör kreditnotan till något
 * operatören ska GÖRA — det är den klass av mening som ärendet handlar om.
 */
const UPPMANING_OM_KREDITNOTA =
  /(skapa|utfärda|använd|gör|lägg upp|registrera|via|genom)\s+(en\s+|ett\s+|den\s+)?kredit(nota|faktura)/i

function makeService(transaction: unknown) {
  const outerInvoice = (transaction as { invoice?: { status: string } })?.invoice
  const tx = {
    rentNoticeEvent: { create: jest.fn().mockResolvedValue({}) },
    rentNotice: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    bankTransaction: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    // #518 — krediteringarna läses på samma vägar som allokeringarna.
    rentNoticeCredit: { findMany: jest.fn().mockResolvedValue([]) },
    rentNoticePayment: {
      findFirst: jest.fn().mockResolvedValue(null),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    $queryRaw: jest.fn().mockResolvedValue([]),
    invoice: {
      findFirst: jest.fn().mockResolvedValue(outerInvoice ? { ...outerInvoice } : null),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    invoicePayment: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'ip-1',
        invoiceId: 'inv-paid',
        amount: new Decimal(3000),
        paidAt: new Date('2026-07-20'),
        source: 'BANK_RECONCILIATION',
      }),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    invoiceEvent: {
      findMany: jest.fn().mockResolvedValue([{ payload: { previousStatus: 'SENT' } }]),
      create: jest.fn().mockResolvedValue({}),
    },
    user: { findUnique: jest.fn().mockResolvedValue(null) },
  }
  const $transaction = jest.fn((cb: (t: unknown) => unknown) => cb(tx))
  const prisma = {
    bankTransaction: {
      findFirst: jest.fn().mockResolvedValue(transaction),
      updateMany: tx.bankTransaction.updateMany,
    },
    rentNotice: { updateMany: tx.rentNotice.updateMany },
    $transaction,
  }
  const service = new ReconciliationService(
    prisma as never,
    {} as never,
    new InvoiceEventsService(prisma as never) as never,
    { reverseJournalEntryForPayment: jest.fn().mockResolvedValue(undefined) } as never,
    {} as never,
    { record: jest.fn().mockResolvedValue({}) } as never,
  )
  return { service, tx, $transaction }
}

/** Diskriminerande: statusen är den ENDA skillnaden mot PARTIAL_TX nedan. */
const PAID_TX = {
  id: 'tx-paid',
  status: 'MATCHED',
  invoice: { id: 'inv-paid', status: 'PAID', invoiceNumber: 'F-2026-0519' },
  matchedRentNotice: null,
}

const PARTIAL_TX = {
  id: 'tx-partial',
  status: 'MATCHED',
  invoice: { id: 'inv-partial', status: 'PARTIAL', invoiceNumber: 'F-2026-0520' },
  matchedRentNotice: null,
}

async function fångaFel(service: ReconciliationService, txId: string) {
  return service
    .unmatchTransaction(txId, 'org-1', 'user-1')
    .then(() => null)
    .catch((e: unknown) => e as Error)
}

describe('#519 — avmatchning av betald faktura: meddelandet', () => {
  it('nekas med 400, och ingenting skrivs (spärren ligger före $transaction)', async () => {
    const { service, $transaction } = makeService(PAID_TX)

    const err = await fångaFel(service, 'tx-paid')

    expect(err).toBeInstanceOf(BadRequestException)
    expect($transaction).not.toHaveBeenCalled()
  })

  it('säger att vägen saknas i dag — inte bara att åtgärden nekas', async () => {
    const { service } = makeService(PAID_TX)

    const message = String((await fångaFel(service, 'tx-paid'))?.message)

    expect(message).toContain('kan inte avmatchas')
    expect(message).toMatch(/ingen väg att häva en betald faktura/i)
    expect(message).toMatch(/ännu inte byggd/i)
  })

  it('innehåller INGEN uppmaning att skapa eller använda en kreditnota', async () => {
    const { service } = makeService(PAID_TX)

    const message = String((await fångaFel(service, 'tx-paid'))?.message).replace(/\s+/g, ' ')

    expect(message).not.toMatch(UPPMANING_OM_KREDITNOTA)
  })

  it('mönstret fäller faktiskt den gamla texten (kanariefågel)', () => {
    // Utan den här raden kan reguljäruttrycket sluta matcha vad som helst —
    // och då blir testet ovan grönt för att det inte mäter något.
    expect('Skapa en kreditnota för att häva betalningen.').toMatch(UPPMANING_OM_KREDITNOTA)
    expect('Använd kreditfaktura i stället.').toMatch(UPPMANING_OM_KREDITNOTA)
    // ... men fäller INTE en text som bara konstaterar att den inte finns.
    expect('Kreditfaktura är den avsedda lösningen, men den är ännu inte byggd.').not.toMatch(
      UPPMANING_OM_KREDITNOTA,
    )
  })

  it('spärren är PAID-specifik — PARTIAL passerar den', async () => {
    const { service } = makeService(PARTIAL_TX)

    const err = await fångaFel(service, 'tx-partial')

    // PARTIAL kan falla av andra skäl i attrappen; det som bevisas är att den
    // inte fastnar i PAID-spärren.
    expect(String(err?.message ?? '')).not.toContain('kan inte avmatchas')
  })
})
