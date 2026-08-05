/**
 * #307 C — DELBETALNING MOT EN INKASSOFAKTURA FÅR INTE LÄMNA INKASSOTILLSTÅNDET.
 *
 * Tre defekter, en gemensam orsak: målstatusen räknades ut på var sitt håll,
 * bredvid statusmaskinen, och ingen av uträkningarna kände till att
 * SENT_TO_COLLECTION är ett tillstånd man inte glider ur genom att betala lite.
 *
 *   a) reconciliation — `data: { status: 'PARTIAL' }` rakt av, med
 *      SENT_TO_COLLECTION i WHERE-tillåtlistan.
 *   b) markAsPaidManually — validerade `isValidTransition(status, 'PAID')` men
 *      skrev `completesInvoice ? 'PAID' : 'PARTIAL'`. Från SENT_TO_COLLECTION
 *      passerade kontrollen (→ PAID ÄR giltig) och koden skrev PARTIAL, som inte
 *      är det. En validering som mäter en annan sak än den utför.
 *   c) reconciliation — `previousStatus: 'SENT'` HÅRDKODAT i händelseloggen.
 *
 * SKADAN: statusen flippade men `remindersPaused` (true) och `sentToCollectionAt`
 * stod kvar från överlämningen. Raden blev internt motsägelsefull och fordran
 * osynlig i BÅDA riktningarna — inkassovyn kräver OVERDUE/SENT_TO_COLLECTION,
 * påminnelsecronen kräver OVERDUE med remindersPaused=false, och Invoice har
 * ingen collectionStage-stege som fångar upp den. Skulden slutade jagas, tyst.
 *
 * VAD TESTERNA MÄTER. Utfallet på raden — vilken status som SKREVS, vad
 * händelseloggen SÄGER, och att pausfälten inte rörs — inte att en operation
 * blev anropad. Ett test som bara hävdar `updateMany` kördes hade varit grönt
 * genom hela defektens livstid.
 */

jest.mock('./pdf.service', () => ({ PdfService: class {} }))
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { Prisma } from '@prisma/client'
import { INVOICE_TRANSITIONS, isValidTransition } from '@eken/shared'
import { InvoicesService } from './invoices.service'
import { ReconciliationService } from '../reconciliation/reconciliation.service'
import { paymentTargetStatus, isPaymentTransitionAllowed } from './invoice-payment-status'
import type { InvoiceStatus } from '@prisma/client'

const TOTAL = 10_000

// ── Attrapper ────────────────────────────────────────────────────────────────

function makeInvoicesService(opts: { status: InvoiceStatus; priorAllocations?: number[] }) {
  const priors = opts.priorAllocations ?? []
  const invoiceRow = {
    id: 'inv-1',
    status: opts.status,
    invoiceNumber: 'F-2026-0001',
    total: new Prisma.Decimal(TOTAL),
  }
  const allocations = priors.map((a, i) => ({
    id: `prior-${i + 1}`,
    amount: new Prisma.Decimal(a),
  }))
  const updateMany = jest.fn().mockResolvedValue({ count: 1 })
  const tx = {
    invoice: { findFirst: jest.fn().mockResolvedValue(invoiceRow), updateMany },
    invoicePayment: {
      findMany: jest.fn(() => Promise.resolve(allocations.map((a) => ({ ...a })))),
      create: jest.fn((arg: { data: { amount: Prisma.Decimal } }) => {
        const rad = { id: `alloc-${allocations.length + 1}`, amount: arg.data.amount }
        allocations.push(rad)
        return Promise.resolve(rad)
      }),
    },
    $queryRaw: jest.fn().mockResolvedValue([]),
  }
  const prisma = {
    invoice: { findFirstOrThrow: jest.fn().mockResolvedValue(invoiceRow) },
    $transaction: undefined as unknown as jest.Mock,
  }
  prisma.$transaction = jest.fn((cb: (t: unknown) => unknown) => cb(tx))
  const eventsService = { record: jest.fn().mockResolvedValue(undefined) }

  const service = new InvoicesService(
    prisma as never,
    eventsService as never,
    {} as never,
    {} as never,
    {
      createJournalEntryForInvoiceManualPayment: jest.fn().mockResolvedValue({ id: 'je-1' }),
    } as never,
    { createForAllOrgUsers: jest.fn().mockResolvedValue(undefined) } as never,
    {} as never,
    {} as never,
  )
  return { service, tx, updateMany, eventsService }
}

function makeReconciliation(opts: { status: InvoiceStatus; priorAllocations?: number[] }) {
  const dec = (n: number | string) => new Prisma.Decimal(n)
  const updateMany = jest.fn().mockResolvedValue({ count: 1 })
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    bankTransaction: { update: jest.fn().mockResolvedValue({}) },
    deposit: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    invoicePayment: {
      findMany: jest
        .fn()
        .mockResolvedValue((opts.priorAllocations ?? []).map((a) => ({ amount: dec(a) }))),
      create: jest.fn().mockResolvedValue({}),
    },
    invoice: {
      findFirst: jest.fn().mockResolvedValue({ status: opts.status, invoiceNumber: 'F-2026-0001' }),
      updateMany,
    },
  }
  const events = { record: jest.fn().mockResolvedValue(undefined) }
  const claimPaidWithinTx = jest
    .fn()
    .mockResolvedValue({ claimed: true, invoiceNumber: 'F-2026-0001' })
  const service = new ReconciliationService(
    { $transaction: jest.fn((cb: (t: unknown) => unknown) => cb(tx)) } as never,
    { claimPaidWithinTx, notifyInvoicePaid: jest.fn() } as never,
    events as never,
    { createJournalEntryForPayment: jest.fn().mockResolvedValue({ id: 'je-1' }) } as never,
    {} as never,
    { record: jest.fn().mockResolvedValue({}) } as never, // #326 C — RentNoticeEventsService
  )
  const applyMatch = (amount: number, allowPartial = true): Promise<boolean> =>
    (
      service as unknown as { applyMatchToInvoice: (...a: unknown[]) => Promise<boolean> }
    ).applyMatchToInvoice(
      'tx-1',
      'inv-1',
      'org-1',
      dec(TOTAL),
      dec(amount),
      new Date('2026-06-15'),
      'user-1',
      null,
      allowPartial,
    )
  return { applyMatch, tx, updateMany, events, claimPaidWithinTx }
}

/** Statusen som FAKTISKT skrevs till raden. */
const writtenStatus = (updateMany: jest.Mock): unknown =>
  (updateMany.mock.calls[0]?.[0] as { data: { status: unknown } } | undefined)?.data?.status

/** Hela `data`-objektet — för att kunna hävda vad som INTE rörs. */
const writtenData = (updateMany: jest.Mock): Record<string, unknown> =>
  (updateMany.mock.calls[0]?.[0] as { data: Record<string, unknown> }).data

// ── A. Den delade källan ─────────────────────────────────────────────────────

describe('#307 C · A: paymentTargetStatus — en källa för validering och skrivning', () => {
  const ALLA = Object.keys(INVOICE_TRANSITIONS) as InvoiceStatus[]

  it('full betalning ger alltid PAID', () => {
    for (const status of ALLA) {
      expect(paymentTargetStatus(status, true)).toBe('PAID')
    }
  })

  it('delbetalning ger PARTIAL — UTOM från SENT_TO_COLLECTION, som behålls', () => {
    for (const status of ALLA) {
      expect(paymentTargetStatus(status, false)).toBe(
        status === 'SENT_TO_COLLECTION' ? 'SENT_TO_COLLECTION' : 'PARTIAL',
      )
    }
  })

  it('självövergången är tillåten utan att finnas som kant i tabellen', () => {
    // Den ska INTE läggas till i INVOICE_TRANSITIONS — att stå kvar är ingen övergång.
    expect(isValidTransition('SENT_TO_COLLECTION', 'SENT_TO_COLLECTION')).toBe(false)
    expect(isPaymentTransitionAllowed('SENT_TO_COLLECTION', 'SENT_TO_COLLECTION')).toBe(true)
  })

  it('självövergången är HÄRLEDD — bara de mål en betalning kan landa på', () => {
    // Granskningsfyndet: ett rakt `target === current → true` hade släppt igenom
    // varje status mot sig själv. Bara de två som paymentTargetStatus faktiskt
    // producerar får passera.
    for (const status of ALLA) {
      expect(isPaymentTransitionAllowed(status, status)).toBe(
        status === 'PARTIAL' || status === 'SENT_TO_COLLECTION',
      )
    }
    // Och de två är precis de som bevaras av uträkningen — inte en egen lista.
    for (const status of ALLA) {
      expect(isPaymentTransitionAllowed(status, status)).toBe(
        paymentTargetStatus(status, false) === status,
      )
    }
  })

  it('varje ÄKTA övergång valideras mot statusmaskinen — ingen genväg', () => {
    for (const from of ALLA) {
      for (const to of ALLA) {
        if (to === from) continue
        expect(isPaymentTransitionAllowed(from, to)).toBe(isValidTransition(from, to))
      }
    }
  })

  it('den gamla tillåtlistan reproduceras — härledd, inte handskriven', () => {
    // reconciliation hade `in ['SENT','PARTIAL','OVERDUE','SENT_TO_COLLECTION']`.
    // Samma mängd faller nu ut ur tabellen, utan att stå uppräknad någonstans.
    const slapperIgenom = ALLA.filter((s) =>
      isPaymentTransitionAllowed(s, paymentTargetStatus(s, false)),
    )
    expect(slapperIgenom.sort()).toEqual(['OVERDUE', 'PARTIAL', 'SENT', 'SENT_TO_COLLECTION'])
  })
})

// ── B. markAsPaidManually (defekt b) ─────────────────────────────────────────

describe('#307 C · B: markAsPaidManually behåller inkassostatusen vid delbetalning', () => {
  it('delbetalning mot SENT_TO_COLLECTION → statusen BEHÅLLS', async () => {
    const { service, updateMany } = makeInvoicesService({ status: 'SENT_TO_COLLECTION' })

    await service.markAsPaidManually('inv-1', 'org-1', 'BANK', 'user-1', 'USER', {
      enteredAmount: 3_000,
    })

    expect(writtenStatus(updateMany)).toBe('SENT_TO_COLLECTION')
  })

  it('raden kan inte bli internt motsägelsefull — status OCH pausfält hänger ihop', async () => {
    const { service, updateMany } = makeInvoicesService({ status: 'SENT_TO_COLLECTION' })

    await service.markAsPaidManually('inv-1', 'org-1', 'BANK', 'user-1', 'USER', {
      enteredAmount: 3_000,
    })

    // ⚠️ ASSERTIONEN MÄTER KONJUNKTIONEN, INTE BARA FÄLTEN. En första version
    // hävdade enbart att pausfälten inte skrivs — och var grön ÄVEN MED DEFEKTEN,
    // eftersom den gamla koden inte heller rörde dem. Den skrev fel STATUS och lät
    // fälten stå kvar; det var just kombinationen som gjorde raden motsägelsefull.
    // Ett test som inte kan falla för buggen det beskriver är ingen mätning.
    const data = writtenData(updateMany)
    expect(data['status']).toBe('SENT_TO_COLLECTION')
    // …och eftersom statusen står kvar förblir pausfälten korrekta genom att inte röras.
    expect(data).not.toHaveProperty('remindersPaused')
    expect(data).not.toHaveProperty('remindersPausedAt')
    expect(data).not.toHaveProperty('sentToCollectionAt')
    // paidAt sätts inte heller — fakturan är inte betald.
    expect(data).not.toHaveProperty('paidAt')
  })

  it('FULL betalning mot SENT_TO_COLLECTION → PAID (kanten är giltig och ska fungera)', async () => {
    const { service, updateMany } = makeInvoicesService({ status: 'SENT_TO_COLLECTION' })

    await service.markAsPaidManually('inv-1', 'org-1', 'BANK', 'user-1', 'USER', {
      enteredAmount: TOTAL,
    })

    expect(writtenStatus(updateMany)).toBe('PAID')
    expect(writtenData(updateMany)).toHaveProperty('paidAt')
  })

  it('claimen nyckas på utgångsstatusen — validerad och utförd övergång är samma', async () => {
    const { service, updateMany } = makeInvoicesService({ status: 'SENT_TO_COLLECTION' })

    await service.markAsPaidManually('inv-1', 'org-1', 'BANK', 'user-1', 'USER', {
      enteredAmount: 3_000,
    })

    const where = (updateMany.mock.calls[0]![0] as { where: Record<string, unknown> }).where
    expect(where['status']).toBe('SENT_TO_COLLECTION')
  })

  it('händelseloggen bär samma målstatus som skrevs', async () => {
    const { service, updateMany, eventsService } = makeInvoicesService({
      status: 'SENT_TO_COLLECTION',
    })

    await service.markAsPaidManually('inv-1', 'org-1', 'BANK', 'user-1', 'USER', {
      enteredAmount: 3_000,
    })

    const payload = eventsService.record.mock.calls[0]![4] as Record<string, unknown>
    expect(payload['previousStatus']).toBe('SENT_TO_COLLECTION')
    expect(payload['newStatus']).toBe(writtenStatus(updateMany))
  })

  it('oförändrat för vanliga fakturor: SENT + delbetalning → PARTIAL', async () => {
    const { service, updateMany } = makeInvoicesService({ status: 'SENT' })
    await service.markAsPaidManually('inv-1', 'org-1', 'BANK', 'user-1', 'USER', {
      enteredAmount: 3_000,
    })
    expect(writtenStatus(updateMany)).toBe('PARTIAL')
  })

  it.each(['DRAFT', 'VOID'] as InvoiceStatus[])(
    '%s avvisas — och felet namnger den övergång som FAKTISKT prövades',
    async (status) => {
      const { service, updateMany } = makeInvoicesService({ status })
      await expect(
        service.markAsPaidManually('inv-1', 'org-1', 'BANK', 'user-1', 'USER', {
          enteredAmount: 3_000,
        }),
        // → PARTIAL, inte → PAID: meddelandet speglar delbetalningen som prövades.
      ).rejects.toThrow(new RegExp(`${status} → PARTIAL`))
      expect(updateMany).not.toHaveBeenCalled()
    },
  )
})

// ── C. Divergensbeviset (defekt b, strukturellt) ─────────────────────────────

describe('#307 C · C: validering och skrivning kan inte divergera igen', () => {
  const PAYABLE: InvoiceStatus[] = ['SENT', 'PARTIAL', 'OVERDUE', 'SENT_TO_COLLECTION']

  it.each(PAYABLE)(
    '%s + delbetalning: skriven status === paymentTargetStatus(status, false)',
    async (status) => {
      const { service, updateMany } = makeInvoicesService({ status })
      await service.markAsPaidManually('inv-1', 'org-1', 'BANK', 'user-1', 'USER', {
        enteredAmount: 3_000,
      })
      // Förväntan HÄRLEDS ur samma funktion koden använder. Skulle någon återinföra
      // ett literalt `? 'PAID' : 'PARTIAL'` vid sidan om, faller det här.
      expect(writtenStatus(updateMany)).toBe(paymentTargetStatus(status, false))
    },
  )

  it.each(PAYABLE)(
    '%s + FULL betalning: skriven status === paymentTargetStatus(status, true)',
    async (status) => {
      const { service, updateMany } = makeInvoicesService({ status })
      await service.markAsPaidManually('inv-1', 'org-1', 'BANK', 'user-1', 'USER', {
        enteredAmount: TOTAL,
      })
      expect(writtenStatus(updateMany)).toBe(paymentTargetStatus(status, true))
    },
  )
})

// ── D. reconciliation (defekt a + c) ─────────────────────────────────────────

describe('#307 C · D: bankmatchad delbetalning behåller inkassostatusen', () => {
  it('delbetalning mot SENT_TO_COLLECTION → statusen BEHÅLLS', async () => {
    const { applyMatch, updateMany } = makeReconciliation({ status: 'SENT_TO_COLLECTION' })

    await expect(applyMatch(3_000)).resolves.toBe(true)

    expect(writtenStatus(updateMany)).toBe('SENT_TO_COLLECTION')
    const data = writtenData(updateMany)
    expect(data).not.toHaveProperty('remindersPaused')
    expect(data).not.toHaveProperty('sentToCollectionAt')
  })

  it('händelseloggen bär FAKTISK utgångsstatus — inte hårdkodad SENT (defekt c)', async () => {
    const { applyMatch, events } = makeReconciliation({ status: 'SENT_TO_COLLECTION' })

    await applyMatch(3_000)

    const payload = events.record.mock.calls[0]![4] as Record<string, unknown>
    expect(payload['previousStatus']).toBe('SENT_TO_COLLECTION')
    expect(payload['newStatus']).toBe('SENT_TO_COLLECTION')
  })

  it('OVERDUE loggas som OVERDUE — hårdkodningen ljög för varje status utom SENT', async () => {
    const { applyMatch, events, updateMany } = makeReconciliation({ status: 'OVERDUE' })

    await applyMatch(3_000)

    const payload = events.record.mock.calls[0]![4] as Record<string, unknown>
    expect(payload['previousStatus']).toBe('OVERDUE')
    expect(payload['newStatus']).toBe('PARTIAL')
    expect(writtenStatus(updateMany)).toBe('PARTIAL')
  })

  it('claimen nyckas på utgångsstatusen', async () => {
    const { applyMatch, updateMany } = makeReconciliation({ status: 'SENT_TO_COLLECTION' })
    await applyMatch(3_000)
    const where = (updateMany.mock.calls[0]![0] as { where: Record<string, unknown> }).where
    expect(where['status']).toBe('SENT_TO_COLLECTION')
  })

  it('radlåset tas FÖRE läsningen som beslutet vilar på', async () => {
    const { applyMatch, tx } = makeReconciliation({ status: 'SENT_TO_COLLECTION' })
    await applyMatch(3_000)
    expect(tx.$queryRaw).toHaveBeenCalled()
    // Ordningen: låset före både statusläsningen och allokeringsläsningen.
    const lasOrdning = tx.$queryRaw.mock.invocationCallOrder[0]!
    expect(lasOrdning).toBeLessThan(tx.invoice.findFirst.mock.invocationCallOrder[0]!)
    expect(lasOrdning).toBeLessThan(tx.invoicePayment.findMany.mock.invocationCallOrder[0]!)
  })

  it('FULL betalning mot SENT_TO_COLLECTION går fortfarande via PAID-claimen', async () => {
    const { applyMatch, claimPaidWithinTx, updateMany } = makeReconciliation({
      status: 'SENT_TO_COLLECTION',
    })

    await applyMatch(TOTAL)

    expect(claimPaidWithinTx).toHaveBeenCalledTimes(1)
    // Delbetalningsgrenen rördes inte.
    expect(updateMany).not.toHaveBeenCalled()
  })

  it.each(['DRAFT', 'VOID', 'PAID'] as InvoiceStatus[])(
    '%s → ingen matchning, ingen allokering (tillåtlistan härledd ur tabellen)',
    async (status) => {
      const { applyMatch, updateMany, tx } = makeReconciliation({ status })
      await expect(applyMatch(3_000)).resolves.toBe(false)
      expect(updateMany).not.toHaveBeenCalled()
      expect(tx.invoicePayment.create).not.toHaveBeenCalled()
    },
  )
})
