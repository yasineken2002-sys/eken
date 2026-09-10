/**
 * Verkliga confirm-, verktygs-, maintenance- och notistjänster.
 * Prisma, kö och audit är ersättningar: detta mäter anropskedjan och svaren,
 * inte PostgreSQL-låsning, varaktig idempotens eller levererade meddelanden.
 */
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))
jest.mock('../tenant-portal/tenant-auth.guard', () => ({ TenantAuthGuard: class {} }))

import { Logger } from '@nestjs/common'
import { TenantAiService } from '../ai/tenant-ai.service'
import { hashPendingAction } from '../ai/ai-assistant.service'
import { TenantToolExecutorService } from '../ai/tools/tenant-tool-executor.service'
import { TenantPortalService } from '../tenant-portal/tenant-portal.service'
import { NotificationsService } from '../notifications/notifications.service'
import { MaintenanceService } from './maintenance.service'

const tenantId = 'syntetisk-hyresgast'
const organizationId = 'syntetisk-organisation'
const conversationId = 'syntetisk-konversation'
const toolName = 'create_maintenance_ticket'
const input = { title: 'Droppande kökskran', description: 'Kranen droppar hela tiden i köket.' }

function fixture(
  ticketTenant: {
    firstName?: string
    lastName?: string
    companyName?: string
    email?: string
  } | null = {
    firstName: 'Test',
    lastName: 'Hyresgäst',
  },
) {
  let pending: string | null = hashPendingAction(toolName, input)
  const tickets: Array<Record<string, unknown>> = []
  const notifications: Array<Record<string, unknown>> = []
  const chatHistory: Array<Record<string, unknown>> = []
  const prisma = {
    property: { findFirst: jest.fn().mockResolvedValue({ id: 'fastighet' }) },
    unit: { findFirst: jest.fn().mockResolvedValue({ id: 'lagenhet' }) },
    tenant: { findFirst: jest.fn().mockResolvedValue({ id: tenantId }) },
    lease: {
      findFirst: jest.fn().mockResolvedValue({
        organizationId,
        unitId: 'lagenhet',
        unit: { propertyId: 'fastighet', property: { id: 'fastighet' } },
        tenant: { firstName: 'Test', lastName: 'Hyresgäst' },
      }),
    },
    maintenanceTicketSequence: {
      upsert: jest.fn().mockImplementation(async () => ({
        lastNumber: tickets.length + 1,
      })),
    },
    maintenanceTicket: {
      create: jest.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
        const ticket = {
          ...data,
          id: `arende-${tickets.length + 1}`,
          status: 'NEW',
          createdAt: new Date(),
          updatedAt: new Date(),
          scheduledDate: null,
          completedAt: null,
          property: { name: 'Testfastigheten' },
          unit: { name: 'Lägenhet 1' },
          tenant: ticketTenant,
          comments: [],
        }
        tickets.push(ticket)
        return ticket
      }),
    },
    user: {
      findMany: jest.fn().mockResolvedValue([{ id: 'forvaltare-1' }, { id: 'forvaltare-2' }]),
    },
    notification: {
      createMany: jest
        .fn()
        .mockImplementation(async ({ data }: { data: Array<Record<string, unknown>> }) => {
          notifications.push(...data)
          return { count: data.length }
        }),
    },
    aiTenantConversation: {
      findFirst: jest.fn().mockResolvedValue({ id: conversationId, tenantId }),
      updateMany: jest
        .fn()
        .mockImplementation(async ({ where }: { where: { pendingActionHash: string } }) => {
          if (pending !== where.pendingActionHash) return { count: 0 }
          pending = null
          return { count: 1 }
        }),
      update: jest.fn().mockResolvedValue({}),
    },
    aiTenantMessage: {
      create: jest.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
        chatHistory.push(data)
        return data
      }),
    },
    $transaction: jest.fn(),
  }
  // Anropar produktionskroppen. Simulerar varken SQL-rollback eller konkurrens.
  prisma.$transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) =>
    callback(prisma),
  )
  const notify = new NotificationsService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  )
  const notifySpy = jest.spyOn(notify, 'createForAllOrgUsers')
  const queue = { enqueue: jest.fn().mockResolvedValue({}) }
  const maintenance = new MaintenanceService(
    prisma as never,
    notify,
    {} as never,
    queue as never,
    {} as never,
  )
  const audit = {
    beginToolExecution: jest.fn().mockResolvedValue({}),
    completeToolExecution: jest.fn().mockResolvedValue({}),
    logToolExecution: jest.fn().mockResolvedValue({}),
  }
  const executor = new TenantToolExecutorService(
    prisma as never,
    maintenance,
    notify,
    audit as never,
    {} as never,
  )
  const execute = jest.spyOn(executor, 'executeTool')
  const ai = new TenantAiService(prisma as never, { get: () => '' } as never, executor, {} as never)
  const portal = new TenantPortalService(prisma as never, {} as never, maintenance, notify)
  const confirm = () =>
    ai.confirmAction(toolName, input, conversationId, true, tenantId, organizationId)
  const manual = () => portal.submitMaintenanceRequest(tenantId, input)
  return {
    prisma,
    tickets,
    notifications,
    chatHistory,
    notifySpy,
    queue,
    execute,
    confirm,
    manual,
    executor,
    ai,
  }
}

const drainNotifications = () => new Promise<void>((resolve) => setImmediate(resolve))

describe('felanmälan: ett ärende, en notis per mottagare och verifierbar återkoppling', () => {
  beforeEach(() => jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined))
  afterEach(() => jest.restoreAllMocks())

  it.each(['AI', 'manuell'] as const)('%s: skickar en notis per aktiv mottagare', async (path) => {
    const f = fixture()
    const result = await (path === 'AI' ? f.confirm() : f.manual())
    await drainNotifications()
    expect(f.tickets).toHaveLength(1)
    expect(f.notifySpy).toHaveBeenCalledTimes(1)
    expect(f.notifications).toHaveLength(2)
    expect(new Set(f.notifications.map((n) => n.userId)).size).toBe(2)
    expect(f.notifications.every((n) => n.relatedEntityId === f.tickets[0]!.id)).toBe(true)
    expect(f.queue.enqueue).toHaveBeenCalledTimes(1)
    expect(f.prisma.user.findMany).toHaveBeenCalledWith({
      where: { organizationId, isActive: true },
      select: { id: true },
    })
    expect(f.notifications.every((n) => String(n.message).includes('Test Hyresgäst'))).toBe(true)
    if (path === 'AI') {
      expect(f.prisma.aiTenantConversation.updateMany).toHaveBeenCalledWith({
        where: {
          id: conversationId,
          tenantId,
          pendingActionHash: hashPendingAction(toolName, input),
          pendingActionExpiresAt: { gt: expect.any(Date) },
        },
        data: { pendingActionHash: null, pendingActionExpiresAt: null },
      })
      expect(result).toMatchObject({ reply: expect.stringContaining('UND-00001') })
      expect(f.chatHistory).toHaveLength(1)
    } else {
      expect(result).toMatchObject({ id: f.tickets[0]!.id, ticketNumber: 'UND-00001' })
      expect(result).not.toHaveProperty('organizationId')
      expect(f.execute).not.toHaveBeenCalled()
    }
  })

  it.each([
    ['AI', 'inga mottagare'],
    ['AI', 'notisfel'],
    ['manuell', 'inga mottagare'],
    ['manuell', 'notisfel'],
  ])('%s / %s: sparar ärendet även utan notis', async (path, failure) => {
    const f = fixture()
    if (failure === 'inga mottagare') f.prisma.user.findMany.mockResolvedValue([])
    else f.prisma.notification.createMany.mockRejectedValue(new Error('syntetiskt notisfel'))
    const response = await (path === 'AI' ? f.confirm() : f.manual())
    await drainNotifications()
    expect(f.tickets).toHaveLength(1)
    expect(f.notifications).toHaveLength(0)
    if ('reply' in response) {
      expect(response.reply).toContain('Felanmälan skapad (#UND-00001)')
      expect(response.reply).not.toMatch(/fått en notifiering|hör av sig/)
      expect(response.reply).toMatch(/följa.*felanmälningar/i)
    } else {
      expect(response).toMatchObject({ id: f.tickets[0]!.id })
    }
  })

  it('en identisk bekräftelse efter tappat chattkvitto skapar inget nytt och råder till kontroll', async () => {
    const f = fixture()
    f.prisma.aiTenantMessage.create.mockRejectedValueOnce(new Error('syntetiskt historikavbrott'))
    await expect(f.confirm()).rejects.toThrow('syntetiskt historikavbrott')
    expect(f.tickets).toHaveLength(1)
    await expect(f.confirm()).rejects.toThrow(/Kontrollera dina felanmälningar/)
    await drainNotifications()
    expect(f.execute).toHaveBeenCalledTimes(1)
    expect(f.tickets).toHaveLength(1)
    expect(f.notifySpy).toHaveBeenCalledTimes(1)
  })

  it('fel före sparande ger ingen skapad-bekräftelse, notis eller köeffekt', async () => {
    const f = fixture()
    f.prisma.maintenanceTicket.create.mockRejectedValue(new Error('syntetiskt databasavbrott'))
    const response = await f.confirm()
    expect(response.reply).not.toMatch(/Felanmälan skapad|fått en notifiering/)
    expect(f.tickets).toHaveLength(0)
    expect(f.notifySpy).not.toHaveBeenCalled()
    expect(f.queue.enqueue).not.toHaveBeenCalled()
    await expect(f.confirm()).rejects.toThrow(/Kontrollera dina felanmälningar/)
    expect(f.execute).toHaveBeenCalledTimes(1)
  })

  it('två avsiktliga manuella felanmälningar med samma text bevaras', async () => {
    const f = fixture()
    await f.manual()
    await f.manual()
    await drainNotifications()
    expect(f.tickets).toHaveLength(2)
    expect(f.tickets.map((t) => t.ticketNumber)).toEqual(['UND-00001', 'UND-00002'])
    expect(f.notifications).toHaveLength(4)
    expect(f.notifySpy).toHaveBeenCalledTimes(2)
  })

  it.each([
    [{ companyName: 'Testbolaget' }, 'Testbolaget — Ärende UND-00001'],
    [
      { companyName: 'Testbolaget', firstName: 'Kontaktperson' },
      'Kontaktperson — Ärende UND-00001',
    ],
    [{ email: 'syntetisk@example.invalid' }, 'syntetisk@example.invalid — Ärende UND-00001'],
    [null, 'Ärende UND-00001'],
    [{}, 'Ärende UND-00001'],
  ] as const)(
    'notisen har företagsnamn eller ett läsbart ärendenummer utan namn (%j)',
    async (tenant, expected) => {
      const f = fixture(tenant)
      await f.manual()
      await drainNotifications()
      expect(f.notifications).toHaveLength(2)
      expect(f.notifications[0]!.message).toBe(`${expected}: ${input.title}`)
    },
  )

  it('utan hyresgästens bekräftelse får verktyget inte skapa ärende', async () => {
    const f = fixture()
    await expect(
      f.executor.executeTool(toolName, input, tenantId, organizationId),
    ).rejects.toThrow()
    expect(f.tickets).toHaveLength(0)
    expect(f.notifySpy).not.toHaveBeenCalled()
  })

  it('oanvändbar bekräftelse före effekt säger inte att något säkert utförts', async () => {
    const f = fixture()
    f.prisma.aiTenantConversation.updateMany.mockResolvedValue({ count: 0 })
    await expect(f.confirm()).rejects.toThrow('Ärendet kan redan ha skapats.')
    expect(f.execute).not.toHaveBeenCalled()
    expect(f.tickets).toHaveLength(0)
  })

  it('andra verktygs felmeddelande ändras inte av felanmälningsfixen', async () => {
    const f = fixture()
    await expect(
      f.ai.confirmAction('request_termination', {}, conversationId, true, tenantId, organizationId),
    ).rejects.toThrow(
      'Bekräftelsen är ogiltig eller har gått ut. Be assistenten föreslå åtgärden igen.',
    )
    expect(f.execute).not.toHaveBeenCalled()
  })

  it('annan hyresgästs konversation ger ingen verktygskörning', async () => {
    const f = fixture()
    f.prisma.aiTenantConversation.findFirst.mockResolvedValue(null)
    await expect(f.confirm()).rejects.toThrow('Konversation hittades inte')
    expect(f.prisma.aiTenantConversation.findFirst).toHaveBeenCalledWith({
      where: { id: conversationId, tenantId },
    })
    expect(f.execute).not.toHaveBeenCalled()
    expect(f.tickets).toHaveLength(0)
  })
})
