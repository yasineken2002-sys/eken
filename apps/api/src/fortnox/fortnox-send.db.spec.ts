/**
 * FORTNOX-SANDNING — sändning och avstämning mot RIKTIG syntetisk Postgres.
 *
 * Mäter kundeffekt i produkttjänsten (FortnoxSendService) med injicerad syntetisk
 * skrivare (MockVoucherWriter) som skriver in i SAMMA syntetiska huvudbok som
 * återläsningen läser. `writer.writes` = antal externa effekter. Samtidighet styrs
 * med deterministiska barriärer (deferred), aldrig sleep som enda bevis.
 * Fallnumren hänvisar till CLAUDE1/FACIT.md.
 */
import { randomUUID } from 'node:crypto'
import { ConfigService } from '@nestjs/config'
import { PrismaClient } from '@prisma/client'
import type { PrismaService } from '../common/prisma/prisma.service'
import { FortnoxConnectionService } from './fortnox-connection.service'
import { FortnoxReadbackService } from './fortnox-readback.service'
import { FortnoxExportService, type FortnoxVoucherDraftBuilder } from './fortnox-export.service'
import { FortnoxTokenCryptoService } from './fortnox-token-crypto.service'
import { MockFortnoxAuthProvider, MockFortnoxLedgerReader } from './fortnox-providers'
import { VerifiedVoucherDraftBuilder } from './fortnox-export-builder'
import { FortnoxSendService } from './fortnox-send.service'
import { DisabledVoucherWriter, MockVoucherWriter } from './fortnox-voucher-writer'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip
const KEY = 'cd'.repeat(32)

function deferred<T = void>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

/** Pollar ett villkor (riktiga I/O-väntor) med hård gräns; kastar vid timeout. */
async function until(cond: () => Promise<boolean> | boolean, ms = 5000) {
  const end = Date.now() + ms
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('until: timeout')
    await new Promise((r) => setTimeout(r, 10))
  }
}

/** Ersätter accessToken från och med anrop nr `from` (anrop 1 = färsk förkontroll i buildern). */
function hookAccessToken(
  connections: { accessToken: unknown },
  from: number,
  impl: (orig: (...a: unknown[]) => Promise<unknown>, args: unknown[]) => Promise<unknown>,
) {
  const orig = (connections.accessToken as (...a: unknown[]) => Promise<unknown>).bind(connections)
  let n = 0
  connections.accessToken = (...args: unknown[]) => {
    n += 1
    return n >= from ? impl(orig, args) : orig(...args)
  }
}

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot en RIKTIG databas', () => expect(HAR_DB).toBe(true))
})

medDb('FORTNOX-SANDNING mot riktig Postgres', () => {
  let prisma: PrismaClient
  const orgs: string[] = []

  beforeAll(async () => {
    const u = new URL(process.env.DATABASE_URL!)
    u.searchParams.set('connection_limit', '16')
    prisma = new PrismaClient({ datasources: { db: { url: u.toString() } } })
    await prisma.$connect()
  })

  afterAll(async () => {
    for (const id of orgs) {
      await prisma.fortnoxVoucherExport.deleteMany({ where: { organizationId: id } })
      await prisma.journalEntryLine.deleteMany({ where: { journalEntry: { organizationId: id } } })
      await prisma.journalEntry.deleteMany({ where: { organizationId: id } })
      await prisma.account.deleteMany({ where: { organizationId: id } })
      await prisma.organization.delete({ where: { id } }).catch(() => undefined)
    }
    await prisma.$disconnect()
  })

  async function setup(opts: { writer?: 'mock' | 'disabled' } = {}) {
    const sfx = randomUUID().slice(0, 8)
    const org = await prisma.organization.create({
      data: {
        name: `snd-${sfx}`,
        email: `snd-${sfx}@example.se`,
        street: 'a',
        city: 'b',
        postalCode: '1',
      },
    })
    orgs.push(org.id)
    const env: Record<string, string> = { FORTNOX_TOKEN_KEY: KEY }
    const config = { get: (k: string) => env[k] } as unknown as ConfigService
    const crypto = new FortnoxTokenCryptoService(config)
    const auth = new MockFortnoxAuthProvider()
    const reader = new MockFortnoxLedgerReader()
    const db = prisma as unknown as PrismaService
    const connections = new FortnoxConnectionService(db, crypto, config, auth, reader)
    const readback = new FortnoxReadbackService(db, connections, reader)
    const verified = new VerifiedVoucherDraftBuilder(db, connections, reader)
    // Barriärbar builder: prov kan stoppa samtliga sändare efter färsk förkontroll.
    let gate: { arrive: () => Promise<void> } | null = null
    const builder: FortnoxVoucherDraftBuilder = {
      build: async (o, j) => {
        const res = await verified.build(o, j)
        if (gate) await gate.arrive()
        return res
      },
    }
    const exports = new FortnoxExportService(db, builder)
    const writer =
      opts.writer === 'disabled' ? new DisabledVoucherWriter() : new MockVoucherWriter(reader)
    const sender = new FortnoxSendService(db, connections, builder, reader, writer)
    const { authUrl } = await connections.begin(org.id, 'u1')
    const state = new URL(authUrl).searchParams.get('state')!
    await connections.handleCallback(state, `mock-code-${state.slice(0, 8)}`)
    await connections.setExportVoucherSeries(org.id, 'A')
    await connections.setExportOmitDimensions(org.id, 'u1', true)
    const acc = async (number: number) =>
      (await prisma.account.findFirst({ where: { organizationId: org.id, number } })) ??
      prisma.account.create({
        data: { organizationId: org.id, number, name: `Konto ${number}`, type: 'EXPENSE' },
      })
    const entry = async (amount = '1234.50') => {
      const a = await acc(5170)
      const b = await acc(2440)
      return prisma.journalEntry.create({
        data: {
          organizationId: org.id,
          date: new Date('2026-10-02'),
          description: 'Reparation trapphus',
          fiscalYear: 2026,
          verNumber: Math.floor(Math.random() * 1e6) + 1,
          lines: {
            create: [
              { accountId: a.id, debit: amount },
              { accountId: b.id, credit: amount },
            ],
          },
        },
      })
    }
    const ready = async (amount?: string) => {
      const je = await entry(amount)
      const row = await exports.dryRun(org.id, je.id)
      expect(row.state).toBe('DRY_RUN_READY')
      return { je, row: row as typeof row & { draftHash: string } }
    }
    const setGate = (n: number) => {
      let count = 0
      const all = deferred()
      gate = {
        arrive: async () => {
          count += 1
          if (count >= n) all.resolve()
          await all.promise
        },
      }
      return () => (gate = null)
    }
    const dbRow = (id: string) => prisma.fortnoxVoucherExport.findUniqueOrThrow({ where: { id } })
    return {
      org,
      reader,
      writer,
      sender,
      exports,
      connections,
      readback,
      ready,
      entry,
      setGate,
      dbRow,
      crypto,
    }
  }

  // ── F01 / F20 ───────────────────────────────────────────────────────────────
  it('F01: lyckad kedja → exakt 1 extern post, CONFIRMED med exakt identitet; readback märker (F20)', async () => {
    const t = await setup()
    const { row } = await t.ready()
    const res = await t.sender.send(t.org.id, 'u1', row.id, row.draftHash)
    expect(res.state).toBe('CONFIRMED')
    expect((t.writer as MockVoucherWriter).writes).toBe(1)
    expect([res.externalYear, res.externalSeries, res.externalNumber]).toEqual([1, 'A', 1])
    const raw = await t.dbRow(row.id)
    expect([
      raw.sendConfirmedBy,
      raw.fortnoxDatabaseNumber,
      raw.sendFinancialYear,
      raw.sendSeries,
    ]).toEqual(['u1', 900001, 1, 'A'])
    const run = await t.readback.read(t.org.id, 'u1', {
      financialYearId: 1,
      periodFrom: '2026-01-01',
      periodTo: '2026-12-31',
      costAccounts: [5170],
    })
    const s = run.summary as { totalOre: number; evenoExportOre: number }
    expect([s.totalOre, s.evenoExportOre]).toEqual([123450, 123450])
  })

  // ── F02 ─────────────────────────────────────────────────────────────────────
  it('F02: två samtidiga sändbegäranden (barriär efter förkontroll) → 1 extern effekt, en 409', async () => {
    const t = await setup()
    const { row } = await t.ready()
    t.setGate(2)
    const res = await Promise.allSettled([
      t.sender.send(t.org.id, 'u1', row.id, row.draftHash),
      t.sender.send(t.org.id, 'u2', row.id, row.draftHash),
    ])
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(res.filter((r) => r.status === 'rejected')).toHaveLength(1)
    expect((t.writer as MockVoucherWriter).writes).toBe(1)
    expect((await t.dbRow(row.id)).state).toBe('CONFIRMED')
  })

  // ── F03 / F04 / F17 / F19 ───────────────────────────────────────────────────
  it('F03: leverantören skriver men svaret tappas → UNKNOWN; send/dry-run skickar aldrig igen', async () => {
    const t = await setup()
    const { je, row } = await t.ready()
    const w = t.writer as MockVoucherWriter
    w.faults.push('unknown_after_write')
    const res = await t.sender.send(t.org.id, 'u1', row.id, row.draftHash)
    expect(res.state).toBe('UNKNOWN')
    expect(w.writes).toBe(1)
    await expect(t.sender.send(t.org.id, 'u1', row.id, row.draftHash)).rejects.toThrow()
    expect((await t.exports.dryRun(t.org.id, je.id)).state).toBe('UNKNOWN') // F17
    expect(w.writes).toBe(1)
  })

  it('F04: avstämning med exakt identitet → CONFIRMED med beslutspost; fel identitet/innehåll → 409', async () => {
    const t = await setup()
    const { row } = await t.ready()
    const w = t.writer as MockVoucherWriter
    w.faults.push('unknown_after_write')
    await t.sender.send(t.org.id, 'u1', row.id, row.draftHash)
    // En annan post i samma serie med annat innehåll.
    t.reader.vouchers.push({
      Year: 1,
      VoucherSeries: 'A',
      VoucherNumber: 2,
      TransactionDate: '2026-10-02',
      VoucherRows: [
        { Account: 5170, Debit: 99, Credit: 0 },
        { Account: 2440, Debit: 0, Credit: 99 },
      ],
    })
    await expect(
      t.sender.reconcile(t.org.id, 'u1', row.id, { year: 1, series: 'A', number: 2 }),
    ).rejects.toThrow(/stämmer inte/)
    await expect(
      t.sender.reconcile(t.org.id, 'u1', row.id, { year: 1, series: 'A', number: 77 }),
    ).rejects.toThrow(/finns inte/)
    await expect(
      t.sender.reconcile(t.org.id, 'u1', row.id, { year: 1, series: 'A', number: 0 }),
    ).rejects.toThrow(/Ogiltig/)
    expect((await t.dbRow(row.id)).state).toBe('UNKNOWN')
    const ok = await t.sender.reconcile(t.org.id, 'u9', row.id, { year: 1, series: 'A', number: 1 })
    expect(ok.state).toBe('CONFIRMED')
    const raw = await t.dbRow(row.id)
    expect((raw.reconcileDecision as { by: string; identity: { number: number } }).by).toBe('u9')
    expect((raw.reconcileDecision as { identity: { number: number } }).identity.number).toBe(1)
    expect(w.writes).toBe(1)
  })

  it('F19: en extern identitet kan inte bekräfta två exporter', async () => {
    const t = await setup()
    const a = await t.ready()
    await t.sender.send(t.org.id, 'u1', a.row.id, a.row.draftHash)
    const b = await t.ready()
    ;(t.writer as MockVoucherWriter).faults.push('unknown_before_write')
    await t.sender.send(t.org.id, 'u1', b.row.id, b.row.draftHash)
    expect((await t.dbRow(b.row.id)).state).toBe('UNKNOWN')
    await expect(
      t.sender.reconcile(t.org.id, 'u1', b.row.id, { year: 1, series: 'A', number: 1 }),
    ).rejects.toThrow(/redan kopplad|stämmer inte/)
  })

  // ── F05 / F06 / F07 ─────────────────────────────────────────────────────────
  it('F05: krasch efter anspråk, före nätanrop → lease ut → UNKNOWN, 0 externa poster, ingen återköning', async () => {
    const t = await setup()
    const { row } = await t.ready()
    // "Krasch": token-hämtningen hänger för evigt; anspråket ligger kvar.
    const hang = deferred<never>()
    hookAccessToken(t.connections as never, 2, () => hang.promise)
    void t.sender.send(t.org.id, 'u1', row.id, row.draftHash).catch(() => undefined)
    await until(async () => (await t.dbRow(row.id)).state === 'SENDING')
    expect((await t.dbRow(row.id)).state).toBe('SENDING')
    await prisma.fortnoxVoucherExport.update({
      where: { id: row.id },
      data: { sendLeaseUntil: new Date(Date.now() - 1) },
    })
    expect(await t.sender.expireLeases(t.org.id)).toBe(1)
    const raw = await t.dbRow(row.id)
    expect([raw.state, raw.lastOutcome]).toEqual(['UNKNOWN', 'LEASE_EXPIRED'])
    expect((t.writer as MockVoucherWriter).writes).toBe(0)
    await expect(t.sender.send(t.org.id, 'u1', row.id, row.draftHash)).rejects.toThrow()
    expect((t.writer as MockVoucherWriter).writes).toBe(0)
  })

  it('F06: krasch efter extern effekt, före lokal sparning → UNKNOWN; avstämning ger CONFIRMED', async () => {
    const t = await setup()
    const { row } = await t.ready()
    const w = t.writer as MockVoucherWriter
    const hang = deferred()
    w.afterWrite = () => hang.promise // posten finns externt; processen "dör" före svaret
    void t.sender.send(t.org.id, 'u1', row.id, row.draftHash).catch(() => undefined)
    await until(() => w.writes === 1)
    expect(w.writes).toBe(1)
    await prisma.fortnoxVoucherExport.update({
      where: { id: row.id },
      data: { sendLeaseUntil: new Date(Date.now() - 1) },
    })
    await t.sender.expireLeases(t.org.id)
    expect((await t.dbRow(row.id)).state).toBe('UNKNOWN')
    const ok = await t.sender.reconcile(t.org.id, 'u1', row.id, { year: 1, series: 'A', number: 1 })
    expect(ok.state).toBe('CONFIRMED')
  })

  it('F07: sen framgång efter lease→UNKNOWN (samma försök) → kvitto + verifiering', async () => {
    const t = await setup()
    const { row } = await t.ready()
    const w = t.writer as MockVoucherWriter
    const gate = deferred()
    w.afterWrite = () => gate.promise
    const pending = t.sender.send(t.org.id, 'u1', row.id, row.draftHash)
    await until(() => w.writes === 1)
    await prisma.fortnoxVoucherExport.update({
      where: { id: row.id },
      data: { sendLeaseUntil: new Date(Date.now() - 1) },
    })
    await t.sender.expireLeases(t.org.id)
    expect((await t.dbRow(row.id)).state).toBe('UNKNOWN')
    gate.resolve()
    expect((await pending).state).toBe('CONFIRMED')
    expect(w.writes).toBe(1)
  })

  it('F07: sen framgång efter avstämning skriver inte över beslutet', async () => {
    const t = await setup()
    const { row } = await t.ready()
    const w = t.writer as MockVoucherWriter
    const gate = deferred()
    w.afterWrite = () => gate.promise
    const pending = t.sender.send(t.org.id, 'u1', row.id, row.draftHash)
    await until(() => w.writes === 1)
    await prisma.fortnoxVoucherExport.update({
      where: { id: row.id },
      data: { sendLeaseUntil: new Date(Date.now() - 1) },
    })
    await t.sender.expireLeases(t.org.id)
    await t.sender.reconcile(t.org.id, 'u7', row.id, { year: 1, series: 'A', number: 1 })
    gate.resolve()
    await pending
    const raw = await t.dbRow(row.id)
    expect([raw.state, raw.lastOutcome, (raw.reconcileDecision as { by: string }).by]).toEqual([
      'CONFIRMED',
      'RECONCILED',
      'u7',
    ])
  })

  // ── F08 / F09 / F10 ─────────────────────────────────────────────────────────
  it.each(['invalid_success', 'wrong_year', 'wrong_series'] as const)(
    'F08: ogiltigt lyckat svar (%s) → UNKNOWN',
    async (fault) => {
      const t = await setup()
      const { row } = await t.ready()
      ;(t.writer as MockVoucherWriter).faults.push(fault)
      const res = await t.sender.send(t.org.id, 'u1', row.id, row.draftHash)
      expect([res.state, res.lastOutcome]).toEqual(['UNKNOWN', 'INVALID_SUCCESS'])
    },
  )

  it('F09: not_sent → tillbaka till DRY_RUN_READY, 0 poster, nytt försök lyckas', async () => {
    const t = await setup()
    const { row } = await t.ready()
    const w = t.writer as MockVoucherWriter
    w.faults.push('not_sent')
    const r1 = await t.sender.send(t.org.id, 'u1', row.id, row.draftHash)
    expect([r1.state, r1.lastOutcome, w.writes]).toEqual(['DRY_RUN_READY', 'NOT_SENT', 0])
    expect((await t.sender.send(t.org.id, 'u1', row.id, row.draftHash)).state).toBe('CONFIRMED')
    expect(w.writes).toBe(1)
  })

  it.each([
    ['rejected', 'REJECTED'],
    ['unknown_before_write', 'UNKNOWN'],
  ] as const)('F10: %s → %s, låst utan omsändning', async (fault, want) => {
    const t = await setup()
    const { row } = await t.ready()
    ;(t.writer as MockVoucherWriter).faults.push(fault)
    expect((await t.sender.send(t.org.id, 'u1', row.id, row.draftHash)).state).toBe(want)
    await expect(t.sender.send(t.org.id, 'u1', row.id, row.draftHash)).rejects.toThrow()
    expect((t.writer as MockVoucherWriter).writes).toBe(0)
  })

  // ── F11 / F12 / F13 ─────────────────────────────────────────────────────────
  it('F11: muterat underlag efter förkontroll → 409, 0 poster, raden oförändrad', async () => {
    const t = await setup()
    const { je, row } = await t.ready()
    await prisma.journalEntryLine.updateMany({
      where: { journalEntryId: je.id, debit: { not: null } },
      data: { debit: '9999.00' },
    })
    await prisma.journalEntryLine.updateMany({
      where: { journalEntryId: je.id, credit: { not: null } },
      data: { credit: '9999.00' },
    })
    await expect(t.sender.send(t.org.id, 'u1', row.id, row.draftHash)).rejects.toThrow(
      /inte längre aktuellt/,
    )
    expect((t.writer as MockVoucherWriter).writes).toBe(0)
    expect((await t.dbRow(row.id)).state).toBe('DRY_RUN_READY')
    await expect(t.sender.send(t.org.id, 'u1', row.id, 'f'.repeat(64))).rejects.toThrow(
      /inte längre aktuellt/,
    )
  })

  it('F12: frånkoppling + återanslutning efter förkontroll → 409 (ny generation), 0 poster', async () => {
    const t = await setup()
    const { row } = await t.ready()
    await t.connections.disconnect(t.org.id)
    const { authUrl } = await t.connections.begin(t.org.id, 'u1')
    const s = new URL(authUrl).searchParams.get('state')!
    await t.connections.handleCallback(s, `mock-code-${s.slice(0, 8)}`)
    await t.connections.setExportVoucherSeries(t.org.id, 'A')
    await t.connections.setExportOmitDimensions(t.org.id, 'u1', true)
    await expect(t.sender.send(t.org.id, 'u1', row.id, row.draftHash)).rejects.toThrow(
      /inte längre aktuellt/,
    )
    expect((t.writer as MockVoucherWriter).writes).toBe(0)
  })

  it('F12: frånkoppling mellan anspråk och nätanrop → not_sent, tillbaka till READY, 0 poster', async () => {
    const t = await setup()
    const { row } = await t.ready()
    hookAccessToken(t.connections as never, 2, async (orig, args) => {
      const a = await orig(...args)
      await t.connections.disconnect(args[0] as string) // frånkoppling mellan anspråk och nätanrop
      return a
    })
    await expect(t.sender.send(t.org.id, 'u1', row.id, row.draftHash)).rejects.toThrow(/ändrades/)
    expect((await t.dbRow(row.id)).state).toBe('DRY_RUN_READY')
    expect((t.writer as MockVoucherWriter).writes).toBe(0)
  })

  it('F13: återläsning i fel företag ger aldrig CONFIRMED', async () => {
    const t = await setup()
    const { row } = await t.ready()
    ;(t.writer as MockVoucherWriter).faults.push('unknown_after_write')
    await t.sender.send(t.org.id, 'u1', row.id, row.draftHash)
    t.reader.company = { ...t.reader.company, DatabaseNumber: 900777 }
    await expect(
      t.sender.reconcile(t.org.id, 'u1', row.id, { year: 1, series: 'A', number: 1 }),
    ).rejects.toThrow(/företaget/)
    expect((await t.dbRow(row.id)).state).toBe('UNKNOWN')
  })

  // ── F14 / F15 ───────────────────────────────────────────────────────────────
  it('F14: återläsning saknar posten → RECEIPT_IDENTIFIED; verify senare → CONFIRMED', async () => {
    const t = await setup()
    const { row } = await t.ready()
    const orig = t.reader.get.bind(t.reader)
    let hide = true
    t.reader.get = (async (tok: string, p: string, q?: Record<string, string | number>) => {
      if (hide && /^\/3\/vouchers\/A\/\d+$/.test(p))
        throw new (await import('./fortnox.types')).FortnoxReadError('invalid', 404)
      return orig(tok, p, q)
    }) as typeof t.reader.get
    const res = await t.sender.send(t.org.id, 'u1', row.id, row.draftHash)
    expect([res.state, res.lastOutcome]).toEqual(['RECEIPT_IDENTIFIED', 'READBACK_NOT_FOUND_YET'])
    hide = false
    expect((await t.sender.verify(t.org.id, row.id)).state).toBe('CONFIRMED')
  })

  it('F15: återläst innehåll avviker → RECEIPT_MISMATCH, låst', async () => {
    const t = await setup()
    const { row } = await t.ready()
    const w = t.writer as MockVoucherWriter
    w.afterWrite = async () => {
      const v = t.reader.vouchers[t.reader.vouchers.length - 1]!
      ;(v.VoucherRows as Array<Record<string, unknown>>)[0]!.Debit = 1 // Fortnox-posten skiljer sig
    }
    const res = await t.sender.send(t.org.id, 'u1', row.id, row.draftHash)
    expect([res.state, res.lastOutcome]).toEqual(['RECEIPT_MISMATCH', 'READBACK_MISMATCH'])
    await expect(t.sender.send(t.org.id, 'u1', row.id, row.draftHash)).rejects.toThrow()
  })

  // ── F18 ─────────────────────────────────────────────────────────────────────
  it('F18: produktkonfiguration (avstängd skrivare) → 409 SENDING_DISABLED, inget anspråk', async () => {
    const t = await setup({ writer: 'disabled' })
    const { row } = await t.ready()
    expect(t.sender.sendingEnabled).toBe(false)
    await expect(t.sender.send(t.org.id, 'u1', row.id, row.draftHash)).rejects.toThrow(
      /SENDING_DISABLED/,
    )
    const raw = await t.dbRow(row.id)
    expect([raw.state, raw.sendAttemptId]).toEqual(['DRY_RUN_READY', null])
    expect((await t.exports.counts(t.org.id, t.sender.sendingEnabled)).sendingEnabled).toBe(false)
  })

  // ── F20 (negativ) ───────────────────────────────────────────────────────────
  it('F20: UNKNOWN/RECEIPT märker inget i readback och nollar ingen summa', async () => {
    const t = await setup()
    const { row } = await t.ready()
    ;(t.writer as MockVoucherWriter).faults.push('unknown_after_write')
    await t.sender.send(t.org.id, 'u1', row.id, row.draftHash)
    const run = await t.readback.read(t.org.id, 'u1', {
      financialYearId: 1,
      periodFrom: '2026-01-01',
      periodTo: '2026-12-31',
      costAccounts: [5170],
    })
    const s = run.summary as { totalOre: number; evenoExportOre: number }
    expect([s.totalOre, s.evenoExportOre]).toEqual([123450, 0])
  })

  // ── Org-gräns i tjänsten ────────────────────────────────────────────────────
  it('F16: annan organisations exportrad kan inte skickas, verifieras eller stämmas av', async () => {
    const a = await setup()
    const b = await setup()
    const { row } = await a.ready()
    await expect(b.sender.send(b.org.id, 'u1', row.id, row.draftHash)).rejects.toThrow(
      /hittades inte/,
    )
    await expect(b.sender.verify(b.org.id, row.id)).rejects.toThrow(/hittades inte/)
    await expect(
      b.sender.reconcile(b.org.id, 'u1', row.id, { year: 1, series: 'A', number: 1 }),
    ).rejects.toThrow(/hittades inte/)
    expect((a.writer as MockVoucherWriter).writes + (b.writer as MockVoucherWriter).writes).toBe(0)
  })
})
