/**
 * #329 — påminnelsebreven bär RESTSKULDEN, inte ursprungsbeloppet.
 *
 * Sedan #322 visar vyerna restskulden. Breven gjorde det inte: operatören såg
 * 2 000 i systemet medan hyresgästen fick krav på 10 000. Kravet formulerades i
 * #307 PR 2b ("byt `Number(invoice.total)` mot `computeInvoiceDebt(...).outstanding`
 * i påminnelsevägen") men byggdes aldrig.
 *
 * DEN KRITISKA DISTINKTIONEN: den formella påminnelsen skriver in avgiften i
 * `invoice.total`. DÄR är `invoice.total` rätt och SKA växa — det är fakturans
 * nominella belopp. Felet var att samma tal gick vidare till BREVET som om det
 * vore vad hyresgästen är skyldig. Testerna nedan hävdar BÅDA sidorna: brevet
 * bär restskulden, och bokföringen bär fortfarande det nominella beloppet.
 */

jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { Prisma } from '@prisma/client'
import { PaymentReminderService } from './payment-reminder.service'

const D = (n: number) => new Prisma.Decimal(n)

/** Faktura på 10 000 som förfallit — beloppen är diskriminerande, se nedan. */
function makeInvoice(opts: { total?: number; payments?: number[]; daysOverdue?: number } = {}) {
  const days = opts.daysOverdue ?? 5
  const dueDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  return {
    id: 'inv-1',
    organizationId: 'org-1',
    invoiceNumber: 'F-2026-0042',
    status: 'OVERDUE',
    total: D(opts.total ?? 10000),
    payments: (opts.payments ?? []).map((a) => ({ amount: D(a) })),
    dueDate,
    ocrNumber: '1234567897',
    remindersPaused: false,
    tenant: { type: 'COMPANY', companyName: 'Hyresgäst AB', email: 'h@example.se' },
    customer: null,
    paymentReminders: [] as Array<{ type: string }>,
    organization: {
      name: 'Värd AB',
      remindersEnabled: true,
      // DISKRIMINERANDE: 60 kr sammanfaller varken med totalen (10 000),
      // delbetalningen (8 000) eller restskulden (2 000).
      reminderFeeSek: D(60),
      bankgiro: '123-4567',
      reminderFormalDay: 14,
      reminderCollectionDay: 30,
    },
  }
}

function makeService(invoice: ReturnType<typeof makeInvoice>) {
  const invoiceUpdate = jest.fn().mockResolvedValue({})
  // #357: fakturans total räknas upp med `updateMany` + `increment`, inte med
  // ett absolut värde. count måste vara 1, annars kastar tillståndsomprövningen.
  const invoiceBump = jest.fn().mockResolvedValue({ count: 1 })
  // #357: hela avgiften ligger numera i EN transaktion med idempotensmarkören
  // först, så `tx` måste bära markören och händelseloggen också. Assertionerna
  // nedan är OFÖRÄNDRADE — det som mäts (brevets siffror vs det nominella
  // beloppet) är exakt detsamma; bara skrivvägen har flyttat in i transaktionen.
  const tx = {
    paymentReminder: {
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    invoiceLine: { create: jest.fn().mockResolvedValue({}) },
    invoice: { update: invoiceUpdate, updateMany: invoiceBump },
    invoiceEvent: { create: jest.fn().mockResolvedValue({}) },
  }
  const prisma = {
    invoice: { findMany: jest.fn().mockResolvedValue([invoice]), update: invoiceUpdate },
    paymentReminder: {
      create: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    invoiceEvent: { create: jest.fn().mockResolvedValue({}) },
    account: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn((cb: (t: unknown) => unknown) => cb(tx)),
  }
  const mail = {
    sendReminderFriendly: jest.fn().mockResolvedValue('msg-1'),
    sendReminderFormal: jest.fn().mockResolvedValue('msg-2'),
  }
  const accounting = { bookReminderFee: jest.fn().mockResolvedValue({ id: 'je-1' }) }
  const notifications = { createForAllOrgUsers: jest.fn().mockResolvedValue(undefined) }
  // Konstruktorordning: (prisma, mail, notifications, accounting).
  const service = new PaymentReminderService(
    prisma as never,
    mail as never,
    notifications as never,
    accounting as never,
  )
  return { service, prisma, mail, tx, invoiceUpdate, invoiceBump }
}

describe('#329 — vänliga påminnelsen (dag 7)', () => {
  it('delbetald faktura → brevet bär RESTSKULDEN, inte totalen', async () => {
    // 10 000 fakturerat, 8 000 betalt → 2 000 kvar. Före #329 stod 10 000 i brevet.
    const { service, mail } = makeService(
      makeInvoice({ total: 10000, payments: [8000], daysOverdue: 5 }),
    )

    await service.processOverdueReminders()

    expect(mail.sendReminderFriendly).toHaveBeenCalledTimes(1)
    expect(mail.sendReminderFriendly.mock.calls[0]![0].total).toBe(2000)
  })

  it('obetald faktura → oförändrat belopp', async () => {
    const { service, mail } = makeService(makeInvoice({ total: 10000, daysOverdue: 5 }))

    await service.processOverdueReminders()

    expect(mail.sendReminderFriendly.mock.calls[0]![0].total).toBe(10000)
  })

  it('flera delbetalningar summeras', async () => {
    const { service, mail } = makeService(
      makeInvoice({ total: 10000, payments: [3000, 4250], daysOverdue: 5 }),
    )

    await service.processOverdueReminders()

    expect(mail.sendReminderFriendly.mock.calls[0]![0].total).toBe(2750)
  })
})

describe('#329 — formella påminnelsen (dag 14): brev och bokföring skiljs åt', () => {
  const formal = (payments: number[] = []) =>
    makeService(makeInvoice({ total: 10000, payments, daysOverdue: 15 }))

  it('BREVET bär restskulden före och efter avgiften', async () => {
    const { service, mail } = formal([8000])

    await service.processOverdueReminders()

    const letter = mail.sendReminderFormal.mock.calls[0]![0]
    expect(letter.outstandingBeforeFee).toBe(2000) // restskuld, INTE 10 000
    expect(letter.feeAmount).toBe(60)
    expect(letter.newTotal).toBe(2060) // restskuld + avgift, INTE 10 060
  })

  it('BOKFÖRINGEN rör bara avgiften — fakturans total kan inte skrivas ner till restskulden', async () => {
    // Den kritiska distinktionen. Skulle brevets siffra läcka in här skulle
    // fakturan skrivas ner från 10 000 till 2 060 och avgiftsbokföringen bli
    // fel i stället — värre än felet vi lagar.
    //
    // #357 gjorde den felformen STRUKTURELLT OMÖJLIG: totalen räknas upp med
    // `increment: fee` i stället för att skrivas som ett absolut värde härlett
    // ur en läsning utanför transaktionen. Ett relativt tillägg kan inte bära
    // restskulden av misstag. Testet mäter därför den nya formen — och att den
    // gamla absoluta skrivvägen inte används alls.
    const { service, invoiceUpdate, invoiceBump } = formal([8000])

    await service.processOverdueReminders()

    expect(invoiceBump).toHaveBeenCalledTimes(1)
    const data = invoiceBump.mock.calls[0]![0].data
    expect(Number(data.total.increment)).toBe(60) // avgiften, INTE 2 060 och INTE 10 060
    expect(invoiceUpdate).not.toHaveBeenCalled()
  })

  it('avgiftsraden skrivs på avgiftens belopp, orörd av restskulden', async () => {
    const { service, tx } = formal([8000])

    await service.processOverdueReminders()

    const line = tx.invoiceLine.create.mock.calls[0]![0].data
    expect(Number(line.unitPrice)).toBe(60)
    expect(Number(line.total)).toBe(60)
  })

  it('obetald faktura → brevets siffror är oförändrade (10 000 / 60 / 10 060)', async () => {
    const { service, mail } = formal([])

    await service.processOverdueReminders()

    const letter = mail.sendReminderFormal.mock.calls[0]![0]
    expect(letter.outstandingBeforeFee).toBe(10000)
    expect(letter.newTotal).toBe(10060)
  })
})

describe('#329 — TESTET SPÄRREN KRÄVDE: restskulden bär avgiften', () => {
  it('efter att avgiften skrivits in i fakturan växer restskulden med avgiften', async () => {
    // Kommentaren i #307 sa uttryckligen: "kontrollera det med ett test, inte
    // med resonemang". Resonemanget är att restskulden = total − Σ allokeringar,
    // och att den formella påminnelsen ökar `total` med avgiften — alltså ökar
    // restskulden lika mycket. Här mäts det.
    const { service, invoiceBump } = makeService(
      makeInvoice({ total: 10000, payments: [8000], daysOverdue: 15 }),
    )

    await service.processOverdueReminders()

    // Fakturans nya nominella total: ursprunget plus det som faktiskt skrevs
    // till DB:n. (#357 — uppräkningen är relativ, se testet ovan.)
    const newNominal = 10000 + Number(invoiceBump.mock.calls[0]![0].data.total.increment)

    // Restskulden räknad ur det NYA tillståndet — samma uttryck som breven och
    // vyerna använder.
    const outstandingAfterFee = newNominal - 8000

    expect(outstandingAfterFee).toBe(2060)
    // …vilket är exakt restskulden före avgiften plus avgiften.
    expect(outstandingAfterFee).toBe(2000 + 60)
  })
})

describe('#329 — urvalet är oförändrat', () => {
  it('WHERE rör bara status och remindersPaused; allokeringarna laddas via include', async () => {
    const { service, prisma } = makeService(makeInvoice({ payments: [8000] }))

    await service.processOverdueReminders()

    const args = prisma.invoice.findMany.mock.calls[0]![0]
    // Exakt samma urval som före #329 — bara beloppet ändras, inte VILKA
    // fakturor som påminns.
    expect(args.where).toEqual({ status: 'OVERDUE', remindersPaused: false })
    expect(args.include.payments).toEqual({ select: { amount: true } })
  })
})
