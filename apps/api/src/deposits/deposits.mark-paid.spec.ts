/**
 * Bokföringsfix #3 — deposition markPaid bokför inbetalningen.
 *
 * Tidigare satte markPaid bara Deposit.status + Invoice.status = PAID och skrev
 * ett event — inbetalningen bokfördes ALDRIG. Depositionens kundfordran (1510,
 * bokförd 1510 D / 2890 K vid create) stod kvar öppen trots betald deposition
 * (BFL 5 kap 6 §). markPaid ska nu boka likvidkonto D / 1510 K i samma tx, och
 * rulla tillbaka om verifikatet uteblir.
 */

jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { Prisma } from '@prisma/client'
import { DepositsService } from './deposits.service'

const DEPOSITION = 20_000

function makeService(
  opts: {
    invoiceStatus?: string
    journalReturnsNull?: boolean
    /**
     * #293 — redan registrerade allokeringar på depositionsfakturan, t.ex. en
     * partiell bankmatchning. DET HÄR är parametern som gör riggen
     * diskriminerande: utan den sammanfaller "depositionens belopp" och
     * "fakturans restskuld" i varje test, och en attrapp kan då inte skilja
     * `deposit.amount` från `outstanding` — exakt samma blindhet som
     * `tx === prisma` i #288 och `create → {}` i #290.
     */
    priorAllocations?: number[]
    /** Fakturans total, om den ska skilja sig från depositionsbeloppet. */
    invoiceTotal?: number
  } = {},
) {
  const deposit = {
    id: 'dep-1',
    status: 'PENDING',
    amount: DEPOSITION,
    invoiceId: 'inv-1',
    invoice: { id: 'inv-1', invoiceNumber: 'F-2026-0001', status: opts.invoiceStatus ?? 'DRAFT' },
  }

  // Anropsordningen fångas för att kunna bevisa LÅSORDNINGEN: fakturan låses
  // före depositionen claimas (samma ordning som bankvägen tar dem).
  const ordning: string[] = []
  const spara = (namn: string) => ordning.push(namn)

  const txMock = {
    $queryRaw: jest.fn((..._args: unknown[]) => {
      spara('lås-faktura')
      return Promise.resolve([])
    }),
    deposit: {
      updateMany: jest.fn((..._args: unknown[]) => {
        spara('claim-deposition')
        return Promise.resolve({ count: 1 })
      }),
      findFirstOrThrow: jest.fn().mockResolvedValue({ ...deposit, status: 'PAID' }),
    },
    invoice: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'inv-1',
        status: opts.invoiceStatus ?? 'DRAFT',
        invoiceNumber: 'F-2026-0001',
        total: new Prisma.Decimal(opts.invoiceTotal ?? DEPOSITION),
      }),
      update: jest.fn().mockResolvedValue({}),
    },
    invoiceEvent: { create: jest.fn().mockResolvedValue({}) },
    // #290 — allokeringen depositionsvägen aldrig skrev. Attrappen returnerar
    // ett RIKTIGT id: med `{}` vore nyckeln "...:undefined" och testet nedan
    // kunde inte skilja en verklig allokeringsnyckel från ingen alls.
    invoicePayment: {
      create: jest.fn((..._args: unknown[]) => {
        spara('skriv-allokering')
        return Promise.resolve({ id: 'alloc-dep-1' })
      }),
      findMany: jest
        .fn()
        .mockResolvedValue(
          (opts.priorAllocations ?? []).map((a) => ({ amount: new Prisma.Decimal(a) })),
        ),
    },
  }

  const prisma = {
    deposit: { findFirst: jest.fn().mockResolvedValue(deposit) },
    $transaction: jest.fn((cb: (t: unknown) => unknown) => cb(txMock)),
  }

  const createJournalEntryForInvoiceManualPayment = jest.fn(() =>
    opts.journalReturnsNull ? Promise.resolve(null) : Promise.resolve({ id: 'je-pay-1' }),
  )
  const accounting = { createJournalEntryForInvoiceManualPayment }
  const notifications = { createForAllOrgUsers: jest.fn() }

  const service = new DepositsService(prisma as never, accounting as never, notifications as never)
  return { service, txMock, createJournalEntryForInvoiceManualPayment, ordning }
}

/** Beloppet som faktiskt gick till bokföringen (arg 1 i journalanropet). */
const bokfortBelopp = (fn: jest.Mock): number => (fn.mock.calls[0] as unknown[])[1] as number

describe('DepositsService.markPaid — bokför inbetalningen', () => {
  it('bokför likvidkonto D / 1510 K i samma tx och sätter deposition + faktura PAID', async () => {
    const { service, txMock, createJournalEntryForInvoiceManualPayment } = makeService()

    await service.markPaid('dep-1', 'org-1', 'user-1')

    // Status-guardad deposition-claim
    expect(txMock.deposit.updateMany).toHaveBeenCalledTimes(1)
    expect(txMock.deposit.updateMany.mock.calls[0]?.[0]).toMatchObject({
      where: { id: 'dep-1', status: 'PENDING' },
      data: { status: 'PAID' },
    })
    // Rad-lås på fakturan (serialiserar mot bankmatch)
    expect(txMock.$queryRaw).toHaveBeenCalledTimes(1)
    // Betalningsverifikat bokat ATOMISKT — tx sista argumentet, belopp = deposit.amount
    expect(createJournalEntryForInvoiceManualPayment).toHaveBeenCalledTimes(1)
    const args = createJournalEntryForInvoiceManualPayment.mock.calls[0] as unknown[]
    expect(args[1]).toBe(20_000)
    expect(args[3]).toBe('MANUAL')
    // #290 — allokerings-id:t sköts in FÖRE tx; tx ligger kvar sist.
    expect(args[6]).toBe('alloc-dep-1')
    expect(args[7]).toBe(txMock)
  })

  it('#290: skriver allokeringen som saknades — verifikatet i övrigt OFÖRÄNDRAT', async () => {
    // Depositionsvägen flippade fakturan till PAID med noll InvoicePayment-rader.
    // Restskulden är ett BERÄKNAT tillstånd (computeInvoiceDebt läser
    // allokeringarna), så betalningen var osynlig för samma sanningskälla som
    // alla andra vägar använder. Raden är den betalning som ändå bokförs.
    const { service, txMock, createJournalEntryForInvoiceManualPayment } = makeService()

    await service.markPaid('dep-1', 'org-1', 'user-1')

    expect(txMock.invoicePayment.create).toHaveBeenCalledTimes(1)
    const rad = (txMock.invoicePayment.create.mock.calls[0] as unknown[])[0] as {
      data: { invoiceId: string; amount: number; paidAt: Date; source: string }
    }
    expect(rad.data.invoiceId).toBe('inv-1')
    // Allokeringen bär SAMMA belopp som verifikatet — ingen ny sanning, bara den
    // som redan bokfördes, nu synlig för restskuldsberäkningen.
    expect(Number(rad.data.amount)).toBe(20_000)
    expect(rad.data.source).toBe('MANUAL')

    const args = createJournalEntryForInvoiceManualPayment.mock.calls[0] as unknown[]
    // Verifikatets argument fält för fält — allt utom nyckeln är som före #290.
    expect(args[0]).toEqual({ id: 'inv-1', invoiceNumber: 'F-2026-0001' }) // samma faktura
    expect(args[1]).toBe(20_000) // samma belopp
    expect(args[2]).toBe(rad.data.paidAt) // samma datum som allokeringen
    expect(args[3]).toBe('MANUAL') // samma betalsätt → samma likvidkonto
    expect(args[4]).toBe('org-1')
    expect(args[5]).toBe('user-1')
    // Moms och kontering ligger i accounting-lagret och rörs inte av #290 — se
    // accounting.invoice-payment.spec.ts.
  })

  it('#290: allokeringen skrivs BARA i grenen som också sätter PAID (ingen dubbelräkning)', async () => {
    // Fakturan redan reglerad av en bankmatch → varken verifikat, statusskrivning
    // ELLER allokering. Annars hade bankvägens allokering fått en tvilling och
    // Σ allokeringar överstigit det som faktiskt kommit in.
    const { service, txMock, createJournalEntryForInvoiceManualPayment } = makeService({
      invoiceStatus: 'PAID',
    })

    await service.markPaid('dep-1', 'org-1', 'user-1')

    expect(txMock.invoicePayment.create).not.toHaveBeenCalled()
    expect(createJournalEntryForInvoiceManualPayment).not.toHaveBeenCalled()
  })

  it('#293: PARTIAL med 5 000 redan bankmatchat → bokför RESTSKULDEN 15 000, inte 20 000', async () => {
    // Reproduktionen från #293. En depositionsfaktura är en helt vanlig Invoice
    // och kan delbetalas via bankens manualMatch(..., allowPartial). Före fixen
    // läste den här grenen bara inv.status och bokförde blint deposit.amount
    // ovanpå det som redan kommit in: 5 000 + 20 000 = 25 000 mot 1930 på en
    // fordran på 20 000, alltså 5 000 kr som aldrig tagits emot.
    const { service, txMock, createJournalEntryForInvoiceManualPayment } = makeService({
      invoiceStatus: 'PARTIAL',
      priorAllocations: [5_000],
    })

    await service.markPaid('dep-1', 'org-1', 'user-1')

    // DET HÄR är assertionen som fäller den gamla koden: 15 000, inte 20 000.
    expect(bokfortBelopp(createJournalEntryForInvoiceManualPayment)).toBe(15_000)
    // …och den skiljer sig från depositionens belopp, vilket är hela poängen.
    expect(bokfortBelopp(createJournalEntryForInvoiceManualPayment)).not.toBe(DEPOSITION)

    // Allokeringen bär samma belopp som verifikatet — annars divergerar
    // allokeringstabellen från huvudboken.
    const rad = (txMock.invoicePayment.create.mock.calls[0] as unknown[])[0] as {
      data: { amount: unknown }
    }
    expect(Number(rad.data.amount)).toBe(15_000)

    // Σ allokeringar (5 000 + 15 000) = fakturans total. Den nya
    // detektionssignalen — Σ allokeringar > total — håller alltså.
    expect(5_000 + Number(rad.data.amount)).toBe(DEPOSITION)

    // Händelseloggen påstår samma sak som verifikatet, inte deposit.amount.
    const event = (txMock.invoiceEvent.create.mock.calls[0] as unknown[])[0] as {
      data: { payload: { amount: number } }
    }
    expect(event.data.payload.amount).toBe(15_000)

    // Fordran är helt reglerad → fakturan blir PAID.
    expect(txMock.invoice.update).toHaveBeenCalledTimes(1)
    expect(txMock.invoice.update.mock.calls[0]?.[0]).toMatchObject({ data: { status: 'PAID' } })
  })

  it('#293: normalfallet är OFÖRÄNDRAT — ingen tidigare allokering → hela beloppet', async () => {
    // Utan allokeringar är restskulden hela totalen, så restskulds-bokningen
    // degenererar till exakt dagens beteende. Utan det här testet vore fixen
    // inte skild från "bokför alltid mindre".
    const { service, createJournalEntryForInvoiceManualPayment } = makeService({
      priorAllocations: [],
    })

    await service.markPaid('dep-1', 'org-1', 'user-1')

    expect(bokfortBelopp(createJournalEntryForInvoiceManualPayment)).toBe(DEPOSITION)
  })

  it('#293: restskuld 0 (banken hann före) → INGET nytt verifikat, men depositionen läks till PAID', async () => {
    // Fakturan är fullt allokerad men statusen hann inte med. Då finns inget att
    // bokföra — och det får inte hindra att den hängande PENDING-depositionen
    // rättas, annars kan den aldrig återbetalas.
    const { service, txMock, createJournalEntryForInvoiceManualPayment } = makeService({
      invoiceStatus: 'PARTIAL',
      priorAllocations: [DEPOSITION],
    })

    await service.markPaid('dep-1', 'org-1', 'user-1')

    expect(createJournalEntryForInvoiceManualPayment).not.toHaveBeenCalled()
    expect(txMock.invoicePayment.create).not.toHaveBeenCalled()
    expect(txMock.invoice.update).not.toHaveBeenCalled()
    // Depositionen claimas ändå — läkningen.
    expect(txMock.deposit.updateMany).toHaveBeenCalledTimes(1)
  })

  it('#293: överallokerad faktura (restskuld negativ) bokför INGENTING', async () => {
    const { service, txMock, createJournalEntryForInvoiceManualPayment } = makeService({
      invoiceStatus: 'PARTIAL',
      priorAllocations: [25_000],
    })

    await service.markPaid('dep-1', 'org-1', 'user-1')

    expect(createJournalEntryForInvoiceManualPayment).not.toHaveBeenCalled()
    expect(txMock.invoicePayment.create).not.toHaveBeenCalled()
  })

  it('#293: restskulden läses INNANFÖR radlåset, och depositionen claimas EFTER fakturan låsts', async () => {
    // Låsordningen faktura → deposition är densamma som bankvägens
    // (applyMatchToInvoice: FOR UPDATE på fakturan, sedan updateMany på Deposit).
    // Omvänd ordning kunde få de två vägarna att vänta in varandra korsvis.
    const { service, txMock, ordning } = makeService({
      invoiceStatus: 'PARTIAL',
      priorAllocations: [5_000],
    })

    await service.markPaid('dep-1', 'org-1', 'user-1')

    expect(ordning).toEqual(['lås-faktura', 'skriv-allokering', 'claim-deposition'])
    // Allokeringsläsningen sker på transaktionsklienten, inte bredvid den.
    expect(txMock.invoicePayment.findMany).toHaveBeenCalledTimes(1)
    expect(txMock.invoicePayment.findMany.mock.calls[0]?.[0]).toMatchObject({
      where: { invoiceId: 'inv-1' },
    })
  })

  it('rullar tillbaka (kastar) om verifikatet uteblir — ingen PAID utan verifikat', async () => {
    const { service } = makeService({ journalReturnsNull: true })
    await expect(service.markPaid('dep-1', 'org-1', 'user-1')).rejects.toThrow(
      /verifikat kunde inte skapas/i,
    )
  })

  it('dubbelbokför inte om fakturan redan reglerats av en bankmatch (status PAID)', async () => {
    const { service, txMock, createJournalEntryForInvoiceManualPayment } = makeService({
      invoiceStatus: 'PAID',
    })

    await service.markPaid('dep-1', 'org-1', 'user-1')

    // Depositionen markeras betald, men ingen ny bokning/statusskrivning på fakturan
    expect(txMock.deposit.updateMany).toHaveBeenCalledTimes(1)
    expect(createJournalEntryForInvoiceManualPayment).not.toHaveBeenCalled()
    expect(txMock.invoice.update).not.toHaveBeenCalled()
  })
})
