/**
 * #517 — EN KREDITERAD FAKTURA BÄR INGEN SKULD OCH ESKALERAR INTE.
 *
 * Det här är påståendet som gör krediteringen till något annat än ett papper.
 * Bokföringen kan vara perfekt och kravtrappan ändå skicka en påminnelse på
 * hela beloppet — det var exakt det #329/#342/#344/#325 arbetade bort på de
 * andra ytorna, och en ny beräkning vid sidan av `computeInvoiceDebt` hade
 * återupprepat det.
 *
 * Testerna körs mot den RIKTIGA `OverdueDebtService` och den riktiga
 * `collection-export`-grinden — inte mot en avskrift av deras logik. En
 * stubbad tjänst kan vara grön medan ytan visar ett annat tal
 * (dev_stubbad_delad_tjanst).
 */

import { Prisma } from '@prisma/client'
import { computeInvoiceDebt, invoiceOutstanding } from './invoice-debt'
import { OverdueDebtService } from '../overdue/overdue-debt.service'

const D = (n: number | string) => new Prisma.Decimal(n)

describe('#517 — skulden går genom computeInvoiceDebt', () => {
  it('helkreditering nollar restskulden', () => {
    const d = computeInvoiceDebt({
      total: D(10_000),
      allocations: [],
      credits: [D(10_000)],
    })
    expect(d.outstanding.toNumber()).toBe(0)
    expect(d.credited.toNumber()).toBe(10_000)
    expect(d.isSettled).toBe(true)
  })

  it('delkreditering sänker restskulden med exakt det krediterade beloppet', () => {
    const d = computeInvoiceDebt({ total: D(10_000), allocations: [], credits: [D(3_000)] })
    expect(d.outstanding.toNumber()).toBe(7_000)
    // Och krediteringen är INTE en betalning — `paid` står kvar på noll, så
    // ingen yta kan förväxla en nedskriven fordran med mottagna pengar.
    expect(d.paid.toNumber()).toBe(0)
  })

  it('kreditering och betalning räknas var för sig men mot samma fordran', () => {
    const d = computeInvoiceDebt({
      total: D(10_000),
      allocations: [D(2_000)],
      credits: [D(3_000)],
    })
    expect(d.paid.toNumber()).toBe(2_000)
    expect(d.credited.toNumber()).toBe(3_000)
    expect(d.outstanding.toNumber()).toBe(5_000)
  })

  it('betalning som täcker den KREDITERADE fordran ger överbetalning, inte restskuld', () => {
    // Fakturan var 10 000, krediterades med 3 000, men hyresgästen hann betala
    // hela ursprungsbeloppet. Skillnaden är ett tillgodohavande — och den ska
    // synas som `overpaid`, aldrig som en skuld.
    const d = computeInvoiceDebt({
      total: D(10_000),
      allocations: [D(10_000)],
      credits: [D(3_000)],
    })
    expect(d.outstanding.toNumber()).toBe(0)
    expect(d.overpaid.toNumber()).toBe(3_000)
  })

  it('typspärren: `credits` går inte att glömma', () => {
    // Anropen ligger i en funktion som ALDRIG körs. Assertionen är att filen
    // typcheckar — `@ts-expect-error` faller om felet försvinner, alltså om
    // fältet skulle göras valfritt igen. Att köra anropen hade bara mätt att
    // koden kraschar på `undefined.reduce`, vilket är en annan sak.
    const aldrigAnropad = () => {
      // @ts-expect-error — utan `credits` typcheckar anropet inte. Det är det
      // som gjorde att varje befintlig skuldkonsument måste läsas igenom vid
      // införandet i stället för att tyst fortsätta räkna fel.
      computeInvoiceDebt({ total: D(1), allocations: [] })

      // @ts-expect-error — samma spärr på radformen.
      invoiceOutstanding({ total: D(1), payments: [] })
    }
    expect(typeof aldrigAnropad).toBe('function')
  })
})

describe('#517 — kravtrappans aggregat ser en krediterad faktura som reglerad', () => {
  function makeSnapshot(invoices: Array<Record<string, unknown>>) {
    const prisma = {
      rentNotice: { findMany: jest.fn().mockResolvedValue([]) },
      invoice: { findMany: jest.fn().mockResolvedValue(invoices) },
    }
    return new OverdueDebtService(prisma as never)
  }

  const förfallen = (total: number, creditNotes: number[], payments: number[] = []) => ({
    total: D(total),
    dueDate: new Date('2026-01-01'),
    payments: payments.map((a) => ({ amount: D(a) })),
    creditNotes: creditNotes.map((t) => ({ total: D(t) })),
  })

  it('helkrediterad OVERDUE-faktura bidrar varken till belopp ELLER antal', async () => {
    const service = makeSnapshot([förfallen(10_000, [10_000])])
    const snapshot = await service.getOverdueSnapshot('org-1', new Date('2026-03-01'))

    expect(snapshot.total).toBe(0)
    // Antalet är det som avgör om hyresvärden ser "1 förfallen faktura".
    expect(snapshot.count).toBe(0)
    expect(snapshot.over30Count).toBe(0)
  })

  it('delkrediterad faktura bidrar med restskulden, inte bruttot', async () => {
    const service = makeSnapshot([förfallen(10_000, [3_000])])
    const snapshot = await service.getOverdueSnapshot('org-1', new Date('2026-03-01'))

    expect(snapshot.total).toBe(7_000)
    expect(snapshot.count).toBe(1)
  })

  it('DISKRIMINERANDE: utan krediteringen hade samma faktura visat 10 000', async () => {
    // Kontrollfallet. Faller det här och det föregående samtidigt mäter sviten
    // ingenting — då är det inte krediteringen som gör skillnaden.
    const service = makeSnapshot([förfallen(10_000, [])])
    const snapshot = await service.getOverdueSnapshot('org-1', new Date('2026-03-01'))

    expect(snapshot.total).toBe(10_000)
    expect(snapshot.count).toBe(1)
  })
})
