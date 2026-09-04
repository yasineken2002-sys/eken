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
import type { CronErrorSink } from '../cron/cron-error-sink'
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
function kryptoMed(
  keyHex: string | undefined,
  pepper: string | undefined,
  gammalNyckelHex?: string,
): SigningCryptoService {
  const config = {
    get: (k: string) =>
      k === 'SIGNING_PII_KEY'
        ? keyHex
        : k === 'SIGNING_PII_PEPPER'
          ? pepper
          : k === 'SIGNING_PII_KEY_OLD'
            ? gammalNyckelHex
            : undefined,
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

  // ── #472: dekrypteringsrundturen ────────────────────────────────────────────

  it('REGRESSION #472: raden bärs av _OLD, inte av den aktuella nyckeln → ALDRIG OK', async () => {
    // Precis det läge som mättes i prod 2026-08-15 kl. 13:11:20: kontrollen
    // svarade OK medan [signing-crypto] visade att läsningen gick via _OLD.
    // Före rundturen gav den här raden `OK` — det är hela ärendets bugg.
    const utfall = await classifyPiiCoherence(
      [källa('Tenant', radSkrivenMed(NYCKEL_A, PEPPER_A))],
      kryptoMed(NYCKEL_B, PEPPER_A, NYCKEL_A), // aktuell = B, gammal = A, raden skriven med A
    )
    expect(utfall.status).not.toBe('OK')
    expect(utfall).toEqual({
      status: 'ROTATION_PAGAR',
      reason: 'CHIFFERTEXT_LASES_VIA_GAMLA_NYCKELN',
      source: 'Tenant',
    })
  })

  it('KANARIEFÅGEL: rundturen MÅSTE fälla en rad krypterad med en annan nyckel, utan fallback', async () => {
    // Matar in det som med säkerhet ska ge utslag: fel nyckel, fallbacken
    // avstängd. Slutar rundturen diskriminera — någon riktar om den till
    // `decrypt`, eller gör den till en no-op som aldrig kastar — blir det här
    // rött, i stället för att varje korrekt rad fortsätter lysa grönt.
    const utfall = await classifyPiiCoherence(
      [källa('Tenant', radSkrivenMed(NYCKEL_A, PEPPER_A))],
      kryptoMed(NYCKEL_B, PEPPER_A), // ingen _OLD
    )
    expect(utfall).toEqual({
      status: 'MISSMATCHNING',
      reason: 'CHIFFERTEXT_LASES_INTE_MED_NYCKELN',
      source: 'Tenant',
    })
  })

  it('KANARIEFÅGEL: ett OK får aldrig vila på fallbacken — den aktuella nyckeln måste bära raden', async () => {
    // Skarpaste formen: fallbacken skulle lyckas, rundturen kastar. Om
    // klassificeraren läser via `decrypt` i stället för `decryptWithCurrentKey`
    // blir det här ett OK — och testet rött.
    const äkta = kryptoMed(NYCKEL_A, PEPPER_A)
    const rundturenTrasig: PiiCoherenceCrypto = {
      configured: true,
      decryptWithCurrentKey: () => {
        throw new Error('aktuell nyckel läser inte raden')
      },
      decrypt: (enc) => äkta.decrypt(enc),
      blindIndex: (pn) => äkta.blindIndex(pn),
    }

    const utfall = await classifyPiiCoherence(
      [källa('Tenant', radSkrivenMed(NYCKEL_A, PEPPER_A))],
      rundturenTrasig,
    )
    expect(utfall.status).not.toBe('OK')
  })

  it('en trasig pepper göms INTE bakom rotationsutfallet', async () => {
    // Mitt i en rotation är en pepper-missmatchning fortfarande ett riktigt fel.
    // Vinner ROTATION_PAGAR här blir en död pepper tyst nedgraderad till varning.
    const utfall = await classifyPiiCoherence(
      [källa('Tenant', radSkrivenMed(NYCKEL_A, PEPPER_A))],
      kryptoMed(NYCKEL_B, PEPPER_B, NYCKEL_A), // rotation pågår OCH fel pepper
    )
    expect(utfall).toEqual({
      status: 'MISSMATCHNING',
      reason: 'HASH_MATCHAR_INTE_PEPPER',
      source: 'Tenant',
    })
  })

  it('_OLD satt men raden redan omkrypterad → vanligt OK, ingen rotationssignal', async () => {
    // Slutfasen av en rotation: fallbacken finns kvar men behövs inte längre.
    const utfall = await classifyPiiCoherence(
      [källa('Tenant', radSkrivenMed(NYCKEL_A, PEPPER_A))],
      kryptoMed(NYCKEL_A, PEPPER_A, NYCKEL_B),
    )
    expect(utfall).toEqual({ status: 'OK', reason: 'HASH_MATCHAR_PEPPER', source: 'Tenant' })
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
    // Räknar BÅDA vägarna in i krypton — annars flyttar en rundtur som råkar
    // gå via fallbacken kostnaden utan att mätningen märker det.
    const räknande: PiiCoherenceCrypto = {
      configured: äkta.configured,
      decryptWithCurrentKey: (enc) => {
        dekrypteringar++
        return äkta.decryptWithCurrentKey(enc)
      },
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

/** ConfigService-stubb som bara känner den enda flagga larmet grindar på. */
function konfigMed(backupEnabled?: string): ConfigService {
  return {
    get: (k: string) => (k === 'BACKUP_ENABLED' ? backupEnabled : undefined),
  } as unknown as ConfigService
}

/** Sänkspion. `reportBootCheck` är den enda väg tjänsten får ta till ErrorLog. */
function sänkspion() {
  const reportBootCheck = jest.fn<Promise<void>, [string, unknown, unknown?]>(() =>
    Promise.resolve(),
  )
  return { sink: { reportBootCheck } as unknown as CronErrorSink, reportBootCheck }
}

describe('PiiCoherenceService — larmet', () => {
  const tjänst = (
    prisma: PrismaService,
    crypto: SigningCryptoService,
    config: ConfigService = konfigMed(undefined),
    sink: CronErrorSink = sänkspion().sink,
  ) => new PiiCoherenceService(prisma, crypto, config, sink)

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
      {
        status: 'ROTATION_PAGAR',
        reason: 'CHIFFERTEXT_LASES_VIA_GAMLA_NYCKELN',
        source: 'Tenant',
      },
      { status: 'MISSMATCHNING', reason: 'HASH_MATCHAR_INTE_PEPPER', source: 'Tenant' },
      { status: 'MISSMATCHNING', reason: 'CHIFFERTEXT_LASES_INTE_MED_NYCKELN', source: 'Customer' },
      { status: 'KAN_EJ_VERIFIERAS', reason: 'NYCKLAR_SAKNAS', source: null },
      { status: 'KAN_EJ_VERIFIERAS', reason: 'INGA_KONTROLLERBARA_RADER', source: null },
      { status: 'KAN_EJ_VERIFIERAS', reason: 'KONTROLLEN_KUNDE_INTE_KORAS', source: null },
    ]
    for (const u of utfall) expect(() => t.report(u)).not.toThrow()
    // Sex av sju rapporteras; bara OK är tyst. ROTATION_PAGAR ingår — den är
    // mildare i NIVÅ, aldrig tystare.
    expect(captureException).toHaveBeenCalledTimes(6)
  })

  it('ROTATION_PAGAR rapporteras på warning — synlig, men inte som en defekt', async () => {
    const varna = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)

    await tjänst(
      prismaMed({ tenant: radSkrivenMed(NYCKEL_A, PEPPER_A) }),
      kryptoMed(NYCKEL_B, PEPPER_A, NYCKEL_A),
    ).onApplicationBootstrap()

    expect(captureException).toHaveBeenCalledTimes(1)
    const [, ctx] = captureException.mock.calls[0]
    expect(ctx.level).toBe('warning')
    expect(ctx.tags).toMatchObject({
      status: 'ROTATION_PAGAR',
      reason: 'CHIFFERTEXT_LASES_VIA_GAMLA_NYCKELN',
    })
    // Och den nådde den lokala loggen — Sentry är inte enda kanalen.
    expect(varna.mock.calls.some(([m]) => String(m).includes('ROTATION_PAGAR'))).toBe(true)
  })

  it('KRAV: rotationsutfallet sväljer inte signalen om Sentry fallerar', () => {
    captureException.mockImplementation(() => {
      throw new Error('sentry nere')
    })
    const fel = jest.spyOn(Logger.prototype, 'error')
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)

    expect(() =>
      tjänst(prismaMed({}), kryptoMed(NYCKEL_A, PEPPER_A)).report({
        status: 'ROTATION_PAGAR',
        reason: 'CHIFFERTEXT_LASES_VIA_GAMLA_NYCKELN',
        source: 'Tenant',
      }),
    ).not.toThrow()

    expect(
      fel.mock.calls.some(([m]) => String(m).includes('Sentry-rapporteringen misslyckades')),
    ).toBe(true)
  })
})

/**
 * #580 — VARAKTIGT LARM VID ÅTERSTÄLLNING MED FEL PII-NYCKEL.
 *
 * Sentry och den lokala loggen bär redan larmet, och båda är fel yta för just
 * det här: loggen försvinner med containern, och en återställning är precis när
 * ingen läser boot-loggen. Proven nedan mäter den varaktiga vägen — att den tas
 * när den ska, och att den INTE tas annars.
 *
 * Provet på tystnad är det som gör mängden skarp. Utan det skulle "larma
 * alltid" passera lika bra som den avsedda grinden.
 */
describe('PiiCoherenceService — varaktigt larm till ErrorLog (#580)', () => {
  const kör = async (
    crypto: SigningCryptoService,
    backupEnabled: string | undefined,
    rad = radSkrivenMed(NYCKEL_A, PEPPER_A),
  ) => {
    const { sink, reportBootCheck } = sänkspion()
    await new PiiCoherenceService(
      prismaMed({ tenant: rad }),
      crypto,
      konfigMed(backupEnabled),
      sink,
    ).onApplicationBootstrap()
    return reportBootCheck
  }

  it('MISSMATCHNING med backupen i drift → varaktig rad i ErrorLog', async () => {
    const spion = await kör(kryptoMed(NYCKEL_A, PEPPER_B), 'true')
    expect(spion).toHaveBeenCalledTimes(1)

    const [namn, fel, kontext] = spion.mock.calls[0] as [
      string,
      Error,
      { detail: Record<string, unknown> },
    ]
    expect(namn).toBe('pii-coherence')
    expect(fel.message).toContain('MISSMATCHNING')
    // Meddelandet ska peka ut ÅTERSTÄLLNINGEN som trolig orsak — det är hela
    // skälet att larmet grindas på backupen.
    expect(fel.message).toContain('återställning')
    expect(kontext.detail['status']).toBe('MISSMATCHNING')
  })

  it('KAN_EJ_VERIFIERAS larmar LIKA varaktigt — de två får aldrig skiljas åt', async () => {
    // Filens egen invariant, uttryckt två gånger i dess kommentarer. Skickas
    // bara det ena blir det andra ett mildare besked utan att någon beslutat det.
    const spion = await kör(kryptoMed(undefined, undefined), 'true')
    expect(spion).toHaveBeenCalledTimes(1)
    expect((spion.mock.calls[0] as [string, Error])[1].message).toContain('KAN_EJ_VERIFIERAS')
  })

  it('MATCHANDE nyckel → tyst, även med backupen i drift', async () => {
    const spion = await kör(kryptoMed(NYCKEL_A, PEPPER_A), 'true')
    expect(spion).not.toHaveBeenCalled()
  })

  it('BACKUP_ENABLED saknas → tyst, trots missmatchning', async () => {
    const spion = await kör(kryptoMed(NYCKEL_A, PEPPER_B), undefined)
    expect(spion).not.toHaveBeenCalled()
  })

  it("BACKUP_ENABLED='false' → tyst (bara strängen 'true' öppnar grinden)", async () => {
    const spion = await kör(kryptoMed(NYCKEL_A, PEPPER_B), 'false')
    expect(spion).not.toHaveBeenCalled()
  })

  it('den lokala kanalen och Sentry larmar OAVSETT grinden — den nya vägen ersätter inget', async () => {
    // Motprovet mot att ha råkat flytta larmet i stället för att lägga till ett.
    await kör(kryptoMed(NYCKEL_A, PEPPER_B), undefined)
    expect(captureException).toHaveBeenCalledTimes(1)
  })

  it('ett kast i sänkan tar INTE ner uppstarten', async () => {
    // Sänkan lovar att aldrig kasta, men tjänsten får inte VILA på det löftet:
    // en trasig ErrorLog vid boot ska inte bli ett startfel.
    const reportBootCheck = jest.fn(() => Promise.reject(new Error('ErrorLog nere')))
    const tjänst = new PiiCoherenceService(
      prismaMed({ tenant: radSkrivenMed(NYCKEL_A, PEPPER_A) }),
      kryptoMed(NYCKEL_A, PEPPER_B),
      konfigMed('true'),
      { reportBootCheck } as unknown as CronErrorSink,
    )
    await expect(tjänst.onApplicationBootstrap()).resolves.toBeUndefined()
  })
})
