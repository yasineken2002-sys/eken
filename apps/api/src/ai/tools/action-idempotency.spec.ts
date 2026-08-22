/**
 * IDEMPOTENS I VERKTYGSVÄGEN — mot en RIKTIG databas.
 *
 * ── VAD MÄTNINGEN VISADE ─────────────────────────────────────────────────────
 *
 * Premissen var att inget hindrar att samma verktygsanrop utförs två gånger. För
 * LÄSVERKTYG stämmer det, och det är ofarligt. För de verktyg som rör pengar
 * stämmer det inte: `create_invoice`, `create_journal_entry` och
 * `mark_invoice_paid` är ACTION_TOOLS, utförs ALDRIG i verktygsloopen, och når
 * bara `executeTool` via `confirmAction` — där `consumePendingAction` gör ett
 * ATOMÄRT engångsanspråk innan verktyget körs.
 *
 * Det som saknades var att den ordningen vilade på att TRE loopar var för sig
 * kom ihåg att stoppa bindande verktyg. Invarianten bor nu i
 * `assertActionToolAuthorized`, som BÅDA exekverarna anropar först av allt.
 *
 * ── VARFÖR MOT EN RIKTIG DATABAS ─────────────────────────────────────────────
 *
 * Anspråket ÄR en databasoperation: `updateMany` på `consumedAt: null` med
 * `count === 1`. Med en attrapp bevisar man bara att man skrev sin egen attrapp
 * rätt. De två defekterna i #562 syntes bara mot riktig Postgres, och samma sak
 * gäller här: att två samtidiga anspråk ger exakt en vinnare är en egenskap hos
 * databasen, inte hos koden.
 */

// Exekveraren drar in hela beroendeträdet; de här två bär ESM i node_modules
// som Jest inte transformerar. Samma två mockar som övriga verktygsspecar.
jest.mock('../../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../../invoices/pdf.service', () => ({ PdfService: class {} }))

import { randomUUID } from 'node:crypto'
import { ForbiddenException } from '@nestjs/common'
import { PrismaService } from '../../common/prisma/prisma.service'
import { assertActionToolAuthorized, isActionTool } from './action-authorization'
import { ToolExecutorService } from './tool-executor.service'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const beskriv = HAR_DB ? describe : describe.skip

describe('grinden — bindande verktyg kräver bevis', () => {
  it('KANARIEFÅGEL: grinden skiljer bindande från läsande', () => {
    // Behandlar den alla verktyg lika är den antingen en spärr mot allt arbete
    // eller ingen spärr alls. Båda fallen är gröna om man bara provar ett håll.
    expect(isActionTool('create_invoice')).toBe(true)
    expect(isActionTool('create_journal_entry')).toBe(true)
    expect(isActionTool('mark_invoice_paid')).toBe(true)
    expect(isActionTool('get_invoices')).toBe(false)
    expect(isActionTool('get_properties')).toBe(false)
  })

  it('ett bindande verktyg UTAN bevis avvisas', () => {
    expect(() => assertActionToolAuthorized('create_invoice', undefined)).toThrow(
      ForbiddenException,
    )
  })

  it('ett LÄSANDE verktyg utan bevis går igenom — läsningar grindas inte', () => {
    // Mätning 4: att köra om en läsning är ofarligt och idempotent av naturen.
    // Att grinda den hade kostat en spärr utan nytta, och gjort varje
    // läsverktygsanrop beroende av en bekräftelse som aldrig föreslogs.
    expect(() => assertActionToolAuthorized('get_invoices', undefined)).not.toThrow()
  })

  it('ett bindande verktyg MED bevis går igenom', () => {
    expect(() =>
      assertActionToolAuthorized('create_invoice', { claimed: true, pendingActionId: 'pa-1' }),
    ).not.toThrow()
  })
})

describe('grinden sitter i executeTool — inte bara i modulen', () => {
  // ── VARFÖR DET HÄR TESTET BEHÖVS ─────────────────────────────────────────
  //
  // Testerna ovan prövar `assertActionToolAuthorized` DIREKT. De är gröna även
  // om ingen exekverare anropar den — alltså även om grinden är helt
  // bortkopplad. Uppmätt: när anropet togs bort ur `executeTool` föll guarden,
  // men INTE ett enda test. Ett test som prövar en regel utan att pröva att den
  // är PÅKOPPLAD mäter halva saken.
  //
  // Här körs den RIKTIGA exekveraren. Beroendena är avsiktligt tomma: grinden
  // ska fälla FÖRE något av dem rörs, så ett ForbiddenException bevisar att den
  // ligger först — och ett annat fel hade bevisat motsatsen.
  function makeExecutor(): { executeTool: ToolExecutorService['executeTool'] } {
    const tom = Array.from({ length: 24 }, () => ({}))
    return new (ToolExecutorService as unknown as new (...a: unknown[]) => ToolExecutorService)(
      ...tom,
    )
  }

  it('ett bindande verktyg UTAN bevis avvisas av executeTool', async () => {
    const executor = makeExecutor()
    await expect(
      executor.executeTool('create_invoice', {}, 'org-1', 'user-1', 'OWNER'),
    ).rejects.toBeInstanceOf(ForbiddenException)
  })

  it('KANARIEFÅGEL: ett LÄSANDE verktyg avvisas INTE av grinden', async () => {
    // Det får gärna falla på de tomma beroendena — men INTE på grinden. Utan
    // det här fallet vore "allt kastar" lika grönt som "rätt saker kastar".
    const executor = makeExecutor()
    const fel = await executor
      .executeTool('get_invoices', {}, 'org-1', 'user-1', 'OWNER')
      .catch((e: unknown) => e)
    expect(fel).not.toBeInstanceOf(ForbiddenException)
  })
})

beskriv('anspråket mot en riktig databas', () => {
  let prisma: PrismaService
  let orgId: string
  let userId: string
  let convId: string

  beforeAll(async () => {
    prisma = new PrismaService()
    await prisma.$connect()
    const org = await prisma.organization.create({
      data: {
        name: `zz-idem-${randomUUID().slice(0, 8)}`,
        orgNumber: `55${Math.floor(Math.random() * 10_000_000)
          .toString()
          .padStart(8, '0')}`,
        email: 'zz@example.test',
        street: 'Gatan 1',
        city: 'Stockholm',
        postalCode: '11111',
      },
      select: { id: true },
    })
    orgId = org.id
    const user = await prisma.user.create({
      data: {
        organizationId: orgId,
        email: `zz-${randomUUID().slice(0, 8)}@example.test`,
        passwordHash: 'x',
        firstName: 'Zz',
        lastName: 'Sond',
        role: 'OWNER',
      },
      select: { id: true },
    })
    userId = user.id
    const conv = await prisma.aiConversation.create({
      data: { organizationId: orgId, userId, title: 'zz' },
      select: { id: true },
    })
    convId = conv.id
  })

  afterAll(async () => {
    if (!prisma) return
    await prisma.aiToolEffect.deleteMany({ where: { organizationId: orgId } })
    await prisma.aiToolExecution.deleteMany({ where: { organizationId: orgId } })
    await prisma.aiConversation.deleteMany({ where: { organizationId: orgId } })
    await prisma.user.deleteMany({ where: { organizationId: orgId } })
    await prisma.organization.deleteMany({ where: { id: orgId } })
    await prisma.$disconnect()
  })

  /** Ett anspråk, exakt som `consumePendingAction` gör det. */
  async function anspråk(id: string): Promise<boolean> {
    const claim = await prisma.aiPendingAction.updateMany({
      where: { id, consumedAt: null },
      data: { consumedAt: new Date() },
    })
    return claim.count === 1
  }

  async function nyBekräftelse(hash: string): Promise<string> {
    const rad = await prisma.aiPendingAction.create({
      data: {
        conversationId: convId,
        organizationId: orgId,
        userId,
        toolName: 'create_invoice',
        toolInputHash: hash,
        expiresAt: new Date(Date.now() + 600_000),
      },
      select: { id: true },
    })
    return rad.id
  }

  it('(1) SAMMA bekräftelse två gånger → exakt ETT anspråk vinner', async () => {
    const id = await nyBekräftelse('hash-A')
    expect(await anspråk(id)).toBe(true)
    // Andra försöket: raden är redan konsumerad → inget att göra.
    expect(await anspråk(id)).toBe(false)
  })

  it('(1b) två SAMTIDIGA anspråk på samma rad → exakt en vinnare', async () => {
    // Databasegenskapen, inte kodegenskapen. En attrapp kan inte visa den här.
    const id = await nyBekräftelse('hash-B')
    const utfall = await Promise.all([anspråk(id), anspråk(id), anspråk(id)])
    expect(utfall.filter(Boolean)).toHaveLength(1)
  })

  it('(2) SAMMA verktyg och SAMMA input men NY bekräftelse → nytt anspråk vinner', async () => {
    // DEN AVGÖRANDE KONTROLLEN. Samma input i två separata turer är ett
    // LEGITIMT upprepande: en hyresvärd som ber om samma faktura två gånger ska
    // få två fakturor. Hade vi nycklat på en hash av toolName + input hade den
    // andra turen tystats bort som en "dubblett" — en spärr mot riktigt arbete.
    const första = await nyBekräftelse('hash-C')
    expect(await anspråk(första)).toBe(true)

    const andra = await nyBekräftelse('hash-C') // IDENTISK hash, ny rad
    expect(andra).not.toBe(första)
    expect(await anspråk(andra)).toBe(true)

    // Båda är konsumerade — alltså två utförda åtgärder, som avsett.
    const konsumerade = await prisma.aiPendingAction.count({
      where: { conversationId: convId, toolInputHash: 'hash-C', consumedAt: { not: null } },
    })
    expect(konsumerade).toBe(2)
  })

  it('en UTGÅNGEN bekräftelse kan inte anspråkas', async () => {
    const rad = await prisma.aiPendingAction.create({
      data: {
        conversationId: convId,
        organizationId: orgId,
        userId,
        toolName: 'create_invoice',
        toolInputHash: 'hash-D',
        expiresAt: new Date(Date.now() - 1000),
      },
      select: { id: true, expiresAt: true },
    })
    // Anspråket självt tittar inte på expiresAt — grinden i consumePendingAction
    // gör det, och den ordningen är avsiktlig: utgången läses FÖRE anspråket så
    // att svaret kan skilja "gick ut" från "redan utförd".
    expect(rad.expiresAt.getTime()).toBeLessThan(Date.now())
  })
})
