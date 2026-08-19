/**
 * #342 — portalen visar vad hyresgästen faktiskt är skyldig.
 *
 * Efter #329 bär påminnelsebreven restskulden. Portalen visade fortfarande
 * fakturans nominella total, så en hyresgäst som betalat 8 000 av 10 000 såg
 * 2 000 i BREVET och 10 000 i PORTALEN — samma person, samma skuld, två tal.
 * Spretigheten skapades delvis av #329.
 *
 * FAR:s bedömning styr designen: nominell total är KORREKT på ett
 * fakturadokument och behålls; restskulden LÄGGS TILL; GDPR-exporten ska INTE
 * ändras — den ska spegla fakturan som den utfärdades.
 */

jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { TenantPortalService, mapExportInvoice } from './tenant-portal.service'
import { testPersonalNumberService } from '../common/crypto/personal-number.testing'
import { invoiceOutstanding } from '../invoices/invoice-debt'

const D = (n: number) => n as unknown as { toString(): string }

/**
 * DISKRIMINERANDE: 10 000 fakturerat, 8 000 betalt, 2 000 kvar. Tre tal som
 * inte sammanfaller — en implementation som råkar returnera fel fält syns.
 */
function invoiceRow(payments: number[] = []) {
  return {
    id: 'inv-1',
    invoiceNumber: 'F-2026-0042',
    type: 'RENT',
    status: payments.length ? 'PARTIAL' : 'OVERDUE',
    total: D(10000),
    payments: payments.map((a) => ({ amount: D(a) })),
    creditNotes: [],
    dueDate: new Date('2026-07-31'),
    issueDate: new Date('2026-07-01'),
    paidAt: null,
    lease: { unit: { name: 'Lgh 1001', property: { name: 'Storgatan 1' } } },
  }
}

function makeService(rows: ReturnType<typeof invoiceRow>[]) {
  const prisma = { invoice: { findMany: jest.fn().mockResolvedValue(rows) } }
  return new TenantPortalService(
    prisma as never,
    testPersonalNumberService(),
    {} as never,
    {} as never,
  )
}

describe('#342 — restskulden når hyresgästen', () => {
  it('delbetald faktura → outstanding är restskulden, total är oförändrad', async () => {
    const [inv] = (await makeService([invoiceRow([8000])]).getInvoices('t-1')) as unknown as Array<
      Record<string, number>
    >

    expect(inv!.outstanding).toBe(2000)
    expect(inv!.paid).toBe(8000)
    // Nominell total BEHÅLLS — FAR: korrekt på ett fakturadokument.
    expect(inv!.total).toBe(10000)
  })

  it('flera delbetalningar summeras', async () => {
    const [inv] = (await makeService([invoiceRow([3000, 4250])]).getInvoices(
      't-1',
    )) as unknown as Array<Record<string, number>>

    expect(inv!.paid).toBe(7250)
    expect(inv!.outstanding).toBe(2750)
  })

  it('obetald faktura → paid = 0, så gränssnittet visar ETT tal', async () => {
    // Noteringen från ärendet: två identiska siffror förklarar ingenting.
    // `paid === 0` är diskriminatorn gränssnittet villkorar den andra raden på.
    const [inv] = (await makeService([invoiceRow()]).getInvoices('t-1')) as unknown as Array<
      Record<string, number>
    >

    expect(inv!.paid).toBe(0)
    expect(inv!.outstanding).toBe(inv!.total)
  })

  it('överbetald faktura → outstanding klampas till 0, men paid visar det FAKTISKT betalda', async () => {
    // Första versionen härledde `paid` som `total − outstanding`. Eftersom
    // `outstanding` är klampat vid 0 blev `paid` då 10 000 i stället för de
    // 12 000 som faktiskt registrerats — överbetalningen försvann tyst ur det
    // hyresgästen ser. Och det HÄR testet hävdade bara `outstanding`, så det
    // fångade inget. Båda granskarna hittade buggen; testet gjorde det inte.
    const [inv] = (await makeService([invoiceRow([12000])]).getInvoices('t-1')) as unknown as Array<
      Record<string, number>
    >

    expect(inv!.outstanding).toBe(0)
    expect(inv!.paid).toBe(12000)
  })
})

describe('#342 — samma tal som brevet', () => {
  it('portalens outstanding är samma uttryck som påminnelsebrevet räknar', async () => {
    // Hela poängen. Breven använder `invoiceOutstanding` sedan #329; portalen
    // använder samma funktion. Testet räknar brevets belopp med samma helper och
    // hävdar att de är identiska — gick de isär vore #342 meningslös.
    const row = invoiceRow([8000])

    const [inv] = (await makeService([row]).getInvoices('t-1')) as unknown as Array<
      Record<string, number>
    >
    const letterAmount = invoiceOutstanding(row as never)

    expect(inv!.outstanding).toBe(letterAmount)
    expect(letterAmount).toBe(2000)
  })
})

describe('#342 — GDPR-exporten är oförändrad', () => {
  it('mapExportInvoice returnerar EXAKT samma fält som före #342', async () => {
    // FAR: exporten ska spegla fakturan som den UTFÄRDADES, inte ett beräknat
    // tillstånd. Inget `paid`/`outstanding` här — och referensen är uttömmande,
    // så ett framtida tillägg faller på den här raden.
    const exported = mapExportInvoice({
      id: 'inv-1',
      invoiceNumber: 'F-2026-0042',
      type: 'RENT',
      status: 'PARTIAL',
      subtotal: D(10000),
      vatTotal: D(0),
      total: D(10000),
      dueDate: new Date('2026-07-31'),
      issueDate: new Date('2026-07-01'),
      paidAt: null,
      reference: null,
      ocrNumber: '1234567897',
      notes: null,
      lines: [],
    } as never)

    expect(Object.keys(exported).sort()).toEqual([
      'dueDate',
      'id',
      'invoiceNumber',
      'issueDate',
      'lines',
      'notes',
      'ocrNumber',
      'paidAt',
      'reference',
      'status',
      'subtotal',
      'total',
      'type',
      'vatTotal',
    ])
    expect(exported).not.toHaveProperty('outstanding')
    expect(exported).not.toHaveProperty('paid')
    expect(exported).not.toHaveProperty('payments')
    expect(exported.total).toBe(10000) // nominellt, orört
  })
})

describe('#342 — ingenting utöver beloppet läcker', () => {
  it('allokeringens interna fält når aldrig hyresgästen', async () => {
    // Selecten hämtar bara `amount`. Fixturen bär FLER fält för att bevisa att
    // mappern (lager 2) inte släpper vidare dem även om selecten skulle drifta —
    // samma disciplin som portal-läcktätningen #156–#160.
    const row = {
      ...invoiceRow(),
      payments: [
        {
          amount: D(8000),
          id: 'ip-HEMLIGT',
          bankTransactionId: 'tx-HEMLIGT',
          source: 'BANK_RECONCILIATION',
          paidAt: new Date('2026-07-20'),
        },
      ],
      creditNotes: [],
    }

    const [inv] = (await makeService([row as never]).getInvoices('t-1')) as unknown as Array<
      Record<string, unknown>
    >

    expect(inv).not.toHaveProperty('payments')
    const serialised = JSON.stringify(inv)
    for (const leak of ['ip-HEMLIGT', 'tx-HEMLIGT', 'BANK_RECONCILIATION']) {
      expect(serialised).not.toContain(leak)
    }
    // …men beloppet räknades: 10 000 − 8 000.
    expect(inv!.outstanding).toBe(2000)
  })
})
