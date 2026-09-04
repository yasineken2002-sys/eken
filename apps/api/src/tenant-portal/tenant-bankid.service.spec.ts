// `tenant-auth.service` drar in ContractTemplateService (StorageService →
// aws-sdk, ESM) och PdfService (puppeteer). Provet rör ingendera — det bygger
// TenantBankIdService med en attrapp för auth — men IMPORTEN av typen räcker för
// att kedjan ska laddas. Samma mockning och samma skäl som
// `tenant-auth.validatesession.spec.ts`.
jest.mock('../contracts/contract-template.service', () => ({
  ContractTemplateService: class {},
}))
jest.mock('../mail/mail.service', () => ({ MailService: class {} }))

import { ConflictException, NotFoundException, UnauthorizedException } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

import { MockBankIdProvider } from '../bankid/providers/mock-bankid.provider'
import { SigningCryptoService } from '../signing/signing-crypto.service'
import { PersonalNumberService } from '../common/crypto/personal-number.service'
import { TenantBankIdService } from './tenant-bankid.service'

/**
 * PORTALENS BANKID-FLÖDE — mekaniken, mot Mock-providern.
 *
 * VAD PROVET INTE KAN SE: att `where`-satsen i uppslaget faktiskt avgränsar på
 * det databasen tycker. Attrappen nedan filtrerar på de fält som STÅR i `where`,
 * så ett tappat fält gör filtret bredare och provet rött — men själva
 * indexanvändningen och Postgres semantik ägs av
 * `tenant-bankid-identity.db.spec.ts`.
 */

const HEMLIGHET = 'x'.repeat(48)
const NU = new Date('2026-09-04T12:00:00.000Z')

/** Skatteverkets officiella testnummer. Mocken intygar det här. */
const TOLV = '199001019802'

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

interface FakeOrder {
  orderRef: string
  purpose: string
  consumedAt: Date | null
  subjectEnc: string | null
  expiresAt: Date
}

interface FakeTenant {
  id: string
  personalNumberHash: string
  org: string
  street?: string
  unit?: string
  anonymizedAt?: Date | null
}

function makeDb(tenants: FakeTenant[]) {
  const orders: FakeOrder[] = []
  const identities: Array<{
    provider: string
    subjectHash: string
    tenantId: string
    verifiedAt: Date
    subjectEnc: string
  }> = []

  const bankIdOrder = {
    create: jest.fn(({ data }: { data: Omit<FakeOrder, 'consumedAt' | 'subjectEnc'> }) => {
      orders.push({ ...data, consumedAt: null, subjectEnc: null })
      return Promise.resolve(data)
    }),
    // KOPIA, inte referens. Prisma returnerar ett fristående objekt; en attrapp
    // som lämnar ut raden själv låter en senare `update` ändra ett värde som
    // anroparen redan läst. Det fällde `giltigt val` med "kvitto saknas" trots
    // att produktionsvägen är korrekt — alltså ett fel i attrappen, inte i koden.
    findUnique: jest.fn(({ where }: { where: { orderRef: string } }) => {
      const o = orders.find((x) => x.orderRef === where.orderRef)
      return Promise.resolve(o ? { ...o } : null)
    }),
    update: jest.fn(
      ({ where, data }: { where: { orderRef: string }; data: Partial<FakeOrder> }) => {
        const o = orders.find((x) => x.orderRef === where.orderRef)
        if (o) Object.assign(o, data)
        return Promise.resolve(o)
      },
    ),
    updateMany: jest.fn(
      ({
        where,
        data,
      }: {
        where: { orderRef: string; consumedAt: null }
        data: Partial<FakeOrder>
      }) => {
        const o = orders.find((x) => x.orderRef === where.orderRef && x.consumedAt == null)
        if (!o) return Promise.resolve({ count: 0 })
        Object.assign(o, data)
        return Promise.resolve({ count: 1 })
      },
    ),
  }

  const tenant = {
    findMany: jest.fn(
      ({ where }: { where: { personalNumberHash: { in: string[] }; anonymizedAt: null } }) =>
        Promise.resolve(
          tenants
            // ATTRAPPEN FILTRERAR PÅ FÄLTEN SOM STÅR I `where`. Tappar tjänsten
            // `anonymizedAt` blir filtret bredare här också, och provet nedan faller.
            .filter((t) => where.personalNumberHash.in.includes(t.personalNumberHash))
            .filter((t) => (where.anonymizedAt === null ? (t.anonymizedAt ?? null) === null : true))
            .map((t) => ({
              id: t.id,
              organization: { name: t.org },
              leases:
                t.street || t.unit
                  ? [{ unit: { name: t.unit ?? null, property: { street: t.street ?? null } } }]
                  : [],
            })),
        ),
    ),
  }

  const tenantBankIdIdentity = {
    upsert: jest.fn(
      ({
        where,
        create,
        update,
      }: {
        where: {
          provider_subjectHash_tenantId: { provider: string; subjectHash: string; tenantId: string }
        }
        create: {
          provider: string
          subjectHash: string
          tenantId: string
          verifiedAt: Date
          subjectEnc: string
        }
        update: { verifiedAt: Date }
      }) => {
        const k = where.provider_subjectHash_tenantId
        const fanns = identities.find(
          (i) => i.subjectHash === k.subjectHash && i.tenantId === k.tenantId,
        )
        if (fanns) fanns.verifiedAt = update.verifiedAt
        else identities.push(create)
        return Promise.resolve({})
      },
    ),
  }

  return {
    orders,
    identities,
    bankIdOrder,
    tenant,
    tenantBankIdIdentity,
    $transaction: jest.fn(function (this: void, fn: (tx: unknown) => Promise<unknown>) {
      return fn({ tenantBankIdIdentity })
    }),
  }
}

function bygg(db: ReturnType<typeof makeDb>, mock: MockBankIdProvider, sessioner: string[] = []) {
  const auth = {
    createSessionForTenant: jest.fn((tenantId: string) => {
      sessioner.push(tenantId)
      return Promise.resolve({
        sessionToken: `st:${tenantId}`,
        expiresAt: new Date('2026-10-04T12:00:00.000Z'),
        tenant: {
          id: tenantId,
          firstName: 'Test',
          lastName: 'Testsson',
          companyName: null,
          email: `${tenantId}@x.se`,
        },
      })
    }),
  }
  const service = new TenantBankIdService(
    mock as never,
    db as never,
    krypto(),
    auth as never,
    { getOrThrow: () => HEMLIGHET } as never,
  )
  return { service, auth }
}

const pn = krypto()
const HASH12 = pn.index(TOLV)
const HASH10 = pn.index('9001019802')

describe('portalens BankID-inloggning', () => {
  it('start skriver en order med EGET syfte och utan identitet', async () => {
    const db = makeDb([])
    const { service } = bygg(db, new MockBankIdProvider({ orderRef: 'o1' }))
    await service.start('127.0.0.1', NU)
    expect(db.orders).toHaveLength(1)
    expect(db.orders[0]).toMatchObject({ purpose: 'TENANT_LOGIN' })
    expect(db.orders[0]?.subjectEnc).toBeNull()
  })

  it('pending förbrukar INTE ordern — pollningen måste kunna fortsätta', async () => {
    const db = makeDb([])
    const { service } = bygg(db, new MockBankIdProvider({ orderRef: 'o1', pendingCollects: 2 }))
    await service.start('127.0.0.1', NU)
    expect((await service.collect('o1', NU)).status).toBe('pending')
    expect(db.orders[0]?.consumedAt).toBeNull()
  })

  it('failed förbrukar ordern — en död order får inte spelas om', async () => {
    const db = makeDb([])
    const { service } = bygg(db, new MockBankIdProvider({ orderRef: 'o1', failWith: 'userCancel' }))
    await service.start('127.0.0.1', NU)
    expect(await service.collect('o1', NU)).toEqual({ status: 'failed', reason: 'userCancel' })
    expect(db.orders[0]?.consumedAt).toEqual(NU)
  })

  it('NOLL hyresgäster → 401 som inte avslöjar något, och ordern förbrukas', async () => {
    const db = makeDb([])
    const { service, auth } = bygg(db, new MockBankIdProvider({ orderRef: 'o1' }))
    await service.start('127.0.0.1', NU)
    const fel = await service.collect('o1', NU).catch((e: Error) => e)
    expect(fel).toBeInstanceOf(UnauthorizedException)
    expect((fel as Error).message).toBe('Inloggningen kunde inte slutföras')
    expect(auth.createSessionForTenant).not.toHaveBeenCalled()
    expect(db.orders[0]?.consumedAt).toEqual(NU)
  })

  it('EN hyresgäst → session, kvitto skrivet, ordern förbrukad', async () => {
    const db = makeDb([{ id: 't1', personalNumberHash: HASH12, org: 'Alfa AB' }])
    const sessioner: string[] = []
    const { service, auth } = bygg(db, new MockBankIdProvider({ orderRef: 'o1' }), sessioner)
    await service.start('127.0.0.1', NU)

    const res = await service.collect('o1', NU)
    if (res.status !== 'complete') throw new Error('otillräcklig avsmalning')
    expect(res.sessionToken).toBe('st:t1')
    expect(res.tenant.id).toBe('t1')
    expect(auth.createSessionForTenant).toHaveBeenCalledWith('t1')
    expect(db.identities).toHaveLength(1)
    expect(db.identities[0]).toMatchObject({
      provider: 'BANKID',
      subjectHash: HASH12,
      tenantId: 't1',
    })
    expect(db.orders[0]?.consumedAt).toEqual(NU)
  })

  it('TIOSIFFRIG registrering hittas också — annars matchar inget', async () => {
    // Kärnan i #745 PR 4:s uppslag. Hyresvärden skrev `900101-9802`, BankID
    // svarar med tolv siffror. Ett uppslag på bara den ena formen hade gett
    // "inget konto hittades" för en hyresgäst som finns.
    const db = makeDb([{ id: 't1', personalNumberHash: HASH10, org: 'Alfa AB' }])
    const { service } = bygg(db, new MockBankIdProvider({ orderRef: 'o1' }))
    await service.start('127.0.0.1', NU)
    const res = await service.collect('o1', NU)
    expect(res.status).toBe('complete')

    // …och uppslaget frågade FAKTISKT båda formerna.
    const anrop = db.tenant.findMany.mock.calls[0]?.[0] as {
      where: { personalNumberHash: { in: string[] } }
    }
    expect(anrop.where.personalNumberHash.in).toEqual([HASH12, HASH10])
  })

  it('en AVIDENTIFIERAD hyresgäst räknas inte som träff', async () => {
    const db = makeDb([
      { id: 't1', personalNumberHash: HASH12, org: 'Alfa AB', anonymizedAt: new Date() },
    ])
    const { service } = bygg(db, new MockBankIdProvider({ orderRef: 'o1' }))
    await service.start('127.0.0.1', NU)
    await expect(service.collect('o1', NU)).rejects.toBeInstanceOf(UnauthorizedException)
  })

  describe('flera hyresvärdar', () => {
    async function tillVal() {
      const db = makeDb([
        { id: 't1', personalNumberHash: HASH12, org: 'Alfa AB', street: 'Storgatan 1', unit: 'A1' },
        { id: 't2', personalNumberHash: HASH10, org: 'Beta AB' },
      ])
      const sessioner: string[] = []
      const { service, auth } = bygg(db, new MockBankIdProvider({ orderRef: 'o1' }), sessioner)
      await service.start('127.0.0.1', NU)
      const res = await service.collect('o1', NU)
      if (res.status !== 'choose') throw new Error('otillräcklig avsmalning')
      return { db, service, auth, token: res.chooseToken, kandidater: res.candidates }
    }

    it('ger kontolista med hyresvärd OCH adress, och förbrukar INTE ordern', async () => {
      const { db, kandidater } = await tillVal()
      expect(kandidater).toEqual([
        { tenantId: 't1', organizationName: 'Alfa AB', address: 'Storgatan 1, A1' },
        { tenantId: 't2', organizationName: 'Beta AB', address: null },
      ])
      expect(db.orders[0]?.consumedAt).toBeNull()
      // Envelopen ligger på ordern så kvittot går att skriva efter valet.
      expect(db.orders[0]?.subjectEnc).toEqual(expect.any(String))
    })

    it('giltigt val → session för DEN valda raden, kvitto skrivet, ordern förbrukad', async () => {
      const { db, service, auth, token } = await tillVal()
      const res = await service.choose(token, 't2', NU)
      if (res.status !== 'complete') throw new Error('otillräcklig avsmalning')
      expect(res.sessionToken).toBe('st:t2')
      expect(auth.createSessionForTenant).toHaveBeenCalledWith('t2')
      expect(db.identities).toHaveLength(1)
      expect(db.identities[0]).toMatchObject({ tenantId: 't2' })
      expect(db.orders[0]?.consumedAt).toEqual(NU)
      // Personuppgiften nollställs i samma sats som förbrukningen.
      expect(db.orders[0]?.subjectEnc).toBeNull()
    })

    it('DEN OMVÄNDA RIKTNINGEN: en rad som INTE matchade kan inte väljas', async () => {
      // Formen: hyresgästen i org A gissar id:t på en rad i org B. Spärren är
      // den SIGNERADE kandidatlistan — `t9` stod aldrig i den, och listan går
      // inte att ändra utan att signaturen faller.
      const { db, service, auth, token } = await tillVal()
      await expect(service.choose(token, 't9', NU)).rejects.toBeInstanceOf(UnauthorizedException)
      expect(auth.createSessionForTenant).not.toHaveBeenCalled()
      expect(db.identities).toHaveLength(0)
      // Ordern lever kvar: ett ogiltigt val får inte bränna den för den som
      // faktiskt har rätt att välja.
      expect(db.orders[0]?.consumedAt).toBeNull()
    })

    it('REPLAY: samma token en andra gång nekas — ordern är förbrukad', async () => {
      const { service, token } = await tillVal()
      await service.choose(token, 't1', NU)
      await expect(service.choose(token, 't1', NU)).rejects.toBeInstanceOf(NotFoundException)
    })

    it('manipulerad token nekas', async () => {
      const { service, token } = await tillVal()
      const delar = token.split('.')
      const trasig = `${delar[0]}.${delar[1]}.${'A'.repeat((delar[2] as string).length)}`
      await expect(service.choose(trasig, 't1', NU)).rejects.toBeInstanceOf(UnauthorizedException)
    })
  })

  it('en WEB-order kan inte fullbordas som en hyresgästinloggning', async () => {
    const db = makeDb([{ id: 't1', personalNumberHash: HASH12, org: 'Alfa AB' }])
    const { service } = bygg(db, new MockBankIdProvider({ orderRef: 'o1' }))
    db.orders.push({
      orderRef: 'o1',
      purpose: 'LOGIN',
      consumedAt: null,
      subjectEnc: null,
      expiresAt: new Date(NU.getTime() + 60_000),
    })
    await expect(service.collect('o1', NU)).rejects.toBeInstanceOf(NotFoundException)
  })

  it('utgången order avvisas', async () => {
    const db = makeDb([])
    const { service } = bygg(db, new MockBankIdProvider({ orderRef: 'o1' }))
    await service.start('127.0.0.1', NU)
    const senare = new Date(NU.getTime() + 10 * 60 * 1000)
    await expect(service.collect('o1', senare)).rejects.toBeInstanceOf(NotFoundException)
  })

  it('två samtidiga collect på samma order: en vinner, den andra får Conflict', async () => {
    const db = makeDb([])
    const { service } = bygg(db, new MockBankIdProvider({ orderRef: 'o1', failWith: 'userCancel' }))
    await service.start('127.0.0.1', NU)
    const [a, b] = await Promise.allSettled([service.collect('o1', NU), service.collect('o1', NU)])
    const utfall = [a, b].map((r) =>
      r.status === 'fulfilled'
        ? 'ok'
        : r.reason instanceof ConflictException
          ? 'konflikt'
          : 'annat',
    )
    expect(utfall.sort()).toEqual(['konflikt', 'ok'])
  })
})
