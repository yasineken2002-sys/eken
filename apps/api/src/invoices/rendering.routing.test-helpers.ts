/**
 * r21-05: publika produktionsanropare, riktiga HTML-kärnor och riktig Chromium-PDF.
 * Endast DB, lagring, mejlkö och den injicerade dokumentklockan är syntetiska.
 * Ingen produktionskod importerar denna fil; anropas av renderer-kontraktets it.
 */
import type { Page } from 'puppeteer'
import { AviseringService } from '../avisering/avisering.service'
import { RentReminderService } from '../avisering/rent-reminder.service'
import { CollectionExportService } from '../collections/collection-export.service'
import { RentCollectionExportService } from '../collections/rent-collection-export.service'
import { testPersonalNumberService } from '../common/crypto/personal-number.testing'
import { PdfService } from './pdf.service'
import { renderingDigest, type PdfRenderingContext } from './rendering-context'
import {
  createRenderingFixtures,
  renderingFixtureAsOf,
  renderingFixtureLogo,
} from './rendering.test-fixtures'

export interface RenderingCallerObservation {
  caller: string
  fixtureId: string
  pdf: Buffer
  sha256: string
  context: PdfRenderingContext
  html?: string
}

// Avgränsar de ofullständiga externa testportarna; produktionsobjekten själva
// konstrueras normalt och inga renderingsmetoder ersätts med syntetisk utdata.
function externalPort<T>(value: unknown): T {
  return value as T
}

export async function runRenderingCallerProof(): Promise<RenderingCallerObservation[]> {
  const fixtures = createRenderingFixtures()
  const frozenInput = JSON.stringify(fixtures)
  const orgId = fixtures.organization.id
  const expectedAsOf = new Date(renderingFixtureAsOf).toISOString()
  const logoUrl = `data:${renderingFixtureLogo.mediaType};base64,${renderingFixtureLogo.base64}`
  let invoice = fixtures.invoiceCases[0]!.document
  let notice = fixtures.noticeCases[0]!.document
  const order: string[] = []
  const uploads: Array<{ bytes: Buffer; key: string; mediaType: string }> = []
  const storage = {
    getFileBuffer: jest.fn(async (key: string) => {
      expect(key).toBe(renderingFixtureLogo.storageKey)
      order.push('logo')
      return Buffer.from(renderingFixtureLogo.base64, 'base64')
    }),
    uploadFile: jest.fn(async (bytes: Buffer, key: string, mediaType: string) => {
      uploads.push({ bytes: Buffer.from(bytes), key, mediaType })
      return `https://storage.example.test/${key}`
    }),
  }
  const tx = {
    invoice: {
      updateMany: jest.fn(async () => {
        order.push('claim')
        return { count: 1 }
      }),
    },
    invoiceEvent: {
      create: jest.fn(async () => {
        order.push('claim-event')
        return { id: 'synthetic-invoice-event' }
      }),
    },
  }
  const prisma = {
    invoice: {
      findFirst: jest.fn(async (query: unknown) => {
        expect(query).toMatchObject({ where: { id: invoice.id, organizationId: orgId } })
        return invoice
      }),
      update: jest.fn(async () => ({})),
    },
    organization: { findUnique: jest.fn(async () => fixtures.organization) },
    rentNotice: {
      findFirst: jest.fn(async (query: unknown) => {
        expect(query).toMatchObject({ where: { id: notice.id, organizationId: orgId } })
        return notice
      }),
      update: jest.fn(async () => ({})),
    },
    rentNoticeEvent: {
      findFirst: jest.fn(async () => null),
      create: jest.fn(async () => ({ id: 'synthetic-notice-event' })),
    },
    rentNoticeSend: {
      findFirst: jest.fn(async () => null),
      create: jest.fn(async () => ({ id: 'synthetic-reminder-send' })),
      update: jest.fn(async () => ({})),
    },
    rentNoticePayment: { findFirst: jest.fn(async () => null) },
    $transaction: jest.fn(async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx)),
  }
  const unexpected = new Proxy(
    {},
    {
      get: (_target, property) => {
        throw new Error(`Unexpected external port in renderer routing proof: ${String(property)}`)
      },
    },
  )
  const pdf = new PdfService(externalPort(prisma), externalPort(storage))
  const avisering = new AviseringService(
    externalPort(prisma),
    externalPort(unexpected),
    externalPort(unexpected),
    pdf,
    externalPort(storage),
    externalPort(unexpected),
    externalPort(unexpected),
    externalPort(unexpected),
    externalPort(unexpected),
    externalPort(unexpected),
    externalPort(unexpected),
  )
  const mail = {
    sendRentNoticeReminder: jest.fn(
      async (_options: { to: string; pdfBuffer: Buffer }) => 'synthetic-reminder-job',
    ),
  }
  const noticeEvents = { record: jest.fn(async (..._args: unknown[]) => ({})) }
  const reminder = new RentReminderService(
    externalPort(prisma),
    externalPort(unexpected),
    externalPort(noticeEvents),
    externalPort(unexpected),
    externalPort(unexpected),
    externalPort(mail),
    pdf,
    externalPort(storage),
    externalPort(unexpected),
    externalPort(unexpected),
    externalPort(unexpected),
    externalPort(unexpected),
  )
  const pn = testPersonalNumberService()
  const collection = new CollectionExportService(
    externalPort(prisma),
    pn,
    pdf,
    externalPort(storage),
    externalPort(unexpected),
  )
  const rentDebt = {
    outstanding: jest.fn(async () => ({ outstanding: 9163.56, interestOnlyAfterCredit: false })),
  }
  const rentCollection = new RentCollectionExportService(
    externalPort(prisma),
    pn,
    pdf,
    externalPort(storage),
    externalPort(unexpected),
    externalPort(rentDebt),
  )
  const contexts: PdfRenderingContext[] = []
  const createContext = pdf.createRenderingContext.bind(pdf)
  const contextSpy = jest
    .spyOn(pdf, 'createRenderingContext')
    .mockImplementation(async (_callerClock, logo) => {
      order.push('context')
      const context = await createContext(new Date(renderingFixtureAsOf), logo)
      contexts.push(context)
      return context
    })
  const collectSpy = jest.spyOn(pdf, 'collectRenderingContext')
  const invoiceSpy = jest.spyOn(pdf, 'renderInvoice')
  const pdfHtmlSpy = jest.spyOn(pdf, 'generateFromHtml')
  // Read-only access to the real final PDF boundary, including invoice's
  // different page margins. spyOn calls through to the existing implementation.
  const pageBoundary = pdf as unknown as {
    withPage: (
      fn: (page: Page) => Promise<unknown>,
      context?: PdfRenderingContext,
    ) => Promise<unknown>
  }
  const pageSpy = jest.spyOn(pageBoundary, 'withPage')
  const noticeSpy = jest.spyOn(AviseringService, 'buildNoticePdfHtml')
  const reminderSpy = jest.spyOn(RentReminderService, 'buildReminderPdfHtml')
  const collectionSpy = jest.spyOn(CollectionExportService, 'buildPdfHtml')
  const rentCollectionSpy = jest.spyOn(RentCollectionExportService, 'buildPdfHtml')
  const spies = [
    contextSpy,
    collectSpy,
    invoiceSpy,
    pdfHtmlSpy,
    pageSpy,
    noticeSpy,
    reminderSpy,
    collectionSpy,
    rentCollectionSpy,
  ]
  const observations: RenderingCallerObservation[] = []

  function beginCase(): void {
    for (const spy of spies) spy.mockClear()
    storage.getFileBuffer.mockClear()
    storage.uploadFile.mockClear()
    contexts.length = 0
    uploads.length = 0
    order.length = 0
  }

  function observe(caller: string, fixtureId: string, bytes: Buffer, html?: string) {
    const context = contexts[0]
    expect(context).toBeDefined()
    if (!context) throw new Error(`Missing rendering context: ${caller}`)
    expect(context.asOf).toBe(expectedAsOf)
    expect(context.logo).toEqual({ dataUrl: logoUrl, digest: renderingDigest(logoUrl) })
    expect(context.environment).toMatch(/^[a-f0-9]{64}$/)
    expect(contextSpy).toHaveBeenCalledWith(expect.any(Date), logoUrl)
    expect(contexts.every((item) => item.asOf === expectedAsOf)).toBe(true)
    expect(storage.getFileBuffer).toHaveBeenCalledTimes(1)
    expect(pageSpy).toHaveBeenCalledTimes(1)
    expect(pageSpy.mock.calls[0]![1]).toBe(context)
    expect(bytes.subarray(0, 8).toString('ascii')).toBe('%PDF-1.4')
    expect(bytes.length).toBeGreaterThan(1000)
    expect(bytes.toString('latin1')).toContain("/CreationDate (D:20260911120000+00'00')")
    expect(bytes.toString('latin1')).toContain("/ModDate (D:20260911120000+00'00')")
    observations.push({
      caller,
      fixtureId,
      pdf: bytes,
      sha256: renderingDigest(bytes),
      context,
      ...(html === undefined ? {} : { html }),
    })
  }

  async function observeHtml(
    caller: string,
    fixtureId: string,
    document: object,
    core: {
      mock: {
        calls: ReadonlyArray<ReadonlyArray<unknown>>
        results: ReadonlyArray<{ value: unknown }>
      }
    },
    contextIndex: number,
    bytes: Buffer,
  ): Promise<void> {
    expect(core).toHaveBeenCalledTimes(1)
    expect(core.mock.calls[0]![0]).toBe(document)
    expect(core.mock.calls[0]![contextIndex]).toBe(contexts[0])
    const html = core.mock.results[0]!.value
    expect(typeof html).toBe('string')
    if (typeof html !== 'string') throw new Error(`Core did not return HTML: ${caller}`)
    expect(collectSpy).toHaveBeenCalledTimes(1)
    expect(collectSpy).toHaveBeenCalledWith(renderingFixtureLogo.storageKey)
    expect(pdfHtmlSpy).toHaveBeenCalledTimes(1)
    expect(pdfHtmlSpy).toHaveBeenCalledWith(html, contexts[0])
    expect(pdfHtmlSpy.mock.calls[0]![1]).toBe(contexts[0])
    expect(bytes).toEqual(await pdfHtmlSpy.mock.results[0]!.value)
    expect(html).toContain(fixtures.organization.name)
    observe(caller, fixtureId, bytes, html)
  }

  function uploadedPdf(): Buffer {
    const documents = uploads.filter((item) => item.mediaType === 'application/pdf')
    expect(documents).toHaveLength(1)
    const document = documents[0]
    if (!document) throw new Error('Public caller did not upload a PDF')
    return document.bytes
  }

  try {
    beginCase()
    const invoiceBytes = await pdf.generateInvoicePdf(invoice.id, orgId)
    expect(invoiceSpy).toHaveBeenCalledTimes(1)
    expect(invoiceSpy.mock.calls[0]![0].invoice.invoiceNumber).toBe(invoice.invoiceNumber)
    expect(invoiceSpy.mock.calls[0]![0].invoice.lines).toEqual(invoice.lines)
    expect(invoiceSpy.mock.calls[0]![1]).toBe(contexts[0])
    expect(await invoiceSpy.mock.results[0]!.value).toBe(invoiceBytes)
    expect(collectSpy).not.toHaveBeenCalled()
    observe('PdfService.generateInvoicePdf', fixtures.invoiceCases[0]!.id, invoiceBytes)

    beginCase()
    const noticeBytes = await avisering.getNoticePdfBuffer(notice.id, orgId)
    await observeHtml(
      'AviseringService.getNoticePdfBuffer',
      fixtures.noticeCases[0]!.id,
      notice,
      noticeSpy,
      2,
      noticeBytes,
    )

    beginCase()
    notice = fixtures.reminderCases[0]!.document
    await reminder.processReminderSendJob(orgId, notice.id)
    const reminderBytes = uploadedPdf()
    await observeHtml(
      'RentReminderService.processReminderSendJob',
      fixtures.reminderCases[0]!.id,
      notice,
      reminderSpy,
      2,
      reminderBytes,
    )
    expect(mail.sendRentNoticeReminder).toHaveBeenCalledTimes(1)
    expect(mail.sendRentNoticeReminder.mock.calls[0]![0].pdfBuffer).toEqual(reminderBytes)
    expect(mail.sendRentNoticeReminder.mock.calls[0]![0].to).toBe(notice.tenant.email)
    expect(noticeEvents.record).toHaveBeenCalledWith(
      notice.id,
      'SENT',
      'SYSTEM',
      null,
      { channel: 'EMAIL', jobId: 'synthetic-reminder-job' },
      { sendId: 'synthetic-reminder-send' },
    )

    beginCase()
    invoice = fixtures.invoiceCollectionCases[0]!.document
    const invoiceExport = await collection.exportForInvoice(invoice.id, orgId)
    await observeHtml(
      'CollectionExportService.exportForInvoice',
      fixtures.invoiceCollectionCases[0]!.id,
      invoice,
      collectionSpy,
      1,
      uploadedPdf(),
    )
    expect(collectionSpy.mock.calls[0]![2]).toBeNull()
    expect(tx.invoice.updateMany).toHaveBeenCalledTimes(1)
    expect(tx.invoiceEvent.create).toHaveBeenCalledTimes(1)
    expect(order.indexOf('claim')).toBeLessThan(order.indexOf('context'))
    expect(order.indexOf('claim-event')).toBeLessThan(order.indexOf('context'))
    expect(uploads.map((item) => item.key)).toEqual([invoiceExport.pdfKey, invoiceExport.csvKey])

    beginCase()
    notice = fixtures.rentCollectionCases[0]!.document
    const noticeExport = await rentCollection.exportForNotice(notice.id, orgId)
    await observeHtml(
      'RentCollectionExportService.exportForNotice',
      fixtures.rentCollectionCases[0]!.id,
      notice,
      rentCollectionSpy,
      1,
      uploadedPdf(),
    )
    expect(rentCollectionSpy.mock.calls[0]![2]).toBeNull()
    expect(rentDebt.outstanding).toHaveBeenCalledWith(notice.id, orgId)
    expect(prisma.rentNoticeEvent.create).toHaveBeenCalledTimes(1)
    expect(uploads.map((item) => item.key)).toEqual([noticeExport.pdfKey, noticeExport.csvKey])

    expect(observations.map((item) => item.caller)).toEqual([
      'PdfService.generateInvoicePdf',
      'AviseringService.getNoticePdfBuffer',
      'RentReminderService.processReminderSendJob',
      'CollectionExportService.exportForInvoice',
      'RentCollectionExportService.exportForNotice',
    ])
    expect(JSON.stringify(fixtures)).toBe(frozenInput)
    return observations
  } finally {
    for (const spy of [...spies].reverse()) spy.mockRestore()
    await pdf.onModuleDestroy()
  }
}
