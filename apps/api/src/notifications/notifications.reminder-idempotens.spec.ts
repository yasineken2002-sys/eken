/**
 * #28 — sendOverdueRemindersForOrg idempotensguard.
 *
 * Den org-scopade påminnelsemetoden saknade dedup: ett dubbelanrop samma dag
 * (dubbelklick, retry, dubbel cron-fire vid multi-replica) skickade
 * påminnelsemejl TVÅ gånger för samma faktura. Skyddet (daglig InvoiceEvent-
 * dedup med type REMINDER_SENT) återinförs här — samma mönster som den
 * borttagna sendOverdueReminders() (PR #27, H2).
 */

import { NotificationsService } from './notifications.service'

function makeInvoice(id: string, email: string | null = 'hyresgast@example.se') {
  return {
    id,
    organizationId: 'org-1',
    status: 'OVERDUE',
    invoiceNumber: `F-${id}`,
    total: 1000,
    dueDate: new Date('2026-05-01'),
    tenant: email
      ? { type: 'COMPANY', companyName: 'Hyresgäst AB', email }
      : { type: 'COMPANY', companyName: 'Hyresgäst AB', email: null },
    customer: null,
    organization: { name: 'Värd AB', invoiceColor: '#1a6b3c' },
  }
}

function makeService(opts: {
  invoices: ReturnType<typeof makeInvoice>[]
  alreadySentIds?: string[]
}) {
  const alreadySent = new Set(opts.alreadySentIds ?? [])
  const prisma = {
    invoice: { findMany: jest.fn().mockResolvedValue(opts.invoices) },
    invoiceEvent: {
      findFirst: jest
        .fn()
        .mockImplementation((args: { where: { invoiceId: string } }) =>
          Promise.resolve(alreadySent.has(args.where.invoiceId) ? { id: 'ev-existing' } : null),
        ),
      create: jest.fn().mockResolvedValue({ id: 'ev-new' }),
    },
  }
  const mail = { sendOverdueReminder: jest.fn().mockResolvedValue(undefined) }
  const service = new NotificationsService(prisma as never, mail as never, {} as never, {} as never)
  return { service, prisma, mail }
}

describe('#28 — sendOverdueRemindersForOrg idempotensguard', () => {
  it('skickar och loggar REMINDER_SENT för en faktura utan tidigare påminnelse idag', async () => {
    const { service, prisma, mail } = makeService({ invoices: [makeInvoice('1')] })
    await service.sendOverdueRemindersForOrg('org-1')
    expect(mail.sendOverdueReminder).toHaveBeenCalledTimes(1)
    expect(prisma.invoiceEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          invoiceId: '1',
          type: 'REMINDER_SENT',
          actorType: 'SYSTEM',
        }),
      }),
    )
  })

  it('hoppar över faktura som redan fått en REMINDER_SENT idag (ingen dubblett)', async () => {
    const { service, prisma, mail } = makeService({
      invoices: [makeInvoice('1')],
      alreadySentIds: ['1'],
    })
    await service.sendOverdueRemindersForOrg('org-1')
    expect(mail.sendOverdueReminder).not.toHaveBeenCalled()
    expect(prisma.invoiceEvent.create).not.toHaveBeenCalled()
  })

  it('skickar bara till de fakturor som inte redan påmints idag', async () => {
    const { service, mail } = makeService({
      invoices: [makeInvoice('1'), makeInvoice('2'), makeInvoice('3')],
      alreadySentIds: ['2'],
    })
    await service.sendOverdueRemindersForOrg('org-1')
    expect(mail.sendOverdueReminder).toHaveBeenCalledTimes(2)
    const sentNumbers = mail.sendOverdueReminder.mock.calls.map((c) => c[0].invoiceNumber)
    expect(sentNumbers).toEqual(['F-1', 'F-3'])
  })

  it('dedup-fönstret är dagen (findFirst frågar inom start/slut av dagen)', async () => {
    const { service, prisma } = makeService({ invoices: [makeInvoice('1')] })
    await service.sendOverdueRemindersForOrg('org-1')
    const where = prisma.invoiceEvent.findFirst.mock.calls[0]![0].where
    expect(where).toMatchObject({ invoiceId: '1', type: 'REMINDER_SENT' })
    expect(where.createdAt.gte).toBeInstanceOf(Date)
    expect(where.createdAt.lt).toBeInstanceOf(Date)
    // Exakt ett dygn mellan gte och lt.
    expect(where.createdAt.lt.getTime() - where.createdAt.gte.getTime()).toBe(24 * 60 * 60 * 1000)
  })

  it('faktura utan e-post hoppas över utan utskick eller event', async () => {
    const { service, prisma, mail } = makeService({ invoices: [makeInvoice('1', null)] })
    await service.sendOverdueRemindersForOrg('org-1')
    expect(mail.sendOverdueReminder).not.toHaveBeenCalled()
    expect(prisma.invoiceEvent.create).not.toHaveBeenCalled()
  })

  it('utskicksfel loggar men skapar inget REMINDER_SENT (fönstret förblir öppet)', async () => {
    const { service, prisma, mail } = makeService({ invoices: [makeInvoice('1')] })
    mail.sendOverdueReminder.mockRejectedValueOnce(new Error('SMTP nere'))
    await service.sendOverdueRemindersForOrg('org-1')
    expect(mail.sendOverdueReminder).toHaveBeenCalledTimes(1)
    expect(prisma.invoiceEvent.create).not.toHaveBeenCalled()
  })
})
