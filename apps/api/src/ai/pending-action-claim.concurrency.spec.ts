/**
 * BEKRÄFTELSEANSPRÅKET UNDER SAMTIDIGHET — mot riktig Postgres.
 *
 * ── VARFÖR DEN HÄR FILEN FINNS ──────────────────────────────────────────────
 *
 * Red team-revisionen namngav "noll samtidighetstester i repot" som den största
 * testluckan. Egenskapen nedan var verifierad som MEKANISM (koden ser rätt ut)
 * men aldrig under last. Riggen fick byggas från noll under revisionen; det här
 * är den, som en spec.
 *
 * ── VARFÖR MOT RIKTIG POSTGRES ──────────────────────────────────────────────
 *
 * Egenskapen är databasens, inte kodens: att `updateMany` med `consumedAt: null`
 * i WHERE ger `count === 1` för exakt EN av N samtidiga transaktioner. En
 * attrapp bevisar bara att man skrev sin egen attrapp rätt — den har ingen
 * radlåsning och ingen READ COMMITTED-semantik.
 *
 * ── NEGATIVKONTROLLEN BOR HÄR, INTE I EN RAPPORT ────────────────────────────
 *
 * Utan den är "1 av 24 vann" lika förenligt med "anspråket håller" som med
 * "riggen kör inte parallellt". Testet nedan kör därför SAMMA rigg utan
 * `consumedAt: null` i villkoret och kräver att ALLA 24 vinner.
 */
import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

// FÖRUTSÄTTNINGSKANARIEFÅGELN LIGGER UTANFÖR det hoppbara blocket. Ligger den
// inuti är den grön av att den hoppades över — hela filen kan då försvinna ur
// CI utan att något blir rött.
describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot en RIKTIG databas', () => {
    expect(HAR_DB).toBe(true)
  })
})

const SAMTIDIGA = 24

medDb('AiPendingAction — engångsanspråket under samtidighet', () => {
  let prisma: PrismaClient
  let orgId: string
  let userId: string
  let convId: string

  beforeAll(async () => {
    prisma = new PrismaClient()
    const sfx = randomUUID().slice(0, 8)
    const org = await prisma.organization.create({
      data: {
        name: `claim-${sfx}`,
        email: `claim-${sfx}@example.se`,
        street: 'a',
        city: 'b',
        postalCode: '11111',
      },
    })
    orgId = org.id
    const user = await prisma.user.create({
      data: {
        organizationId: orgId,
        email: `claim-${sfx}@example.se`,
        passwordHash: 'x',
        firstName: 'A',
        lastName: 'B',
      },
    })
    userId = user.id
    const conv = await prisma.aiConversation.create({ data: { organizationId: orgId, userId } })
    convId = conv.id
  }, 30_000)

  afterAll(async () => {
    await prisma.organization.delete({ where: { id: orgId } })
    await prisma.$disconnect()
  })

  const nyPending = (hash: string) =>
    prisma.aiPendingAction.create({
      data: {
        conversationId: convId,
        organizationId: orgId,
        userId,
        toolName: 'create_journal_entry',
        toolInputHash: hash,
        expiresAt: new Date(Date.now() + 600_000),
      },
      select: { id: true },
    })

  /**
   * Anspråket, ordagrant som i `consumePendingAction`.
   * `skydd: false` tar bort `consumedAt: null` ur villkoret — och ingenting annat.
   */
  async function anspråk(hash: string, skydd: boolean): Promise<'claimed' | 'blocked'> {
    const rad = await prisma.aiPendingAction.findFirst({
      where: { conversationId: convId, organizationId: orgId, userId, toolInputHash: hash },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    })
    const claim = await prisma.aiPendingAction.updateMany({
      where: skydd ? { id: rad!.id, consumedAt: null } : { id: rad!.id },
      data: { consumedAt: new Date() },
    })
    return claim.count === 1 ? 'claimed' : 'blocked'
  }

  const kör = async (hash: string, skydd: boolean) => {
    await nyPending(hash)
    const res = await Promise.all(Array.from({ length: SAMTIDIGA }, () => anspråk(hash, skydd)))
    return res.filter((r) => r === 'claimed').length
  }

  it(`KÄRNAN: ${SAMTIDIGA} samtidiga bekräftelser → exakt EN vinner`, async () => {
    expect(await kör(`skydd-${randomUUID().slice(0, 8)}`, true)).toBe(1)
  }, 60_000)

  it(`NEGATIVKONTROLL: utan villkoret vinner ALLA ${SAMTIDIGA}`, async () => {
    // Beviset för att det är VILLKORET som håller. Utan den här raden är
    // resultatet ovan lika förenligt med "riggen kör sekventiellt".
    expect(await kör(`utan-${randomUUID().slice(0, 8)}`, false)).toBe(SAMTIDIGA)
  }, 60_000)

  it('och den vinnande körningen är den enda som ser consumedAt satt av sig själv', async () => {
    // Invarianten bakom svaret "Åtgärden är redan utförd": raden är konsumerad
    // exakt en gång, inte N gånger med sista skrivningen kvar.
    const hash = `en-${randomUUID().slice(0, 8)}`
    await nyPending(hash)
    const res = await Promise.all(Array.from({ length: SAMTIDIGA }, () => anspråk(hash, true)))
    expect(res.filter((r) => r === 'claimed')).toHaveLength(1)
    expect(res.filter((r) => r === 'blocked')).toHaveLength(SAMTIDIGA - 1)
  }, 60_000)
})
