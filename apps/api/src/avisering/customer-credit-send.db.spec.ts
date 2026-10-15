/** Verklig databas/bokföring och tjänstekedja; PDF, Redis och mejlleverantör är lokala dubbelgångare. */
// Jest kör CommonJS; React Emails dynamiska ESM-renderare är en separat adapter.
// Den riktiga React-mallen renderas här med ReactDOMServer, utan extern tjänst.
jest.mock('@react-email/render', () => ({
  render: async (
    element: Parameters<typeof import('react-dom/server').renderToStaticMarkup>[0],
  ) => {
    const renderer = jest.requireActual<typeof import('react-dom/server')>('react-dom/server')
    return renderer.renderToStaticMarkup(element)
  },
}))
jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))

import { ConfigService } from '@nestjs/config'
import type { ModuleRef } from '@nestjs/core'
import type { Job, JobOptions, Queue } from 'bull'
import { PrismaService } from '../common/prisma/prisma.service'
import { runWithActor } from '../common/actor/actor.context'
import { rentNoticeOutstanding } from './rent-debt.service'
import {
  fixture,
  receive,
  services,
  isIsolatedDatabase,
} from '../customer-credit/customer-credit-dispatch.test-fixtures'
import { MailQueue } from '../mail/mail.queue'
import { MailRenderer } from '../mail/mail.renderer'
import { MailService } from '../mail/mail.service'
import { MailWorkerNormal } from '../mail/mail.worker'
import type { MailJobPayload } from '../mail/mail.types'
import { PdfWorker } from '../pdf-jobs/pdf.worker'
import type { PdfJobPayload } from '../pdf-jobs/pdf.types'
import { AviseringService } from './avisering.service'
import { RentNoticeEventsService } from './rent-notice-events.service'
import { RentNoticeCreditService } from './rent-notice-credit.service'
import { readPreparedNoticeMail } from './notice-dispatch'

jest.setTimeout(30_000)
const ISOLATED = isIsolatedDatabase()
const medDb = ISOLATED ? describe : describe.skip

// Körs även när DB-sviten skulle hoppas över. Saknad isolerad databas får
// aldrig ge en grön mätning utan att affärsfallen faktiskt har körts.
it('testförutsättningen är en uttryckligt isolerad databas', () => {
  expect(ISOLATED).toBe(true)
})

function unused<T>(): T {
  return new Proxy(
    {},
    {
      get: (_, key) => {
        throw new Error(`Oväntat beroende ${String(key)}`)
      },
    },
  ) as T
}

type ProviderMail = {
  from: string
  to: string
  subject: string
  html: string
  text: string
  attachments: Array<{ filename: string; content: Buffer }>
}

function rig(prisma: PrismaService) {
  const jobs = new Map<string, MailJobPayload>()
  const add = jest.fn(async (payload: MailJobPayload, options: JobOptions) => {
    const id = String(options.jobId)
    if (!jobs.has(id)) jobs.set(id, payload)
    return { id }
  })
  const queue = { add, getJob: async () => undefined } as unknown as Queue<MailJobPayload>
  const config = new ConfigService({
    RESEND_API_KEY: 'local-test-only',
    MAIL_FROM: 'Test <no-reply@example.invalid>',
  })
  const renderer = new MailRenderer()
  const mail = new MailService(new MailQueue(queue, queue, queue, prisma), renderer, config)
  const pdf = { generateFromHtml: jest.fn(async (html: string) => Buffer.from(html)) }
  const core = services(prisma)
  const events = new RentNoticeEventsService(prisma)
  const avisering = new AviseringService(
    prisma,
    unused(),
    mail,
    pdf as unknown as ConstructorParameters<typeof AviseringService>[3],
    unused(),
    unused(),
    core.accounting,
    unused(),
    unused(),
    unused(),
    events,
    core.credit,
  )
  const pdfWorker = new PdfWorker({ get: () => avisering } as unknown as ModuleRef)
  const worker = new MailWorkerNormal(renderer, prisma, config, events)
  const deliveries = new Map<string, { mail: ProviderMail; id: string }>()
  let timeoutAfterAccept = false
  const send = jest.fn(async (content: ProviderMail, options: { idempotencyKey: string }) => {
    const key = options.idempotencyKey
    const existing = deliveries.get(key)
    if (existing) expect(content).toEqual(existing.mail)
    const accepted = existing ?? { mail: content, id: `provider-${key}` }
    deliveries.set(key, accepted)
    if (timeoutAfterAccept) {
      timeoutAfterAccept = false
      throw new Error('Simulerad timeout efter accepterat mejl')
    }
    return { data: { id: accepted.id }, error: null }
  })
  Object.defineProperty(worker, 'resend', { value: { emails: { send } } })
  const prepare = (organizationId: string, noticeId: string) =>
    pdfWorker.handle({
      data: { kind: 'avisering-send', organizationId, noticeId },
      id: noticeId,
      attemptsMade: 0,
    } as unknown as Job<PdfJobPayload>)
  const consume = (payload: MailJobPayload) =>
    worker.handle({
      data: payload,
      id: payload.idempotencyKey,
      attemptsMade: 0,
      queue: { name: 'local-only' },
    } as unknown as Job<MailJobPayload>)
  const onlyJob = () => {
    expect(jobs.size).toBe(1)
    return [...jobs.values()][0]!
  }
  return {
    core,
    avisering,
    pdf,
    add,
    jobs,
    deliveries,
    send,
    prepare,
    consume,
    onlyJob,
    timeoutOnce: () => {
      timeoutAfterAccept = true
    },
  }
}

medDb('kundtillgodo genom PDF-worker, fryst avi, mejlkö och leverantörskvitto', () => {
  const prisma = new PrismaService()
  beforeAll(() => prisma.$connect())
  afterAll(() => prisma.$disconnect())
  afterEach(() => jest.restoreAllMocks())

  async function customer(targetAmount = '1000.00', withCredit = true) {
    const f = await fixture(prisma, { targetAmount })
    await prisma.organization.update({
      where: { id: f.organizationId },
      data: { bankgiro: '5050-1055' },
    })
    if (withCredit) await receive(prisma, f)
    return f
  }

  it.each(['SUSPENDED', 'CANCELLED'] as const)(
    '%s organisation efter köning får inget ekonomiskt tillgodoavdrag',
    async (status) => {
      const f = await customer('25.00')
      const r = rig(prisma)
      const financialState = async () =>
        JSON.stringify(
          await Promise.all([
            prisma.customerCreditApplication.findMany({
              where: { organizationId: f.organizationId },
              orderBy: { id: 'asc' },
            }),
            prisma.rentNoticePayment.findMany({
              where: { rentNotice: { organizationId: f.organizationId } },
              orderBy: { id: 'asc' },
            }),
            prisma.journalEntry.findMany({
              where: { organizationId: f.organizationId },
              orderBy: { id: 'asc' },
              include: { lines: { orderBy: { id: 'asc' } } },
            }),
            prisma.journalEntrySequence.findMany({
              where: { organizationId: f.organizationId },
              orderBy: [{ series: 'asc' }, { fiscalYear: 'asc' }],
            }),
          ]),
        )
      const before = await financialState()
      await prisma.organization.update({ where: { id: f.organizationId }, data: { status } })
      await expect(r.prepare(f.organizationId, f.target.id)).rejects.toThrow(
        'utskicksinställningar',
      )
      expect(await financialState()).toBe(before)
      expect(await r.core.credit.findPreparedNotice(f.organizationId, f.target.id)).toBeNull()
      const notice = await prisma.rentNotice.findUniqueOrThrow({ where: { id: f.target.id } })
      expect(notice.status).not.toBe('PAID')
      expect(Number(notice.paidAmount ?? 0)).toBe(0)
      expect(r.jobs.size).toBe(0)
      expect(r.send).not.toHaveBeenCalled()
    },
  )

  it('25 kr används en gång och 975 kr följer PDF, OCR, mejl och leveranskvittot', async () => {
    const f = await customer()
    const r = rig(prisma)
    await r.prepare(f.organizationId, f.target.id)
    const before = await prisma.rentNotice.findUniqueOrThrow({ where: { id: f.target.id } })
    expect(before.status).toBe('PENDING')
    expect(before.sentAt).toBeNull()
    const dispatch = await r.core.credit.findPreparedNotice(f.organizationId, f.target.id)
    expect(dispatch).not.toBeNull()
    expect(dispatch!.payableAmount?.toFixed(2)).toBe('975.00')
    expect(dispatch!.customerCreditAmount?.toFixed(2)).toBe('25.00')
    const mail = readPreparedNoticeMail(dispatch!, f.organizationId)
    const html = Buffer.from(mail.attachments[0]!.contentBase64, 'base64').toString()
    expect(html).toContain('Tillgodo använt:')
    expect(html).toContain('# 1234567890 # 975 00 ')
    expect(mail.html).toMatch(/>975\s+kr</)
    await r.consume(r.onlyJob())
    await r.prepare(f.organizationId, f.target.id)
    await r.consume(r.onlyJob())
    expect(r.send).toHaveBeenCalledTimes(1)
    expect(r.deliveries.size).toBe(1)
    expect(
      await prisma.customerCreditApplication.count({ where: { rentNoticeId: f.target.id } }),
    ).toBe(1)
    const applied = await prisma.customerCreditApplication.findFirstOrThrow({
      where: { rentNoticeId: f.target.id },
    })
    expect(applied.actorKind).toBe('SYSTEM')
    const after = await prisma.rentNotice.findUniqueOrThrow({ where: { id: f.target.id } })
    expect(after.status).toBe('SENT')
    expect(after.sentAt).not.toBeNull()
    expect(after.noticeMessageId).toBe(`provider-rent-notice-send-${dispatch!.id}`)
    expect(await r.avisering.getNoticePdfBuffer(f.target.id, f.organizationId)).toEqual(
      Buffer.from(html),
    )
  })

  it('full täckning skickar information med 0 kr, ingen betalningskupong och behåller PAID', async () => {
    const f = await customer('25.00')
    const r = rig(prisma)
    await r.prepare(f.organizationId, f.target.id)
    const html = r.pdf.generateFromHtml.mock.calls[0]![0]
    expect(html).toContain('Inget återstår att betala')
    expect(html).not.toContain('Avrivningskupong')
    expect(html).not.toContain('Dröjsmål debiteras')
    expect(html).not.toContain('ange alltid vid betalning')
    await r.consume(r.onlyJob())
    const delivered = [...r.deliveries.values()][0]!.mail
    expect(delivered.html).toContain('Inget återstår att betala')
    expect(delivered.html).not.toContain('Ange OCR-numret vid betalning')
    const notice = await prisma.rentNotice.findUniqueOrThrow({ where: { id: f.target.id } })
    expect(notice.status).toBe('PAID')
    expect(notice.sentAt).not.toBeNull()
    expect(notice.paidAmount?.toFixed(2)).toBe('25.00')
  })

  it('renderingsfel efter full avräkning kan försöka igen utan nytt tillgodo', async () => {
    const f = await customer('25.00')
    const r = rig(prisma)
    r.pdf.generateFromHtml.mockRejectedValueOnce(new Error('Syntetiskt PDF-fel'))
    await expect(r.prepare(f.organizationId, f.target.id)).rejects.toThrow('Syntetiskt PDF-fel')
    expect(r.jobs.size).toBe(0)
    expect((await prisma.rentNotice.findUniqueOrThrow({ where: { id: f.target.id } })).status).toBe(
      'PAID',
    )
    await r.prepare(f.organizationId, f.target.id)
    await r.consume(r.onlyJob())
    expect(
      await prisma.customerCreditApplication.count({ where: { rentNoticeId: f.target.id } }),
    ).toBe(1)
    expect(r.deliveries.size).toBe(1)
  })

  it('köfel återanvänder exakt samma PDF, mottagare och mejl trots ändrade kunduppgifter', async () => {
    const f = await customer()
    const r = rig(prisma)
    r.add.mockRejectedValueOnce(new Error('Syntetiskt Redis-fel'))
    await expect(r.prepare(f.organizationId, f.target.id)).rejects.toThrow('Syntetiskt Redis-fel')
    const first = await r.core.credit.findPreparedNotice(f.organizationId, f.target.id)
    await prisma.tenant.update({
      where: { id: f.tenantId },
      data: { email: 'changed@example.invalid', firstName: 'Ändrad' },
    })
    await prisma.organization.update({
      where: { id: f.organizationId },
      data: { name: 'Ändrat namn' },
    })
    await r.prepare(f.organizationId, f.target.id)
    const second = await r.core.credit.findPreparedNotice(f.organizationId, f.target.id)
    expect(second!.mailPayload).toEqual(first!.mailPayload)
    expect(r.pdf.generateFromHtml).toHaveBeenCalledTimes(1)
    await r.consume(r.onlyJob())
    expect([...r.deliveries.values()][0]!.mail.to).not.toBe('changed@example.invalid')
  })

  it('timeout efter accepterat mejl använder samma leverantörsnyckel och en faktisk leverans', async () => {
    const f = await customer()
    const r = rig(prisma)
    await r.prepare(f.organizationId, f.target.id)
    r.timeoutOnce()
    await expect(r.consume(r.onlyJob())).rejects.toThrow('timeout')
    expect(
      (await r.core.credit.findPreparedNotice(f.organizationId, f.target.id))!.acceptedAt,
    ).toBeNull()
    await r.consume(r.onlyJob())
    expect(r.send).toHaveBeenCalledTimes(2)
    expect(r.deliveries.size).toBe(1)
    expect(
      (await r.core.credit.findPreparedNotice(f.organizationId, f.target.id))!.acceptedAt,
    ).not.toBeNull()
  })

  it('DB-fel efter leverantörens accept återhämtar samma kvitto och skriver leveransstatus atomiskt', async () => {
    const f = await customer()
    const r = rig(prisma)
    await r.prepare(f.organizationId, f.target.id)
    const send = await r.core.credit.findPreparedNotice(f.organizationId, f.target.id)
    // Unikt messageId hindrar just DB-kvittot efter ett lyckat leverantörsanrop.
    const collision = await prisma.rentNoticeSend.create({
      data: {
        rentNoticeId: f.source.id,
        kind: 'NOTICE',
        messageId: `provider-rent-notice-send-${send!.id}`,
      },
    })
    await expect(r.consume(r.onlyJob())).rejects.toThrow()
    expect(r.deliveries.size).toBe(1)
    expect(
      (await r.core.credit.findPreparedNotice(f.organizationId, f.target.id))!.acceptedAt,
    ).toBeNull()
    expect(
      (await prisma.rentNotice.findUniqueOrThrow({ where: { id: f.target.id } })).sentAt,
    ).toBeNull()
    // Endast det syntetiska kollisionshindret raderas; ingen ekonomisk rad ändras.
    await prisma.rentNoticeSend.delete({ where: { id: collision.id } })
    await r.consume(r.onlyJob())
    expect(r.send).toHaveBeenCalledTimes(2)
    expect(r.deliveries.size).toBe(1)
    expect(
      (await r.core.credit.findPreparedNotice(f.organizationId, f.target.id))!.acceptedAt,
    ).not.toBeNull()
  })

  it('senare delbetalning sänker aktuellt saldo utan att skriva om den fastställda avin', async () => {
    const f = await customer()
    const r = rig(prisma)
    await r.prepare(f.organizationId, f.target.id)
    const original = await r.core.credit.findPreparedNotice(f.organizationId, f.target.id)
    await runWithActor('SYSTEM', () =>
      r.avisering.markAsPaid(f.target.id, f.organizationId, 500, 'BANK'),
    )
    const current = await prisma.rentNotice.findUniqueOrThrow({
      where: { id: f.target.id },
      include: { payments: true, credits: true },
    })
    expect(rentNoticeOutstanding(current).payable).toBe(475)
    expect(current.status).not.toBe('PAID')
    await r.consume(r.onlyJob())
    const saved = await r.core.credit.findPreparedNotice(f.organizationId, f.target.id)
    expect(saved!.mailPayload).toEqual(original!.mailPayload)
    expect(saved!.payableAmount?.toFixed(2)).toBe('975.00')
    expect([...r.deliveries.values()][0]!.mail.html).toContain(
      'aktuellt kvarvarande belopp i hyresgästportalen',
    )
    expect(r.send).toHaveBeenCalledTimes(1)
  })

  it('bank/manuell betalning efter köning stoppar ett ännu opåbörjat betalningsmejl', async () => {
    const f = await customer()
    const r = rig(prisma)
    await r.prepare(f.organizationId, f.target.id)
    // Belägg konsumtionsgrinden: betalningsallokeringen prövas i de separata bokföringsproven.
    await prisma.rentNotice.update({ where: { id: f.target.id }, data: { status: 'PAID' } })
    await r.consume(r.onlyJob())
    expect(r.send).not.toHaveBeenCalled()
    expect(
      (await r.core.credit.findPreparedNotice(f.organizationId, f.target.id))!.dispatchStartedAt,
    ).toBeNull()
  })

  it('anonymisering efter köning återanvänder aldrig den sparade gamla adressen', async () => {
    const f = await customer('25.00')
    const r = rig(prisma)
    await r.prepare(f.organizationId, f.target.id)
    await prisma.tenant.update({
      where: { id: f.tenantId },
      data: { anonymizedAt: new Date(), email: 'gdpr@example.invalid' },
    })
    await r.consume(r.onlyJob())
    expect(r.send).not.toHaveBeenCalled()
  })

  it('en annan organisations jobb kan inte använda utskicks-id:t', async () => {
    const f = await customer()
    const other = await customer()
    const r = rig(prisma)
    await r.prepare(f.organizationId, f.target.id)
    await expect(
      r.consume({ ...r.onlyJob(), organizationId: other.organizationId }),
    ).rejects.toThrow('reservation saknas')
    expect(r.send).not.toHaveBeenCalled()
  })

  it('okänt leveransutfall efter 23h stoppar ett nytt leverantörsanrop', async () => {
    const f = await customer()
    const r = rig(prisma)
    await r.prepare(f.organizationId, f.target.id)
    r.timeoutOnce()
    await expect(r.consume(r.onlyJob())).rejects.toThrow('timeout')
    const now = Date.now()
    jest.spyOn(Date, 'now').mockReturnValue(now + 24 * 60 * 60 * 1000)
    await expect(r.consume(r.onlyJob())).rejects.toThrow('omförsöksfönstret')
    expect(r.send).toHaveBeenCalledTimes(1)
    expect(r.deliveries.size).toBe(1)
  })

  it.each(['PAID', 'suppressed'] as const)(
    'okänt accepterat utskick blir ett uttryckligt fel efter %s, utan nytt betalningsmejl',
    async (change) => {
      const f = await customer()
      const r = rig(prisma)
      await r.prepare(f.organizationId, f.target.id)
      r.timeoutOnce()
      await expect(r.consume(r.onlyJob())).rejects.toThrow('timeout')
      if (change === 'PAID')
        await prisma.rentNotice.update({ where: { id: f.target.id }, data: { status: 'PAID' } })
      else
        await prisma.organization.update({
          where: { id: f.organizationId },
          data: { transactionalEmailsDisabled: true },
        })
      await expect(r.consume(r.onlyJob())).rejects.toThrow('Okänt leveransutfall')
      expect(r.send).toHaveBeenCalledTimes(1)
      expect(r.deliveries.size).toBe(1)
    },
  )

  it.each([false, true])(
    'läser om strypventilen efter avilåset även om förkontrollen var gammal (påbörjat=%s)',
    async (started) => {
      const f = await customer()
      const r = rig(prisma)
      await r.prepare(f.organizationId, f.target.id)
      if (started) {
        r.timeoutOnce()
        await expect(r.consume(r.onlyJob())).rejects.toThrow('Simulerad timeout')
      }
      const oldOrg = await prisma.organization.findUniqueOrThrow({
        where: { id: f.organizationId },
      })
      await prisma.organization.update({
        where: { id: f.organizationId },
        data: { transactionalEmailsDisabled: true },
      })
      // Representerar en förkontroll gjord före flaggbytet/låsväntan.
      // Återläsningen i arbetets verkliga DB-transaktion får inget substitut.
      jest.spyOn(prisma.organization, 'findUnique').mockResolvedValueOnce(oldOrg)
      if (started) await expect(r.consume(r.onlyJob())).rejects.toThrow('Okänt leveransutfall')
      else await r.consume(r.onlyJob())
      expect(r.send).toHaveBeenCalledTimes(started ? 1 : 0)
      const dispatch = await r.core.credit.findPreparedNotice(f.organizationId, f.target.id)
      expect(dispatch!.acceptedAt).toBeNull()
    },
  )

  it('två samtidiga PDF-jobb köar den sparade vinnaren även när PDF-byten skiljer sig', async () => {
    const f = await customer()
    const r = rig(prisma)
    let entered = 0
    let release!: () => void
    const both = new Promise<void>((resolve) => {
      release = resolve
    })
    r.pdf.generateFromHtml.mockImplementation(async (html) => {
      const version = ++entered
      if (entered === 2) release()
      await both
      return Buffer.from(`${html}<!-- PDF ${version} -->`)
    })
    await Promise.all([
      r.prepare(f.organizationId, f.target.id),
      r.prepare(f.organizationId, f.target.id),
    ])
    expect(entered).toBe(2)
    expect(r.add.mock.calls[0]![0].attachments).toEqual(r.add.mock.calls[1]![0].attachments)
    expect(
      await prisma.customerCreditApplication.count({ where: { rentNoticeId: f.target.id } }),
    ).toBe(1)
    await r.consume(r.onlyJob())
    expect(r.deliveries.size).toBe(1)
  })

  it('kreditnota kan inte ändra en fastställd men ännu inte levererad avi även vid tillgodo0', async () => {
    const f = await customer('1000.00', false)
    const r = rig(prisma)
    await r.prepare(f.organizationId, f.target.id)
    const service = new RentNoticeCreditService(prisma, unused(), unused())
    await expect(
      service.createCredit(f.target.id, f.organizationId, 'unused-actor', {
        lines: [{ amount: 500 }],
        reason: 'Syntetiskt motprov',
      }),
    ).rejects.toThrow('fastställda utskick')
    expect(await prisma.rentNoticeCredit.count({ where: { rentNoticeId: f.target.id } })).toBe(0)
  })
})
