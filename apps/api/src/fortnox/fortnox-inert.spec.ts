/**
 * Inert som standard (C2 K-F2/K-F3, SAMORDNING-04):
 *  - modulen registrerar ingen cron, kö, worker eller hook → automationsinventeringen
 *    (health: cron/konsumenter) är oförändrad oavsett flagga;
 *  - utan FORTNOX_ENABLED=true väljs Stub (503 på anslutning);
 *  - Mock väljs ENDAST vid NODE_ENV=test + uttryckligt val — aldrig i development,
 *    production eller saknad NODE_ENV; påslaget utan skarp provider kastar.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ServiceUnavailableException } from '@nestjs/common'
import type { ConfigService } from '@nestjs/config'
import { FortnoxTokenCryptoService } from './fortnox-token-crypto.service'
import { StubFortnoxAuthProvider, StubFortnoxLedgerReader, fortnoxMode } from './fortnox-providers'
import { RealFortnoxAuthProvider } from './fortnox-real-provider'
import { FORTNOX_SCOPES, realClients } from './fortnox.module'

const KEY = 'cd'.repeat(32)
const cfg = (env: Record<string, string | undefined>) =>
  ({ get: (k: string) => env[k] }) as unknown as ConfigService
const mode = (env: Record<string, string | undefined>) =>
  fortnoxMode(cfg(env), new FortnoxTokenCryptoService(cfg(env)))

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? sources(join(dir, e.name))
      : e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts')
        ? [join(dir, e.name)]
        : [],
  )
}

describe('Fortnox inert som standard', () => {
  it('ingen cron, kö, worker eller schemaläggning i Fortnox-koden', () => {
    const files = sources(__dirname)
    expect(files.length).toBeGreaterThan(10) // skanningen har inte gått blind
    for (const f of files) {
      const s = readFileSync(f, 'utf8')
      expect([
        f,
        /@Cron\(|@Interval\(|@Timeout\(|@Processor\(|@Process\(|BullModule|registerQueue|setInterval\(/.test(
          s,
        ),
      ]).toEqual([f, false])
    }
  })

  it.each([
    [{}, 'STUB'],
    [{ FORTNOX_ENABLED: 'false', FORTNOX_PROVIDER: 'mock', NODE_ENV: 'test' }, 'STUB'],
    [
      {
        FORTNOX_ENABLED: 'true',
        FORTNOX_TOKEN_KEY: KEY,
        FORTNOX_PROVIDER: 'mock',
        NODE_ENV: 'test',
      },
      'MOCK',
    ],
  ])('val av provider %j → %s', (env, want) => {
    expect(mode(env)).toBe(want)
  })

  it.each([
    [{ FORTNOX_ENABLED: 'true', FORTNOX_PROVIDER: 'mock', NODE_ENV: 'test' }, /FORTNOX_TOKEN_KEY/],
    [
      {
        FORTNOX_ENABLED: 'true',
        FORTNOX_TOKEN_KEY: KEY,
        FORTNOX_PROVIDER: 'mock',
        NODE_ENV: 'development',
      },
      /uttryckligt FORTNOX_PROVIDER=real/,
    ],
    [
      {
        FORTNOX_ENABLED: 'true',
        FORTNOX_TOKEN_KEY: KEY,
        FORTNOX_PROVIDER: 'mock',
        NODE_ENV: 'production',
      },
      /uttryckligt FORTNOX_PROVIDER=real/,
    ],
    [
      { FORTNOX_ENABLED: 'true', FORTNOX_TOKEN_KEY: KEY, FORTNOX_PROVIDER: 'mock' },
      /uttryckligt FORTNOX_PROVIDER=real/,
    ],
    [
      { FORTNOX_ENABLED: 'true', FORTNOX_TOKEN_KEY: KEY, NODE_ENV: 'production' },
      /uttryckligt FORTNOX_PROVIDER=real/,
    ],
  ])('påslaget utan säker provider kastar vid boot %j', (env, msg) => {
    expect(() => mode(env)).toThrow(msg)
  })

  const REAL = {
    FORTNOX_ENABLED: 'true',
    FORTNOX_TOKEN_KEY: KEY,
    FORTNOX_PROVIDER: 'real',
    FORTNOX_CLIENT_ID: 'syntetiskt-klient-id',
    FORTNOX_CLIENT_SECRET: 'SYNTETISK-HEMLIGHET-123',
    FORTNOX_CALLBACK_URL: 'https://app.example.se/v1/integrations/fortnox/callback',
  }

  it.each([
    [
      { FORTNOX_ENABLED: 'true', FORTNOX_TOKEN_KEY: KEY, FORTNOX_PROVIDER: 'real' },
      /saknar FORTNOX_CLIENT_ID, FORTNOX_CLIENT_SECRET, FORTNOX_CALLBACK_URL/,
    ],
    [
      {
        FORTNOX_ENABLED: 'true',
        FORTNOX_TOKEN_KEY: KEY,
        FORTNOX_PROVIDER: 'real',
        FORTNOX_CLIENT_ID: 'id',
        FORTNOX_CLIENT_SECRET: 's',
        FORTNOX_CALLBACK_URL: 'http://x.example/cb',
      },
      /FORTNOX_CALLBACK_URL \(https\)/,
    ],
    [{ FORTNOX_ENABLED: 'true', FORTNOX_PROVIDER: 'real' }, /FORTNOX_TOKEN_KEY/],
  ])('REAL med ofullständig konfiguration stoppar vid boot %#', (env, msg) => {
    expect(() => mode(env)).toThrow(msg)
  })

  it('REAL endast vid uttryckligt val och komplett konfiguration', () => {
    expect(mode(REAL)).toBe('REAL')
    expect(mode({ ...REAL, FORTNOX_ENABLED: 'false' })).toBe('STUB')
  })

  it('felmeddelanden namnger nycklar, aldrig värden', () => {
    try {
      mode({ ...REAL, FORTNOX_CALLBACK_URL: 'ftp://x' })
      throw new Error('borde ha kastat')
    } catch (e) {
      expect(String(e)).not.toContain('SYNTETISK-HEMLIGHET-123')
      expect(String(e)).not.toContain('syntetiskt-klient-id')
    }
  })

  it('REAL-klienter skapas utan nätanrop; auth-URL går till Fortnox med PKCE S256 och minsta scopes', () => {
    const spy = jest.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('inget nät i prov')
    })
    try {
      const c = cfg(REAL)
      const real = realClients(c, new FortnoxTokenCryptoService(c))
      expect(real).not.toBeNull()
      const auth = new RealFortnoxAuthProvider({
        client: real!.oauth,
        redirectUri: real!.redirectUri,
        scopes: FORTNOX_SCOPES,
        enabled: true,
      })
      const u = new URL(
        auth.authorizeUrl({
          state: 's'.repeat(64),
          codeChallenge: 'c'.repeat(43),
          redirectUri: real!.redirectUri,
        }),
      )
      expect(`${u.origin}${u.pathname}`).toBe('https://apps.fortnox.se/oauth-v1/auth')
      expect(u.searchParams.get('code_challenge_method')).toBe('S256')
      expect((u.searchParams.get('scope') ?? '').split(' ').sort()).toEqual([
        'bookkeeping',
        'companyinformation',
        'costcenter',
        'project',
      ])
      expect(u.toString()).not.toContain('SYNTETISK-HEMLIGHET-123')
      expect(spy).not.toHaveBeenCalled()
      expect(realClients(cfg({}), new FortnoxTokenCryptoService(cfg({})))).toBeNull()
    } finally {
      spy.mockRestore()
    }
  })

  it('Stub svarar 503 på varje väg', async () => {
    const a = new StubFortnoxAuthProvider()
    expect(() => a.authorizeUrl()).toThrow(ServiceUnavailableException)
    expect(() => a.exchangeCode()).toThrow(ServiceUnavailableException)
    expect(() => new StubFortnoxLedgerReader().get()).toThrow(ServiceUnavailableException)
  })

  it('K-S6: Stub- och REAL-läsare får aldrig en kapabel skrivare, oavsett miljö', async () => {
    const { Test } = await import('@nestjs/testing')
    const { FORTNOX_VOUCHER_WRITER, DisabledVoucherWriter } =
      await import('./fortnox-voucher-writer')
    const { FORTNOX_LEDGER_READER } = await import('./fortnox.types')
    const mod = await import('./fortnox.module')
    const providers = Reflect.getMetadata('providers', mod.FortnoxModule) as Array<{
      provide?: unknown
      useFactory?: (...a: unknown[]) => unknown
    }>
    const writerProvider = providers.find((p) => p?.provide === FORTNOX_VOUCHER_WRITER)!
    const envs = [
      { FORTNOX_MOCK_WRITE_FAULT: 'unknown_after_write_once', NODE_ENV: 'production' },
      {},
    ]
    for (const env of envs) {
      for (const reader of [new StubFortnoxLedgerReader(), { get: async () => ({}) }]) {
        const w = writerProvider.useFactory!(reader, cfg(env)) as { capable: boolean }
        expect(w).toBeInstanceOf(DisabledVoucherWriter)
        expect(w.capable).toBe(false)
      }
    }
    void Test
    void FORTNOX_LEDGER_READER
  })
})
