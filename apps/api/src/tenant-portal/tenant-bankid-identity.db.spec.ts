import { randomUUID } from 'node:crypto'

import { Prisma, PrismaClient } from '@prisma/client'

/**
 * DET GLOBALA INDEXET OCH IDENTITETSTABELLEN — mot riktig Postgres (#745 PR 4).
 *
 * ── VAD EN ATTRAPP INTE KAN PRÖVA HÄR ─────────────────────────────────────
 *
 *   1. Att `@@index([personalNumberHash])` INTE är unikt. Skillnaden mellan
 *      index och unikt villkor syns bara när man försöker skriva den andra
 *      raden — och att den skrivningen LYCKAS är hela poängen: samma person ska
 *      kunna vara hyresgäst hos två hyresvärdar.
 *   2. Att `@@unique([provider, subjectHash, tenantId])` tillåter flera
 *      hyresförhållanden per person men bara ETT kvitto per (person, rad).
 *   3. Att uppslaget faktiskt hittar båda formerna av blindindex när de ligger i
 *      olika rader — attrappen filtrerar på det tjänsten skickar, databasen på
 *      det som står i kolumnen.
 *
 * ── VAD PROVET INTE KAN SE ────────────────────────────────────────────────
 *
 * Att tjänsten TAR de här vägarna. Det ägs av `tenant-bankid.service.spec.ts`.
 */
const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot en RIKTIG databas', () => {
    expect(HAR_DB).toBe(true)
  })
})

medDb('#745 PR 4 · Tenant-index och TenantBankIdIdentity', () => {
  let prisma: PrismaClient
  const städa: string[] = []

  beforeAll(() => {
    prisma = new PrismaClient()
  })

  afterEach(async () => {
    for (const orgId of städa.splice(0)) {
      await prisma.tenantBankIdIdentity.deleteMany({
        where: { tenant: { organizationId: orgId } },
      })
      await prisma.tenant.deleteMany({ where: { organizationId: orgId } })
      await prisma.organization.deleteMany({ where: { id: orgId } })
    }
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  /** Egen org + hyresgäst per anrop. Riggen lånar inget av omgivningen. */
  async function nyOrgMedTenant(
    namn: string,
    personalNumberHash: string,
  ): Promise<{ orgId: string; tenantId: string }> {
    const sfx = randomUUID().slice(0, 8)
    const org = await prisma.organization.create({
      data: {
        name: `${namn}-${sfx}`,
        email: `tb-${sfx}@example.se`,
        street: 'a',
        city: 'b',
        postalCode: '11111',
      },
      select: { id: true },
    })
    städa.push(org.id)
    const tenant = await prisma.tenant.create({
      data: {
        organizationId: org.id,
        type: 'INDIVIDUAL',
        firstName: 'Test',
        lastName: 'Testsson',
        email: `tb-t-${sfx}@example.se`,
        personalNumberHash,
      },
      select: { id: true },
    })
    return { orgId: org.id, tenantId: tenant.id }
  }

  const HASH = 'b'.repeat(64)
  const HASH_KORT = 'c'.repeat(64)

  it('SAMMA PERSON, TVÅ HYRESVÄRDAR — det normala, inte kantfallet', async () => {
    // Om indexet vore UNIKT hade den andra hyresvärdens registrering blivit ett
    // hårt fel. Att den här skrivningen lyckas ÄR provet.
    const a = await nyOrgMedTenant('Alfa', HASH)
    const b = await nyOrgMedTenant('Beta', HASH)
    expect(a.tenantId).not.toBe(b.tenantId)

    // …och uppslaget vid inloggning ger båda.
    const träffar = await prisma.tenant.findMany({
      where: { personalNumberHash: HASH, anonymizedAt: null },
      select: { id: true },
    })
    expect(träffar).toHaveLength(2)
  })

  it('UPPSLAGET FRÅGAR BÅDA FORMERNA — tio- och tolvsiffrigt i olika rader', async () => {
    // Hyresvärd A skrev tolv siffror, hyresvärd B tio. Ett uppslag på bara den
    // ena formen hade missat den andra, och felet hade sett ut som "inget konto".
    await nyOrgMedTenant('Alfa', HASH)
    await nyOrgMedTenant('Beta', HASH_KORT)
    const träffar = await prisma.tenant.findMany({
      where: { personalNumberHash: { in: [HASH, HASH_KORT] }, anonymizedAt: null },
      select: { id: true },
    })
    expect(träffar).toHaveLength(2)
  })

  it('det ORG-SCOPADE indexet står kvar och svarar på sin egen fråga', async () => {
    // Den gamla frågan — "har DEN HÄR organisationen en hyresgäst med numret?" —
    // ska fortsätta fungera. Provet finns för att en framtida "förenkling" som
    // tar bort det org-scopade indexet ska bli röd.
    const a = await nyOrgMedTenant('Alfa', HASH)
    await nyOrgMedTenant('Beta', HASH)
    const iOrgA = await prisma.tenant.findMany({
      where: { organizationId: a.orgId, personalNumberHash: HASH },
      select: { id: true },
    })
    expect(iOrgA.map((t) => t.id)).toEqual([a.tenantId])
  })

  it('ETT KVITTO per (person, hyresgästrad) — en andra skrivning ger P2002', async () => {
    const a = await nyOrgMedTenant('Alfa', HASH)
    const data = {
      tenantId: a.tenantId,
      provider: 'BANKID',
      subjectHash: HASH,
      subjectEnc: 'enc',
      verifiedAt: new Date(),
    }
    await prisma.tenantBankIdIdentity.create({ data })
    const fel = await prisma.tenantBankIdIdentity.create({ data }).catch((e: unknown) => e)
    expect((fel as Prisma.PrismaClientKnownRequestError).code).toBe('P2002')

    // …och upsert på samma nyckel är det tjänsten faktiskt gör: en rad, inte två.
    await prisma.tenantBankIdIdentity.upsert({
      where: {
        provider_subjectHash_tenantId: {
          provider: 'BANKID',
          subjectHash: HASH,
          tenantId: a.tenantId,
        },
      },
      create: data,
      update: { verifiedAt: new Date() },
    })
    expect(await prisma.tenantBankIdIdentity.count({ where: { tenantId: a.tenantId } })).toBe(1)
  })

  it('SAMMA PERSON kan ha kvitto hos BÅDA hyresvärdarna', async () => {
    const a = await nyOrgMedTenant('Alfa', HASH)
    const b = await nyOrgMedTenant('Beta', HASH)
    for (const t of [a, b]) {
      await prisma.tenantBankIdIdentity.create({
        data: {
          tenantId: t.tenantId,
          provider: 'BANKID',
          subjectHash: HASH,
          subjectEnc: 'enc',
          verifiedAt: new Date(),
        },
      })
    }
    expect(await prisma.tenantBankIdIdentity.count({ where: { subjectHash: HASH } })).toBe(2)
  })

  it('en raderad hyresgäst tar sitt kvitto med sig (Cascade)', async () => {
    const a = await nyOrgMedTenant('Alfa', HASH)
    await prisma.tenantBankIdIdentity.create({
      data: {
        tenantId: a.tenantId,
        provider: 'BANKID',
        subjectHash: HASH,
        subjectEnc: 'enc',
        verifiedAt: new Date(),
      },
    })
    await prisma.tenant.delete({ where: { id: a.tenantId } })
    expect(await prisma.tenantBankIdIdentity.count({ where: { subjectHash: HASH } })).toBe(0)
  })

  it('ORDERNS ENVELOPE nollställs i samma sats som förbrukningen', async () => {
    // Personuppgiften får inte ligga kvar "tills städjobbet kommer". Provet mäter
    // att den atomiska förbrukningen tar båda fälten.
    const orderRef = `tb-${randomUUID()}`
    await prisma.bankIdOrder.create({
      data: {
        orderRef,
        purpose: 'TENANT_LOGIN',
        subjectEnc: 'enc',
        expiresAt: new Date(Date.now() + 60_000),
      },
    })
    const res = await prisma.bankIdOrder.updateMany({
      where: { orderRef, consumedAt: null },
      data: { consumedAt: new Date(), subjectEnc: null },
    })
    expect(res.count).toBe(1)
    const efter = await prisma.bankIdOrder.findUnique({
      where: { orderRef },
      select: { subjectEnc: true, consumedAt: true },
    })
    expect(efter?.subjectEnc).toBeNull()
    expect(efter?.consumedAt).not.toBeNull()
    await prisma.bankIdOrder.deleteMany({ where: { orderRef } })
  })
})
