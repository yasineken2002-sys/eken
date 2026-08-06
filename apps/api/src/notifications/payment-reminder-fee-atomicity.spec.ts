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
      findMany: jest.fn(async () => [invoice]),
    },
    invoiceEvent: {
      create: jest.fn(async () => {
        rec.ordning.push('händelse')
        return { id: 'ev-1' }
      }),
    },
  }

  const prisma = {
    ...txClient,
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
    for (const steg of ['claim', 'avgiftsrad', 'total', 'verifikat', 'händelse']) {
      const i = h.rec.ordning.indexOf(steg)
      expect(i).toBeGreaterThan(start)
      expect(i).toBeLessThan(commit)
    }

    // Utskicket ligger EFTER commit — aldrig inuti transaktionen.
    expect(h.rec.ordning.indexOf('utskick')).toBeGreaterThan(commit)
    expect(h.prisma.$transaction).toHaveBeenCalledTimes(1)
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
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('utskicket kunde inte köas'))

    // Leveranskorrelationen skrivs INTE när köandet misslyckades.
    expect(h.txClient.paymentReminder.updateMany).not.toHaveBeenCalled()
  })

  it('lyckat utskick → leveranskorrelationen skrivs efter commit, inte i transaktionen', async () => {
    const h = makeService({})
    await sendFormal(h)

    expect(h.txClient.paymentReminder.updateMany).toHaveBeenCalledTimes(1)
    expect(h.rec.ordning.indexOf('messageId')).toBeGreaterThan(h.rec.ordning.indexOf('tx:commit'))
  })
})
