/**
 * FORTNOX-NATT-20261003 (C1), A18: genererade fall med FASTA, sparade frön.
 * Antalet fall rapporteras per familj och skiljs från Jest-räkningen
 * (FORTNOX_GENERERAT_RAPPORT=<fil> skriver räkningen som JSON).
 *
 *  G1 (ren): transformer + compareVoucher mot oberoende orakel i heltalsören.
 *  G2 (riktig Postgres + skarp skrivare mot syntetisk HTTP): slumpade sekvenser av
 *     send/verify/reconcile/dry-run och fel, med oberoende invarianter efter varje steg.
 *  G3 (ren): transportens skrivgrind — en POST passerar endast som exakt
 *     POST /3/vouchers?financialyear=<positivt heltal> på en skrivkapabel transport.
 */
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { ConflictException } from '@nestjs/common'
import type { ConfigService } from '@nestjs/config'
import { PrismaClient } from '@prisma/client'
import type { PrismaService } from '../common/prisma/prisma.service'
import {
  buildFortnoxVoucherDraft,
  type FortnoxVoucherDraftConfig,
  type LocalJournalEntrySnapshot,
} from './export/fortnox-voucher-draft'
import { FortnoxConnectionService } from './fortnox-connection.service'
import { FortnoxExportService } from './fortnox-export.service'
import { VerifiedVoucherDraftBuilder } from './fortnox-export-builder'
import { FakeFortnoxApi, noopRateLimiter, type FakeFortnoxFault } from './fortnox-fake-api.testing'
import { FortnoxReadbackService } from './fortnox-readback.service'
import { MockFortnoxAuthProvider, MockFortnoxLedgerReader } from './fortnox-providers'
import { RealFortnoxLedgerReader } from './fortnox-real-provider'
import { FortnoxSendService, compareVoucher } from './fortnox-send.service'
import { FortnoxTokenCryptoService } from './fortnox-token-crypto.service'
import { RealFortnoxVoucherWriter } from './fortnox-voucher-writer'
import { FortnoxTransport } from './provider/fortnox-transport'
import { prepareFortnoxRequest } from './provider/fortnox-transport.routes'

/** Fasta frön (även i FORTNOX-NATT-20261003/CLAUDE1/genererat/FRON.json). */
export const FRON = { G1: 0x20261003, G2: 0x01868238, G3: 0x0e7e4003 } as const
const ANTAL = { G1: 1500, G2: 1000, G3: 1500 } as const
const rapport: Record<string, { fron: number; fall: number; kontroller: number }> = {}
const notera = (familj: keyof typeof FRON, fall: number, kontroller: number) => {
  rapport[familj] = { fron: FRON[familj], fall, kontroller }
}

afterAll(() => {
  const fil = process.env.FORTNOX_GENERERAT_RAPPORT
  if (fil) writeFileSync(fil, JSON.stringify({ antal: ANTAL, rapport }, null, 2) + '\n')
})

/** mulberry32 — deterministisk, beroendefri. */
function rng(seed: number) {
  let a = seed >>> 0
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1))
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!
  return { next, int, pick }
}

/** Oberoende: heltalsören → decimalsträng utan flyttal. */
const oreStr = (o: number) => `${Math.floor(o / 100)}.${String(o % 100).padStart(2, '0')}`
/** Oberoende: tal ur JSON → ören via strängform; null om inte exakt två decimaler. */
function oreOf(v: unknown): number | null {
  if (v === undefined || v === null) return 0
  if (typeof v !== 'number') return null
  const [i, d = ''] = String(v).split('.')
  if (d.length > 2 || !/^\d+$/.test(i ?? '')) return null
  return Number(i) * 100 + Number(d.padEnd(2, '0'))
}
const BOUNDARY = [1, 5, 99, 100, 101, 999, 1000, 99_999, 100_000, 999_999_999, 1_000_000_000]
const CHARS = 'abcdefghijklmnopqrstuvwxyzåäöÅÄÖ0123456789 -.,:/'

function amount(r: ReturnType<typeof rng>): number {
  return r.next() < 0.4 ? r.pick(BOUNDARY) : r.int(1, 50_000_000)
}

/** Balanserade rader i ören: d debetrader, c kreditrader. */
function balanced(r: ReturnType<typeof rng>) {
  const debits = Array.from({ length: r.int(1, 3) }, () => amount(r))
  const total = debits.reduce((a, b) => a + b, 0)
  const c = Math.min(r.int(1, 3), total)
  const cuts = new Set<number>()
  while (cuts.size < c - 1) cuts.add(r.int(1, total - 1))
  const pts = [0, ...[...cuts].sort((a, b) => a - b), total]
  const credits = pts.slice(1).map((p, i) => p - pts[i]!)
  return { debits, credits, total }
}

describe('A18 G1: transformer och jämförelse (ren)', () => {
  it(`${ANTAL.G1} genererade verifikat: balans, exakta ören, eko = MATCH, varje enskild mutation = MISMATCH`, () => {
    const r = rng(FRON.G1)
    let kontroller = 0
    const fel: string[] = []
    const check = (ok: boolean, what: string, i: number) => {
      kontroller += 1
      if (!ok && fel.length < 20) fel.push(`fall ${i}: ${what}`)
    }
    const ACCOUNTS = [1930, 2440, 2640, 3010, 4010, 5010, 5170, 6110, 7010, 8410]
    for (let i = 0; i < ANTAL.G1; i++) {
      const { debits, credits } = balanced(r)
      const day = r.pick(['2026-01-01', '2026-12-31', '2026-02-28', '2026-06-30', '2026-07-01'])
      const date =
        r.next() < 0.5
          ? day
          : `2026-${String(r.int(1, 12)).padStart(2, '0')}-${String(r.int(1, 28)).padStart(2, '0')}`
      const description =
        Array.from({ length: r.int(1, 50) }, () => r.pick([...CHARS]))
          .join('')
          .trim() || 'x'
      const lines = [
        ...debits.map((o) => ({ acc: r.pick(ACCOUNTS), debit: o, credit: null as number | null })),
        ...credits.map((o) => ({ acc: r.pick(ACCOUNTS), debit: null as number | null, credit: o })),
      ]
      const proof = { organizationId: 'o', externalDatabaseNumber: 1868238, evidenceRef: 'gen' }
      const entry: LocalJournalEntrySnapshot = {
        inputOrigin: 'PERSISTED_JOURNAL_ENTRY',
        id: `e${i}`,
        organizationId: 'o',
        date,
        eventDate: null,
        description,
        reference: null,
        source: 'MANUAL',
        sourceId: null,
        aiToolExecutionId: null,
        fiscalYear: 2026,
        series: 'A',
        verNumber: i + 1,
        reversalOfEntryId: null,
        lines: lines.map((l, k) => ({
          id: `l${i}-${k}`,
          journalEntryId: `e${i}`,
          accountId: `a${l.acc}`,
          debit: l.debit === null ? null : oreStr(l.debit),
          credit: l.credit === null ? null : oreStr(l.credit),
          description: null,
          account: { id: `a${l.acc}`, organizationId: 'o', number: l.acc },
        })),
      }
      const config: FortnoxVoucherDraftConfig = {
        organizationId: 'o',
        externalCompany: {
          organizationNumber: '555555-5555',
          databaseNumber: 1868238,
          evidenceRef: 'gen',
        },
        financialYear: {
          ...proof,
          localFiscalYear: 2026,
          id: 3,
          voucherYear: 3,
          fromDate: '2026-01-01',
          toDate: '2026-12-31',
        },
        voucherSeries: { ...proof, code: 'A', financialYearId: 3 },
        accounts: ACCOUNTS.map((n) => ({
          ...proof,
          localAccountId: `a${n}`,
          localAccountNumber: n,
          externalAccountNumber: n,
        })),
        dimensions: { ...proof, mode: 'OMIT', reason: 'gen' },
      }
      const res = buildFortnoxVoucherDraft(entry, config)
      check(res.status === 'READY_DRY_RUN', `status ${res.status}`, i)
      if (res.status !== 'READY_DRY_RUN') continue
      const v = res.payload.Voucher
      const rows = v.VoucherRows as Array<Record<string, unknown>>
      // Oberoende orakel: varje rad bär exakt genererat belopp och konto; balans; inga dimensioner.
      check(rows.length === lines.length, 'radantal', i)
      rows.forEach((row, k) => {
        check(row.Account === lines[k]!.acc, 'konto', i)
        check(oreOf(row.Debit) === (lines[k]!.debit ?? 0), 'debet', i)
        check(oreOf(row.Credit) === (lines[k]!.credit ?? 0), 'kredit', i)
        check(!('CostCenter' in row) && !('Project' in row), 'dimension', i)
      })
      const sum = (k: 'Debit' | 'Credit') => rows.reduce((a, x) => a + (oreOf(x[k]) ?? NaN), 0)
      check(sum('Debit') === sum('Credit'), 'balans', i)
      check(
        v.Description === description && v.TransactionDate === date && v.VoucherSeries === 'A',
        'huvud',
        i,
      )
      check(res.query.financialyear === 3, 'år', i)

      const frozen = { payload: res.payload, query: res.query } as Parameters<
        typeof compareVoucher
      >[0]
      const id = { year: 3, series: 'A', number: r.int(1, 99999) }
      const echo = () =>
        ({ ...structuredClone(v), Year: 3, VoucherNumber: id.number }) as Record<string, unknown>
      check(compareVoucher(frozen, echo(), id), 'eko ska matcha', i)
      const reordered = echo()
      ;(reordered.VoucherRows as unknown[]).reverse()
      check(compareVoucher(frozen, reordered, id), 'omordnade rader ska matcha', i)
      const k = r.int(0, rows.length - 1)
      const mutations: Array<[string, (x: Record<string, unknown>) => void]> = [
        [
          'öre',
          (x) => {
            const row = (x.VoucherRows as Array<Record<string, number>>)[k]!
            if (row.Debit) row.Debit = (oreOf(row.Debit)! + 1) / 100
            else row.Credit = (oreOf(row.Credit)! + 1) / 100
          },
        ],
        [
          'konto',
          (x) => {
            const row = (x.VoucherRows as Array<Record<string, number>>)[k]!
            row.Account = row.Account === 9999 ? 9998 : 9999
          },
        ],
        [
          'beskrivning',
          (x) => {
            x.Description = `${String(x.Description)}x`
          },
        ],
        [
          'datum',
          (x) => {
            x.TransactionDate = x.TransactionDate === '2026-12-31' ? '2026-12-30' : '2026-12-31'
          },
        ],
        [
          'serie',
          (x) => {
            x.VoucherSeries = 'B'
          },
        ],
        [
          'år',
          (x) => {
            x.Year = 4
          },
        ],
        [
          'nummer',
          (x) => {
            x.VoucherNumber = id.number + 1
          },
        ],
        [
          'borttagen rad',
          (x) => {
            ;(x.VoucherRows as Array<Record<string, unknown>>)[k]!.Removed = true
          },
        ],
        [
          'saknad rad',
          (x) => {
            ;(x.VoucherRows as unknown[]).splice(k, 1)
          },
        ],
        [
          'extra nollrad',
          (x) => {
            ;(x.VoucherRows as unknown[]).push({ Account: 1930, Debit: 0, Credit: 0 })
          },
        ],
        [
          'sida bytt',
          (x) => {
            const row = (x.VoucherRows as Array<Record<string, unknown>>)[k]!
            const d = row.Debit
            row.Debit = row.Credit
            row.Credit = d
          },
        ],
      ]
      for (const [name, mutate] of mutations) {
        const m = echo()
        mutate(m)
        check(!compareVoucher(frozen, m, id), `mutation ${name} ska inte matcha`, i)
      }
    }
    notera('G1', ANTAL.G1, kontroller)
    expect(fel).toEqual([])
    expect(kontroller).toBeGreaterThan(ANTAL.G1 * 15)
  })
})

describe('A18 G3: transportens skrivgrind (ren)', () => {
  it(`${ANTAL.G3} genererade anrop: POST passerar endast som exakt POST /3/vouchers?financialyear=<positivt heltal> med skrivförmåga`, () => {
    const r = rng(FRON.G3)
    const PATHS = [
      '/3/vouchers',
      '/3/vouchers/A/1',
      '/3/vouchers/sublist',
      '/3/accounts',
      '/3/accounts/1930',
      '/3/financialyears',
      '/3/companyinformation',
      '/3/voucherseries/A',
      '/3/supplierinvoices',
      '/3/invoices',
      '/3/vouchers/',
      '/3/Vouchers',
      '/3/vouchers?x=1',
      '/3/vouchers#a',
      '/3/vouchers/%2e%2e',
      'https://api.fortnox.se/3/vouchers',
      '//evil.example/3/vouchers',
      '/3/../3/vouchers',
      '/3/vouchers/A/1/2',
      '/2/vouchers',
    ]
    const METHODS = ['POST', 'GET', 'PUT', 'DELETE', 'PATCH', 'post']
    const QVALUES: unknown[] = [
      1,
      3,
      0,
      -1,
      1.5,
      '1',
      '01',
      '1x',
      ' 1',
      '',
      9007199254740993,
      true,
      'A',
    ]
    let kontroller = 0
    let postPasserade = 0
    const fel: string[] = []
    for (let i = 0; i < ANTAL.G3; i++) {
      // Hälften nära-giltiga skrivningar (en avvikelse åt gången), resten fritt.
      const near = r.next() < 0.5
      const method = near ? (r.next() < 0.9 ? 'POST' : r.pick(METHODS)) : r.pick(METHODS)
      const path = near ? (r.next() < 0.8 ? '/3/vouchers' : r.pick(PATHS)) : r.pick(PATHS)
      const allow = r.next() < 0.7
      const query: Record<string, unknown> = {}
      if (near) {
        if (r.next() < 0.85) query.financialyear = r.next() < 0.6 ? r.int(1, 99) : r.pick(QVALUES)
        if (r.next() < 0.15) query[r.pick(['voucherseries', 'page', 'x'])] = r.pick(QVALUES)
      } else {
        const qk = r.int(0, 2)
        for (let q = 0; q < qk; q++)
          query[r.pick(['financialyear', 'voucherseries', 'page', 'limit', 'x'])] = r.pick(QVALUES)
      }
      const body =
        near && r.next() < 0.8
          ? { Voucher: {} }
          : r.pick<unknown>([{ Voucher: {} }, {}, [], null, undefined, 'x'])
      let passed: { url: string; method: string } | null = null
      try {
        const p = prepareFortnoxRequest(
          {
            accessToken: 'tok',
            rateLimitKey: 'k',
            method: method as 'POST',
            path,
            query: query as Record<string, string>,
            body,
          },
          allow,
        )
        passed = { url: p.url, method: p.method }
      } catch {
        passed = null
      }
      // Oberoende orakel för skrivning.
      const fy = query.financialyear
      const fyOk =
        (typeof fy === 'number' && Number.isSafeInteger(fy) && fy >= 1) ||
        (typeof fy === 'string' &&
          /^\d+$/.test(fy) &&
          Number.isSafeInteger(Number(fy)) &&
          Number(fy) >= 1)
      const onlyFy = Object.keys(query).every((k) => k === 'financialyear')
      const bodyOk = body !== null && typeof body === 'object' && !Array.isArray(body)
      const expectPost =
        method === 'POST' &&
        allow &&
        path === '/3/vouchers' &&
        onlyFy &&
        (fy === undefined || fyOk) &&
        bodyOk
      kontroller += 1
      if (method === 'POST') {
        if (Boolean(passed) !== expectPost && fel.length < 20)
          fel.push(
            `fall ${i}: POST ${path} ${JSON.stringify(query)} allow=${allow} → ${passed ? 'passerade' : 'avvisad'}`,
          )
      } else if (passed && passed.method !== 'GET') {
        fel.push(`fall ${i}: ${method} passerade som ${passed.method}`)
      }
      if (passed?.method === 'POST') postPasserade += 1
      if (passed) {
        kontroller += 1
        const u = new URL(passed.url)
        if (u.origin !== 'https://api.fortnox.se' || !u.pathname.startsWith('/3/') || u.hash)
          fel.push(`fall ${i}: url ${passed.url}`)
        if (passed.method === 'POST' && u.pathname !== '/3/vouchers')
          fel.push(`fall ${i}: POST-väg ${u.pathname}`)
      }
    }
    notera('G3', ANTAL.G3, kontroller)
    ;(rapport.G3 as Record<string, number>).postPasserade = postPasserade
    expect(fel).toEqual([])
    // Icke-tomt: grinden ska faktiskt släppa igenom giltiga skrivningar i urvalet.
    expect(postPasserade).toBeGreaterThan(ANTAL.G3 / 10)
  })
})

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip
const KEY = 'cd'.repeat(32)
const LOCKED = [
  'UNKNOWN',
  'REJECTED',
  'RECEIPT_MISMATCH',
  'RECEIPT_IDENTIFIED',
  'CONFIRMED',
  'SENDING',
]

medDb('A18 G2: tillståndsmaskin mot riktig Postgres och skarp skrivare (syntetisk HTTP)', () => {
  let prisma: PrismaClient
  const orgs: string[] = []
  beforeAll(async () => {
    const u = new URL(process.env.DATABASE_URL!)
    u.searchParams.set('connection_limit', '8')
    prisma = new PrismaClient({ datasources: { db: { url: u.toString() } } })
    await prisma.$connect()
  })
  afterAll(async () => {
    for (const id of orgs) {
      await prisma.fortnoxVoucherExport.deleteMany({ where: { organizationId: id } })
      await prisma.fortnoxReadRun.deleteMany({ where: { organizationId: id } })
      await prisma.journalEntryLine.deleteMany({ where: { journalEntry: { organizationId: id } } })
      await prisma.journalEntry.deleteMany({ where: { organizationId: id } })
      await prisma.account.deleteMany({ where: { organizationId: id } })
      await prisma.organization.delete({ where: { id } }).catch(() => undefined)
    }
    await prisma.$disconnect()
  })

  async function org() {
    const sfx = randomUUID().slice(0, 8)
    const o = await prisma.organization.create({
      data: {
        name: `gen-${sfx}`,
        email: `gen-${sfx}@example.se`,
        street: 'a',
        city: 'b',
        postalCode: '1',
      },
    })
    orgs.push(o.id)
    const config = {
      get: (k: string) => ({ FORTNOX_TOKEN_KEY: KEY })[k],
    } as unknown as ConfigService
    const ledger = new MockFortnoxLedgerReader()
    ledger.pageSize = 50
    ledger.company = {
      CompanyName: 'Eveno integrationstest 2026-10-02',
      OrganizationNumber: '555555-5555',
      DatabaseNumber: 1868238,
    }
    const api = new FakeFortnoxApi(ledger)
    const fetch = api.fetch as unknown as typeof globalThis.fetch
    const reader = new RealFortnoxLedgerReader({
      transport: new FortnoxTransport({ fetch, rateLimiter: noopRateLimiter }),
      clientId: 'k',
      enabled: true,
    })
    const writer = new RealFortnoxVoucherWriter({
      transport: new FortnoxTransport({
        fetch,
        rateLimiter: noopRateLimiter,
        allowVoucherWrites: true,
      }),
      reader,
      clientId: 'k',
    })
    const db = prisma as unknown as PrismaService
    const connections = new FortnoxConnectionService(
      db,
      new FortnoxTokenCryptoService(config),
      config,
      new MockFortnoxAuthProvider(),
      reader,
    )
    const builder = new VerifiedVoucherDraftBuilder(db, connections, reader)
    const exportsSvc = new FortnoxExportService(db, builder)
    const sender = new FortnoxSendService(db, connections, builder, reader, writer)
    const readback = new FortnoxReadbackService(db, connections, reader)
    const { authUrl } = await connections.begin(o.id, 'u1')
    const state = new URL(authUrl).searchParams.get('state')!
    await connections.handleCallback(state, `mock-code-${state.slice(0, 8)}`)
    await connections.setExportVoucherSeries(o.id, 'A')
    await connections.setExportOmitDimensions(o.id, 'u1', true)
    const a = await prisma.account.create({
      data: { organizationId: o.id, number: 5170, name: 'R', type: 'EXPENSE' },
    })
    const b = await prisma.account.create({
      data: { organizationId: o.id, number: 2440, name: 'L', type: 'LIABILITY' },
    })
    return { o, api, ledger, exportsSvc, sender, readback, a, b }
  }

  it(`${ANTAL.G2} genererade sekvenser: ≤1 POST per export, låsta tillstånd blir aldrig READY, CONFIRMED = exakt återläst innehåll, unika identiteter, readback räknar en gång`, async () => {
    const r = rng(FRON.G2)
    const SEND_FAULTS = [
      'ok',
      'ok',
      'ok',
      'drop_response_after_write',
      'status_500_after_write',
      'status_400',
      'status_429',
      'network_error_before_write',
      'wrong_year_after_write',
      'no_number_after_write',
      'ci_mismatch',
      'ci_401',
    ] as const
    const EXPECT: Record<(typeof SEND_FAULTS)[number], string> = {
      ok: 'CONFIRMED',
      drop_response_after_write: 'UNKNOWN',
      status_500_after_write: 'UNKNOWN',
      status_400: 'REJECTED',
      status_429: 'REJECTED',
      network_error_before_write: 'UNKNOWN',
      wrong_year_after_write: 'UNKNOWN',
      no_number_after_write: 'UNKNOWN',
      ci_mismatch: 'DRY_RUN_READY',
      ci_401: 'DRY_RUN_READY',
    }
    const PER_ORG = 25
    let kontroller = 0
    let steg = 0
    const fel: string[] = []
    const check = (ok: boolean, what: string) => {
      kontroller += 1
      if (!ok && fel.length < 30) fel.push(what)
    }
    let t = await org()
    let foreign = 0
    const utfall: Record<string, number> = {}
    const tally = (k: string) => (utfall[k] = (utfall[k] ?? 0) + 1)
    for (let i = 0; i < ANTAL.G2; i++) {
      if (i > 0 && i % PER_ORG === 0) {
        await checkReadback(t, check, i)
        t = await org()
      }
      const ore = amount(r)
      const desc = `EVENO TEST GEN ${FRON.G2}-${i}`
      const je = await prisma.journalEntry.create({
        data: {
          organizationId: t.o.id,
          date: new Date('2026-10-02'),
          description: desc,
          fiscalYear: 2026,
          verNumber: i + 1,
          lines: {
            create: [
              { accountId: t.a.id, debit: oreStr(ore) },
              { accountId: t.b.id, credit: oreStr(ore) },
            ],
          },
        },
      })
      const row = await t.exportsSvc.dryRun(t.o.id, je.id)
      check(row.state === 'DRY_RUN_READY', `fall ${i}: dry-run ${row.state}`)
      let posts = 0
      let prev = row.state
      const ops = r.int(2, 6)
      for (let s = 0; s < ops; s++) {
        steg += 1
        const op = r.pick([
          'send',
          'send',
          'send',
          'verify',
          'reconcile',
          'dryrun',
          'foreign',
        ] as const)
        const before = t.api.posts
        const cur = await prisma.fortnoxVoucherExport.findUniqueOrThrow({ where: { id: row.id } })
        let expected: string | null = null
        try {
          if (op === 'send') {
            const f = r.pick(SEND_FAULTS)
            if (f === 'ci_mismatch') t.api.companyOverride.set(t.api.companyCalls + 2, 900001)
            else if (f === 'ci_401') t.api.companyStatus.set(t.api.companyCalls + 2, 401)
            else if (f !== 'ok') t.api.faults.push(f as FakeFortnoxFault)
            expected = cur.state === 'DRY_RUN_READY' ? EXPECT[f] : 'CONFLICT'
            const res = await t.sender.send(t.o.id, 'u1', row.id, cur.draftHash ?? row.draftHash!)
            check(
              res.state === expected,
              `fall ${i} steg ${s}: send ${f} gav ${res.state}, väntat ${expected}`,
            )
          } else if (op === 'verify') {
            expected = cur.state === 'RECEIPT_IDENTIFIED' ? 'ANY' : 'CONFLICT'
            await t.sender.verify(t.o.id, row.id)
          } else if (op === 'reconcile') {
            const kind = r.pick(['right', 'foreign', 'missing'] as const)
            const ours = t.ledger.vouchers.find((v) => v.Description === desc)
            const other = t.ledger.vouchers.find((v) => v.Description !== desc)
            const id =
              kind === 'right' && ours
                ? { year: 1, series: 'A', number: Number(ours.VoucherNumber) }
                : kind === 'foreign' && other
                  ? { year: 1, series: 'A', number: Number(other.VoucherNumber) }
                  : { year: 1, series: 'A', number: 999_999 }
            const locked = ['UNKNOWN', 'REJECTED', 'RECEIPT_MISMATCH'].includes(cur.state)
            const ourId = ours && id.number === Number(ours.VoucherNumber)
            expected = locked && ourId ? 'CONFIRMED' : 'CONFLICT'
            const res = await t.sender.reconcile(t.o.id, 'u1', row.id, id)
            check(
              res.state === expected,
              `fall ${i} steg ${s}: reconcile ${kind} gav ${res.state}, väntat ${expected}`,
            )
          } else if (op === 'dryrun') {
            expected = 'ANY'
            const res = await t.exportsSvc.dryRun(t.o.id, je.id)
            if (LOCKED.includes(cur.state))
              check(res.state === cur.state, `fall ${i}: dry-run ändrade ${cur.state}→${res.state}`)
          } else {
            foreign += 1
            const n = Math.max(0, ...t.ledger.vouchers.map((v) => Number(v.VoucherNumber))) + 1
            const fo = amount(r)
            t.ledger.vouchers.push({
              Year: 1,
              VoucherSeries: 'A',
              VoucherNumber: n,
              TransactionDate: '2026-10-03',
              Description: `FRÄMMANDE ${foreign}`,
              VoucherRows: [
                { Account: 5170, Debit: fo / 100, Credit: 0 },
                { Account: 2440, Debit: 0, Credit: fo / 100 },
              ],
            })
          }
        } catch (err) {
          tally(`${op}:409`)
          check(
            expected === 'CONFLICT' && err instanceof ConflictException,
            `fall ${i} steg ${s}: ${op} kastade ${(err as Error).message}, väntat ${expected}`,
          )
        } finally {
          t.api.faults = []
          t.api.companyOverride.clear()
          t.api.companyStatus.clear()
        }
        posts += t.api.posts - before
        const now = await prisma.fortnoxVoucherExport.findUniqueOrThrow({ where: { id: row.id } })
        if (now.state !== cur.state) tally(`${op}:${cur.state}->${now.state}`)
        if (op === 'send' && now.state === 'DRY_RUN_READY' && now.lastOutcome === 'NOT_SENT')
          tally('send:not_sent')
        // Invarianter (oberoende av produktens egna jämförelser).
        check(posts <= 1, `fall ${i}: ${posts} POST för samma export`)
        check(
          !(LOCKED.includes(prev) && (now.state === 'DRY_RUN_READY' || now.state === 'BLOCKED')),
          `fall ${i}: ${prev}→${now.state}`,
        )
        if (now.state === 'CONFIRMED') {
          const v = t.ledger.vouchers.find(
            (x) =>
              x.VoucherSeries === now.externalSeries &&
              x.VoucherNumber === now.externalNumber &&
              x.Year === now.externalYear,
          )
          const rows = (v?.VoucherRows ?? []) as Array<Record<string, unknown>>
          const keys = rows
            .map((x) => `${String(x.Account)}|${oreOf(x.Debit)}|${oreOf(x.Credit)}`)
            .sort()
          check(
            v?.Description === desc &&
              v?.TransactionDate === '2026-10-02' &&
              JSON.stringify(keys) === JSON.stringify([`2440|0|${ore}`, `5170|${ore}|0`].sort()),
            `fall ${i}: CONFIRMED utan exakt innehåll`,
          )
        }
        prev = now.state
      }
    }
    await checkReadback(t, check, ANTAL.G2)
    const dupes = await prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*)::bigint AS n FROM (
        SELECT "organizationId","fortnoxDatabaseNumber","externalYear","externalSeries","externalNumber"
        FROM "FortnoxVoucherExport" WHERE "externalNumber" IS NOT NULL AND "organizationId" = ANY(${orgs})
        GROUP BY 1,2,3,4,5 HAVING count(*) > 1) d`
    check(Number(dupes[0]!.n) === 0, 'dubbla externa identiteter')
    notera('G2', ANTAL.G2, kontroller)
    rapport.G2!.kontroller = kontroller
    ;(rapport.G2 as Record<string, unknown>).steg = steg
    ;(rapport.G2 as Record<string, unknown>).utfall = utfall
    // Icke-tomt: varje huvudövergång ska ha nåtts i urvalet.
    for (const k of [
      'send:DRY_RUN_READY->CONFIRMED',
      'send:DRY_RUN_READY->UNKNOWN',
      'send:DRY_RUN_READY->REJECTED',
      'reconcile:UNKNOWN->CONFIRMED',
      'send:409',
      'reconcile:409',
      'send:not_sent',
    ])
      expect([k, (utfall[k] ?? 0) > 10]).toEqual([k, true])
    expect(fel).toEqual([])
  }, 900_000)

  async function checkReadback(
    t: Awaited<ReturnType<typeof org>>,
    check: (ok: boolean, what: string) => void,
    i: number,
  ) {
    const run = await t.readback.read(t.o.id, 'u1', {
      financialYearId: 1,
      periodFrom: '2026-01-01',
      periodTo: '2026-12-31',
      costAccounts: [5170],
    })
    const s = run.summary as { totalOre: number; evenoExportOre: number } | null
    // Oberoende summor ur den syntetiska huvudboken.
    const net = (v: { VoucherRows?: unknown }) =>
      ((v.VoucherRows ?? []) as Array<Record<string, unknown>>)
        .filter((x) => x.Account === 5170)
        .reduce((a, x) => a + (oreOf(x.Debit) ?? 0) - (oreOf(x.Credit) ?? 0), 0)
    const total = t.ledger.vouchers.reduce((a, v) => a + net(v), 0)
    const confirmed = await prisma.fortnoxVoucherExport.findMany({
      where: { organizationId: t.o.id, state: 'CONFIRMED' },
    })
    const eveno = confirmed.reduce((a, c) => {
      const v = t.ledger.vouchers.find(
        (x) => x.VoucherSeries === c.externalSeries && x.VoucherNumber === c.externalNumber,
      )
      return a + (v ? net(v) : NaN)
    }, 0)
    check(s !== null && s.totalOre === total, `readback före ${i}: total ${s?.totalOre} ≠ ${total}`)
    check(
      s !== null && s.evenoExportOre === eveno,
      `readback före ${i}: eveno ${s?.evenoExportOre} ≠ ${eveno}`,
    )
  }
})
