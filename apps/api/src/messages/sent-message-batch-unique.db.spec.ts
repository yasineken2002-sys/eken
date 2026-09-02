/**
 * EN RAD PER MOTTAGARE PER UTSKICK — mot riktig Postgres.
 *
 * ── VAD PROVET ÄGER ─────────────────────────────────────────────────────────
 *
 * `@@unique([organizationId, tenantId, batchId])`. Enheten i datan är
 * mottagaren (#633) och enheten i operatörens vy är utskicket (#635); det
 * förhållandet bär ett antagande som fram till nu var en konvention — att en
 * grupp innehåller varje mottagare högst en gång. Bryts det räknar vyn fel om
 * hur många som fick brevet.
 *
 * Provet mäter DATABASENS villkor, inte verktygets loop. Det är en avsiktlig
 * uppdelning: `compose-email-effect-unit.db.spec.ts` äger loopens beteende,
 * den här filen äger invarianten som loopen lutar sig mot. En invariant som
 * bara prövas genom sin ena anropare är oprövad för nästa anropare.
 *
 * ── VAD PROVET INTE KAN SE, OCH VARFÖR DET STÅR HÄR ─────────────────────────
 *
 * Indexet skyddar INTE mot att samma BREV skickas två gånger. `batchId`
 * genereras per verktygsanrop, så en omkörning efter en krasch bär ett NYTT
 * batchId och kan per konstruktion inte krocka med den avbrutna körningens
 * rader. Det som bär omkörningen är uppslaget på (subject, content) i loopen,
 * och det är applikationsnivå.
 *
 * Skillnaden mot `PaymentReminder` i `send_overdue_reminders`, som ser likadan
 * ut: DESS nyckel `(invoiceId, type)` är härledd ur INNEHÅLLET och överlever
 * därför en omkörning. `batchId` är härlett ur KÖRNINGEN.
 *
 * ── RIGGEN ÄGER SINA EGNA FÖRUTSÄTTNINGAR ───────────────────────────────────
 *
 * Ingen `findFirst` mot befintlig data: organisationen, användaren och
 * hyresgästerna skapas här och städas bort efteråt, i FK-riktning. Prövad mot
 * en TOM databas och två gånger mot samma databas — en rigg som lånar
 * omgivningens data mäter omgivningen.
 */
import { randomUUID } from 'node:crypto'

import { Prisma } from '@prisma/client'
import { PrismaService } from '../common/prisma/prisma.service'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot en RIKTIG databas', () => {
    expect(HAR_DB).toBe(true)
  })
})

/** Tre räcker för att skilja "en per mottagare" från "en totalt". */
const ANTAL_MOTTAGARE = 3

medDb('SentMessage: (organizationId, tenantId, batchId) är unikt', () => {
  let prisma: PrismaService
  let orgId: string
  let userId: string
  const tenantIds: string[] = []

  const rad = (tenantId: string, batchId: string | null, subject = 'Trapphuset målas') => ({
    organizationId: orgId,
    tenantId,
    sentById: userId,
    subject,
    content: 'Vi målar trapphuset på torsdag.',
    sentToAll: false,
    recipientCount: 1,
    successCount: 0,
    failedCount: 0,
    status: 'PENDING' as const,
    batchId,
  })

  /** Skriver hela utskicket och returnerar hur många som krockade. */
  const skrivUtskick = async (batchId: string) => {
    let krockar = 0
    for (const tenantId of tenantIds) {
      try {
        await prisma.sentMessage.create({ data: rad(tenantId, batchId), select: { id: true } })
      } catch (err) {
        if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002')
          throw err
        krockar++
      }
    }
    return krockar
  }

  beforeAll(async () => {
    prisma = new PrismaService()
    const sfx = randomUUID().slice(0, 8)
    const org = await prisma.organization.create({
      data: {
        name: `batch-${sfx}`,
        email: `batch-${sfx}@example.se`,
        street: 'a',
        city: 'b',
        postalCode: '11111',
      },
      select: { id: true },
    })
    orgId = org.id
    const user = await prisma.user.create({
      data: {
        organizationId: orgId,
        email: `batch-${sfx}@example.se`,
        passwordHash: 'x',
        firstName: 'B',
        lastName: 'U',
        role: 'OWNER',
      },
      select: { id: true },
    })
    userId = user.id
    for (let i = 0; i < ANTAL_MOTTAGARE; i++) {
      const t = await prisma.tenant.create({
        data: {
          organizationId: orgId,
          type: 'INDIVIDUAL',
          firstName: `Hyres${i}`,
          lastName: 'Gäst',
          email: `batch-t${i}-${sfx}@example.se`,
        },
        select: { id: true },
      })
      tenantIds.push(t.id)
    }
  })

  afterAll(async () => {
    // FK-riktning: barnen först. Organization har Restrict-barn på andra håll,
    // så raderingen måste vara fullständig och inte förlita sig på kaskad.
    await prisma.sentMessage.deleteMany({ where: { organizationId: orgId } })
    await prisma.tenant.deleteMany({ where: { organizationId: orgId } })
    await prisma.user.deleteMany({ where: { organizationId: orgId } })
    await prisma.organization.delete({ where: { id: orgId } })
    await prisma.$disconnect()
  })

  const raderIOrg = () =>
    prisma.sentMessage.findMany({
      where: { organizationId: orgId },
      select: { tenantId: true, batchId: true },
    })

  it('SAMMA batch två gånger ger EN rad per mottagare', async () => {
    const batchId = randomUUID()

    expect(await skrivUtskick(batchId)).toBe(0)
    // Andra körningen av SAMMA utskick: varje mottagare krockar, ingen ny rad.
    expect(await skrivUtskick(batchId)).toBe(ANTAL_MOTTAGARE)

    const rader = (await raderIOrg()).filter((r) => r.batchId === batchId)
    expect(rader).toHaveLength(ANTAL_MOTTAGARE)
    expect(new Set(rader.map((r) => r.tenantId)).size).toBe(ANTAL_MOTTAGARE)
  })

  it('TVÅ OLIKA batchar till samma hyresgäst ger TVÅ rader', async () => {
    // Motprovet är hela produktpoängen: ett medvetet andra brev är ett NYTT
    // utskick, och det ska gå igenom. En spärr som stoppade det hade gjort
    // "skicka igen" omöjligt utan att någon bad om det.
    const tenantId = tenantIds[0]!
    const a = randomUUID()
    const b = randomUUID()

    await prisma.sentMessage.create({ data: rad(tenantId, a), select: { id: true } })
    await prisma.sentMessage.create({ data: rad(tenantId, b), select: { id: true } })

    const rader = (await raderIOrg()).filter((r) => r.batchId === a || r.batchId === b)
    expect(rader).toHaveLength(2)
  })

  it('rader UTAN batchId deltar inte i villkoret — historiken överlever', async () => {
    // Postgres räknar NULL som skilt från NULL i ett unikt index. Allt skrivet
    // före #635 har batchId NULL, och en migration som fällt på dem hade varit
    // omöjlig att köra i produktion.
    const tenantId = tenantIds[1]!
    await prisma.sentMessage.create({ data: rad(tenantId, null), select: { id: true } })
    await prisma.sentMessage.create({ data: rad(tenantId, null), select: { id: true } })

    const utanBatch = (await raderIOrg()).filter((r) => r.tenantId === tenantId && !r.batchId)
    expect(utanBatch).toHaveLength(2)
  })

  it('TVÅ SAMTIDIGA skrivningar: exakt en vinner, och förloraren får P2002', async () => {
    // Det här är skälet spärren ligger i databasen och inte i en `findFirst`
    // före: mellan en läsning och en skrivning finns ett fönster där båda
    // körningarna ser "ingen rad" och båda skriver. Ett unikt index har inget
    // sådant fönster.
    const tenantId = tenantIds[2]!
    const batchId = randomUUID()

    const utfall = await Promise.allSettled([
      prisma.sentMessage.create({ data: rad(tenantId, batchId), select: { id: true } }),
      prisma.sentMessage.create({ data: rad(tenantId, batchId), select: { id: true } }),
    ])

    expect(utfall.filter((u) => u.status === 'fulfilled')).toHaveLength(1)
    const avvisad = utfall.find((u) => u.status === 'rejected') as PromiseRejectedResult
    expect((avvisad.reason as Prisma.PrismaClientKnownRequestError).code).toBe('P2002')

    const rader = (await raderIOrg()).filter((r) => r.batchId === batchId)
    expect(rader).toHaveLength(1)
  })

  it('konfliktens FORM är den som verktygets disambiguering läser', async () => {
    // `ärBatchMottagarkonflikt` i tool-executor.service.ts kräver att
    // `meta.target` innehåller BÅDE tenantId och batchId — en blind P2002-fångst
    // hade maskerat en krock på ett annat index och gjort ett uteblivet brev
    // tyst. Ändrar Prisma formen ska det synas här och inte i produktion.
    const tenantId = tenantIds[0]!
    const batchId = randomUUID()
    await prisma.sentMessage.create({ data: rad(tenantId, batchId), select: { id: true } })

    const fel = await prisma.sentMessage
      .create({ data: rad(tenantId, batchId), select: { id: true } })
      .then(
        () => null,
        (e: unknown) => e,
      )

    expect(fel).toBeInstanceOf(Prisma.PrismaClientKnownRequestError)
    const p2002 = fel as Prisma.PrismaClientKnownRequestError
    expect(p2002.code).toBe('P2002')
    const target = (p2002.meta as { target?: unknown }).target
    expect(Array.isArray(target)).toBe(true)
    expect(target as string[]).toEqual(
      expect.arrayContaining(['organizationId', 'tenantId', 'batchId']),
    )
  })
})
