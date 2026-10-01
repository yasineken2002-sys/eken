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
      /skarp/,
    ],
    [
      {
        FORTNOX_ENABLED: 'true',
        FORTNOX_TOKEN_KEY: KEY,
        FORTNOX_PROVIDER: 'mock',
        NODE_ENV: 'production',
      },
      /skarp/,
    ],
    [{ FORTNOX_ENABLED: 'true', FORTNOX_TOKEN_KEY: KEY, FORTNOX_PROVIDER: 'mock' }, /skarp/],
    [{ FORTNOX_ENABLED: 'true', FORTNOX_TOKEN_KEY: KEY, NODE_ENV: 'production' }, /skarp/],
  ])('påslaget utan säker provider kastar vid boot %j', (env, msg) => {
    expect(() => mode(env)).toThrow(msg)
  })

  it('Stub svarar 503 på varje väg', async () => {
    const a = new StubFortnoxAuthProvider()
    expect(() => a.authorizeUrl()).toThrow(ServiceUnavailableException)
    expect(() => a.exchangeCode()).toThrow(ServiceUnavailableException)
    expect(() => new StubFortnoxLedgerReader().get()).toThrow(ServiceUnavailableException)
  })
})
