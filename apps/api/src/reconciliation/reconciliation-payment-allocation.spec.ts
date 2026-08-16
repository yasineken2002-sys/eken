/**
 * Bankavstämnings-härdning PR 3b — PARTIELL bankmatchning.
 *
 * Seriens ENDA icke-penganeutrala PR: en delbetalning bokför ett RIKTIGT
 * partialverifikat (1930/1510) på delbeloppet. Testerna bevisar:
 *   • MIS-ALLOKERING: delbetalning bara via deterministisk OCR/referens (rätt avi,
 *     rätt belopp); fuzzy förblir allt-eller-inget (D3).
 *   • GRÄNSFALL: ören-fel (inom toleransbandet) → full betalning; > tolerans → partiell.
 *   • ATOMICITET: kastar bokföringen mitt i → HELA matchningen rullas tillbaka
 *     (felet propageras, inte längre fire-and-forget).
 *   • TVÅ DELBETALNINGAR → PAID vid den andra (outstanding-medveten flip).
 *   • PENGA-INVARIANT: allokeringens belopp == partialverifikatets belopp.
 *   • ÖVERBETALNING mot EN avi: ingen match (UNMATCHED). Gäller fortfarande —
 *     men bara när det är den ENDA öppna avin. Täcker beloppet flera avier tar
 *     vattenfallet över (H3 PR B, waterfall-allocation.spec.ts); överstiger det
 *     HELA den öppna skulden avvisas det där också (#482).
 */

jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { Decimal } from '@prisma/client/runtime/library'
import { InternalServerErrorException } from '@nestjs/common'
import { ReconciliationService } from './reconciliation.service'

function dec(n: number | string) {
  return new Decimal(n)
}

function makeService(opts: {
  transaction?: Record<string, unknown>
  /** Kandidat som väljs av OCR/referens i matchTransaction (db.rentNotice.findFirst). */
  ocrCandidate?: Record<string, unknown> | null
  /** Kandidat(er) för fuzzy-grenen (db.rentNotice.findMany). */
  fuzzyNotices?: Array<Record<string, unknown>>
  /** Avin som re-läses INNE i transaktionen (skuldkomponenter). */
  txNotice?: Record<string, unknown>
  /** Tidigare allokeringar (för outstanding-beräkningen inne i tx). */
  priorAllocations?: Array<{ amount: Decimal }>
  journalThrows?: boolean
  journalReturnsNull?: boolean
}) {
  const txNotice = opts.txNotice ?? {
    id: 'rn-1',
    noticeNumber: 'AVI-2026-06-0001',
    status: 'SENT',
    collectionStage: 'NONE',
    type: 'RENT',
    totalAmount: dec('8000'),
    consumptionAmount: dec('0'),
    miscChargeAmount: dec('0'),
    reminderFeeAmount: dec('0'),
    interestAccruedAmount: dec('0'),
  }

  const txMock = {
    // PR 3b — rad-lås (FOR UPDATE) serialiserar samtidiga delbetalningar.
    $queryRaw: jest.fn().mockResolvedValue([]),
    rentNotice: {
      // H3 PR B: vattenfallet läser kandidater med findMany. Tom lista = inga
      // fler öppna avier, alltså inget vattenfall — riggens fall ägs av
      // enskildvägen och beteendet är oförändrat.
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(txNotice),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({}),
    },
    rentNoticePayment: {
      findMany: jest.fn().mockResolvedValue(opts.priorAllocations ?? []),
      create: jest.fn().mockResolvedValue({ id: 'rnp-x' }),
    },
    bankTransaction: { update: jest.fn().mockResolvedValue({}) },
    rentNoticeEvent: { create: jest.fn().mockResolvedValue({}) },
  }

  const createJournalEntryForRentNoticePayment = jest.fn()
  if (opts.journalThrows) {
    createJournalEntryForRentNoticePayment.mockRejectedValue(new Error('Bokföring nere'))
  } else if (opts.journalReturnsNull) {
    createJournalEntryForRentNoticePayment.mockResolvedValue(null)
  } else {
    createJournalEntryForRentNoticePayment.mockResolvedValue({ id: 'je-1' })
  }

  const prisma = {
    bankTransaction: {
      findFirst: jest.fn().mockResolvedValue(opts.transaction ?? null),
      update: jest.fn().mockResolvedValue({}),
    },
    rentNotice: {
      findFirst: jest.fn().mockResolvedValue(opts.ocrCandidate ?? null),
      findMany: jest.fn().mockResolvedValue(opts.fuzzyNotices ?? []),
    },
    invoice: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
    },
    // Speglar Prisma interaktiv $transaction: kör callbacken med tx-klienten;
    // kastar callbacken propagerar felet (= rollback i verklig DB).
    $transaction: jest.fn((cb: (t: unknown) => unknown) => cb(txMock)),
  }

  const accounting = { createJournalEntryForRentNoticePayment }
  const events = { record: jest.fn().mockResolvedValue(undefined) }
  // #340: kravstegs-trailen går numera via RentNoticeEventsService.record(), som
  // denormaliserar aktörsetiketten. Attrappen namnges så testet kan assertera
  // på ANROPET i stället för på en rå rentNoticeEvent.create.
  const rentNoticeEvents = { record: jest.fn().mockResolvedValue({}) }

  const service = new ReconciliationService(
    prisma as never,
    {} as never, // invoices
    events as never,
    accounting as never,
    {} as never, // PaymentFreshnessService — ej använd i matchnings-/unmatch-vägen,
    rentNoticeEvents as never, // #326 C — RentNoticeEventsService
  )
  return { service, prisma, txMock, createJournalEntryForRentNoticePayment, rentNoticeEvents }
}

const OCR_TX = (amount: number) => ({
  id: 'tx-1',
  rawOcr: '1234567890',
  amount: dec(amount),
  date: new Date('2026-06-15'),
  description: '',
  reference: '',
})

// ── 1. MIS-ALLOKERING + partiell allokering via OCR ────────────────────────────
describe('PR3b · OCR delbetalning — rätt avi, rätt belopp', () => {
  it('amount < restskuld → PARTIELL allokering på delbeloppet, ingen PAID-flip', async () => {
    const { service, txMock, createJournalEntryForRentNoticePayment } = makeService({
      transaction: OCR_TX(5000),
      ocrCandidate: { id: 'rn-1' },
    })

    const matched = await service.matchTransaction(OCR_TX(5000) as never, 'org-1')
    expect(matched).toBe(true)

    // Allokeringen avser DELBELOPPET, länkad till rätt avi + bank-tx.
    const alloc = txMock.rentNoticePayment.create.mock.calls[0]![0].data
    expect(alloc).toMatchObject({
      rentNoticeId: 'rn-1',
      bankTransactionId: 'tx-1',
      source: 'BANK_RECONCILIATION',
    })
    expect(new Decimal(alloc.amount).toNumber()).toBe(5000)

    // INGEN PAID-flip: uppdateringen sätter bara paidAmount-spegeln, ingen status.
    expect(txMock.rentNotice.updateMany).toHaveBeenCalledTimes(1)
    const partUpd = txMock.rentNotice.updateMany.mock.calls[0]![0]
    expect(partUpd.data).toEqual({ paidAmount: 5000 })
    expect(partUpd.where).toMatchObject({ id: 'rn-1', organizationId: 'org-1' })

    // PENGA-INVARIANT: partialverifikatet bokförs på EXAKT delbeloppet, atomiskt (tx).
    expect(createJournalEntryForRentNoticePayment).toHaveBeenCalledTimes(1)
    const jArgs = createJournalEntryForRentNoticePayment.mock.calls[0]!
    expect(new Decimal(jArgs[1].amount).toNumber()).toBe(5000)
    expect(jArgs[4]).toBe(txMock) // tx vidareskickad → atomiskt
  })

  it('väljer ÄLDSTA obetalda avi (orderBy dueDate asc) i OCR-kandidatsökningen', async () => {
    const { service, prisma } = makeService({
      transaction: OCR_TX(5000),
      ocrCandidate: { id: 'rn-1' },
    })
    await service.matchTransaction(OCR_TX(5000) as never, 'org-1')
    const findArgs = prisma.rentNotice.findFirst.mock.calls[0]![0]
    expect(findArgs.orderBy).toEqual([{ dueDate: 'asc' }, { createdAt: 'asc' }])
  })
})

// ── 2. GRÄNSFALL: ören-fel vs genuin delbetalning ──────────────────────────────
describe('PR3b · toleransbandet skiljer ören-fel från delbetalning', () => {
  it('ören-fel (restskuld − 0,50) → FULL betalning, allokerar HELA restskulden (öre absorberas) → PAID', async () => {
    const { service, txMock } = makeService({
      transaction: OCR_TX(7999.5),
      ocrCandidate: { id: 'rn-1' },
    })
    await service.matchTransaction(OCR_TX(7999.5) as never, 'org-1')

    // Allokeringen = restskulden (8000), inte det inkomna 7999,50 → 1510 nollas rent.
    const alloc = txMock.rentNoticePayment.create.mock.calls[0]![0].data
    expect(new Decimal(alloc.amount).toNumber()).toBe(8000)
    // FULL → PAID via status-guardad updateMany + kravsteg NONE.
    expect(txMock.rentNotice.updateMany).toHaveBeenCalledTimes(1)
    expect(txMock.rentNotice.updateMany.mock.calls[0]![0].data).toMatchObject({
      status: 'PAID',
      paidAmount: 8000,
      collectionStage: 'NONE',
    })
  })

  it('restskuld − 2 kr (> tolerans) → genuin PARTIELL betalning', async () => {
    const { service, txMock } = makeService({
      transaction: OCR_TX(7998),
      ocrCandidate: { id: 'rn-1' },
    })
    await service.matchTransaction(OCR_TX(7998) as never, 'org-1')
    expect(
      new Decimal(txMock.rentNoticePayment.create.mock.calls[0]![0].data.amount).toNumber(),
    ).toBe(7998)
    // ej PAID — updateMany sätter bara paidAmount, ingen status.
    expect(txMock.rentNotice.updateMany.mock.calls[0]![0].data.status).toBeUndefined()
  })
})

// ── 3. ATOMICITET: krasch i bokföringen → full rollback (ej fire-and-forget) ────
describe('PR3b · atomicitet — verifikatet är inte fire-and-forget', () => {
  it('bokföringen KASTAR → felet propageras (hela tx rullar tillbaka)', async () => {
    const { service } = makeService({
      transaction: OCR_TX(5000),
      ocrCandidate: { id: 'rn-1' },
      journalThrows: true,
    })
    await expect(service.matchTransaction(OCR_TX(5000) as never, 'org-1')).rejects.toThrow(
      'Bokföring nere',
    )
  })

  it('bokföringen returnerar null (saknat 1930/1510) för RENT → 500 → rollback', async () => {
    const { service } = makeService({
      transaction: OCR_TX(5000),
      ocrCandidate: { id: 'rn-1' },
      journalReturnsNull: true,
    })
    await expect(service.matchTransaction(OCR_TX(5000) as never, 'org-1')).rejects.toBeInstanceOf(
      InternalServerErrorException,
    )
  })
})

// ── 4. TVÅ DELBETALNINGAR → PAID vid den andra ─────────────────────────────────
describe('PR3b · ackumulerade delbetalningar', () => {
  it('andra delbetalningen som täcker resten → PAID, paidAmount = Σ allokeringar', async () => {
    // Tidigare delbetalning 6000 finns; ny betalning 2000 → restskuld 2000 → FULL.
    const { service, txMock } = makeService({
      transaction: OCR_TX(2000),
      ocrCandidate: { id: 'rn-1' },
      priorAllocations: [{ amount: dec('6000') }],
    })
    await service.matchTransaction(OCR_TX(2000) as never, 'org-1')

    // Allokeringen = restskulden 2000.
    expect(
      new Decimal(txMock.rentNoticePayment.create.mock.calls[0]![0].data.amount).toNumber(),
    ).toBe(2000)
    // PAID, paidAmount = 6000 + 2000 = 8000 (Σ allokeringar).
    expect(txMock.rentNotice.updateMany.mock.calls[0]![0].data).toMatchObject({
      status: 'PAID',
      paidAmount: 8000,
    })
  })

  it('fullt OCR-reglerad avi (ocrOutstanding 0) → ingen ny match', async () => {
    const { service, txMock } = makeService({
      transaction: OCR_TX(3000),
      ocrCandidate: { id: 'rn-1' },
      priorAllocations: [{ amount: dec('8000') }], // redan fullbetald
    })
    const matched = await service.matchTransaction(OCR_TX(3000) as never, 'org-1')
    expect(matched).toBe(false)
    expect(txMock.rentNoticePayment.create).not.toHaveBeenCalled()
  })
})

// ── 5. ÖVERBETALNING mot EN ENDA avi → UNMATCHED ───────────────────────────────
//
// ERSÄTTER ett tidigare medvetet lås. Testet hette "överbetalning (D4) hanteras
// ej här" och låste beteendet att en klumpbetalning ALDRIG fördelas. D4 revs i
// H3 PR B — skälet fanns aldrig nedskrivet, och det närliggande argumentet om
// kundkredit/klampning motiverar inte ett vattenfall, som varken accepterar
// tyst eller klampar. Se #109 och `applyWaterfallToRentNotices`.
//
// Det som återstår av låset — och som fortfarande gäller — är detta: när det
// finns EN öppen avi och beloppet överstiger dess restskuld sker ingen match.
// Riggens `findMany` returnerar tom lista, alltså inga fler kandidater, så
// vattenfallet avstår och enskildvägens regel är den som prövas.
describe('PR3b/H3 · överbetalning mot en ENDA avi hanteras inte här', () => {
  it('amount > restskuld + tolerans → ingen allokering, ingen bokföring, matched false', async () => {
    const { service, txMock, createJournalEntryForRentNoticePayment } = makeService({
      transaction: OCR_TX(9000),
      ocrCandidate: { id: 'rn-1' },
    })
    const matched = await service.matchTransaction(OCR_TX(9000) as never, 'org-1')
    expect(matched).toBe(false)
    expect(txMock.rentNoticePayment.create).not.toHaveBeenCalled()
    expect(createJournalEntryForRentNoticePayment).not.toHaveBeenCalled()
  })
})

// ── 6. D3: fuzzy förblir ALLT-ELLER-INGET ──────────────────────────────────────
describe('PR3b · D3 — fuzzy är allt-eller-inget', () => {
  it('fuzzy FULL betalning matchar fortfarande (atomiskt verifikat)', async () => {
    const tx = {
      id: 'tx-f',
      rawOcr: null,
      amount: dec('8000'),
      date: new Date('2026-06-20'),
      description: '',
      reference: '',
    }
    const { service, txMock, createJournalEntryForRentNoticePayment } = makeService({
      transaction: tx,
      fuzzyNotices: [
        {
          id: 'rn-1',
          totalAmount: dec('8000'),
          consumptionAmount: dec('0'),
          miscChargeAmount: dec('0'),
          reminderFeeAmount: dec('0'),
        },
      ],
    })
    const matched = await service.matchTransaction(tx as never, 'org-1')
    expect(matched).toBe(true)
    expect(txMock.rentNotice.updateMany.mock.calls[0]![0].data.status).toBe('PAID')
    expect(createJournalEntryForRentNoticePayment).toHaveBeenCalledTimes(1)
  })

  it('fuzzy med ett DELbelopp matchar ALDRIG (filtret kräver ≈ full payable) → UNMATCHED', async () => {
    const tx = {
      id: 'tx-f2',
      rawOcr: null,
      amount: dec('5000'),
      date: new Date('2026-06-20'),
      description: '',
      reference: '',
    }
    const { service, txMock } = makeService({
      transaction: tx,
      fuzzyNotices: [
        {
          id: 'rn-1',
          totalAmount: dec('8000'),
          consumptionAmount: dec('0'),
          miscChargeAmount: dec('0'),
          reminderFeeAmount: dec('0'),
        },
      ],
    })
    const matched = await service.matchTransaction(tx as never, 'org-1')
    expect(matched).toBe(false)
    expect(txMock.rentNoticePayment.create).not.toHaveBeenCalled()
  })
})

// ── 7. PR2-regression: full betalning av INKASSO_READY → NONE + trail ──────────
describe('PR3b · full betalning nollställer kravsteget (PR2 oförändrat)', () => {
  it('OCR FULL betalning av INKASSO_READY-avi → status PAID + collectionStage NONE + trail', async () => {
    const { service, txMock, rentNoticeEvents } = makeService({
      transaction: OCR_TX(8000),
      ocrCandidate: { id: 'rn-1' },
      txNotice: {
        id: 'rn-1',
        noticeNumber: 'AVI-2026-06-0001',
        status: 'OVERDUE',
        collectionStage: 'INKASSO_READY',
        type: 'RENT',
        totalAmount: dec('8000'),
        consumptionAmount: dec('0'),
        miscChargeAmount: dec('0'),
        reminderFeeAmount: dec('0'),
        interestAccruedAmount: dec('0'),
      },
    })
    await service.matchTransaction(OCR_TX(8000) as never, 'org-1')

    expect(txMock.rentNotice.updateMany.mock.calls[0]![0].data).toMatchObject({
      status: 'PAID',
      collectionStage: 'NONE',
    })
    // #340: skrivningen går via record() — inte en rå create — så aktörsetiketten
    // denormaliseras och överlever att användaren raderas.
    // M2 PR 1: avi-grenen skriver numera OCKSÅ en PAYMENT_RECEIVED-post, före
    // den här. Assertionen letar därför upp kravstegs-noteringen i stället för
    // att anta att den är först — testets AVSIKT är noteringens innehåll, inte
    // dess plats i anropsordningen. Noteringen själv är oförändrad.
    const [noticeId, type, actorType, actorId, payload] = rentNoticeEvents.record.mock.calls.find(
      (c) => c[1] === 'NOTE_ADDED',
    )!
    expect(noticeId).toBe('rn-1')
    expect(type).toBe('NOTE_ADDED')
    expect(actorType).toBe('SYSTEM')
    expect(actorId).toBeNull()
    expect(payload).toMatchObject({
      action: 'collection-stage-reset',
      from: 'INKASSO_READY',
      reason: 'paid',
    })
    // Ingen rå create kvar på den här vägen.
    expect(txMock.rentNoticeEvent.create).not.toHaveBeenCalled()
  })

  it('PARTIELL betalning av INKASSO_READY-avi → kravsteget rörs INTE, ingen trail', async () => {
    const { service, txMock } = makeService({
      transaction: OCR_TX(3000),
      ocrCandidate: { id: 'rn-1' },
      txNotice: {
        id: 'rn-1',
        noticeNumber: 'AVI-2026-06-0001',
        status: 'OVERDUE',
        collectionStage: 'INKASSO_READY',
        type: 'RENT',
        totalAmount: dec('8000'),
        consumptionAmount: dec('0'),
        miscChargeAmount: dec('0'),
        reminderFeeAmount: dec('0'),
        interestAccruedAmount: dec('0'),
      },
    })
    await service.matchTransaction(OCR_TX(3000) as never, 'org-1')
    // Partiell → bara paidAmount uppdateras, ingen status/stage-flip, ingen trail.
    expect(txMock.rentNotice.updateMany.mock.calls[0]![0].data.status).toBeUndefined()
    expect(txMock.rentNotice.updateMany.mock.calls[0]![0].data.collectionStage).toBeUndefined()
    expect(txMock.rentNoticeEvent.create).not.toHaveBeenCalled()
  })
})

// ── 8. manualMatch: delbetalning + överbetalning ───────────────────────────────
describe('PR3b · manualMatch respekterar faktiskt belopp', () => {
  it('manuell matchning av ett delbelopp → delbetalning (avin förblir obetald)', async () => {
    const { service, txMock } = makeService({
      transaction: { id: 'tx-m', date: new Date('2026-06-15'), amount: dec('4000') },
      ocrCandidate: { id: 'rn-1' }, // prisma.rentNotice.findFirst (target-existens)
    })
    await service.manualMatch('tx-m', { rentNoticeId: 'rn-1' }, 'org-1', 'user-1')
    expect(
      new Decimal(txMock.rentNoticePayment.create.mock.calls[0]![0].data.amount).toNumber(),
    ).toBe(4000)
    // ej PAID — bara paidAmount-spegeln.
    expect(txMock.rentNotice.updateMany.mock.calls[0]![0].data.status).toBeUndefined()
  })

  // OFÖRÄNDRAD av H3 PR B, med flit: manuell matchning pekar ut EN bestämd avi
  // som operatören valt. Ett vattenfall där hade gått emot det valet. Vattenfallet
  // körs bara i den AUTOMATISKA OCR-grenen, där identifieraren är hyresgästens
  // betalningsidentitet och inte ett utpekat objekt.
  it('manuell matchning av en överbetalning → BadRequest (oförändrad efter H3)', async () => {
    const { service } = makeService({
      transaction: { id: 'tx-m2', date: new Date('2026-06-15'), amount: dec('9000') },
      ocrCandidate: { id: 'rn-1' },
    })
    await expect(
      service.manualMatch('tx-m2', { rentNoticeId: 'rn-1' }, 'org-1', 'user-1'),
    ).rejects.toThrow(/restskuld|reglerad/)
  })
})
