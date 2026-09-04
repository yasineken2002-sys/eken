import { Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

jest.mock('../contracts/contract-template.service', () => ({
  ContractTemplateService: class {},
}))
jest.mock('../mail/mail.service', () => ({ MailService: class {} }))

import { MockBankIdProvider } from '../bankid/providers/mock-bankid.provider'
import { SigningCryptoService } from '../signing/signing-crypto.service'
import { PersonalNumberService } from '../common/crypto/personal-number.service'
import { TenantBankIdService } from './tenant-bankid.service'

/**
 * PERSONNUMRET FÅR ALDRIG NÅ EN LOGG.
 *
 * Två kontroller, och de mäter olika saker. Ingen duger som den andra:
 *
 *   STATISKT   ingen rad i tjänsten skickar personnumret till en logger. Fångar
 *              det uppenbara, och fångar det även i grenar provet inte kör.
 *   DYNAMISKT  det som FAKTISKT skrevs under ett helt flöde innehåller inte
 *              numret. Fångar det som går via ett objekt, en interpolation eller
 *              ett fel som råkar bära det.
 *
 * Båda har en kanariefågel: en kontroll som inte kan fälla mäter ingenting.
 */

const KÄLLA = join(__dirname, 'tenant-bankid.service.ts')
const PN = '199001019802'
const NU = new Date('2026-09-04T12:00:00.000Z')

function krypto(): PersonalNumberService {
  const config = {
    get: (n: string) =>
      n === 'SIGNING_PII_KEY'
        ? 'a'.repeat(64)
        : n === 'SIGNING_PII_PEPPER'
          ? 'p'.repeat(32)
          : undefined,
  } as unknown as ConfigService
  return new PersonalNumberService(new SigningCryptoService(config))
}

describe('personnummer i loggen', () => {
  it('STATISKT: ingen logger-rad i tjänsten nämner personnumret', () => {
    const kod = readFileSync(KÄLLA, 'utf8')
    const rader = kod.split('\n')
    const loggrader = rader.filter((r) => /this\.logger\.\w+\(/.test(r))
    // Golv: hittar kontrollen inga loggrader alls mäter den ingenting.
    expect(loggrader.length).toBeGreaterThanOrEqual(1)
    for (const rad of loggrader) {
      expect(rad).not.toMatch(/personnummer|personalNumber|completionData/)
    }
  })

  it('KANARIEFÅGEL för den statiska: mönstret fäller en rad som DÅ vore fel', () => {
    const fejk = '    this.logger.log(`[bankid] ${personnummer}`)'
    expect(fejk).toMatch(/this\.logger\.\w+\(/)
    expect(fejk).toMatch(/personnummer|personalNumber|completionData/)
  })

  it('DYNAMISKT: ett helt flöde skriver aldrig ut numret', async () => {
    const skrivet: string[] = []
    const spioner = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map((nivå) =>
      jest.spyOn(Logger.prototype, nivå).mockImplementation((...args: unknown[]) => {
        skrivet.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
      }),
    )
    try {
      const orders: Array<Record<string, unknown>> = []
      const db = {
        bankIdOrder: {
          create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
            orders.push({ ...data, consumedAt: null })
            return Promise.resolve(data)
          }),
          findUnique: jest.fn(() => Promise.resolve({ ...orders[0] })),
          update: jest.fn(() => Promise.resolve({})),
          updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
        },
        tenant: {
          findMany: jest.fn(() =>
            Promise.resolve([{ id: 't1', organization: { name: 'Alfa AB' }, leases: [] }]),
          ),
        },
        tenantBankIdIdentity: { upsert: jest.fn(() => Promise.resolve({})) },
        $transaction: jest.fn((fn: (tx: unknown) => Promise<unknown>) =>
          fn({ tenantBankIdIdentity: { upsert: jest.fn(() => Promise.resolve({})) } }),
        ),
      }
      const auth = {
        createSessionForTenant: jest.fn(() =>
          Promise.resolve({
            sessionToken: 'st',
            expiresAt: new Date(),
            tenant: { id: 't1', firstName: 'A', lastName: 'B', companyName: null, email: 'a@b.se' },
          }),
        ),
      }
      const service = new TenantBankIdService(
        new MockBankIdProvider({ orderRef: 'o1', completionData: { personalNumber: PN } }) as never,
        db as never,
        krypto(),
        auth as never,
        { getOrThrow: () => 'x'.repeat(48) } as never,
      )

      await service.start('127.0.0.1', NU)
      await service.collect('o1', NU)

      // KANARIEFÅGEL: fångade spionen något alls? Annars kan provet inte falla.
      expect(skrivet.length).toBeGreaterThanOrEqual(1)
      const allt = skrivet.join('\n')
      expect(allt).not.toContain(PN)
      expect(allt).not.toContain('9001019802')
    } finally {
      for (const s of spioner) s.mockRestore()
    }
  })
})
