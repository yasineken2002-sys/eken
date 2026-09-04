import { randomUUID } from 'node:crypto'

import { Prisma, PrismaClient } from '@prisma/client'

/**
 * IDENTITETSTABELLEN OCH ORDERN — mot riktig Postgres (#745 PR 2).
 *
 * ── VAD EN ATTRAPP INTE KAN PRÖVA HÄR ─────────────────────────────────────
 *
 * Tre av frågorna nedan avgörs av databasen och inte av koden:
 *
 *   1. Att `@@unique([provider, subjectHash, userId])` TILLÅTER flera konton per
 *      person men bara EN rad per (person, konto). En attrapp returnerar det den
 *      blev tillsagd, oavsett vad villkoret säger.
 *   2. Att `@@index([provider, subjectHash])` INTE är unikt. Skillnaden mellan
 *      index och unikt villkor syns bara när man försöker skriva den andra raden.
 *   3. Att förbrukningen är ATOMÄR — `updateMany` med `consumedAt: null` i
 *      villkoret. Två samtidiga anrop ska ge `count 1` och `count 0`.
 *
 * ── VAD PROVET INTE KAN SE ────────────────────────────────────────────────
 *
 * Att tjänsten TAR de här grenarna. Det ägs av `bankid-auth.service.spec.ts`.
 */
const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot en RIKTIG databas', () => {
    expect(HAR_DB).toBe(true)
  })
})

medDb('#745 PR 2 · UserBankIdIdentity och BankIdOrder', () => {
  let prisma: PrismaClient
  const städa: string[] = []

  beforeAll(() => {
    prisma = new PrismaClient()
  })

  afterEach(async () => {
    for (const orgId of städa.splice(0)) {
      await prisma.userBankIdIdentity.deleteMany({ where: { user: { organizationId: orgId } } })
      await prisma.user.deleteMany({ where: { organizationId: orgId } })
      await prisma.organization.deleteMany({ where: { id: orgId } })
    }
    await prisma.bankIdOrder.deleteMany({ where: { orderRef: { startsWith: 'e2e-' } } })
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  async function nyOrgMedUser(namn: string): Promise<{ orgId: string; userId: string }> {
    const sfx = randomUUID().slice(0, 8)
    const org = await prisma.organization.create({
      data: {
        name: `${namn}-${sfx}`,
        email: `bid-${sfx}@example.se`,
        street: 'a',
        city: 'b',
        postalCode: '11111',
      },
      select: { id: true },
    })
    städa.push(org.id)
    const user = await prisma.user.create({
      data: {
        organizationId: org.id,
        email: `bid-u-${sfx}@example.se`,
        passwordHash: 'x',
        firstName: 'A',
        lastName: 'B',
      },
      select: { id: true },
    })
    return { orgId: org.id, userId: user.id }
  }

  const HASH = 'a'.repeat(64)

  // ── Identiteten ───────────────────────────────────────────────────────────
  it('SAMMA PERSON, FLERA KONTON — det normala, inte kantfallet', async () => {
    const a = await nyOrgMedUser('Alfa')
    const b = await nyOrgMedUser('Beta')
    for (const u of [a, b]) {
      await prisma.userBankIdIdentity.create({
        data: {
          userId: u.userId,
          provider: 'BANKID',
          subjectHash: HASH,
          subjectEnc: 'enc',
          verifiedAt: new Date(),
        },
      })
    }
    // Uppslaget vid inloggning — det som får ge FLERA träffar.
    const träffar = await prisma.userBankIdIdentity.findMany({
      where: { provider: 'BANKID', subjectHash: HASH },
    })
    expect(träffar).toHaveLength(2)
  })

  it('IDEMPOTENSEN: samma person + samma konto en andra gång ger P2002', async () => {
    const a = await nyOrgMedUser('Alfa')
    const data = {
      userId: a.userId,
      provider: 'BANKID',
      subjectHash: HASH,
      subjectEnc: 'enc',
      verifiedAt: new Date(),
    }
    await prisma.userBankIdIdentity.create({ data })
    const fel = await prisma.userBankIdIdentity.create({ data }).catch((e: unknown) => e)
    expect(fel).toBeInstanceOf(Prisma.PrismaClientKnownRequestError)
    expect((fel as Prisma.PrismaClientKnownRequestError).code).toBe('P2002')

    // …och upsert på samma nyckel är det tjänsten faktiskt gör: en rad, inte två.
    await prisma.userBankIdIdentity.upsert({
      where: {
        provider_subjectHash_userId: {
          provider: 'BANKID',
          subjectHash: HASH,
          userId: a.userId,
        },
      },
      create: data,
      update: { verifiedAt: new Date() },
    })
    expect(
      await prisma.userBankIdIdentity.count({ where: { subjectHash: HASH, userId: a.userId } }),
    ).toBe(1)
  })

  it('OLIKA PROVIDER är olika identiteter — fältet är inte dekoration', async () => {
    const a = await nyOrgMedUser('Alfa')
    for (const provider of ['BANKID', 'FREJA']) {
      await prisma.userBankIdIdentity.create({
        data: {
          userId: a.userId,
          provider,
          subjectHash: HASH,
          subjectEnc: 'enc',
          verifiedAt: new Date(),
        },
      })
    }
    // Inloggningsuppslaget är provider-scopat: FREJA-raden får inte svara på en
    // BANKID-inloggning.
    expect(
      await prisma.userBankIdIdentity.count({ where: { provider: 'BANKID', subjectHash: HASH } }),
    ).toBe(1)
  })

  it('en raderad användare tar sin identitet med sig (Cascade)', async () => {
    const a = await nyOrgMedUser('Alfa')
    await prisma.userBankIdIdentity.create({
      data: {
        userId: a.userId,
        provider: 'BANKID',
        subjectHash: HASH,
        subjectEnc: 'enc',
        verifiedAt: new Date(),
      },
    })
    await prisma.user.delete({ where: { id: a.userId } })
    expect(await prisma.userBankIdIdentity.count({ where: { subjectHash: HASH } })).toBe(0)
  })

  // ── Ordern ────────────────────────────────────────────────────────────────
  it('FÖRBRUKNINGEN ÄR ATOMÄR: två samtidiga ger count 1 och count 0', async () => {
    const orderRef = `e2e-${randomUUID()}`
    await prisma.bankIdOrder.create({
      data: {
        orderRef,
        purpose: 'LOGIN',
        expiresAt: new Date(Date.now() + 60_000),
      },
    })
    const nu = new Date()
    const [a, b] = await Promise.all([
      prisma.bankIdOrder.updateMany({
        where: { orderRef, consumedAt: null },
        data: { consumedAt: nu },
      }),
      prisma.bankIdOrder.updateMany({
        where: { orderRef, consumedAt: null },
        data: { consumedAt: nu },
      }),
    ])
    expect([a.count, b.count].sort()).toEqual([0, 1])
  })

  it('orderRef är UNIKT — samma handtag kan inte dubbleras', async () => {
    const orderRef = `e2e-${randomUUID()}`
    const data = { orderRef, purpose: 'LOGIN', expiresAt: new Date(Date.now() + 60_000) }
    await prisma.bankIdOrder.create({ data })
    const fel = await prisma.bankIdOrder.create({ data }).catch((e: unknown) => e)
    expect((fel as Prisma.PrismaClientKnownRequestError).code).toBe('P2002')
  })

  it('utgångna ordrar städas bort, och städningen är idempotent', async () => {
    const gammal = `e2e-${randomUUID()}`
    const färsk = `e2e-${randomUUID()}`
    await prisma.bankIdOrder.create({
      data: { orderRef: gammal, purpose: 'LOGIN', expiresAt: new Date(Date.now() - 1000) },
    })
    await prisma.bankIdOrder.create({
      data: { orderRef: färsk, purpose: 'LOGIN', expiresAt: new Date(Date.now() + 60_000) },
    })

    const första = await prisma.bankIdOrder.deleteMany({ where: { expiresAt: { lt: new Date() } } })
    expect(första.count).toBeGreaterThanOrEqual(1)
    // Andra körningen träffar noll — invarianten som gör cronen klass B.
    const andra = await prisma.bankIdOrder.deleteMany({ where: { expiresAt: { lt: new Date() } } })
    expect(andra.count).toBe(0)
    // …och den färska raden rördes inte.
    expect(await prisma.bankIdOrder.count({ where: { orderRef: färsk } })).toBe(1)
  })
})
