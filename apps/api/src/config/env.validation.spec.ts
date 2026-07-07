/**
 * Boot-validering (launch-readiness #1). Bevisar:
 * - prod + saknad kritisk var → appen vägrar starta (kastar), felet namnger varen
 * - prod + alla finns → returnerar oförändrat (bootar normalt)
 * - dev-läge + saknade varer → varnar men blockerar INTE
 * - flagg-villkorade (PSD2/SIGNING) → respekterar flaggan (av = ok, på utan nyckel = fel),
 *   och kastar i alla miljöer (speglar modul-factoryns fail-fast)
 */

import { validateEnv } from './env.validation'

/** Fullständig, giltig prod-env — utgångsläge som varje test muterar från. */
function fullProdEnv(): Record<string, string> {
  return {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://u:p@host:5432/db',
    REDIS_URL: 'redis://host:6379',
    JWT_SECRET: 'x'.repeat(32),
    PLATFORM_JWT_SECRET: 'y'.repeat(32),
    RESEND_API_KEY: 're_live_abc',
    RESEND_WEBHOOK_SECRET: 'whsec_abc',
    ANTHROPIC_API_KEY: 'sk-ant-abc',
    R2_ACCOUNT_ID: 'acc',
    R2_ACCESS_KEY_ID: 'akid',
    R2_SECRET_ACCESS_KEY: 'secret',
    R2_BUCKET_NAME: 'bucket',
    APP_URL: 'https://app.eveno.se',
    WEB_URL: 'https://app.eveno.se',
    ADMIN_URL: 'https://admin.eveno.se',
    PORTAL_URL: 'https://portal.eveno.se',
  }
}

describe('validateEnv — boot-validering (#1)', () => {
  let warnSpy: jest.SpyInstance

  beforeEach(() => {
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
  })
  afterEach(() => warnSpy.mockRestore())

  describe('produktion', () => {
    it('alla kritiska finns → bootar normalt (returnerar oförändrat, ingen varning)', () => {
      const env = fullProdEnv()
      const out = validateEnv({ ...env })
      expect(out).toEqual(env)
      expect(warnSpy).not.toHaveBeenCalled()
    })

    it('saknad kritisk var (R2_BUCKET_NAME) → kastar, felet namnger varen', () => {
      const env = fullProdEnv()
      delete env.R2_BUCKET_NAME
      expect(() => validateEnv(env)).toThrow(/R2_BUCKET_NAME saknas/)
      expect(() => validateEnv(env)).toThrow(/Uppstart avbruten/)
    })

    it('saknad PORTAL_URL → kastar (hyresgäster skulle annars få localhost-länkar)', () => {
      const env = fullProdEnv()
      delete env.PORTAL_URL
      expect(() => validateEnv(env)).toThrow(/PORTAL_URL saknas/)
    })

    it('samlar ALLA fel i ett meddelande (flera saknade)', () => {
      const env = fullProdEnv()
      delete env.REDIS_URL
      delete env.RESEND_API_KEY
      expect(() => validateEnv(env)).toThrow(/REDIS_URL saknas[\s\S]*RESEND_API_KEY saknas/)
    })

    it('ogiltigt format (APP_URL ej URL, JWT_SECRET för kort) → kastar', () => {
      const env = fullProdEnv()
      env.APP_URL = 'inte-en-url'
      env.JWT_SECRET = 'kort'
      expect(() => validateEnv(env)).toThrow(/APP_URL ogiltig/)
      expect(() => validateEnv(env)).toThrow(/JWT_SECRET ogiltig/)
    })
  })

  describe('dev/test — mildare', () => {
    it('development + saknade kritiska varer → varnar men kastar INTE', () => {
      const out = validateEnv({ NODE_ENV: 'development' })
      expect(out).toEqual({ NODE_ENV: 'development' })
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(warnSpy.mock.calls[0][0]).toMatch(/miljövariabel-varning/)
      expect(warnSpy.mock.calls[0][0]).toMatch(/DATABASE_URL saknas/)
    })

    it('avsaknad av NODE_ENV behandlas som development (varnar, kastar ej)', () => {
      expect(() => validateEnv({})).not.toThrow()
      expect(warnSpy).toHaveBeenCalled()
    })

    it('test-miljö blockerar inte (så testsviten kan boota AppModule)', () => {
      expect(() => validateEnv({ NODE_ENV: 'test' })).not.toThrow()
    })
  })

  describe('flagg-villkorade (speglar befintlig fail-fast)', () => {
    it('PSD2_ENABLED != true → PSD2_TOKEN_KEY krävs ej', () => {
      expect(() => validateEnv({ NODE_ENV: 'development' })).not.toThrow()
      expect(() => validateEnv({ NODE_ENV: 'development', PSD2_ENABLED: 'false' })).not.toThrow()
    })

    it('PSD2_ENABLED=true utan giltig nyckel → kastar ÄVEN i dev', () => {
      expect(() => validateEnv({ NODE_ENV: 'development', PSD2_ENABLED: 'true' })).toThrow(
        /PSD2_TOKEN_KEY saknas\/ogiltig/,
      )
      // fel längd
      expect(() =>
        validateEnv({ NODE_ENV: 'development', PSD2_ENABLED: 'true', PSD2_TOKEN_KEY: 'abc' }),
      ).toThrow(/PSD2_TOKEN_KEY/)
    })

    it('PSD2_ENABLED=true med giltig 64-hex-nyckel → ok', () => {
      expect(() =>
        validateEnv({
          NODE_ENV: 'development',
          PSD2_ENABLED: 'true',
          PSD2_TOKEN_KEY: 'a'.repeat(64),
        }),
      ).not.toThrow()
    })

    it('SIGNING_ENABLED=true kräver både PII_KEY (64 hex) och PII_PEPPER (≥16)', () => {
      expect(() => validateEnv({ NODE_ENV: 'development', SIGNING_ENABLED: 'true' })).toThrow(
        /SIGNING_PII_KEY[\s\S]*SIGNING_PII_PEPPER/,
      )
      expect(() =>
        validateEnv({
          NODE_ENV: 'development',
          SIGNING_ENABLED: 'true',
          SIGNING_PII_KEY: 'b'.repeat(64),
          SIGNING_PII_PEPPER: 'kort',
        }),
      ).toThrow(/SIGNING_PII_PEPPER saknas\/för kort/)
      expect(() =>
        validateEnv({
          NODE_ENV: 'development',
          SIGNING_ENABLED: 'true',
          SIGNING_PII_KEY: 'b'.repeat(64),
          SIGNING_PII_PEPPER: 'p'.repeat(16),
        }),
      ).not.toThrow()
    })
  })

  describe('valfria med default', () => {
    it('ogiltigt PORT-format → varning, ej boot-krasch ens i prod', () => {
      const env = fullProdEnv()
      env.PORT = 'inte-ett-tal'
      expect(() => validateEnv(env)).not.toThrow()
      expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/PORT ogiltig/))
    })

    it('MAIL_FROM saknas → helt ok (default används), ingen varning', () => {
      const env = fullProdEnv()
      expect(() => validateEnv(env)).not.toThrow()
      expect(warnSpy).not.toHaveBeenCalled()
    })
  })
})
