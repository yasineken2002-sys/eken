/**
 * N3: betalningsgrinden och den utgående bilagan måste använda samma läsning.
 * Riktig Postgres, worker, PdfService/mall, MailService/MailQueue och
 * status/historik. Bara Chromium, Bull och lagring ersätts med lokala fångare.
 * Browserfångaren returnerar HTML-bytes som provbilaga: detta mäter innehållet
 * till PDF-renderaren och hela vägen till det serialiserade mejljobbet, inte
 * Chromiums PDF-serialisering eller leverantörens leverans/idempotens.
 * Ingen sleep eller produktkrok; varje fall har egna DB-rader.
 */
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('puppeteer', () => ({ __esModule: true, default: { launch: jest.fn() } }))

import { randomUUID } from 'node:crypto'
import { PrismaClient, type InvoiceStatus } from '@prisma/client'
import puppeteer from 'puppeteer'
import { MailQueue } from '../mail/mail.queue'
import { MailService } from '../mail/mail.service'
import type { MailJobPayload } from '../mail/mail.types'
import { InvoiceEventsService } from './invoice-events.service'
import { InvoicesService } from './invoices.service'
import { PdfService } from './pdf.service'

const A = '5050-1055'
const B = '900-8004'
const INVALID = '1234-5678'
const BAD_TARGETS = [
  ['null', null, /saknas/],
  ['tomt', '', /saknas/],
  ['blankt', '   ', /saknas/],
  ['ogiltigt', INVALID, /kontrollsiffra/],
] as const

describe('N3 · fakturaworkerns betalningssnapshot', () => {
  let nextReadChange: { target: string | null } | undefined
  const prisma = new PrismaClient().$extends({
    query: {
      invoice: {
        async findFirst({ args, query }) {
          const snapshot = await query(args)
          const change = nextReadChange
          nextReadChange = undefined
          if (change) await setTarget(change.target)
          return snapshot
        },
      },
    },
  })
  let orgId: string
  let tenantId: string
  let service: InvoicesService
  let pdf: PdfService
  let afterPdf: (() => Promise<void>) | undefined
  const rendered: string[] = []
  const outgoing: MailJobPayload[] = []
  const queued: string[] = []
  const quiet = { log: () => undefined, warn: () => undefined, error: () => undefined }

  beforeAll(async () => {
    // Ingen describe.skip: frånvaro av DB får inte ge grönt.
    expect(process.env.DATABASE_URL).toBeTruthy()
    await prisma.$connect()
  })

  beforeEach(async () => {
    rendered.length = outgoing.length = queued.length = 0
    afterPdf = undefined
    nextReadChange = undefined
    const org = await prisma.organization.create({
      data: {
        name: 'N3 Syntetisk hyresvärd',
        email: 'n3@example.invalid',
        street: 'Provgatan 1',
        postalCode: '11111',
        city: 'Provstad',
        bankgiro: A,
        transactionalEmailsDisabled: false,
      },
    })
    orgId = org.id
    const tenant = await prisma.tenant.create({
      data: {
        organizationId: orgId,
        type: 'INDIVIDUAL',
        firstName: 'Alva',
        lastName: 'Provperson',
        email: 'n3-tenant@example.invalid',
        personalNumberHash: `n3-${randomUUID()}`,
      },
    })
    tenantId = tenant.id

    jest.mocked(puppeteer.launch).mockResolvedValue({
      connected: true,
      on: jest.fn(),
      close: jest.fn(),
      newPage: async () => {
        let html = ''
        return {
          setContent: async (value: string) => {
            html = value
            rendered.push(value)
          },
          pdf: async () => {
            const built = Buffer.from(html)
            await afterPdf?.()
            return built
          },
          close: async () => undefined,
        }
      },
    } as never)
    pdf = new PdfService(prisma as never, {} as never)
    Object.assign(pdf, { logger: quiet })
    const bull = {
      add: async (payload: MailJobPayload) => {
        outgoing.push(structuredClone(payload))
        return { id: 'local-n3-mail' }
      },
    }
    const mailQueue = new MailQueue(bull as never, bull as never, bull as never, prisma as never)
    Object.assign(mailQueue, { logger: quiet })
    service = new InvoicesService(
      prisma as never,
      new InvoiceEventsService(prisma as never),
      pdf,
      new MailService(mailQueue),
      {} as never,
      {} as never,
      {} as never,
      {
        enqueue: async (job: { invoiceId: string }) => {
          queued.push(job.invoiceId)
          return 'local-n3-pdf'
        },
      } as never,
    )
    Object.assign(service, { logger: quiet })
  })

  afterEach(async () => {
    jest.restoreAllMocks()
    await pdf?.onModuleDestroy()
    if (!orgId) return
    await prisma.invoiceEvent.deleteMany({ where: { invoice: { organizationId: orgId } } })
    await prisma.invoicePayment.deleteMany({ where: { invoice: { organizationId: orgId } } })
    await prisma.invoiceLine.deleteMany({ where: { invoice: { organizationId: orgId } } })
    await prisma.invoice.deleteMany({ where: { organizationId: orgId, isCreditNote: true } })
    await prisma.invoice.deleteMany({ where: { organizationId: orgId } })
    await prisma.tenant.deleteMany({ where: { organizationId: orgId } })
    await prisma.organization.delete({ where: { id: orgId } })
  })

  afterAll(async () => prisma.$disconnect())

  async function setTarget(bankgiro: string | null): Promise<void> {
    await prisma.organization.update({ where: { id: orgId }, data: { bankgiro } })
  }

  async function invoice(
    opts: {
      status?: InvoiceStatus
      total?: number
      creditOf?: string
      sendError?: string
    } = {},
  ) {
    const total = opts.total ?? 1000
    return prisma.invoice.create({
      data: {
        organizationId: orgId,
        tenantId,
        invoiceNumber: `N3-${randomUUID()}`,
        type: 'OTHER',
        status: opts.status ?? 'DRAFT',
        subtotal: total,
        vatTotal: 0,
        total,
        issueDate: new Date('2026-09-01T00:00:00Z'),
        dueDate: new Date('2040-01-31T00:00:00Z'),
        isCreditNote: Boolean(opts.creditOf),
        ...(opts.creditOf ? { creditedInvoiceId: opts.creditOf } : {}),
        ...(opts.sendError ? { sendError: opts.sendError } : {}),
        lines: {
          create: [{ description: 'N3 provrad', quantity: 1, unitPrice: total, vatRate: 0, total }],
        },
      },
    })
  }

  const state = (id: string) =>
    prisma.invoice.findUniqueOrThrow({
      where: { id },
      select: { status: true, sendError: true, total: true },
    })
  const events = (id: string) =>
    prisma.invoiceEvent.findMany({ where: { invoiceId: id }, orderBy: { createdAt: 'asc' } })
  const run = (id: string) => service.processInvoiceSendJob(id, orgId, 'n3-actor')

  /** Ändra DB efter den riktiga läsningen, men lämna dess snapshot orörd. */
  function changeAfterRead(target: string | null) {
    nextReadChange = { target }
  }

  function expectDocument(id: string, number: string, target: string) {
    // Kundeffekten först: exakt betalningsinstruktion i utgående bilaga.
    const attachment = outgoing[0]?.attachments?.[0]
    const body = Buffer.from(attachment?.contentBase64 ?? '', 'base64').toString()
    expect(body.replace(/<[^>]*>/g, ' ')).toMatch(new RegExp(`Bankgiro:?\\s+${target}`, 'i'))
    expect(body).toContain(number)
    expect(body).toContain('Alva Provperson')
    expect(body).toBe(rendered[0])
    expect(outgoing).toHaveLength(1)
    expect(outgoing[0]).toMatchObject({
      organizationId: orgId,
      to: 'n3-tenant@example.invalid',
      template: 'invoice-created',
      idempotencyKey: `invoice-send-${id}`,
      props: { invoiceNumber: number, organizationName: 'N3 Syntetisk hyresvärd' },
    })
    expect(attachment?.filename).toBe(`faktura-${number}.pdf`)
  }

  async function expectSent(id: string) {
    expect(await state(id)).toMatchObject({ status: 'SENT', sendError: null })
    expect((await events(id)).map((e) => e.type)).toEqual(['SENT'])
  }

  it('POSITIV: giltigt A bärs av dokument och mejl; sant SENT och tidigare fel rensas', async () => {
    const inv = await invoice({ sendError: 'Tidigare fel' })
    await service.sendInvoiceEmail(inv.id, orgId, 'n3-actor')
    expect(queued).toEqual([inv.id])
    await run(inv.id)
    expectDocument(inv.id, inv.invoiceNumber, A)
    await expectSent(inv.id)
  })

  it.each(BAD_TARGETS)(
    'omprövar %s efter köandet: ingen bilaga, DRAFT + SEND_FAILED',
    async (_name, target, reason) => {
      const inv = await invoice()
      await service.sendInvoiceEmail(inv.id, orgId, 'n3-actor')
      await setTarget(target)
      await run(inv.id)
      expect(outgoing).toEqual([])
      expect(rendered).toEqual([])
      expect(await state(inv.id)).toMatchObject({
        status: 'DRAFT',
        sendError: expect.stringMatching(reason),
      })
      const history = await events(inv.id)
      expect(history.map((e) => e.type)).toEqual(['SEND_FAILED'])
      expect(history[0]?.payload).toMatchObject({
        error: expect.stringContaining('Inställningar → Betalningsinformation'),
      })
    },
  )

  it.each(BAD_TARGETS)(
    '%s vid enqueue: synkront avslag utan utskick eller historik',
    async (_name, target, reason) => {
      const inv = await invoice({ status: 'SENT' })
      await setTarget(target)
      const before = await state(inv.id)
      await expect(service.sendInvoiceEmail(inv.id, orgId, 'n3-actor')).rejects.toMatchObject({
        status: 400,
        message: expect.stringMatching(reason),
      })
      expect(queued).toEqual([])
      expect(outgoing).toEqual([])
      expect(rendered).toEqual([])
      expect(await state(inv.id)).toEqual(before)
      expect(await events(inv.id)).toEqual([])
    },
  )

  it('giltigt A→B före workerstart: omprövar och skickar B', async () => {
    const inv = await invoice()
    await service.sendInvoiceEmail(inv.id, orgId, 'n3-actor')
    await setTarget(B)
    await run(inv.id)
    expectDocument(inv.id, inv.invoiceNumber, B)
    await expectSent(inv.id)
  })

  it.each([
    ['null', null],
    ['tomt', ''],
    ['blankt', '   '],
    ['ogiltigt', INVALID],
    ['giltigt B', B],
  ] as const)(
    'N3: A→%s efter workerläsningen: godkänt A i bilaga + SENT',
    async (_name, target) => {
      const inv = await invoice()
      changeAfterRead(target)
      await run(inv.id)
      expectDocument(inv.id, inv.invoiceNumber, A)
      await expectSent(inv.id)
      expect((await prisma.organization.findUniqueOrThrow({ where: { id: orgId } })).bankgiro).toBe(
        target,
      )
    },
  )

  it.each([null, B])(
    'efter färdigbyggt dokument: ändring till %s påverkar inte bilagan eller sant SENT',
    async (target) => {
      const inv = await invoice()
      afterPdf = async () => {
        await setTarget(target)
      }
      await run(inv.id)
      expectDocument(inv.id, inv.invoiceNumber, A)
      await expectSent(inv.id)
      expect((await prisma.organization.findUniqueOrThrow({ where: { id: orgId } })).bankgiro).toBe(
        target,
      )
    },
  )

  it.each(['SENT', 'OVERDUE'] as const)(
    'redan %s + saknat mål: gammalt SENT bevaras, nytt SEND_FAILED, inget mejl',
    async (status) => {
      const inv = await invoice({ status })
      const old = await prisma.invoiceEvent.create({
        data: { invoiceId: inv.id, type: 'SENT', actorType: 'SYSTEM', payload: { previous: true } },
      })
      await setTarget(null)
      await run(inv.id)
      expect(outgoing).toEqual([])
      expect(rendered).toEqual([])
      expect(await state(inv.id)).toMatchObject({
        status,
        sendError: expect.stringMatching(/saknas/),
      })
      const history = await events(inv.id)
      expect(history.map((e) => e.type)).toEqual(['SENT', 'SEND_FAILED'])
      expect(history[0]).toEqual(old)
    },
  )

  it('redan SENT + A→B efter läsning: A skickas och tidigare historik bevaras', async () => {
    const inv = await invoice({ status: 'SENT' })
    const old = await prisma.invoiceEvent.create({
      data: { invoiceId: inv.id, type: 'SENT', actorType: 'SYSTEM', payload: { previous: true } },
    })
    changeAfterRead(B)
    await run(inv.id)
    expectDocument(inv.id, inv.invoiceNumber, A)
    expect(await state(inv.id)).toMatchObject({ status: 'SENT', sendError: null })
    const history = await events(inv.id)
    expect(history.map((e) => e.type)).toEqual(['SENT', 'SENT'])
    expect(history[0]).toEqual(old)
  })

  it.each(['kreditnota', 'nollbelopp', 'fullbetald rest', 'fullkrediterad rest'] as const)(
    '%s undantas från målkravet',
    async (kind) => {
      const original = kind === 'kreditnota' ? await invoice({ status: 'SENT' }) : undefined
      const inv = await invoice({
        ...(original ? { creditOf: original.id } : {}),
        total: kind === 'nollbelopp' ? 0 : 1000,
      })
      if (kind === 'fullbetald rest') {
        await prisma.invoicePayment.create({
          data: {
            invoiceId: inv.id,
            amount: 1000,
            paidAt: new Date('2026-09-01T00:00:00Z'),
            source: 'MANUAL',
          },
        })
      }
      if (kind === 'fullkrediterad rest') await invoice({ creditOf: inv.id, status: 'SENT' })
      await setTarget(null)
      await run(inv.id)
      expectDocument(inv.id, inv.invoiceNumber, '–')
      await expectSent(inv.id)
    },
  )

  it.each(['VOID', 'PAID'] as const)('%s hoppas över utan ny historik', async (status) => {
    const inv = await invoice({ status })
    await run(inv.id)
    expect(outgoing).toEqual([])
    expect(rendered).toEqual([])
    expect(await state(inv.id)).toMatchObject({ status, sendError: null })
    expect(await events(inv.id)).toEqual([])
  })

  it('annan organisation får ingen faktura eller bilaga via worker eller PDF-nedladdning', async () => {
    const inv = await invoice()
    const before = await state(inv.id)
    const otherOrg = randomUUID()
    await expect(service.processInvoiceSendJob(inv.id, otherOrg, 'n3-actor')).rejects.toMatchObject(
      { status: 404 },
    )
    await expect(pdf.generateInvoicePdf(inv.id, otherOrg)).rejects.toMatchObject({ status: 404 })
    expect(outgoing).toEqual([])
    expect(rendered).toEqual([])
    expect(await state(inv.id)).toEqual(before)
    expect(await events(inv.id)).toEqual([])
  })
})
