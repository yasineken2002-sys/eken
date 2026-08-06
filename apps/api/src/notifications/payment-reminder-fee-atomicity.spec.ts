/**
 * #357 — påminnelseavgiftens atomicitet på fakturavägen.
 *
 * Fakturavägen kunde skriva TVÅ `InvoiceLine`-rader mot ETT 3593-verifikat:
 * hyresgästen krävdes på 120 kr medan huvudboken bar 60 kr. Orsaken var
 * SKRIVORDNINGEN — `sendFormalReminder` gjorde fyra skrivningar i fyra
 * transaktioner med idempotensmarkören SIST, så allt som kastade däremellan
 * lämnade fakturan uppskriven utan markör och nästa cron-körning lade på en
 * avgiftsrad till.
 *
 * VAD DE HÄR TESTERNA BEVISAR: ordningen och kontrakten — att markören tas som
 * ett villkorat anspråk FÖRE sidoeffekterna, att allt sker inuti EN transaktion,
 * att `null` från `bookReminderFee` kastar, och att ett kö-fel inte gör avgiften
 * ogjord.
 *
 * VAD DE INTE BEVISAR: att rollbacken faktiskt sker. En mockad `$transaction`
 * kan inte rulla tillbaka något. Det är mätt mot riktig Postgres i bevisriggen
 * (scenario S9: org utan konto 3593 → noll avgiftsrader, oförändrad total, noll
 * markörer, noll händelser), och sammanfattat i PR-beskrivningen. Läs inte de
 * här testerna som bevis för atomicitet i databasen — de bevakar att koden
 * fortsätter BEGÄRA den.
 */

jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { PaymentReminderService } from './payment-reminder.service'

interface Recorder {
  ordning: string[]
}

function makeService(opts: {
  claimCount?: number
  bumpCount?: number
  bookReturns?: { id: string } | null
  mailRejects?: boolean
  fee?: number
}) {
  const rec: Recorder = { ordning: [] }
  const claimCount = opts.claimCount ?? 1
  const fee = opts.fee ?? 60

  const invoice = {
    id: 'inv-1',
    organizationId: 'org-1',
    invoiceNumber: 'F-2026-000001',
    total: 9000,
    dueDate: new Date('2026-05-01'),
    ocrNumber: '1234567',
    payments: [],
    paymentReminders: [],
    tenant: { type: 'INDIVIDUAL', firstName: 'Hyres', lastName: 'Gäst', email: 'hg@example.se' },
    customer: null,
    organization: {
      id: 'org-1',
      name: 'Värd AB',
      remindersEnabled: true,
      reminderFeeSek: fee,
      reminderFormalDay: 14,
      reminderCollectionDay: 30,
      bankgiro: '123-4567',
    },
  }

  // `tx` och `prisma` är AVSIKTLIGT samma objekt här — det räcker för att mäta
  // ordning och argument. Det är också precis den attrapp som i #288 dolde ett
  // atomicitetsfel, vilket är varför riggen finns vid sidan av.
  const txClient = {
    paymentReminder: {
      createMany: jest.fn(async () => {
        rec.ordning.push('claim')
        return { count: claimCount }
      }),
      updateMany: jest.fn(async () => {
        rec.ordning.push('messageId')
        return { count: 1 }
      }),
    },
    invoiceLine: {
      create: jest.fn(async () => {
        rec.ordning.push('avgiftsrad')
        return { id: 'line-1' }
      }),
    },
    invoice: {
      update: jest.fn(async () => {
        rec.ordning.push('total')
        return invoice
      }),
      updateMany: jest.fn(async () => {
        rec.ordning.push('bump')
        return { count: opts.bumpCount ?? 1 }
      }),
      findMany: jest.fn(async () => [invoice]),
    },
    invoiceEvent: {
      create: jest.fn(async () => {
        rec.ordning.push('händelse')
        return { id: 'ev-1' }
      }),
    },
  }

  // `prisma` får EGNA funktioner, inte spridda referenser från `txClient`.
  // Med `{ ...txClient }` blev `prisma.invoiceLine.create === txClient.invoiceLine.create`,
  // och då kunde testet inte skilja en skrivning på transaktionsklienten från en
  // på den vanliga klienten inuti callbacken — "allt ligger inuti transaktionen"
  // var alltså inte mätt. (Kodgranskning #357.)
  const nonTx = <T>(namn: string, svar: T) =>
    jest.fn(async () => {
      rec.ordning.push(`ICKE-TX:${namn}`)
      return svar
    })
  const prisma = {
    paymentReminder: {
      createMany: nonTx('claim', { count: claimCount }),
      updateMany: nonTx('messageId', { count: 1 }),
    },
    invoiceLine: { create: nonTx('avgiftsrad', { id: 'line-1' }) },
    invoice: {
      update: nonTx('total', invoice),
      updateMany: nonTx('bump', { count: 1 }),
      findMany: jest.fn(async () => [invoice]),
    },
    invoiceEvent: { create: nonTx('händelse', { id: 'ev-1' }) },
    $transaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
      rec.ordning.push('tx:start')
      const res = await cb(txClient)
      rec.ordning.push('tx:commit')
      return res
    }),
  }

  const mail = {
    sendReminderFormal: jest.fn(async () => {
      rec.ordning.push('utskick')
      if (opts.mailRejects) throw new Error('kön nere')
      return 'msg-1'
    }),
  }

  const accounting = {
    bookReminderFee: jest.fn(async () => {
      rec.ordning.push('verifikat')
      return opts.bookReturns === undefined ? { id: 'je-1' } : opts.bookReturns
    }),
  }

  const service = new PaymentReminderService(
    prisma as never,
    mail as never,
    { createForAllOrgUsers: jest.fn(), create: jest.fn() } as never,
    accounting as never,
  )
  return { service, prisma, mail, accounting, rec, invoice, txClient }
}

/** Kör den privata sendFormalReminder direkt — cron-urvalet är inte det som mäts. */
async function sendFormal(h: ReturnType<typeof makeService>) {
  const priv = h.service as unknown as {
    sendFormalReminder: (inv: unknown, email: string, days: number) => Promise<void>
  }
  await priv.sendFormalReminder(h.invoice, 'hg@example.se', 20)
}

describe('#357 — sendFormalReminder tar avgiften atomiskt', () => {
  it('markören tas FÖRE avgiftsraden, och allt ligger inuti transaktionen', async () => {
    const h = makeService({})
    await sendFormal(h)

    // Anspråket måste komma först: det är det som gör unik-villkoret till en
    // verklig spärr i stället för en efterhandsanteckning.
    expect(h.rec.ordning.indexOf('claim')).toBeLessThan(h.rec.ordning.indexOf('avgiftsrad'))

    // Fyra skrivningar, en transaktion.
    const start = h.rec.ordning.indexOf('tx:start')
    const commit = h.rec.ordning.indexOf('tx:commit')
    for (const steg of ['claim', 'bump', 'avgiftsrad', 'verifikat', 'händelse']) {
      const i = h.rec.ordning.indexOf(steg)
      expect(i).toBeGreaterThan(start)
      expect(i).toBeLessThan(commit)
    }

    // Utskicket ligger EFTER commit — aldrig inuti transaktionen.
    expect(h.rec.ordning.indexOf('utskick')).toBeGreaterThan(commit)
    expect(h.prisma.$transaction).toHaveBeenCalledTimes(1)

    // Och det enda som rör den ICKE-transaktionella klienten är
    // leveranskorrelationen. Skulle någon skrivning glida ut ur transaktionen
    // dyker den upp här.
    expect(h.rec.ordning.filter((x) => x.startsWith('ICKE-TX:'))).toEqual(['ICKE-TX:messageId'])
  })

  it('fakturan ändrar tillstånd under körningen → ConflictException, inget utskick', async () => {
    // Status och pausflaggan lästes i cronens findMany före loopen. Betalas
    // fakturan eller pausas kravtrappan mitt i körningen ska ingen avgift tas.
    const h = makeService({ bumpCount: 0 })

    await expect(sendFormal(h)).rejects.toThrow(/ändrade tillstånd/)

    expect(h.txClient.invoiceLine.create).not.toHaveBeenCalled()
    expect(h.accounting.bookReminderFee).not.toHaveBeenCalled()
    expect(h.mail.sendReminderFormal).not.toHaveBeenCalled()
    expect(h.rec.ordning).not.toContain('tx:commit')
  })

  it('totalen räknas upp med increment, inte med ett absolut värde', async () => {
    // Absolut värde härlett ur en läsning UTANFÖR transaktionen är lost
    // update-formen. `increment` är atomiskt i databasen.
    const h = makeService({})
    await sendFormal(h)

    const calls = h.txClient.invoice.updateMany.mock.calls as unknown as Array<
      [{ data: { total: { increment: unknown } }; where: Record<string, unknown> }]
    >
    expect(calls).toHaveLength(1)
    expect(Number(calls[0]![0].data.total.increment)).toBe(60)
    // Och omprövningen av förutsättningarna står i samma where.
    expect(calls[0]![0].where).toMatchObject({ status: 'OVERDUE', remindersPaused: false })
    // Den gamla absoluta skrivningen ska vara borta.
    expect(h.txClient.invoice.update).not.toHaveBeenCalled()
  })

  it('verifikatet bokförs med samma tx som avgiftsraden (INV-A)', async () => {
    const h = makeService({})
    await sendFormal(h)

    const calls = h.accounting.bookReminderFee.mock.calls as unknown as Array<
      [{ tx?: unknown; sourceId: string; source: string }]
    >
    expect(calls).toHaveLength(1)
    const arg = calls[0]![0]
    expect(arg.tx).toBe(h.txClient)
    expect(arg.source).toBe('INVOICE')
    expect(arg.sourceId).toBe('reminder-fee:inv-1')
  })

  it('anspråk redan taget (count = 0) → ingen avgiftsrad, inget verifikat, inget utskick', async () => {
    const h = makeService({ claimCount: 0 })
    await sendFormal(h)

    expect(h.txClient.invoiceLine.create).not.toHaveBeenCalled()
    expect(h.txClient.invoice.update).not.toHaveBeenCalled()
    expect(h.accounting.bookReminderFee).not.toHaveBeenCalled()
    expect(h.mail.sendReminderFormal).not.toHaveBeenCalled()
  })

  it('bookReminderFee ger null (saknad kontoplan) → kastar, inget utskick', async () => {
    const h = makeService({ bookReturns: null })

    await expect(sendFormal(h)).rejects.toThrow(/kontoplanen/)

    // Kastet lämnar transaktionen — utskicket får aldrig ske, och i en riktig
    // databas rullas avgiftsraden tillbaka (mätt i riggen, S9).
    expect(h.mail.sendReminderFormal).not.toHaveBeenCalled()
    expect(h.rec.ordning).not.toContain('tx:commit')
  })

  it('avgift 0 → ingen bokföring krävs, och inget kast', async () => {
    // `bookReminderFee` returnerar null både vid avgift ≤ 0 och vid saknad
    // kontoplan. De två fallen får inte behandlas lika: en org som konfigurerat
    // bort avgiften ska få sin påminnelse skickad.
    const h = makeService({ fee: 0, bookReturns: null })
    await sendFormal(h)

    expect(h.accounting.bookReminderFee).not.toHaveBeenCalled()
    expect(h.mail.sendReminderFormal).toHaveBeenCalled()
    // Och ingen 0-kronorsrad: den är ingen affärshändelse, men skulle följa med
    // ut på fakturaunderlaget och i inkassokravet och påstå en lagstadgad
    // avgift på noll kronor. (FAR-granskning #357.)
    expect(h.txClient.invoiceLine.create).not.toHaveBeenCalled()
  })

  it('kö-fel efter commit → avgiften står kvar, markören rörs inte, felet loggas', async () => {
    const h = makeService({ mailRejects: true })
    const spy = jest.spyOn(
      (h.service as never as { logger: { error: () => void } }).logger,
      'error',
    )

    // enqueueSafely kastar aldrig — anroparen ska få tillbaka kontrollen.
    await expect(sendFormal(h)).resolves.toBeUndefined()

    // Pengarna är tagna och bokförda; ingenting rullas tillbaka av ett kö-fel.
    expect(h.txClient.invoiceLine.create).toHaveBeenCalledTimes(1)
    expect(h.accounting.bookReminderFee).toHaveBeenCalledTimes(1)
    expect(h.rec.ordning).toContain('tx:commit')

    // Men det är ett pengaställe: hyresgästen har debiterats utan att få brevet.
    // Det får aldrig passera tyst.
    // FAILED formuleras som "blev inte av" — och får inte förväxlas med TIMEOUT,
    // som bara betyder "kunde inte bekräftas" (jobbet kan ha landat ändå).
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('utskicket MISSLYCKADES'))
    expect(spy).not.toHaveBeenCalledWith(expect.stringContaining('KUNDE INTE BEKRÄFTAS'))

    // Leveranskorrelationen skrivs INTE när köandet misslyckades.
    expect(h.prisma.paymentReminder.updateMany).not.toHaveBeenCalled()

    // En kompenserande SEND_FAILED-post skrivs: REMINDER_SENT ligger redan i
    // den append-only loggen och kan aldrig rättas.
    const events = h.prisma.invoiceEvent.create.mock.calls as unknown as Array<
      [{ data: { type: string } }]
    >
    expect(events.map((c) => c[0].data.type)).toContain('SEND_FAILED')
  })

  it('kö-fel → returnerar false så cronen räknar det som fel, inte som skickat', async () => {
    const h = makeService({ mailRejects: true })
    const priv = h.service as unknown as {
      sendFormalReminder: (inv: unknown, e: string, d: number) => Promise<boolean>
    }
    await expect(priv.sendFormalReminder(h.invoice, 'hg@example.se', 20)).resolves.toBe(false)
  })

  it('lyckat utskick → returnerar true', async () => {
    const h = makeService({})
    const priv = h.service as unknown as {
      sendFormalReminder: (inv: unknown, e: string, d: number) => Promise<boolean>
    }
    await expect(priv.sendFormalReminder(h.invoice, 'hg@example.se', 20)).resolves.toBe(true)
  })

  it('lyckat utskick → leveranskorrelationen skrivs efter commit, inte i transaktionen', async () => {
    const h = makeService({})
    await sendFormal(h)

    expect(h.prisma.paymentReminder.updateMany).toHaveBeenCalledTimes(1)
    expect(h.rec.ordning.indexOf('ICKE-TX:messageId')).toBeGreaterThan(
      h.rec.ordning.indexOf('tx:commit'),
    )
  })
})
