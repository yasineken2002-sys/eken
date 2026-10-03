/**
 * FORTNOX-NATT-20261003 (C1): spärrarna kring den skarpa skrivaren.
 * INVENTERING-001 A01, A03, A14, A15.
 */
import type { ConfigService } from '@nestjs/config'
import { FortnoxTokenCryptoService } from './fortnox-token-crypto.service'
import {
  MockFortnoxLedgerReader,
  StubFortnoxLedgerReader,
  fortnoxTestVoucherWritesOptIn,
} from './fortnox-providers'
import { RealFortnoxLedgerReader } from './fortnox-real-provider'
import {
  DisabledVoucherWriter,
  FORTNOX_TEST_WRITE_COMPANIES,
  FORTNOX_VOUCHER_WRITER,
  FortnoxWriteError,
  RealFortnoxVoucherWriter,
} from './fortnox-voucher-writer'
import { FortnoxModule, realClients } from './fortnox.module'
import { FortnoxTransport } from './provider/fortnox-transport'
import { FakeFortnoxApi, noopRateLimiter } from './fortnox-fake-api.testing'

const KEY = 'cd'.repeat(32)
const cfg = (env: Record<string, string | undefined>) =>
  ({ get: (k: string) => env[k] }) as unknown as ConfigService
const REAL = {
  FORTNOX_ENABLED: 'true',
  FORTNOX_TOKEN_KEY: KEY,
  FORTNOX_PROVIDER: 'real',
  FORTNOX_CLIENT_ID: 'syntetiskt-klient-id',
  FORTNOX_CLIENT_SECRET: 'SYNTETISK-HEMLIGHET-123',
  FORTNOX_CALLBACK_URL: 'https://app.example.se/v1/integrations/fortnox/callback',
  NODE_ENV: 'development',
}
const OPT_IN = { FORTNOX_TEST_VOUCHER_WRITES: 'testforetag-1868238' }

function writerFactory() {
  const providers = Reflect.getMetadata('providers', FortnoxModule) as Array<{
    provide?: unknown
    useFactory?: (...a: unknown[]) => unknown
  }>
  return providers.find((p) => p?.provide === FORTNOX_VOUCHER_WRITER)!.useFactory!
}

function build(env: Record<string, string | undefined>) {
  const config = cfg(env)
  const real = realClients(config, new FortnoxTokenCryptoService(config))
  const reader = real
    ? new RealFortnoxLedgerReader({
        transport: real.transport,
        clientId: real.clientId,
        enabled: true,
      })
    : new StubFortnoxLedgerReader()
  return { real, writer: writerFactory()(reader, config, real) as { capable: boolean } }
}

describe('FORTNOX-NATT: spärrar för skarp skrivning', () => {
  it('företagslistan är hårdkodad till exakt testföretaget och fryst', () => {
    expect(FORTNOX_TEST_WRITE_COMPANIES).toEqual([1868238])
    expect(Object.isFrozen(FORTNOX_TEST_WRITE_COMPANIES)).toBe(true)
  })

  it('A01: REAL utan opt-in → DisabledVoucherWriter och ingen skrivtransport', () => {
    const { real, writer } = build(REAL)
    expect(real?.writeTransport).toBeNull()
    expect(writer).toBeInstanceOf(DisabledVoucherWriter)
    expect(writer.capable).toBe(false)
  })

  it('REAL med exakt opt-in → RealFortnoxVoucherWriter som bara tillåter testföretaget', () => {
    const { real, writer } = build({ ...REAL, ...OPT_IN })
    expect(real?.writeTransport).toBeInstanceOf(FortnoxTransport)
    expect(real?.writeTransport).not.toBe(real?.transport)
    expect(writer).toBeInstanceOf(RealFortnoxVoucherWriter)
    const w = writer as RealFortnoxVoucherWriter
    expect(w.allowsCompany(1868238)).toBe(true)
    for (const other of [null, 0, 900001, 1868237, 1868239])
      expect(w.allowsCompany(other)).toBe(false)
  })

  it('opt-in i Stub- eller Mock-läge ger ingen skarp skrivare', () => {
    expect(build({ ...OPT_IN }).writer).toBeInstanceOf(DisabledVoucherWriter)
    const mock = writerFactory()(
      new MockFortnoxLedgerReader(),
      cfg({ ...OPT_IN, NODE_ENV: 'test' }),
      null,
    )
    expect(mock).not.toBeInstanceOf(RealFortnoxVoucherWriter)
  })

  it.each([
    'true',
    '1',
    'yes',
    'testforetag-1868238 ',
    ' testforetag-1868238',
    'testforetag-900001',
    'TESTFORETAG-1868238',
  ])('A03: felaktigt opt-in-värde %p stoppar boot i alla lägen', (value) => {
    expect(() =>
      fortnoxTestVoucherWritesOptIn(cfg({ FORTNOX_TEST_VOUCHER_WRITES: value })),
    ).toThrow(/ogiltigt värde/)
    expect(() => build({ ...REAL, FORTNOX_TEST_VOUCHER_WRITES: value })).toThrow(/ogiltigt värde/)
    expect(() =>
      writerFactory()(
        new StubFortnoxLedgerReader(),
        cfg({ FORTNOX_TEST_VOUCHER_WRITES: value }),
        null,
      ),
    ).toThrow(/ogiltigt värde/)
  })

  it('A03: opt-in i NODE_ENV=production stoppar boot; tomt/saknat är av', () => {
    expect(() => build({ ...REAL, ...OPT_IN, NODE_ENV: 'production' })).toThrow(/produktion/)
    expect(fortnoxTestVoucherWritesOptIn(cfg({}))).toBe(false)
    expect(fortnoxTestVoucherWritesOptIn(cfg({ FORTNOX_TEST_VOUCHER_WRITES: '' }))).toBe(false)
  })

  it('felmeddelanden innehåller aldrig värdet', () => {
    try {
      fortnoxTestVoucherWritesOptIn(cfg({ FORTNOX_TEST_VOUCHER_WRITES: 'hemligt-varde-xyz' }))
    } catch (e) {
      expect(String((e as Error).message)).not.toContain('hemligt-varde-xyz')
    }
  })

  describe('skrivaren mot syntetisk HTTP', () => {
    function rig(company = 1868238) {
      const ledger = new MockFortnoxLedgerReader()
      ledger.company = { ...ledger.company, DatabaseNumber: company }
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
      return { api, reader, writer }
    }
    const payload = {
      Voucher: {
        Description: 'EVENO TEST 20261003 x',
        TransactionDate: '2026-10-02',
        VoucherSeries: 'A',
        Year: 1,
        VoucherRows: [
          { Account: 5170, Debit: 1 },
          { Account: 2440, Credit: 1 },
        ],
      },
    }

    it('bindning utanför listan → not_sent utan ett enda HTTP-anrop', async () => {
      const { api, writer } = rig()
      for (const db of [null, 900001]) {
        await expect(
          writer.createVoucher('tok', { financialyear: 1 }, payload, { databaseNumber: db }),
        ).rejects.toMatchObject({ outcome: 'not_sent' })
      }
      expect(api.requests).toEqual([])
    })

    it('live-företaget ≠ bindningen → not_sent, endast GET companyinformation', async () => {
      const { api, writer } = rig(900001)
      await expect(
        writer.createVoucher('tok', { financialyear: 1 }, payload, { databaseNumber: 1868238 }),
      ).rejects.toBeInstanceOf(FortnoxWriteError)
      expect(api.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
        'GET /3/companyinformation',
      ])
    })

    it('A15: läsarens transport kan aldrig POSTa (WRITE_DISABLED, 0 anrop)', async () => {
      const { api } = rig()
      const t = new FortnoxTransport({
        fetch: api.fetch as unknown as typeof globalThis.fetch,
        rateLimiter: noopRateLimiter,
      })
      await expect(
        t.request({
          accessToken: 'tok',
          rateLimitKey: 'k',
          method: 'POST',
          path: '/3/vouchers',
          body: {},
          query: { financialyear: 1 },
        }),
      ).rejects.toMatchObject({ code: 'WRITE_DISABLED', outcome: 'not_sent' })
      expect(api.requests).toEqual([])
    })

    it.each([
      ['/3/accounts', { financialyear: 1 }],
      ['/3/financialyears', {}],
      ['/3/vouchers/A/1', { financialyear: 1 }],
      ['/3/vouchers', { financialyear: 0 }],
      ['/3/vouchers', { financialyear: '1x' }],
      ['/3/vouchers', { voucherseries: 'A' }],
      ['/3/vouchers/../accounts', {}],
    ] as const)(
      'A14: skrivtransporten avvisar POST %s %j lokalt (not_sent, 0 anrop)',
      async (path, query) => {
        const { api } = rig()
        const t = new FortnoxTransport({
          fetch: api.fetch as unknown as typeof globalThis.fetch,
          rateLimiter: noopRateLimiter,
          allowVoucherWrites: true,
        })
        await expect(
          t.request({
            accessToken: 'tok',
            rateLimitKey: 'k',
            method: 'POST',
            path,
            body: {},
            query,
          }),
        ).rejects.toMatchObject({ outcome: 'not_sent' })
        expect(api.requests).toEqual([])
      },
    )
  })
})
