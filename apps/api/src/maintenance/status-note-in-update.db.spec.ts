/**
 * `update_maintenance_status`: NOTERINGEN LIGGER I UPPDATERINGEN — mot riktig Postgres.
 *
 * ── VARFÖR DET HÄR ERSÄTTER EN SPÄRR I STÄLLET FÖR ATT VARA EN ──────────────
 *
 * Posten var BLANDAD: statusdelen är en ren `update` och därmed idempotent, men
 * `addComment` var ett APPEND — en omkörning lade kommentaren en andra gång.
 * Den svagaste halvan bestämde klassen.
 *
 * Alternativet var ett tidsfönster på (ticket, författare, innehåll). Att ta bort
 * BEHOVET av en spärr slår att bygga den, och här går det: kommentaren beskriver
 * en ÖVERGÅNG. Att skriva den när ingen övergång skedde var alltid fel — inte
 * bara vid en omkörning. Nu är den nästlad i samma `update` och villkorad på att
 * statusen faktiskt ändras.
 *
 * ── HYRESGÄSTENS VY ÄNDRAS INTE, OCH DET ÄR MÄTT ────────────────────────────
 *
 * Verktyget skriver `isInternal: true`, och portalen läser
 * `where: { isInternal: false }` (tenant-portal.service.ts). Hyresgästen ser
 * alltså aldrig de här noteringarna — varken före eller efter. Provet längst ned
 * håller fast vid det, så att en framtida ändring av `isInternal` inte gör en
 * intern arbetsanteckning synlig för den boende.
 *
 * ── VAD PROVET INTE KAN SE ──────────────────────────────────────────────────
 *
 * Jämförelsen sker mot den status som lästes, inte i satsens `WHERE`. Två HELT
 * samtidiga anrop kan därför båda se den gamla statusen och båda skriva sin
 * notering. Kostnaden är en dubblerad INTERN rad, och den är för liten för ett
 * lås — men provet mäter inte den, och det står här.
 */
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))

import { randomUUID } from 'node:crypto'

import { Logger } from '@nestjs/common'

import { MaintenanceService } from './maintenance.service'
import { PrismaService } from '../common/prisma/prisma.service'
import { ToolExecutorService } from '../ai/tools/tool-executor.service'
import { AiAuditService } from '../ai/audit/ai-audit.service'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot en RIKTIG databas', () => {
    expect(HAR_DB).toBe(true)
  })
})

const NOTERING = 'Rörmokare bokad till torsdag.'

medDb('update_maintenance_status — noteringen skrivs vid övergången', () => {
  let prisma: PrismaService
  let executor: ToolExecutorService
  let orgId: string
  let userId: string
  let propertyId: string
  let ticketId: string
  let ticketNumber: string

  const kör = (nyStatus: string, kommentar?: string) =>
    executor.executeTool(
      'update_maintenance_status',
      { ticketId, ticketNumber, newStatus: nyStatus, ...(kommentar ? { comment: kommentar } : {}) },
      orgId,
      userId,
      'OWNER',
      { actionProof: { claimed: true } },
    )

  const kommentarer = () =>
    prisma.maintenanceComment.findMany({
      where: { ticketId },
      select: { content: true, isInternal: true },
    })

  beforeAll(async () => {
    prisma = new PrismaService()
    const maintenance = Object.create(MaintenanceService.prototype) as MaintenanceService
    Object.assign(maintenance, { prisma })
    executor = Object.create(ToolExecutorService.prototype) as ToolExecutorService
    Object.assign(executor, {
      prisma,
      maintenanceService: maintenance,
      audit: new AiAuditService(prisma),
      logger: new Logger('spec'),
    })

    const sfx = randomUUID().slice(0, 8)
    const org = await prisma.organization.create({
      data: {
        name: `not-${sfx}`,
        email: `not-${sfx}@example.se`,
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
        email: `not-${sfx}@example.se`,
        passwordHash: 'x',
        firstName: 'N',
        lastName: 'O',
        role: 'OWNER',
      },
      select: { id: true },
    })
    userId = user.id
    const property = await prisma.property.create({
      data: {
        organizationId: orgId,
        name: `Fastigheten ${sfx}`,
        propertyDesignation: `NOT ${sfx}`,
        type: 'RESIDENTIAL',
        street: 'a',
        city: 'b',
        postalCode: '11111',
        totalArea: 100,
      },
      select: { id: true },
    })
    propertyId = property.id
  }, 30_000)

  beforeEach(async () => {
    await prisma.maintenanceComment.deleteMany({ where: { ticket: { organizationId: orgId } } })
    await prisma.maintenanceTicket.deleteMany({ where: { organizationId: orgId } })
    const t = await prisma.maintenanceTicket.create({
      data: {
        organizationId: orgId,
        propertyId,
        ticketNumber: `AR-${randomUUID().slice(0, 8)}`,
        title: 'Droppande kran',
        description: 'Det droppar.',
        status: 'NEW',
      },
      select: { id: true, ticketNumber: true },
    })
    ticketId = t.id
    ticketNumber = t.ticketNumber
  })

  afterAll(async () => {
    await prisma.maintenanceComment.deleteMany({ where: { ticket: { organizationId: orgId } } })
    await prisma.maintenanceTicket.deleteMany({ where: { organizationId: orgId } })
    await prisma.property.deleteMany({ where: { organizationId: orgId } })
    await prisma.user.deleteMany({ where: { organizationId: orgId } })
    for (let försök = 1; ; försök++) {
      await prisma.aiToolExecution.deleteMany({ where: { organizationId: orgId } })
      try {
        await prisma.organization.delete({ where: { id: orgId } })
        break
      } catch (err) {
        if (försök >= 5) throw err
        await new Promise((r) => setTimeout(r, 200))
      }
    }
    await prisma.$disconnect()
  })

  it('SAMMA anrop två gånger → EN notering', async () => {
    // Det defekta fallet före ändringen: `update` var idempotent, `addComment`
    // var ett append, och omkörningen lade raden en andra gång.
    await kör('IN_PROGRESS', NOTERING)
    await kör('IN_PROGRESS', NOTERING)

    expect(await kommentarer()).toHaveLength(1)
  })

  it('TVÅ LEGITIMA anrop → TVÅ noteringar', async () => {
    // Den obligatoriska andra kontrollen. Två VERKLIGA övergångar, var och en
    // med sin notering, ska ge två rader — annars vore spärren för grov och
    // hade ätit en anteckning om ett arbete som faktiskt hände.
    await kör('IN_PROGRESS', 'Rörmokare bokad.')
    await kör('COMPLETED', 'Bytt packning, klart.')

    const rader = await kommentarer()
    expect(rader).toHaveLength(2)
    expect(rader.map((r) => r.content).sort()).toEqual([
      'Bytt packning, klart.',
      'Rörmokare bokad.',
    ])
  })

  it('STATUSEN sätts ändå — den idempotenta halvan är orörd', async () => {
    await kör('IN_PROGRESS', NOTERING)
    const efter = await prisma.maintenanceTicket.findUniqueOrThrow({
      where: { id: ticketId },
      select: { status: true },
    })
    expect(efter.status).toBe('IN_PROGRESS')
  })

  it('SVARET säger att inget ändrades, och att noteringen inte sparades', async () => {
    // Ett tyst hopp hade sett ut som en genomförd ändring, och en notering som
    // var tänkt att fastna hade fallit bort utan att någon fick veta det.
    await kör('IN_PROGRESS', 'första')
    const andra = await kör('IN_PROGRESS', 'en helt annan notering')

    expect(andra.message).toMatch(/hade redan status/i)
    expect(andra.message).toMatch(/ingen notering lades till/i)
    expect(await kommentarer()).toHaveLength(1)
  })

  it('en övergång UTAN notering skriver ingen rad', async () => {
    await kör('IN_PROGRESS')
    expect(await kommentarer()).toHaveLength(0)
  })

  it('HYRESGÄSTENS VY ÄNDRAS INTE: noteringen är intern', async () => {
    // Portalen läser `where: { isInternal: false }`. Blir en notering någonsin
    // extern blir en intern arbetsanteckning synlig för den boende.
    await kör('IN_PROGRESS', NOTERING)

    const rader = await kommentarer()
    expect(rader).toHaveLength(1)
    expect(rader[0]!.isInternal).toBe(true)

    const portalsynliga = await prisma.maintenanceComment.count({
      where: { ticketId, isInternal: false },
    })
    expect(portalsynliga).toBe(0)
  })
})
