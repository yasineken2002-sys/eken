/**
 * BOKNINGEN HELA VÄGEN — mot riktig Postgres.
 *
 * Planens rad 10 blir KLAR först när en bokning gått hela vägen i ett
 * db-spec-flöde. Det här är det flödet: tilldela → skicka arbetsorder →
 * hantverkaren svarar via länken → svaret syns i historiken.
 *
 * ── VARFÖR RIKTIG DATABAS ───────────────────────────────────────────────────
 *
 * Två av egenskaperna är villkor Postgres utvärderar, inte kod:
 *
 *   ENGÅNGSSPÄRREN  `updateMany` med `respondedAt: null` i `where`. En attrapp
 *                   returnerar det den blev tillsagd oavsett villkor, så en
 *                   tappad rad i `where` hade varit osynlig — och det är just
 *                   den raden som gör två samtidiga klick till ett svar.
 *   ORG-SCOPNINGEN  ett ärende i en annan organisation ska ge 404.
 *
 * Riggen skapar sina egna förutsättningar och städar i FK-riktning.
 */
import { randomUUID } from 'node:crypto'
import * as crypto from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { BadRequestException, NotFoundException } from '@nestjs/common'

import { WorkOrderService } from './work-order.service'
import { ContractorsService } from './contractors.service'
import { HISTORY_SOURCES } from '../history/history-sources.registry'
import type { PrismaService } from '../common/prisma/prisma.service'
import type { MailService } from '../mail/mail.service'

const HAR_DB = Boolean(process.env.DATABASE_URL)
const medDb = HAR_DB ? describe : describe.skip

describe('förutsättningar', () => {
  it('KANARIEFÅGEL: sviten körs mot en RIKTIG databas', () => {
    expect(HAR_DB).toBe(true)
  })
})

medDb('arbetsorderflödet mot riktig Postgres', () => {
  let prisma: PrismaClient
  let service: WorkOrderService
  let contractors: ContractorsService
  const skickade: { to: string; subject: string; bodyHtml: string }[] = []

  const orgA = randomUUID()
  const userId = randomUUID()
  const propertyId = randomUUID()
  const unitId = randomUUID()
  const tenantId = randomUUID()
  const ids = { ticket: '', hantverkare: '', order: '' }
  let token = ''

  beforeAll(async () => {
    prisma = new PrismaClient()

    // Mejlet är den enda utåtriktade sömmen och attrappas — provet mäter ATT
    // ett mejl köades och till vem, inte Resends beteende. Svarslänken plockas
    // ur kroppen, precis som hantverkaren skulle göra.
    const mail = {
      sendCustomEmail: async (o: { to: string; subject: string; bodyHtml: string }) => {
        skickade.push(o)
        return 'job-1'
      },
    } as unknown as MailService
    const config = { get: () => 'https://app.exempel.test' } as never

    service = new WorkOrderService(prisma as unknown as PrismaService, mail, config)
    contractors = new ContractorsService(prisma as unknown as PrismaService)

    await prisma.organization.create({
      data: {
        id: orgA,
        name: 'Org A',
        orgNumber: `55${orgA.slice(0, 8)}`,
        email: `${orgA}@exempel.test`,
        street: 'Testgatan 1',
        city: 'Testby',
        postalCode: '11111',
      },
    })
    await prisma.user.create({
      data: {
        id: userId,
        organizationId: orgA,
        email: `${userId}@exempel.test`,
        passwordHash: 'x',
        firstName: 'Test',
        lastName: 'Testsson',
        role: 'OWNER',
      },
    })
    await prisma.property.create({
      data: {
        id: propertyId,
        organizationId: orgA,
        name: 'Testfastigheten',
        propertyDesignation: `Testby ${propertyId.slice(0, 6)}`,
        type: 'RESIDENTIAL',
        street: 'Storgatan 1',
        city: 'Stockholm',
        postalCode: '11122',
        totalArea: 420,
      },
    })
    await prisma.unit.create({
      data: {
        id: unitId,
        propertyId,
        name: 'Lägenhet 1',
        unitNumber: '1001',
        type: 'APARTMENT',
        area: 60,
        rooms: 2,
        monthlyRent: 9000,
      },
    })
    await prisma.tenant.create({
      data: {
        id: tenantId,
        organizationId: orgA,
        type: 'INDIVIDUAL',
        firstName: 'Hyres',
        lastName: 'Gästsson',
        email: `${tenantId}@exempel.test`,
        phone: '070-0000000',
      },
    })

    const c = await contractors.create(
      { name: 'Rör & Värme AB', email: 'ror@exempel.test', categories: ['PLUMBING'] },
      orgA,
      userId,
    )
    ids.hantverkare = c.id

    const t = await prisma.maintenanceTicket.create({
      data: {
        organizationId: orgA,
        propertyId,
        unitId,
        tenantId,
        ticketNumber: 'AR-1',
        title: 'Läckande kran',
        description: 'Droppar dygnet runt sedan i måndags.',
        category: 'PLUMBING',
      },
    })
    ids.ticket = t.id
  }, 60_000)

  afterAll(async () => {
    const w = { organizationId: orgA }
    await prisma.contractorWorkOrder.deleteMany({ where: w })
    await prisma.maintenanceComment.deleteMany({ where: { ticket: w } })
    await prisma.maintenanceTicket.deleteMany({ where: w })
    await prisma.contractor.deleteMany({ where: w })
    await prisma.tenant.deleteMany({ where: w })
    await prisma.unit.deleteMany({ where: { property: w } })
    await prisma.property.deleteMany({ where: w })
    await prisma.user.deleteMany({ where: w })
    await prisma.organization.deleteMany({ where: { id: orgA } })
    await prisma.$disconnect()
  }, 60_000)

  it('1. arbetsordern skickas, mejlet köas och länken finns i kroppen', async () => {
    const order = await service.send(ids.ticket, { contractorId: ids.hantverkare }, orgA, userId)
    ids.order = order.id
    expect(order.status).toBe('SENT')
    expect(order.sentToEmail).toBe('ror@exempel.test')

    expect(skickade).toHaveLength(1)
    expect(skickade[0]!.to).toBe('ror@exempel.test')

    const m = /\/arbetsorder\/([a-f0-9]{64})/.exec(skickade[0]!.bodyHtml)
    expect(m).not.toBeNull()
    token = m![1]!
  })

  it('2. RÅVÄRDET LAGRAS ALDRIG — bara hashen', async () => {
    const rad = await prisma.contractorWorkOrder.findUniqueOrThrow({ where: { id: ids.order } })
    expect(rad.responseTokenHash).toBe(crypto.createHash('sha256').update(token).digest('hex'))
    // Token får inte finnas någonstans i raden — inte i något fält.
    expect(JSON.stringify(rad)).not.toContain(token)
  })

  it('3. utan delning skrivs INGEN kontaktuppgift och ingen transparensrad', async () => {
    const rad = await prisma.contractorWorkOrder.findUniqueOrThrow({ where: { id: ids.order } })
    expect(rad.sharedTenantContact).toBeNull()
    expect(rad.bodyText).not.toContain('070-0000000')
    const kommentarer = await prisma.maintenanceComment.count({ where: { ticketId: ids.ticket } })
    expect(kommentarer).toBe(0)
  })

  it('4. en andra öppen order till samma hantverkare avvisas', async () => {
    await expect(
      service.send(ids.ticket, { contractorId: ids.hantverkare }, orgA, userId),
    ).rejects.toBeInstanceOf(BadRequestException)
  })

  it('5. hantverkaren svarar via länken — ACCEPTED med föreslagen tid', async () => {
    const svar = await service.respond(token, { accepterar: true, proposedAt: '2026-09-20' })
    expect(svar.status).toBe('ACCEPTED')
    const rad = await prisma.contractorWorkOrder.findUniqueOrThrow({ where: { id: ids.order } })
    expect(rad.respondedAt).toBeInstanceOf(Date)
    expect(rad.proposedAt).toBeInstanceOf(Date)
  })

  it('6. ENGÅNGS: samma länk en andra gång avvisas', async () => {
    await expect(service.respond(token, { accepterar: false })).rejects.toBeInstanceOf(
      NotFoundException,
    )
  })

  it('7. ett påhittat token ger SAMMA svar som ett förbrukat', async () => {
    // Skiljer sig svaren åt berättar endpointen för den som gissar vilka token
    // som funnits.
    const pahittat = crypto.randomBytes(32).toString('hex')
    await expect(service.respond(pahittat, { accepterar: true })).rejects.toBeInstanceOf(
      NotFoundException,
    )
  })

  it('8. hela flödet syns i historiken, i rätt ordning', async () => {
    const källa = HISTORY_SOURCES.find((k) => k.key === 'maintenance-ticket')!
    const h = await källa.load({
      prisma,
      organizationId: orgA,
      subject: { kind: 'TENANT', id: tenantId },
    } as never)
    const typer = h.map((x) => x.type)
    expect(typer).toContain('WORK_ORDER_SENT')
    expect(typer).toContain('WORK_ORDER_ACCEPTED')
    expect(typer).not.toContain('WORK_ORDER_CONTACT_SHARED')
  })

  describe('delning av hyresgästens kontaktuppgift', () => {
    let order2 = ''

    it('9. delning skrivs på ordern OCH som en rad hyresgästen ser', async () => {
      const o = await service.send(
        ids.ticket,
        { contractorId: ids.hantverkare, delaHyresgastKontakt: true },
        orgA,
        userId,
      )
      order2 = o.id
      expect(o.sharedTenantContact).toBe('070-0000000')
      expect(o.bodyText).toContain('070-0000000')

      // Transparensraden: ICKE-intern, alltså synlig i portalen. Den nämner
      // KANALEN, aldrig värdet — numret finns redan på ordern.
      const kommentarer = await prisma.maintenanceComment.findMany({
        where: { ticketId: ids.ticket },
      })
      expect(kommentarer).toHaveLength(1)
      expect(kommentarer[0]!.isInternal).toBe(false)
      expect(kommentarer[0]!.content).toContain('telefonnummer')
      expect(kommentarer[0]!.content).toContain('Rör & Värme AB')
      expect(kommentarer[0]!.content).not.toContain('070-0000000')
    })

    it('10. utlämnandet är en EGEN historikhändelse, utan värdet', async () => {
      const källa = HISTORY_SOURCES.find((k) => k.key === 'maintenance-ticket')!
      const h = await källa.load({
        prisma,
        organizationId: orgA,
        subject: { kind: 'TENANT', id: tenantId },
      } as never)
      const delning = h.filter((x) => x.type === 'WORK_ORDER_CONTACT_SHARED')
      expect(delning).toHaveLength(1)
      expect(delning[0]!.description).not.toContain('070-0000000')
    })

    it('11. avbokning stänger länken och köar ett avbokningsmejl', async () => {
      const fore = skickade.length
      const avbokad = await service.cancel(order2, orgA, 'Hyresgästen löste det själv')
      expect(avbokad.status).toBe('CANCELLED')
      expect(skickade).toHaveLength(fore + 1)
      expect(skickade[skickade.length - 1]!.subject).toContain('Avbokad')
    })
  })

  it('12. en AVBOKAD order raderar inte att hantverkaren svarat', async () => {
    // Ordern i prov 5 är ACCEPTED. Avbokas den ska historiken visa BÅDA
    // fakta — att hantverkaren tog jobbet, och att det sedan ströks. Att den
    // första försvinner vore en historik som skrivs om i efterhand.
    const källa = HISTORY_SOURCES.find((k) => k.key === 'maintenance-ticket')!
    const ladda = async () => {
      const h = await källa.load({
        prisma,
        organizationId: orgA,
        subject: { kind: 'TENANT', id: tenantId },
      } as never)
      return h.map((x) => x.type)
    }
    expect(await ladda()).toContain('WORK_ORDER_ACCEPTED')

    await service.cancel(ids.order, orgA, 'Ändrade oss')

    const efter = await ladda()
    expect(efter).toContain('WORK_ORDER_ACCEPTED')
    expect(efter).toContain('WORK_ORDER_CANCELLED')
  })

  /**
   * KANARIEFÅGEL — mot INSTRUMENTET.
   *
   * Proven ovan är gröna om `respond` KASTAR. Den kastar också om riggen aldrig
   * nådde uppslaget. Den här kräver att en FÄRSK, giltig länk fungerar — alltså
   * att sonden kan ge något annat än ett avslag. Kan den inte det mäter prov
   * 6 och 7 ingenting.
   */
  it('KANARIEFÅGEL: en färsk länk går att svara på', async () => {
    const t = await prisma.maintenanceTicket.create({
      data: {
        organizationId: orgA,
        propertyId,
        ticketNumber: 'AR-2',
        title: 'Annat fel',
        description: 'Beskrivning som är tillräckligt lång.',
        category: 'PLUMBING',
      },
    })
    await service.send(t.id, { contractorId: ids.hantverkare }, orgA, userId)
    const färsk = /\/arbetsorder\/([a-f0-9]{64})/.exec(skickade[skickade.length - 1]!.bodyHtml)![1]!
    await expect(service.respond(färsk, { accepterar: false })).resolves.toEqual({
      status: 'DECLINED',
    })
  })
})
