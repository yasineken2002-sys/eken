import { Logger } from '@nestjs/common'
import * as Sentry from '@sentry/nestjs'
import { SigningCryptoService } from '../../signing/signing-crypto.service'
import {
  classifyPiiCoherence,
  PiiCoherenceService,
  type PiiCoherenceCrypto,
  type PiiCoherenceOutcome,
  type PiiProbeRow,
  type PiiProbeSource,
} from './pii-coherence.service'
import type { ConfigService } from '@nestjs/config'
import type { PrismaService } from '../prisma/prisma.service'

jest.mock('@sentry/nestjs', () => ({ captureException: jest.fn() }))

const captureException = Sentry.captureException as jest.Mock

const NYCKEL_A = 'a'.repeat(64)
const NYCKEL_B = 'b'.repeat(64)
const PEPPER_A = 'pepper-alfa-minst-16-tecken'
const PEPPER_B = 'pepper-beta-minst-16-tecken'
const PERSONNUMMER = '19850101-1234'

/**
 * Riktig SigningCryptoService — äkta AES-256-GCM och äkta HMAC.
 *
 * Med flit ingen stubb: en fejkad `decrypt` som "kastar vid fel nyckel" hade
 * bevisat att stubben gör det den fick veta, inte att AES-GCM faktiskt kastar
 * på authTag. Hela nyckel-grenen vilar på den egenskapen.
 */
function kryptoMed(keyHex: string | undefined, pepper: string | undefined): SigningCryptoService {
  const config = {
    get: (k: string) =>
      k === 'SIGNING_PII_KEY' ? keyHex : k === 'SIGNING_PII_PEPPER' ? pepper : undefined,
  } as unknown as ConfigService
  return new SigningCryptoService(config)
}

/** En rad som den ser ut i databasen, skriven med angiven nyckel + pepper. */
function radSkrivenMed(keyHex: string, pepper: string, pn = PERSONNUMMER): PiiProbeRow {
  const k = kryptoMed(keyHex, pepper)
  return { personalNumberEnc: k.encrypt(pn), personalNumberHash: k.blindIndex(pn) }
}

function källa(table: string, row: PiiProbeRow | null): PiiProbeSource {
  return { table, findFirst: () => Promise.resolve(row) }
}

/** Prisma-stubb: bara de tre delegaterna buildProbeSources rör. */
function prismaMed(rader: {
  tenant?: PiiProbeRow | null
  customer?: PiiProbeRow | null
  signatureEvidence?: PiiProbeRow | null
  kastar?: Error
}): PrismaService {
  const svar = (row: PiiProbeRow | null | undefined) => () =>
    rader.kastar ? Promise.reject(rader.kastar) : Promise.resolve(row ?? null)
  return {
    tenant: { findFirst: svar(rader.tenant) },
    customer: { findFirst: svar(rader.customer) },
    signatureEvidence: { findFirst: svar(rader.signatureEvidence) },
  } as unknown as PrismaService
}

beforeEach(() => {
  captureException.mockReset()
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined)
})

afterEach(() => jest.restoreAllMocks())

describe('classifyPiiCoherence — klassificeringen', () => {
  it('nyckel och pepper hör ihop med raden → OK', async () => {
    const utfall = await classifyPiiCoherence(
      [källa('Tenant', radSkrivenMed(NYCKEL_A, PEPPER_A))],
      kryptoMed(NYCKEL_A, PEPPER_A),
    )
    expect(utfall).toEqual({ status: 'OK', reason: 'HASH_MATCHAR_PEPPER', source: 'Tenant' })
  })

  it('peppern bytt utan omräkning av hasharna → MISSMATCHNING', async () => {
    const utfall = await classifyPiiCoherence(
      [källa('Tenant', radSkrivenMed(NYCKEL_A, PEPPER_A))],
      kryptoMed(NYCKEL_A, PEPPER_B),
    )
    expect(utfall).toEqual({
      status: 'MISSMATCHNING',
      reason: 'HASH_MATCHAR_INTE_PEPPER',
      source: 'Tenant',
    })
  })

  it('nyckeln bytt utan omkryptering → MISSMATCHNING (AES-GCM kastar på authTag)', async () => {
    const utfall = await classifyPiiCoherence(
      [källa('Tenant', radSkrivenMed(NYCKEL_A, PEPPER_A))],
      kryptoMed(NYCKEL_B, PEPPER_A),
    )
    expect(utfall).toEqual({
      status: 'MISSMATCHNING',
      reason: 'CHIFFERTEXT_LASES_INTE_MED_NYCKELN',
      source: 'Tenant',
    })
  })

  it('KRAV: noll kontrollerbara rader ger KAN_EJ_VERIFIERAS, aldrig OK', async () => {
    const utfall = await classifyPiiCoherence(
      [källa('Tenant', null), källa('Customer', null), källa('SignatureEvidence', null)],
      kryptoMed(NYCKEL_A, PEPPER_A),
    )
    expect(utfall.status).toBe('KAN_EJ_VERIFIERAS')
    expect(utfall.reason).toBe('INGA_KONTROLLERBARA_RADER')
    expect(utfall.status).not.toBe('OK')
  })

  it('rader finns men bär inte båda kolumnerna → KAN_EJ_VERIFIERAS', async () => {
    const halv: PiiProbeRow = { personalNumberEnc: 'nåt', personalNumberHash: null }
    const utfall = await classifyPiiCoherence(
      [
        källa('Tenant', halv),
        källa('Customer', { personalNumberEnc: null, personalNumberHash: 'x' }),
      ],
      kryptoMed(NYCKEL_A, PEPPER_A),
    )
    expect(utfall.status).toBe('KAN_EJ_VERIFIERAS')
  })

  it('nycklarna saknas → KAN_EJ_VERIFIERAS, och ingen rad läses', async () => {
    const findFirst = jest.fn()
    const utfall = await classifyPiiCoherence(
      [{ table: 'Tenant', findFirst }],
      kryptoMed(undefined, undefined),
    )
    expect(utfall).toEqual({ status: 'KAN_EJ_VERIFIERAS', reason: 'NYCKLAR_SAKNAS', source: null })
    expect(findFirst).not.toHaveBeenCalled()
  })

  it('hoppar över tomma källor och kontrollerar den första som bär en rad', async () => {
    const utfall = await classifyPiiCoherence(
      [
        källa('Tenant', null),
        källa('Customer', null),
        källa('SignatureEvidence', radSkrivenMed(NYCKEL_A, PEPPER_A)),
      ],
      kryptoMed(NYCKEL_A, PEPPER_A),
    )
    expect(utfall.source).toBe('SignatureEvidence')
  })

  it('KOSTNAD: läser EN rad och dekrypterar EN gång, även när flera källor har rader', async () => {
    const äkta = kryptoMed(NYCKEL_A, PEPPER_A)
    let dekrypteringar = 0
    const räknande: PiiCoherenceCrypto = {
      configured: äkta.configured,
      decrypt: (enc) => {
        dekrypteringar++
        return äkta.decrypt(enc)
      },
      blindIndex: (pn) => äkta.blindIndex(pn),
    }
    const senare = jest.fn()

    await classifyPiiCoherence(
      [
        källa('Tenant', radSkrivenMed(NYCKEL_A, PEPPER_A)),
        { table: 'Customer', findFirst: senare },
        { table: 'SignatureEvidence', findFirst: senare },
      ],
      räknande,
    )

    expect(dekrypteringar).toBe(1)
    expect(senare).not.toHaveBeenCalled()
  })

  it('letar INTE vidare efter en rad som råkar matcha när den första missmatchar', async () => {
    const utfall = await classifyPiiCoherence(
      [
        källa('Tenant', radSkrivenMed(NYCKEL_A, PEPPER_B)), // fel pepper
        källa('Customer', radSkrivenMed(NYCKEL_A, PEPPER_A)), // hade gett OK
      ],
      kryptoMed(NYCKEL_A, PEPPER_A),
    )
    expect(utfall.status).toBe('MISSMATCHNING')
    expect(utfall.source).toBe('Tenant')
  })
})

describe('PiiCoherenceService — larmet', () => {
  const tjänst = (prisma: PrismaService, crypto: SigningCryptoService) =>
    new PiiCoherenceService(prisma, crypto)

  it('OK larmar inte', async () => {
    await tjänst(
      prismaMed({ tenant: radSkrivenMed(NYCKEL_A, PEPPER_A) }),
      kryptoMed(NYCKEL_A, PEPPER_A),
    ).onApplicationBootstrap()
    expect(captureException).not.toHaveBeenCalled()
  })

  it('missmatchning larmar till Sentry på error-nivå', async () => {
    await tjänst(
      prismaMed({ tenant: radSkrivenMed(NYCKEL_A, PEPPER_A) }),
      kryptoMed(NYCKEL_A, PEPPER_B),
    ).onApplicationBootstrap()

    expect(captureException).toHaveBeenCalledTimes(1)
    const [fel, ctx] = captureException.mock.calls[0]
    expect(fel).toBeInstanceOf(Error)
    expect(ctx.level).toBe('error')
    expect(ctx.tags).toMatchObject({
      check: 'pii-coherence',
      status: 'MISSMATCHNING',
      reason: 'HASH_MATCHAR_INTE_PEPPER',
    })
  })

  it('KRAV: KAN_EJ_VERIFIERAS larmar LIKA HÖGT som en missmatchning', async () => {
    // Tom databas — det läge där kontrollen annars tyst blir en no-op.
    await tjänst(prismaMed({}), kryptoMed(NYCKEL_A, PEPPER_A)).onApplicationBootstrap()
    expect(captureException).toHaveBeenCalledTimes(1)
    const tomDb = captureException.mock.calls[0][1]

    captureException.mockReset()
    await tjänst(
      prismaMed({ tenant: radSkrivenMed(NYCKEL_A, PEPPER_A) }),
      kryptoMed(NYCKEL_A, PEPPER_B),
    ).onApplicationBootstrap()
    const missmatch = captureException.mock.calls[0][1]

    // Samma nivå och samma tagg-form: ingen av dem är ett mildare besked.
    expect(tomDb.level).toBe(missmatch.level)
    expect(tomDb.level).toBe('error')
    expect(Object.keys(tomDb.tags).sort()).toEqual(Object.keys(missmatch.tags).sort())
  })

  it('KRAV: ett oväntat läsfel rapporteras som "kunde inte köras", aldrig som tystnad', async () => {
    await tjänst(
      prismaMed({ kastar: new Error('connection terminated') }),
      kryptoMed(NYCKEL_A, PEPPER_A),
    ).onApplicationBootstrap()

    expect(captureException).toHaveBeenCalledTimes(1)
    expect(captureException.mock.calls[0][1].tags).toMatchObject({
      status: 'KAN_EJ_VERIFIERAS',
      reason: 'KONTROLLEN_KUNDE_INTE_KORAS',
    })
  })

  it('boot går vidare även om kontrollen kastar (varning, inte fail-fast)', async () => {
    await expect(
      tjänst(
        prismaMed({ kastar: new Error('connection terminated') }),
        kryptoMed(NYCKEL_A, PEPPER_A),
      ).onApplicationBootstrap(),
    ).resolves.toBeUndefined()
  })

  it('en missmatchning tar INTE ner appen', async () => {
    await expect(
      tjänst(
        prismaMed({ tenant: radSkrivenMed(NYCKEL_A, PEPPER_A) }),
        kryptoMed(NYCKEL_A, PEPPER_B),
      ).onApplicationBootstrap(),
    ).resolves.toBeUndefined()
  })

  it('om Sentry själv fallerar rapporteras DET — signalen sväljs inte', async () => {
    captureException.mockImplementation(() => {
      throw new Error('sentry nere')
    })
    const fel = jest.spyOn(Logger.prototype, 'error')

    await expect(
      tjänst(prismaMed({}), kryptoMed(NYCKEL_A, PEPPER_A)).onApplicationBootstrap(),
    ).resolves.toBeUndefined()

    expect(
      fel.mock.calls.some(([m]) => String(m).includes('Sentry-rapporteringen misslyckades')),
    ).toBe(true)
  })

  it('larmet bär aldrig ett personnummer eller ett hemligt värde', async () => {
    await tjänst(
      prismaMed({ tenant: radSkrivenMed(NYCKEL_A, PEPPER_A) }),
      kryptoMed(NYCKEL_A, PEPPER_B),
    ).onApplicationBootstrap()

    const serialiserat = JSON.stringify(captureException.mock.calls[0])
    const [fel] = captureException.mock.calls[0]
    for (const hemligt of [PERSONNUMMER, '198501011234', NYCKEL_A, PEPPER_A, PEPPER_B]) {
      expect(serialiserat).not.toContain(hemligt)
      expect((fel as Error).message).not.toContain(hemligt)
    }
  })

  it('rapporterar varje status-värde utan att kasta', () => {
    const t = tjänst(prismaMed({}), kryptoMed(NYCKEL_A, PEPPER_A))
    const utfall: PiiCoherenceOutcome[] = [
      { status: 'OK', reason: 'HASH_MATCHAR_PEPPER', source: 'Tenant' },
      { status: 'MISSMATCHNING', reason: 'HASH_MATCHAR_INTE_PEPPER', source: 'Tenant' },
      { status: 'MISSMATCHNING', reason: 'CHIFFERTEXT_LASES_INTE_MED_NYCKELN', source: 'Customer' },
      { status: 'KAN_EJ_VERIFIERAS', reason: 'NYCKLAR_SAKNAS', source: null },
      { status: 'KAN_EJ_VERIFIERAS', reason: 'INGA_KONTROLLERBARA_RADER', source: null },
      { status: 'KAN_EJ_VERIFIERAS', reason: 'KONTROLLEN_KUNDE_INTE_KORAS', source: null },
    ]
    for (const u of utfall) expect(() => t.report(u)).not.toThrow()
    // Fem av sex larmar; bara OK är tyst.
    expect(captureException).toHaveBeenCalledTimes(5)
  })
})
