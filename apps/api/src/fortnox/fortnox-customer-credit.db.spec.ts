/** Riktig bokföring/Postgres och syntetiska bank/Fortnox-portar. Inga nätverksanrop. */
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { ConflictException, NotFoundException } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Prisma } from '@prisma/client'
import type { FortnoxAccountMappingRowInput } from '@eken/shared'
import { runWithActor } from '../common/actor/actor.context'
import { PrismaService } from '../common/prisma/prisma.service'
import { isIsolatedDatabase } from '../customer-credit/customer-credit-dispatch.test-fixtures'
import {
  booked,
  prepareNotice,
  refundFixture,
} from '../customer-credit/customer-credit-refund.test-fixtures'
import { FortnoxConnectionService } from './fortnox-connection.service'
import { VerifiedVoucherDraftBuilder } from './fortnox-export-builder'
import { FortnoxExportService, type FortnoxVoucherDraftBuilder } from './fortnox-export.service'
import { godkannMappning } from './fortnox-kontomappning.testing'
import type { LedgerRowProvenance } from './fortnox-ledger'
import { MockFortnoxAuthProvider, MockFortnoxLedgerReader } from './fortnox-providers'
import { FortnoxReadbackService } from './fortnox-readback.service'
import { FortnoxSendService } from './fortnox-send.service'
import { FortnoxTokenCryptoService } from './fortnox-token-crypto.service'
import { MockVoucherWriter } from './fortnox-voucher-writer'

// Läsningen mäter rollback i testerna, den allokerar aldrig verifikationsnummer.
async function accountingSnapshot(prisma: PrismaService, organizationId: string) {
  return JSON.stringify(
    await Promise.all([
      prisma.journalEntry.findMany({
        where: { organizationId },
        orderBy: { id: 'asc' },
        include: { lines: { orderBy: { id: 'asc' } } },
      }),
      prisma.journalEntrySequence.findMany({
        where: { organizationId },
        orderBy: [{ series: 'asc' }, { fiscalYear: 'asc' }],
      }),
    ]),
  )
}

jest.setTimeout(60_000)
const ISOLATED = isIsolatedDatabase()
const medDb = ISOLATED ? describe : describe.skip
const human = <T>(run: () => T) => runWithActor('HUMAN', run)
const system = <T>(run: () => T) => runWithActor('SYSTEM', run)
const USER = 'synthetic-fortnox-owner'

it('tillgodots exportprov kräver en uttryckligt isolerad databas även om sviten annars hoppas över', () => {
  expect(ISOLATED).toBe(true)
})

const mapping = (bank = 1940, liability = 2997): FortnoxAccountMappingRowInput[] => [
  {
    role: 'KUNDFORDRAN',
    vatTreatment: 'EJ_TILLAMPLIG',
    sourceAccountNumber: 1510,
    targetAccountNumber: 1510,
  },
  {
    role: 'HYRESINTAKT',
    vatTreatment: 'MOMSFRI',
    sourceAccountNumber: 3911,
    targetAccountNumber: 3915,
  },
  {
    role: 'LIKVID',
    vatTreatment: 'EJ_TILLAMPLIG',
    sourceAccountNumber: 1930,
    targetAccountNumber: bank,
  },
  {
    role: 'KUNDTILLGODOSKULD',
    vatTreatment: 'EJ_TILLAMPLIG',
    sourceAccountNumber: 2998,
    targetAccountNumber: liability,
  },
]

/** Bara Fortnox-kopplingen är ny. Domänrader/verifikat kommer från ordinarie tillgodotjänster. */
async function setup(
  prisma: PrismaService,
  options: { approve?: boolean; settle?: boolean; sourcePeriod?: Date } = {},
) {
  const r = await refundFixture(prisma, {
    creditAmount: '100.00',
    targetAmount: '60.00',
    ...(options.sourcePeriod === undefined ? {} : { sourcePeriod: options.sourcePeriod }),
  })
  if (options.sourcePeriod) {
    // Historisk avräkning via offentlig tjänst; ingen sen automatisk aviavräkning.
    // Jan15 årB, begränsad till nu om provet körs före den dagen i januari.
    const appliedAt = new Date(
      Math.min(Date.UTC(r.f.target.year, r.f.target.month - 1, 15, 12), Date.now()),
    )
    await system(() =>
      r.credits.applyToNextNotice({
        organizationId: r.f.organizationId,
        creditId: r.credit.id,
        rentNoticeId: r.f.target.id,
        requestId: 'synthetic-fortnox-historical-application',
        amount: new Prisma.Decimal('60.00'),
        appliedAt,
      }),
    )
  } else {
    await system(() => r.credits.prepareNoticeForSend(prepareNotice(r.f)))
  }
  const application = await prisma.customerCreditApplication.findFirstOrThrow({
    where: { creditId: r.credit.id },
  })
  const reservation = await r.reserve('40.00')
  r.bank.send.mockImplementation(async (instruction) => booked(instruction))
  const confirmed = await human(() => r.refund.submitRefund(r.scope(reservation.id)))
  const refund =
    options.settle === false
      ? confirmed
      : await system(() => r.refund.postConfirmedRefund(r.scope(reservation.id)))
  const organizationId = r.f.organizationId
  const journals = await prisma.journalEntry.findMany({ where: { organizationId } })
  const bySource = (sourceId: string) => {
    const row = journals.find((entry) => entry.sourceId === sourceId)
    if (!row) throw new Error(`Fixturen saknar det riktiga verifikatet ${sourceId}`)
    return row
  }
  const source = bySource(`rent-notice:${r.f.source.id}`)
  const payment = bySource(`rent-notice-bank-payment:${r.credit.sourcePaymentId}`)
  const target = bySource(`rent-notice:${r.f.target.id}`)
  const config = new ConfigService({ FORTNOX_TOKEN_KEY: 'cd'.repeat(32), NODE_ENV: 'test' })
  const reader = new MockFortnoxLedgerReader()
  // Alla målkonton här är uttryckligt syntetiska. De är inget BAS- eller produktionsbeslut.
  reader.accounts = [
    { Number: 1510, Description: 'Syntetisk kundfordran', Active: true, VATCode: null },
    { Number: 1940, Description: 'Syntetisk bank A', Active: true, VATCode: null },
    { Number: 1941, Description: 'Syntetisk bank B', Active: true, VATCode: null },
    { Number: 2997, Description: 'Syntetiskt tillgodo A', Active: true, VATCode: null },
    { Number: 2996, Description: 'Syntetiskt tillgodo B', Active: true, VATCode: null },
    { Number: 3915, Description: 'Syntetisk momsfri bostadshyra', Active: true, VATCode: 'MF' },
  ]
  const years = [...new Set(journals.map((entry) => entry.date.getUTCFullYear()))].sort()
  reader.financialYears = years.map((year, index) => ({
    Id: index + 1,
    FromDate: `${year}-01-01`,
    ToDate: `${year}-12-31`,
    AccountingMethod: 'ACCRUAL',
  }))
  const connections = new FortnoxConnectionService(
    prisma,
    new FortnoxTokenCryptoService(config),
    config,
    new MockFortnoxAuthProvider(),
    reader,
  )
  const builder = new VerifiedVoucherDraftBuilder(prisma, connections, reader)
  const exports = new FortnoxExportService(prisma, builder)
  const writer = new MockVoucherWriter(reader)
  const sender = new FortnoxSendService(prisma, connections, builder, reader, writer)
  const readback = new FortnoxReadbackService(prisma, connections, reader, writer)
  const { authUrl } = await connections.begin(organizationId, USER)
  const state = new URL(authUrl).searchParams.get('state')!
  await connections.handleCallback(state, `mock-code-${state.slice(0, 8)}`)
  await connections.setExportVoucherSeries(organizationId, 'A')
  await connections.setExportOmitDimensions(organizationId, USER, true)
  const approve = async (rows = mapping()) => {
    const revisions = []
    for (const year of reader.financialYears) {
      revisions.push(
        await godkannMappning(prisma, connections, reader, organizationId, rows, year.Id),
      )
    }
    return revisions
  }
  if (options.approve !== false) await approve()
  const ready = async (journalEntryId: string) => {
    const row = await exports.dryRun(organizationId, journalEntryId)
    expect([row.state, row.blockReason]).toEqual(['DRY_RUN_READY', null])
    if (!row.draftHash) throw new Error('Förhandskontrollen saknar underlagshash')
    return { ...row, draftHash: row.draftHash }
  }
  const send = async (journalEntryId: string) => {
    const row = await ready(journalEntryId)
    const result = await sender.send(organizationId, USER, row.id, row.draftHash)
    expect(result.state).toBe('CONFIRMED')
    return result
  }
  const origin = async () => {
    await send(source.id)
    await send(payment.id)
  }
  return {
    ...r,
    organizationId,
    application,
    refund,
    source,
    payment,
    target,
    reader,
    connections,
    builder,
    exports,
    writer,
    sender,
    readback,
    approve,
    ready,
    send,
    origin,
  }
}
type Scenario = Awaited<ReturnType<typeof setup>>

const voucherRows = (t: Scenario, index: number) => {
  const voucher = t.reader.vouchers[index]
  if (!voucher) throw new Error('Förväntat Fortnox-verifikat saknas')
  return (voucher.VoucherRows as Array<{ Account: number; Debit?: number; Credit?: number }>)
    .map((row) => [row.Account, row.Debit ?? 0, row.Credit ?? 0])
    .sort((a, b) => a[0]! - b[0]!)
}

/** Avsiktligt förfalskad rå journal, aldrig använd som positiv bokföringsfixture. */
async function forgedPayment(
  prisma: PrismaService,
  t: Scenario,
  sourceId: string,
  debit: number,
  credit: number,
  amount: string,
) {
  const accounts = await prisma.account.findMany({
    where: { organizationId: t.organizationId, number: { in: [debit, credit] } },
  })
  const accountId = (number: number) => {
    const account = accounts.find((row) => row.number === number)
    if (!account) throw new Error(`Motprovet saknar konto ${number}`)
    return account.id
  }
  return prisma.journalEntry.create({
    data: {
      organizationId: t.organizationId,
      source: 'PAYMENT',
      sourceId,
      description: 'SYNTETISKT negativprov: falskt betalningsunderlag',
      date: new Date(),
      fiscalYear: new Date().getUTCFullYear(),
      series: 'Z',
      verNumber: 1,
      lines: {
        create: [
          { accountId: accountId(debit), debit: new Prisma.Decimal(amount) },
          { accountId: accountId(credit), credit: new Prisma.Decimal(amount) },
        ],
      },
    },
  })
}

medDb('kundtillgodo genom verifierad Fortnox-export och återläsning', () => {
  const prisma = new PrismaService()
  beforeAll(() => prisma.$connect())
  // Refund/event får inte raderas: varje test har en egen organisation och bevisen bevaras.
  afterAll(() => prisma.$disconnect())

  it('100 mottaget →60 avräknat →40 återbetalt ger sex exporter och exakt avstämd huvudbok', async () => {
    const t = await setup(prisma)
    const localBefore = await accountingSnapshot(prisma, t.organizationId)
    await t.origin()
    const receipt = await t.send(t.credit.journalEntryId)
    const targetExport = await t.send(t.target.id)
    const applicationExport = await t.send(t.application.journalEntryId)
    const refundExport = await t.send(t.refund.journalEntryId!)
    expect(t.writer.writes).toBe(6)
    expect(t.reader.vouchers).toHaveLength(6)
    expect(voucherRows(t, 1)).toEqual([
      [1510, 0, 1000],
      [1940, 1000, 0],
    ])
    expect(voucherRows(t, 2)).toEqual([
      [1940, 100, 0],
      [2997, 0, 100],
    ])
    expect(voucherRows(t, 4)).toEqual([
      [1510, 0, 60],
      [2997, 60, 0],
    ])
    expect(voucherRows(t, 5)).toEqual([
      [1940, 0, 40],
      [2997, 40, 0],
    ])
    const applicationRow = await prisma.fortnoxVoucherExport.findUniqueOrThrow({
      where: { id: applicationExport.id },
    })
    expect(applicationRow.draft).toMatchObject({
      kundtillgodo: {
        version: 1,
        kind: 'APPLICATION',
        creditId: t.credit.id,
        eventId: t.application.id,
        anchors: expect.arrayContaining([
          expect.objectContaining({
            originExportId: receipt.id,
            role: 'KUNDTILLGODOSKULD',
            targetAccountNumber: 2997,
          }),
          expect.objectContaining({
            originExportId: targetExport.id,
            role: 'KUNDFORDRAN',
            targetAccountNumber: 1510,
          }),
        ]),
      },
    })
    const refundRow = await prisma.fortnoxVoucherExport.findUniqueOrThrow({
      where: { id: refundExport.id },
    })
    expect(refundRow.draft).toMatchObject({
      kundtillgodo: {
        version: 1,
        kind: 'REFUND',
        creditId: t.credit.id,
        eventId: t.refund.id,
        anchors: expect.arrayContaining([
          expect.objectContaining({
            originExportId: receipt.id,
            role: 'KUNDTILLGODOSKULD',
            targetAccountNumber: 2997,
          }),
          expect.objectContaining({
            originExportId: receipt.id,
            role: 'LIKVID',
            targetAccountNumber: 1940,
          }),
        ]),
      },
    })
    expect((await t.exports.dryRun(t.organizationId, t.credit.journalEntryId)).id).toBe(receipt.id)
    await expect(
      t.sender.send(t.organizationId, USER, receipt.id, receipt.draftHash!),
    ).rejects.toBeInstanceOf(ConflictException)
    expect(t.writer.writes).toBe(6)

    const allRows: LedgerRowProvenance[] = []
    const vouchers = t.reader.vouchers
    try {
      for (const year of t.reader.financialYears) {
        // Den generella fejken filtrerar inte sublist på år. Ge varje års läsning dess egna
        // redan skrivna poster; alla år traverseras så januari aldrig lånar innevarande år.
        t.reader.vouchers = vouchers.filter((voucher) => voucher.Year === year.Id)
        const run = await t.readback.read(t.organizationId, USER, {
          financialYearId: year.Id,
          periodFrom: year.FromDate,
          periodTo: year.ToDate,
          costAccounts: [1510, 1940, 2997, 3915],
        })
        expect(run.status).toBe('COMPLETE')
        const saved = await prisma.fortnoxReadRun.findUniqueOrThrow({ where: { id: run.id } })
        const rows = (saved.rows as unknown as { rows: LedgerRowProvenance[] }).rows
        allRows.push(...rows)
      }
    } finally {
      t.reader.vouchers = vouchers
    }
    expect(allRows).toHaveLength(12)
    expect(new Set(allRows.map((row) => `${row.voucher}#${row.row}`)).size).toBe(12)
    expect(
      allRows.every(
        (row) =>
          row.evenoExport &&
          row.evenoSource?.journalEntryId &&
          row.evenoSource.mappingRevision !== null,
      ),
    ).toBe(true)
    const balances = [1510, 1940, 2997, 3915].map((number) => [
      number,
      allRows.filter((row) => row.account === number).reduce((sum, row) => sum + row.amountOre, 0),
    ])
    expect(balances).toEqual([
      [1510, 0],
      [1940, 106000],
      [2997, 0],
      [3915, -106000],
    ])
    const localLines = await prisma.journalEntryLine.findMany({
      where: { journalEntry: { organizationId: t.organizationId } },
      select: { debit: true, credit: true, account: { select: { number: true } } },
    })
    for (const [local, external] of [
      [1510, 1510],
      [1930, 1940],
      [2998, 2997],
      [3911, 3915],
    ] as const) {
      const localOre = localLines
        .filter((line) => line.account.number === local)
        .reduce(
          (sum, line) => sum.plus(line.debit ?? 0).minus(line.credit ?? 0),
          new Prisma.Decimal(0),
        )
        .times(100)
        .toNumber()
      expect(balances.find(([number]) => number === external)?.[1]).toBe(localOre)
    }
    expect(
      new Set(
        allRows.filter((row) => row.account === 2997).map((row) => row.evenoSource?.sourceAccount),
      ),
    ).toEqual(new Set([2998]))
    expect(
      new Set(
        allRows.filter((row) => row.account === 1940).map((row) => row.evenoSource?.sourceAccount),
      ),
    ).toEqual(new Set([1930]))
    expect(await accountingSnapshot(prisma, t.organizationId)).toBe(localBefore)
    expect(
      await prisma.fortnoxVoucherExport.count({
        where: { organizationId: t.organizationId, state: 'CONFIRMED' },
      }),
    ).toBe(6)
  })

  it('kräver bekräftad källbetalning, tillgodomottagning och målfordran i rätt ordning', async () => {
    const t = await setup(prisma)
    await t.send(t.source.id)
    for (const id of [
      t.credit.journalEntryId,
      t.application.journalEntryId,
      t.refund.journalEntryId!,
    ]) {
      expect((await t.exports.dryRun(t.organizationId, id)).state).toBe('BLOCKED')
    }
    const paymentReady = await t.ready(t.payment.id)
    expect(paymentReady.state).toBe('DRY_RUN_READY')
    expect((await t.exports.dryRun(t.organizationId, t.credit.journalEntryId)).state).toBe(
      'BLOCKED',
    )
    await t.send(t.payment.id)
    await t.send(t.credit.journalEntryId)
    expect((await t.exports.dryRun(t.organizationId, t.application.journalEntryId)).state).toBe(
      'BLOCKED',
    )
    expect(t.writer.writes).toBe(3)
    await t.send(t.target.id)
    await t.send(t.application.journalEntryId)
    await t.send(t.refund.journalEntryId!)
    expect(t.writer.writes).toBe(6)
  })

  it('okänt skrivutfall på mottagningen blockerar följder och retry; exakt återläsning frigör dem utan nytt POST', async () => {
    const t = await setup(prisma)
    await t.origin()
    const row = await t.ready(t.credit.journalEntryId)
    t.writer.faults.push('unknown_after_write')
    expect((await t.sender.send(t.organizationId, USER, row.id, row.draftHash)).state).toBe(
      'UNKNOWN',
    )
    expect(t.writer.writes).toBe(3)
    await expect(
      t.sender.send(t.organizationId, USER, row.id, row.draftHash),
    ).rejects.toBeInstanceOf(ConflictException)
    expect((await t.exports.dryRun(t.organizationId, t.credit.journalEntryId)).state).toBe(
      'UNKNOWN',
    )
    expect((await t.exports.dryRun(t.organizationId, t.application.journalEntryId)).state).toBe(
      'BLOCKED',
    )
    expect((await t.exports.dryRun(t.organizationId, t.refund.journalEntryId!)).state).toBe(
      'BLOCKED',
    )
    const external = t.reader.vouchers[2]!
    const reconciled = await t.sender.reconcile(t.organizationId, USER, row.id, {
      year: Number(external.Year),
      series: String(external.VoucherSeries),
      number: Number(external.VoucherNumber),
    })
    expect(reconciled.state).toBe('CONFIRMED')
    expect(t.writer.writes).toBe(3)
    await t.send(t.target.id)
    await t.send(t.application.journalEntryId)
    await t.send(t.refund.journalEntryId!)
    expect(t.writer.writes).toBe(6)
  })

  it('samtidiga sändningar av samma mottagning gör bara en extern skrivning', async () => {
    const t = await setup(prisma)
    await t.origin()
    const row = await t.ready(t.credit.journalEntryId)
    let entered!: () => void
    let resume!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const gate = new Promise<void>((resolve) => {
      resume = resolve
    })
    t.writer.beforeWrite = async () => {
      entered()
      await gate
    }
    const first = t.sender.send(t.organizationId, USER, row.id, row.draftHash)
    const outcome = first.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    )
    try {
      await Promise.race([
        started,
        outcome.then(() => {
          throw new Error('Sändaren nådde aldrig skrivbarriären')
        }),
      ])
      await expect(
        t.sender.send(t.organizationId, 'synthetic-second-owner', row.id, row.draftHash),
      ).rejects.toBeInstanceOf(ConflictException)
    } finally {
      resume()
      await outcome
      t.writer.beforeWrite = null
    }
    const done = await outcome
    if ('error' in done) throw done.error
    expect(done.value.state).toBe('CONFIRMED')
    expect(t.writer.writes).toBe(3)
    expect(
      await prisma.fortnoxVoucherExport.count({
        where: { organizationId: t.organizationId, journalEntryId: t.credit.journalEntryId },
      }),
    ).toBe(1)
  })

  it('ny godkänd mappning bevarar mottagningens frysta konton och varje rads ursprungsrevision', async () => {
    const t = await setup(prisma)
    await t.origin()
    const receipt = await t.send(t.credit.journalEntryId)
    const oldRevision = await prisma.fortnoxAccountMappingRevision.findFirstOrThrow({
      where: {
        organizationId: t.organizationId,
        financialYearId: receipt.externalYear!,
        status: 'APPROVED',
      },
      select: { id: true, revision: true, contentSha256: true },
    })
    await t.approve(mapping(1941, 2996))
    const target = await t.send(t.target.id)
    const newRevision = await prisma.fortnoxAccountMappingRevision.findFirstOrThrow({
      where: {
        organizationId: t.organizationId,
        financialYearId: target.externalYear!,
        status: 'APPROVED',
      },
      select: { id: true, revision: true, contentSha256: true },
    })
    expect(newRevision.revision).toBeGreaterThan(oldRevision.revision)
    const application = await t.send(t.application.journalEntryId)
    const refund = await t.send(t.refund.journalEntryId!)
    expect(voucherRows(t, 4)).toEqual([
      [1510, 0, 60],
      [2997, 60, 0],
    ])
    expect(voucherRows(t, 5)).toEqual([
      [1940, 0, 40],
      [2997, 40, 0],
    ])
    expect(
      t.reader.vouchers
        .flatMap((_, index) => voucherRows(t, index))
        .some(([account]) => account === 1941 || account === 2996),
    ).toBe(false)

    // Gemensam topprevision räcker inte: appens skuld och fordran har olika ursprung.
    const savedReceipt = await prisma.fortnoxVoucherExport.findUniqueOrThrow({
      where: { id: receipt.id },
    })
    expect(savedReceipt.draft).toMatchObject({
      kundtillgodo: {
        anchors: [
          expect.objectContaining({
            originJournalEntryId: t.payment.id,
            role: 'LIKVID',
            targetAccountNumber: 1940,
            mappingRevision: oldRevision,
          }),
        ],
      },
    })
    for (const [entry, expectedRows, expectedAnchors] of [
      [
        application,
        [
          [1510, newRevision],
          [2997, oldRevision],
        ],
        [
          { originExportId: receipt.id, role: 'KUNDTILLGODOSKULD', mappingRevision: oldRevision },
          { originExportId: target.id, role: 'KUNDFORDRAN', mappingRevision: newRevision },
        ],
      ],
      [
        refund,
        [
          [1940, oldRevision],
          [2997, oldRevision],
        ],
        [
          { originExportId: receipt.id, role: 'KUNDTILLGODOSKULD', mappingRevision: oldRevision },
          { originExportId: receipt.id, role: 'LIKVID', mappingRevision: oldRevision },
        ],
      ],
    ] as const) {
      const saved = await prisma.fortnoxVoucherExport.findUniqueOrThrow({ where: { id: entry.id } })
      const draft = saved.draft as unknown as {
        kontomappning: {
          rader: Array<{ malkonto: number; mappingRevision: typeof oldRevision }>
        }
      }
      expect(
        draft.kontomappning.rader
          .sort((a, b) => a.malkonto - b.malkonto)
          .map((row) => [row.malkonto, row.mappingRevision]),
      ).toEqual(expectedRows)
      expect(saved.draft).toMatchObject({
        kundtillgodo: {
          anchors: expect.arrayContaining(
            expectedAnchors.map((anchor) => expect.objectContaining(anchor)),
          ),
        },
      })
    }

    const allRows: LedgerRowProvenance[] = []
    const vouchers = t.reader.vouchers
    try {
      for (const year of t.reader.financialYears) {
        // Fejkens sublist filtrerar inte år; läs varje års verkligt exporterade testposter.
        t.reader.vouchers = vouchers.filter((voucher) => voucher.Year === year.Id)
        const run = await t.readback.read(t.organizationId, USER, {
          financialYearId: year.Id,
          periodFrom: year.FromDate,
          periodTo: year.ToDate,
          costAccounts: [1510, 1940, 2997, 3915],
        })
        expect(run.status).toBe('COMPLETE')
        const saved = await prisma.fortnoxReadRun.findUniqueOrThrow({ where: { id: run.id } })
        allRows.push(...(saved.rows as unknown as { rows: LedgerRowProvenance[] }).rows)
      }
    } finally {
      t.reader.vouchers = vouchers
    }
    for (const [journalEntryId, expected] of [
      [
        t.credit.journalEntryId,
        [
          [1940, oldRevision.revision],
          [2997, oldRevision.revision],
        ],
      ],
      [
        t.target.id,
        [
          [1510, newRevision.revision],
          [3915, newRevision.revision],
        ],
      ],
      [
        t.application.journalEntryId,
        [
          [1510, newRevision.revision],
          [2997, oldRevision.revision],
        ],
      ],
      [
        t.refund.journalEntryId!,
        [
          [1940, oldRevision.revision],
          [2997, oldRevision.revision],
        ],
      ],
    ] as const) {
      expect(
        allRows
          .filter((row) => row.evenoSource?.journalEntryId === journalEntryId)
          .sort((a, b) => a.account - b.account)
          .map((row) => [row.account, row.evenoSource?.mappingRevision]),
      ).toEqual(expected)
    }
    expect(allRows).toHaveLength(12)
    expect(t.writer.writes).toBe(6)
  })

  it.each(['inaktivt', 'momskod'] as const)(
    'ett fryst skuldkonto som blivit %s stoppas även om den nya mappningen är giltig',
    async (change) => {
      const t = await setup(prisma)
      await t.origin()
      await t.send(t.credit.journalEntryId)
      await t.send(t.target.id)
      await t.approve(mapping(1941, 2996))
      const ready = await t.ready(t.application.journalEntryId)
      const old = t.reader.accounts.find((account) => account.Number === 2997)!
      if (change === 'inaktivt') old.Active = false
      else old.VATCode = 'U1'
      await expect(
        t.sender.send(t.organizationId, USER, ready.id, ready.draftHash),
      ).rejects.toBeInstanceOf(ConflictException)
      expect((await t.exports.dryRun(t.organizationId, t.application.journalEntryId)).state).toBe(
        'BLOCKED',
      )
      expect((await t.exports.dryRun(t.organizationId, t.refund.journalEntryId!)).state).toBe(
        'BLOCKED',
      )
      expect(t.writer.writes).toBe(4)
    },
  )

  it('saknad uttrycklig tillgodoskuldmappning blockerar mottagningen utan gissat konto', async () => {
    const t = await setup(prisma, { approve: false })
    await t.approve(mapping().filter((row) => row.role !== 'KUNDTILLGODOSKULD'))
    await t.origin()
    const row = await t.exports.dryRun(t.organizationId, t.credit.journalEntryId)
    expect(row.state).toBe('BLOCKED')
    expect(row.draftHash).toBeNull()
    expect(t.writer.writes).toBe(2)
    await t.approve()
    await t.send(t.credit.journalEntryId)
    expect(t.writer.writes).toBe(3)
  })

  it.each(['DatabaseNumber', 'OrganizationNumber'] as const)(
    'ändrat Fortnox-%s efter dry-run ger ingen ny skrivning',
    async (field) => {
      const t = await setup(prisma)
      await t.origin()
      const row = await t.ready(t.credit.journalEntryId)
      if (field === 'DatabaseNumber') t.reader.company.DatabaseNumber += 1
      else t.reader.company.OrganizationNumber = '556000-9999'
      await expect(
        t.sender.send(t.organizationId, USER, row.id, row.draftHash),
      ).rejects.toBeInstanceOf(ConflictException)
      expect((await t.exports.dryRun(t.organizationId, t.credit.journalEntryId)).state).toBe(
        'BLOCKED',
      )
      expect(t.writer.writes).toBe(2)
    },
  )

  it('annan organisation får varken exportera journalen, sända exportraden eller låna tillgodots käll-id', async () => {
    const a = await setup(prisma)
    const b = await setup(prisma)
    await a.origin()
    const row = await a.ready(a.credit.journalEntryId)
    await expect(
      a.exports.dryRun(b.organizationId, a.credit.journalEntryId),
    ).rejects.toBeInstanceOf(NotFoundException)
    await expect(
      a.sender.send(b.organizationId, USER, row.id, row.draftHash),
    ).rejects.toBeInstanceOf(NotFoundException)
    const forged = await forgedPayment(
      prisma,
      b,
      `customer-credit-receipt:${a.credit.id}`,
      1930,
      2998,
      '100.00',
    )
    expect((await b.exports.dryRun(b.organizationId, forged.id)).state).toBe('BLOCKED')
    expect(a.writer.writes).toBe(2)
    expect(b.writer.writes).toBe(0)
  })

  it('CUSTOMER_CREDIT-allokeringen kan inte också exporteras som en vanlig bankinbetalning', async () => {
    const t = await setup(prisma)
    await t.send(t.target.id)
    const payment = await prisma.rentNoticePayment.findUniqueOrThrow({
      where: { customerCreditApplicationId: t.application.id },
    })
    expect(payment.source).toBe('CUSTOMER_CREDIT')
    const forged = await forgedPayment(
      prisma,
      t,
      `rent-notice-bank-payment:${payment.id}`,
      1930,
      1510,
      '60.00',
    )
    const outcome = await t.exports.dryRun(t.organizationId, forged.id)
    expect(outcome.state).toBe('BLOCKED')
    expect(outcome.blockReason).toContain('EVENT_UNSUPPORTED')
    expect(t.writer.writes).toBe(1)
  })

  it('balanserad men ändrad mottagningsjournal får inte skickas med tidigare godkänd hash', async () => {
    const t = await setup(prisma)
    await t.origin()
    const row = await t.ready(t.credit.journalEntryId)
    // Direkt korrupt testunderlag: balansen är fortfarande noll men källbeloppet är 100, inte101.
    await prisma.journalEntryLine.updateMany({
      where: { journalEntryId: t.credit.journalEntryId, debit: { not: null } },
      data: { debit: new Prisma.Decimal('101.00') },
    })
    await prisma.journalEntryLine.updateMany({
      where: { journalEntryId: t.credit.journalEntryId, credit: { not: null } },
      data: { credit: new Prisma.Decimal('101.00') },
    })
    await expect(
      t.sender.send(t.organizationId, USER, row.id, row.draftHash),
    ).rejects.toBeInstanceOf(ConflictException)
    expect((await t.exports.dryRun(t.organizationId, t.credit.journalEntryId)).state).toBe(
      'BLOCKED',
    )
    expect(t.writer.writes).toBe(2)
  })

  it.each(['bankkälla', 'ursprungsbevis'] as const)(
    '%s som ändras efter färsk builder-kontroll stoppas före skrivanspråk',
    async (change) => {
      const t = await setup(prisma)
      await t.origin()
      const row = await t.ready(t.credit.journalEntryId)
      let changed = false
      const raceBuilder: FortnoxVoucherDraftBuilder = {
        build: async (organizationId, journalEntryId) => {
          const result = await t.builder.build(organizationId, journalEntryId)
          if (result.ok && !changed) {
            changed = true
            if (change === 'bankkälla') {
              await prisma.bankTransaction.update({
                where: { id: t.f.bankTransactionId },
                data: { status: 'IGNORED' },
              })
            } else {
              await prisma.fortnoxVoucherExport.update({
                where: {
                  organizationId_journalEntryId: {
                    organizationId: t.organizationId,
                    journalEntryId: t.payment.id,
                  },
                },
                data: { state: 'UNKNOWN' },
              })
            }
          }
          return result
        },
      }
      const sender = new FortnoxSendService(prisma, t.connections, raceBuilder, t.reader, t.writer)
      await expect(
        sender.send(t.organizationId, USER, row.id, row.draftHash),
      ).rejects.toBeInstanceOf(ConflictException)
      expect(changed).toBe(true)
      expect(t.writer.writes).toBe(2)
      const after = await prisma.fortnoxVoucherExport.findUniqueOrThrow({ where: { id: row.id } })
      expect(after.state).toBe('DRY_RUN_READY')
      expect(after.sendAttemptId).toBeNull()
    },
  )

  it('BANK_CONFIRMED utan bokförd SETTLED-order får ingen återbetalningsexport trots förfalskad journal', async () => {
    const t = await setup(prisma, { settle: false })
    expect(t.refund.state).toBe('BANK_CONFIRMED')
    expect(t.refund.journalEntryId).toBeNull()
    await t.origin()
    await t.send(t.credit.journalEntryId)
    const forged = await forgedPayment(
      prisma,
      t,
      `customer-credit-refund:${t.refund.id}`,
      2998,
      1930,
      '40.00',
    )
    expect((await t.exports.dryRun(t.organizationId, forged.id)).state).toBe('BLOCKED')
    expect(t.writer.writes).toBe(3)
  })

  it.each(['källbetalning', 'målavi'] as const)(
    'ordinarie bokföringsrättelse av %s nekas även efter att tillgodoexporten nått SENDING',
    async (kind) => {
      const t = await setup(prisma)
      await t.origin()
      if (kind === 'målavi') {
        await t.send(t.credit.journalEntryId)
        await t.send(t.target.id)
      }
      const row = await t.ready(
        kind === 'källbetalning' ? t.credit.journalEntryId : t.application.journalEntryId,
      )
      const before = await accountingSnapshot(prisma, t.organizationId)
      const writesBefore = t.writer.writes
      let entered!: () => void
      let resume!: () => void
      const inWriter = new Promise<void>((resolve) => {
        entered = resolve
      })
      const releaseWriter = new Promise<void>((resolve) => {
        resume = resolve
      })
      t.writer.beforeWrite = async () => {
        entered()
        await releaseWriter
      }
      const first = t.sender.send(t.organizationId, USER, row.id, row.draftHash)
      const outcome = first.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      )
      try {
        await Promise.race([
          inWriter,
          outcome.then(() => {
            throw new Error('Sändaren nådde aldrig rättelseprovets skrivbarriär')
          }),
        ])
        expect(
          (await prisma.fortnoxVoucherExport.findUniqueOrThrow({ where: { id: row.id } })).state,
        ).toBe('SENDING')
        const reversal = human(() =>
          t.accounting.reverseJournalEntry({
            entryId: kind === 'källbetalning' ? t.payment.id : t.target.id,
            organizationId: t.organizationId,
            actorRole: 'OWNER',
            actorUserId: null,
            reason: 'Syntetiskt motprov under pågående Fortnox-export',
          }),
        )
        await expect(reversal).rejects.toBeInstanceOf(ConflictException)
        await expect(reversal).rejects.toThrow(/kundtillgodo/i)
        expect(await accountingSnapshot(prisma, t.organizationId)).toBe(before)
        expect(t.writer.writes).toBe(writesBefore)
      } finally {
        resume()
        await outcome
        t.writer.beforeWrite = null
      }
      const done = await outcome
      if ('error' in done) throw done.error
      expect(done.value.state).toBe('CONFIRMED')
      expect(t.writer.writes).toBe(writesBefore + 1)
      expect(await accountingSnapshot(prisma, t.organizationId)).toBe(before)
    },
  )

  it('generisk syntetisk rättelse av kundtillgodo blockeras även när originalet är bekräftat exporterat', async () => {
    const t = await setup(prisma)
    await t.origin()
    await t.send(t.credit.journalEntryId)
    const original = await prisma.journalEntry.findUniqueOrThrow({
      where: { id: t.credit.journalEntryId },
      include: { lines: true },
    })
    // Rått negativt underlag: riktiga tjänsten vägrar just denna generella rättelse.
    // Inga originalrader ändras och inga databasregler eller triggers kopplas bort.
    const reversal = await prisma.journalEntry.create({
      data: {
        organizationId: t.organizationId,
        source: 'MANUAL',
        sourceId: `entry-reversal:${original.id}`,
        reversalOfEntryId: original.id,
        description: 'SYNTETISK otillåten generell rättelse av kundtillgodo',
        date: new Date(),
        fiscalYear: new Date().getUTCFullYear(),
        series: 'Z',
        verNumber: 1,
        lines: {
          create: original.lines.map((line) => ({
            accountId: line.accountId,
            debit: line.credit,
            credit: line.debit,
          })),
        },
      },
    })
    const rejected = await t.exports.dryRun(t.organizationId, reversal.id)
    expect(rejected.state).toBe('BLOCKED')
    expect(rejected.blockReason).toContain('EVENT_UNSUPPORTED')
    expect(rejected.blockReason).toMatch(/kundtillgodo/i)
    expect(t.writer.writes).toBe(3)
  })

  it('historisk avräkning via offentlig tjänst: decembermottagning årA ger frysta mål vid januariavdrag och återbetalning årB', async () => {
    const yearB = new Date().getUTCFullYear()
    const yearA = yearB - 1
    const t = await setup(prisma, { sourcePeriod: new Date(Date.UTC(yearA, 11, 1)) })
    expect(t.credit.receivedAt.toISOString()).toBe(`${yearA}-12-25T12:00:00.000Z`)
    expect(t.application.appliedAt.getUTCFullYear()).toBe(yearB)
    expect(t.application.appliedAt.getUTCMonth()).toBe(0)
    const fiscalA = t.reader.financialYears.find((year) => year.FromDate === `${yearA}-01-01`)!
    const fiscalB = t.reader.financialYears.find((year) => year.FromDate === `${yearB}-01-01`)!
    expect(fiscalA.Id).not.toBe(fiscalB.Id)

    const source = await t.send(t.source.id)
    const payment = await t.send(t.payment.id)
    const receipt = await t.send(t.credit.journalEntryId)
    expect([source.externalYear, payment.externalYear, receipt.externalYear]).toEqual([
      fiscalA.Id,
      fiscalA.Id,
      fiscalA.Id,
    ])
    // Den nya revisionen gäller båda åren. Mottagningens bank/skuld ska ändå bestå.
    await t.approve(mapping(1941, 2996))
    const target = await t.send(t.target.id)
    const application = await t.send(t.application.journalEntryId)
    const refund = await t.send(t.refund.journalEntryId!)
    expect([target.externalYear, application.externalYear, refund.externalYear]).toEqual([
      fiscalB.Id,
      fiscalB.Id,
      fiscalB.Id,
    ])
    expect(application.externalYear).not.toBe(receipt.externalYear)
    expect(refund.externalYear).not.toBe(receipt.externalYear)
    expect(voucherRows(t, 4)).toEqual([
      [1510, 0, 60],
      [2997, 60, 0],
    ])
    expect(voucherRows(t, 5)).toEqual([
      [1940, 0, 40],
      [2997, 40, 0],
    ])
    expect(t.reader.vouchers.map((voucher) => voucher.Year)).toEqual([
      fiscalA.Id,
      fiscalA.Id,
      fiscalA.Id,
      fiscalB.Id,
      fiscalB.Id,
      fiscalB.Id,
    ])
    expect(
      new Set(
        t.reader.vouchers.map(
          (voucher) => `${voucher.Year}|${voucher.VoucherSeries}|${voucher.VoucherNumber}`,
        ),
      ).size,
    ).toBe(6)
    for (const [index, calendarYear] of [
      [0, yearA],
      [1, yearA],
      [2, yearA],
      [3, yearB],
      [4, yearB],
      [5, yearB],
    ] as const) {
      expect(t.reader.vouchers[index]!.TransactionDate).toMatch(new RegExp(`^${calendarYear}-`))
    }
    const saved = await prisma.fortnoxVoucherExport.findUniqueOrThrow({ where: { id: refund.id } })
    expect(saved.draft).toMatchObject({
      kundtillgodo: {
        anchors: expect.arrayContaining([
          expect.objectContaining({
            originExportId: receipt.id,
            role: 'KUNDTILLGODOSKULD',
            targetAccountNumber: 2997,
          }),
          expect.objectContaining({
            originExportId: receipt.id,
            role: 'LIKVID',
            targetAccountNumber: 1940,
          }),
        ]),
      },
    })
    expect(t.writer.writes).toBe(6)
  })
})
