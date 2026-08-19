/**
 * A (fakturasidan) — VOID reverserar avgiften OCH städar dokumentet.
 *
 * Avgiften togs på TVÅ ställen (payment-reminder.service.ts): ett verifikat under
 * `reminder-fee:<invoiceId>` OCH en rad på fakturan med `total` uppräknad.
 * Reverseras bara verifikatet fortsätter dokumentet kräva en avgift som
 * huvudboken inte längre bär — samma divergens mellan reskontra och huvudbok som
 * #357 stängde, med omvänt tecken. Därför bevakas båda sidorna här.
 *
 * DISKRIMINERANDE DATA: fakturans total (9 060) och avgiften (60) är olika tal,
 * och avgiften är inte en jämn andel av totalen. Vore de lika kunde testet inte
 * se om `decrement` fick avgiften eller totalen.
 *
 * RÄNTAN TESTAS INTE HÄR — den finns inte på fakturasidan. `bookInterest` har en
 * enda anropare (RentInterestService) och fakturavägen kristalliserar aldrig
 * ränta. Det sista testet låser fast det: ett anrop hit vore en uppslagning som
 * per konstruktion aldrig kan träffa något.
 */

jest.mock('./pdf.service', () => ({ PdfService: class {} }))
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { Prisma } from '@prisma/client'

import { InvoicesService } from './invoices.service'
import { REMINDER_FEE_LINE_DESCRIPTION } from './reminder-fee-line'

const INVOICE_ID = 'inv-1'
const TOTAL = 9060
const AVGIFT = 60

function makeService(opts: { feeLines?: Array<{ id: string; total: number }> } = {}) {
  const feeLines = opts.feeLines ?? [{ id: 'line-fee', total: AVGIFT }]
  const invoiceRow = {
    id: INVOICE_ID,
    status: 'OVERDUE',
    invoiceNumber: 'F-2026-0001',
    total: new Prisma.Decimal(TOTAL),
  }

  const lineFindMany = jest.fn((args: { where: { description?: string } }) =>
    // Svarar BARA på den delade konstanten. Söker koden på en annan sträng får
    // den noll rader — och en tyst no-op är precis buggen som ska förhindras.
    Promise.resolve(args.where.description === REMINDER_FEE_LINE_DESCRIPTION ? feeLines : []),
  )
  const lineDeleteMany = jest.fn().mockResolvedValue({ count: feeLines.length })
  const invoiceUpdate = jest.fn().mockResolvedValue(invoiceRow)

  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    invoice: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(invoiceRow),
      update: invoiceUpdate,
    },
    invoicePayment: { findMany: jest.fn().mockResolvedValue([]) },
    invoiceLine: { findMany: lineFindMany, deleteMany: lineDeleteMany },
    // E: förbrukningsdebiteringar lossas vid VOID. Ingen charge här.
    consumptionCharge: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    deposit: { findFirst: jest.fn().mockResolvedValue(null) },
  }
  const prisma = { $transaction: jest.fn((cb: (t: unknown) => unknown) => cb(tx)) }

  const reverseJournalEntryForInvoice = jest.fn().mockResolvedValue(undefined)
  const reverseJournalEntryForReminderFee = jest.fn().mockResolvedValue(undefined)
  const reverseJournalEntryForDepositAccrual = jest.fn().mockResolvedValue(undefined)
  const accounting = {
    reverseJournalEntryForInvoice,
    reverseJournalEntryForReminderFee,
    reverseJournalEntryForDepositAccrual,
  }

  const service = new InvoicesService(
    prisma as never,
    { record: jest.fn().mockResolvedValue(undefined) } as never,
    {} as never,
    {} as never,
    accounting as never,
    { createForAllOrgUsers: jest.fn().mockResolvedValue(undefined) } as never,
    {} as never,
    {} as never,
  )

  return {
    service,
    tx,
    accounting,
    reverseJournalEntryForReminderFee,
    lineFindMany,
    lineDeleteMany,
    invoiceUpdate,
  }
}

/** Plockar det `invoice.update`-anrop som faktiskt rör totalen — det FÖRSTA
 *  anropet är statusflippen (`data: { status: 'VOID' }`), inte avgiftsavdraget. */
function totalDecrement(invoiceUpdate: jest.Mock): number | undefined {
  for (const call of invoiceUpdate.mock.calls) {
    const arg = call[0] as { data?: { total?: { decrement?: Prisma.Decimal } } }
    if (arg.data?.total?.decrement != null) return Number(arg.data.total.decrement)
  }
  return undefined
}

describe('A (faktura) — VOID reverserar påminnelseavgiften', () => {
  it('reverserar avgiften med source INVOICE och fakturans id', async () => {
    const { service, reverseJournalEntryForReminderFee } = makeService()

    await service.transitionStatus(INVOICE_ID, 'org-1', 'VOID', 'user-1', 'USER')

    expect(reverseJournalEntryForReminderFee).toHaveBeenCalledTimes(1)
    const args = reverseJournalEntryForReminderFee.mock.calls[0] as unknown[]
    // source FÖRST — avgiftens nyckel skiljer sig från fakturans accrual på BÅDA
    // axlarna (source + sourceId), och bara sourceId räcker inte.
    expect(args[0]).toBe('INVOICE')
    expect(args[1]).toBe(INVOICE_ID)
    expect(args[2]).toBe('org-1')
    expect(args[3]).toBe('Makulerad faktura')
    expect(args[4]).toBe('user-1')
  })

  it('ATOMISKT: reverseringen får transaktionsklienten, inte prisma bredvid den', async () => {
    // Läxan från #288 — attrappens tx är ETT EGET objekt, skilt från prisma.
    const { service, tx, reverseJournalEntryForReminderFee } = makeService()

    await service.transitionStatus(INVOICE_ID, 'org-1', 'VOID', 'user-1', 'USER')

    const args = reverseJournalEntryForReminderFee.mock.calls[0] as unknown[]
    expect(args[5]).toBe(tx)
  })

  it('DOKUMENTET: avgiftsraden raderas och totalen minskas med avgiften', async () => {
    const { service, lineDeleteMany, invoiceUpdate } = makeService()

    await service.transitionStatus(INVOICE_ID, 'org-1', 'VOID', 'user-1', 'USER')

    expect(lineDeleteMany).toHaveBeenCalledTimes(1)
    const del = lineDeleteMany.mock.calls[0]![0] as { where: { id: { in: string[] } } }
    expect(del.where.id.in).toEqual(['line-fee'])

    // AVGIFTEN dras av, inte totalen. Talen är olika just för att testet ska
    // kunna se skillnaden.
    expect(totalDecrement(invoiceUpdate)).toBe(AVGIFT)
    expect(totalDecrement(invoiceUpdate)).not.toBe(TOTAL)
  })

  it('raden identifieras via den DELADE konstanten, inte en egen literal', async () => {
    const { service, lineFindMany } = makeService()

    await service.transitionStatus(INVOICE_ID, 'org-1', 'VOID', 'user-1', 'USER')

    const fråga = lineFindMany.mock.calls[0]![0] as { where: Record<string, unknown> }
    expect(fråga.where).toMatchObject({
      invoiceId: INVOICE_ID,
      description: REMINDER_FEE_LINE_DESCRIPTION,
    })
  })

  it('FLERA avgiftsrader (legacy före #357) summeras och raderas allihop', async () => {
    // #357 gör att bara en kan uppstå numera, men spärren är ung och koden får
    // inte anta att den alltid hållit.
    const { service, lineDeleteMany, invoiceUpdate } = makeService({
      feeLines: [
        { id: 'l1', total: 60 },
        { id: 'l2', total: 60 },
      ],
    })

    await service.transitionStatus(INVOICE_ID, 'org-1', 'VOID', 'user-1', 'USER')

    const del = lineDeleteMany.mock.calls[0]![0] as { where: { id: { in: string[] } } }
    expect(del.where.id.in).toEqual(['l1', 'l2'])
    expect(totalDecrement(invoiceUpdate)).toBe(120)
  })

  it('INGEN avgift → dokumentet rörs inte (ingen radering, ingen totaländring)', async () => {
    const { service, lineDeleteMany, invoiceUpdate } = makeService({ feeLines: [] })

    await service.transitionStatus(INVOICE_ID, 'org-1', 'VOID', 'user-1', 'USER')

    expect(lineDeleteMany).not.toHaveBeenCalled()
    // Bara statusflippens update, ingen total-justering.
    expect(totalDecrement(invoiceUpdate)).toBeUndefined()
  })

  it('AVGRÄNSNING: ingen ränta reverseras — den finns inte på fakturasidan', async () => {
    const { service, accounting } = makeService()

    await service.transitionStatus(INVOICE_ID, 'org-1', 'VOID', 'user-1', 'USER')

    // Fakturavägen kristalliserar aldrig ränta (bookInterest har en enda
    // anropare, RentInterestService). Ett anrop hit vore symmetri av vana.
    expect(accounting).not.toHaveProperty('reverseJournalEntryForInterest')
  })
})

describe('E (faktura) — förbrukningsdebiteringar lossas vid VOID', () => {
  it('frigör charges: status CONFIRMED och invoiceId nollad', async () => {
    const { service, tx } = makeService()

    await service.transitionStatus(INVOICE_ID, 'org-1', 'VOID', 'user-1', 'USER')

    expect(tx.consumptionCharge.updateMany).toHaveBeenCalledTimes(1)
    const arg = tx.consumptionCharge.updateMany.mock.calls[0]![0] as {
      where: Record<string, unknown>
      data: Record<string, unknown>
    }
    expect(arg.where).toMatchObject({
      invoiceId: INVOICE_ID,
      organizationId: 'org-1',
      // Villkorat: en charge som hunnit bli CANCELLED får inte återuppstå.
      status: 'ATTACHED',
    })
    // invoiceId MÅSTE nollas — annars pekar chargen kvar på den makulerade
    // fakturan och nästa `invoiceSeparateCharges` kan inte knyta om den.
    expect(arg.data).toEqual({ status: 'CONFIRMED', invoiceId: null })
  })

  it('MISC-CHARGES RÖRS INTE — de kan inte ligga på en faktura', async () => {
    // `MiscCharge` har ingen invoiceId-kolumn (bara relationen rentNoticeLine).
    // De fyra teoretiska kombinationerna är tre; ett anrop här hade grindat mot
    // något som inte kan uppstå.
    const { tx } = makeService()

    expect(tx).not.toHaveProperty('miscCharge')
  })
})
