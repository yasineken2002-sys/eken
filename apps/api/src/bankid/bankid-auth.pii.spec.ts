import { Logger } from '@nestjs/common'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { BankIdAuthService } from './bankid-auth.service'
import { MockBankIdProvider } from './providers/mock-bankid.provider'

const PERSONNUMMER = '199001019802'
const NU = new Date('2026-09-04T12:00:00Z')

/**
 * PERSONNUMRET FÅR ALDRIG NÅ EN LOGG — mätt åt två håll.
 *
 * Kravet står vid `BankIdCompletionData` i `bankid.types.ts` och i tjänstens
 * docblock, men en regel i prosa är ingen regel. De två proven nedan mäter olika
 * saker och ingen duger som den andra:
 *
 *   STATISKT   ingen rad i den nya koden skickar personnumret till loggen
 *   DYNAMISKT  en verklig körning producerar ingen loggrad som innehåller det
 *
 * Det statiska fångar en NY rad som någon lägger till; det dynamiska fångar att
 * värdet läcker via ett objekt, ett fel eller en interpolering som inte ser ut
 * som `personalNumber` i källan.
 */
describe('personnummer i loggen (statiskt)', () => {
  const KÄLLOR = [
    'bankid-auth.service.ts',
    'bankid.controller.ts',
    'bankid-choose-token.ts',
    'bankid.types.ts',
    'providers/stub-bankid.provider.ts',
  ]

  it('ingen loggning av personalNumber i den nya koden', () => {
    const träffar: string[] = []
    for (const fil of KÄLLOR) {
      const text = readFileSync(join(__dirname, fil), 'utf8')
      text.split('\n').forEach((rad, i) => {
        // Rader som LOGGAR och samtidigt nämner personnumret. Kommentarer
        // undantas: hela poängen med dem är att beskriva regeln.
        const kod = rad.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '')
        if (/\b(logger|console)\s*\.\s*\w+\(/.test(kod) && /personalNumber/.test(kod)) {
          träffar.push(`${fil}:${i + 1}`)
        }
      })
    }
    expect(träffar).toEqual([])
  })

  it('KANARIEFÅGEL: sonden hittar en INJICERAD överträdelse', () => {
    // Utan den här raden går det inte att skilja "inga träffar" från "sonden
    // tittar på fel sak". Samma fixtur som ovan, men med en rad som SKA fällas.
    const fusk = `    this.logger.log(\`pn=\${res.completionData.personalNumber}\`)`
    const kod = fusk.replace(/\/\/.*$/, '')
    expect(/\b(logger|console)\s*\.\s*\w+\(/.test(kod) && /personalNumber/.test(kod)).toBe(true)
  })
})

describe('personnummer i loggen (dynamiskt)', () => {
  it('en fullbordad anslutning producerar INGEN loggrad med personnumret', async () => {
    const rader: string[] = []
    const spionera = (m: unknown, ...rest: unknown[]) => {
      rader.push([m, ...rest].map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '))
    }
    const spies = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map((n) =>
      jest.spyOn(Logger.prototype, n).mockImplementation(spionera as never),
    )

    try {
      const orders: Array<Record<string, unknown>> = []
      const db = {
        bankIdOrder: {
          create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
            orders.push({ ...data, consumedAt: null })
            return Promise.resolve(data)
          }),
          findUnique: jest.fn(() =>
            Promise.resolve({
              purpose: 'ENROLL',
              userId: 'u1',
              consumedAt: null,
              expiresAt: new Date(NU.getTime() + 60_000),
            }),
          ),
          updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
        },
        userBankIdIdentity: { upsert: jest.fn(() => Promise.resolve({})) },
        $transaction: jest.fn((fn: (tx: unknown) => Promise<unknown>) =>
          fn({
            bankIdOrder: { updateMany: jest.fn(() => Promise.resolve({ count: 1 })) },
            userBankIdIdentity: { upsert: jest.fn(() => Promise.resolve({})) },
          }),
        ),
      }
      const service = new BankIdAuthService(
        new MockBankIdProvider({
          orderRef: 'o1',
          completionData: { personalNumber: PERSONNUMMER },
        }) as never,
        db as never,
        {
          blindIndex: (pn: string) => `hash:${pn.slice(0, 4)}`,
          encrypt: () => 'enc',
        } as never,
        { issueTokensForUser: jest.fn() } as never,
        { getOrThrow: () => 'x'.repeat(48) } as never,
        { record: jest.fn() } as never,
      )

      await service.enrollStart('u1', '127.0.0.1', NU)
      await service.enrollCollect('u1', 'o1', NU)

      // KANARIEFÅGEL: loggen ska ha FÅTT något, annars mäter provet tystnad.
      expect(rader.length).toBeGreaterThan(0)
      expect(rader.join('\n')).not.toContain(PERSONNUMMER)
      // …och inte heller utan bindestreck eller i delar.
      expect(rader.join('\n')).not.toContain('9001019802')
    } finally {
      for (const s of spies) s.mockRestore()
    }
  })
})
