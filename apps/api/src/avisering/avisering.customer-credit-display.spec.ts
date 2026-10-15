jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))

import { Prisma, RentNoticePaymentSource } from '@prisma/client'
import { ConflictException } from '@nestjs/common'
import { AviseringService } from './avisering.service'

const D = (amount: number) => new Prisma.Decimal(amount)
const fmt = (amount: number) =>
  amount.toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

function notice(overrides: Record<string, unknown> = {}) {
  return {
    id: 'notice-1',
    organizationId: 'org-1',
    type: 'RENT',
    status: 'PENDING',
    sentAt: null,
    isProrated: false,
    ocrNumber: '1234567890',
    noticeNumber: 'AVI-2026-0001',
    dueDate: new Date('2026-11-01T00:00:00Z'),
    year: 2026,
    month: 11,
    amount: D(9775),
    totalAmount: D(9775),
    vatAmount: D(0),
    consumptionAmount: D(0),
    miscChargeAmount: D(0),
    reminderFeeAmount: D(0),
    interestAccruedAmount: D(0),
    credits: [],
    payments: [{ amount: D(25), source: RentNoticePaymentSource.CUSTOMER_CREDIT }],
    tenant: {
      type: 'INDIVIDUAL',
      firstName: 'Anna',
      lastName: 'Andersson',
      companyName: null,
      email: 'anna@example.test',
      phone: null,
    },
    lease: {
      monthlyRent: D(9775),
      unit: {
        unitNumber: '1101',
        name: 'Lägenhet',
        property: { street: 'Testgatan 1', name: 'Testfastigheten' },
      },
    },
    lines: [],
    ...overrides,
  }
}

function rig(overrides: Record<string, unknown> = {}, bankgiro: string | null = '5050-1055') {
  const row = notice(overrides)
  const org = { name: 'Testvärden', bankgiro, logoStorageKey: null }
  const prisma = {
    organization: { findUnique: jest.fn().mockResolvedValue(org) },
    rentNotice: {
      findFirst: jest.fn().mockResolvedValue(row),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  }
  const mail = { sendRentNotice: jest.fn().mockResolvedValue('mail-job-1') }
  // Fångar den riktiga dokumenttemplaten. Puppeteer och extern mejlleverans
  // behövs inte för att jämföra de tre betalningsbärande beloppen.
  const pdf = { generateFromHtml: jest.fn(async (html: string) => Buffer.from(html)) }
  const service = new AviseringService(
    prisma as never,
    {} as never,
    mail as never,
    pdf as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  )
  return { service, prisma, mail, pdf, row }
}

function expectAmount(html: string, amount: number) {
  expect(html).toContain(`<td>${fmt(amount)} kr</td>`)
  expect(html.match(/<div class="amount-value">\s*([^<]+?)\s*<\/div>/)?.[1]?.trim()).toBe(
    `${fmt(amount)} kr`,
  )
}

describe('Kundtillgodo i hyresavins PDF, OCR-rad och mejl', () => {
  it('visar 9 775 kr hyra − 25 kr tillgodo = 9 750 kr i samma utskick', async () => {
    const { service, prisma, mail, pdf, row } = rig()
    const before = JSON.stringify(row)

    await service.processNoticeSendJob('org-1', 'notice-1')

    const html = pdf.generateFromHtml.mock.calls[0]![0]
    expect(html).toContain(`${fmt(9775)} kr`)
    expect(html).toContain('Tillgodo använt:')
    expect(html).toContain(`<td>−${fmt(25)} kr</td>`)
    expectAmount(html, 9750)
    // Kontrollsiffran är oberoende förberäknad för girobeloppet 9750 00.
    expect(html).toContain('# 1234567890 # 9750 00 3 > 50501055#41#')
    expect(mail.sendRentNotice).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 9750, pdfBuffer: Buffer.from(html) }),
    )
    expect(prisma.rentNotice.findFirst).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: { id: 'notice-1', organizationId: 'org-1' },
        include: expect.objectContaining({
          credits: { select: { amount: true } },
          payments: { select: { amount: true, source: true } },
        }),
      }),
    )
    expect(JSON.stringify(row)).toBe(before)
    expect(prisma.rentNotice.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'SENT' }) }),
    )
  })

  it('hämtar tillgodo även när en PDF laddas ned utan att skickas', async () => {
    const { service, prisma, mail } = rig()
    const html = (await service.getNoticePdfBuffer('notice-1', 'org-1')).toString()

    expectAmount(html, 9750)
    expect(html).toContain('Tillgodo använt:')
    expect(prisma.rentNotice.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          payments: { select: { amount: true, source: true } },
        }),
      }),
    )
    expect(mail.sendRentNotice).not.toHaveBeenCalled()
    expect(prisma.rentNotice.updateMany).not.toHaveBeenCalled()
  })

  it('behåller originalavins belopp när bara bank- och manuella betalningar finns', async () => {
    const { service } = rig({
      payments: [
        { amount: D(100), source: RentNoticePaymentSource.BANK_RECONCILIATION },
        { amount: D(200), source: RentNoticePaymentSource.MANUAL },
      ],
    })
    const html = (await service.getNoticePdfBuffer('notice-1', 'org-1')).toString()

    expectAmount(html, 9775)
    expect(html).not.toContain('Tillgodo använt:')
    expect(html).toContain('# 1234567890 # 9775 00 4 > 50501055#41#')
  })

  it('avräknar endast tillgodo när flera betalningskällor finns', async () => {
    const { service } = rig({
      payments: [
        { amount: D(100), source: RentNoticePaymentSource.BANK_RECONCILIATION },
        { amount: D(200), source: RentNoticePaymentSource.MANUAL },
        { amount: D(10), source: RentNoticePaymentSource.CUSTOMER_CREDIT },
        { amount: D(15), source: RentNoticePaymentSource.CUSTOMER_CREDIT },
      ],
    })
    const html = (await service.getNoticePdfBuffer('notice-1', 'org-1')).toString()

    expectAmount(html, 9750)
    expect(html).toContain(`<td>−${fmt(25)} kr</td>`)
  })

  it('summerar flera små tillgodobelopp exakt i ören', async () => {
    const { service, mail } = rig({
      payments: [
        { amount: D(0.1), source: RentNoticePaymentSource.CUSTOMER_CREDIT },
        { amount: D(0.2), source: RentNoticePaymentSource.CUSTOMER_CREDIT },
      ],
    })
    await service.processNoticeSendJob('org-1', 'notice-1')

    expect(mail.sendRentNotice).toHaveBeenCalledWith(expect.objectContaining({ amount: 9774.7 }))
    const html = mail.sendRentNotice.mock.calls[0]![0].pdfBuffer.toString()
    expect(html).toContain(`<td>−${fmt(0.3)} kr</td>`)
    expectAmount(html, 9774.7)
    expect(html).toContain('# 1234567890 # 9774 70 ')
  })

  it('bevarar moms, avirader och befintlig kreditering som separata poster', async () => {
    const { service, row } = rig({
      amount: D(7820),
      vatAmount: D(1955),
      consumptionAmount: D(120.75),
      miscChargeAmount: D(40.25),
      reminderFeeAmount: D(60),
      interestAccruedAmount: D(80),
      credits: [{ amount: D(100) }],
      lines: [{ description: 'Vatten', total: D(120.75) }],
    })
    const before = JSON.stringify(row)
    const html = (await service.getNoticePdfBuffer('notice-1', 'org-1')).toString()

    expect(html).toContain(`${fmt(7820)} kr`)
    expect(html).toContain(`${fmt(1955)} kr`)
    expect(html).toContain(`${fmt(120.75)} kr`)
    expectAmount(html, 9871)
    expect(JSON.stringify(row)).toBe(before)
  })

  it('utan tillgodo visas oförändrat belopp och ingen avdragsrad', async () => {
    const { service, mail } = rig({ payments: [] })
    await service.processNoticeSendJob('org-1', 'notice-1')

    expect(mail.sendRentNotice).toHaveBeenCalledWith(expect.objectContaining({ amount: 9775 }))
    const html = mail.sendRentNotice.mock.calls[0]![0].pdfBuffer.toString()
    expectAmount(html, 9775)
    expect(html).not.toContain('Tillgodo använt:')
  })

  it('visar aldrig ett negativt betalningskrav vid för stort lagrat tillgodo', async () => {
    const { service } = rig({
      payments: [{ amount: D(10_000), source: RentNoticePaymentSource.CUSTOMER_CREDIT }],
    })
    const html = (await service.getNoticePdfBuffer('notice-1', 'org-1')).toString()

    expectAmount(html, 0)
    expect(html).toContain('# 1234567890 # 0 00 0 > 50501055#41#')
  })

  it('tillgodo kringgår inte kravet på giltigt bankgiro', async () => {
    const { service, mail, pdf } = rig({}, null)
    await service.processNoticeSendJob('org-1', 'notice-1')

    expect(mail.sendRentNotice).not.toHaveBeenCalled()
    expect(pdf.generateFromHtml).not.toHaveBeenCalled()
    const html = (await service.getNoticePdfBuffer('notice-1', 'org-1')).toString()
    expect(html).toContain('SAKNAS')
    expect(html).not.toContain('50501055#41#')
    expectAmount(html, 9750)
  })

  it('köar inget mejl om det första tillgodot tillkommer under PDF-renderingen', async () => {
    const { service, prisma, mail, pdf, row } = rig({ payments: [] })
    pdf.generateFromHtml.mockImplementationOnce(async (html: string) => {
      prisma.rentNotice.findFirst.mockResolvedValue({
        ...row,
        payments: [{ amount: D(25), source: RentNoticePaymentSource.CUSTOMER_CREDIT }],
      })
      return Buffer.from(html)
    })

    await expect(service.processNoticeSendJob('org-1', 'notice-1')).rejects.toBeInstanceOf(
      ConflictException,
    )

    expect(mail.sendRentNotice).not.toHaveBeenCalled()
    expect(prisma.rentNotice.findFirst).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        select: expect.objectContaining({
          payments: { select: { amount: true, source: true } },
        }),
      }),
    )
    expect(prisma.rentNotice.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'FAILED',
          sendError: 'Tillgodo ändrades under PDF-renderingen. Avin behöver renderas om.',
        }),
      }),
    )
  })

  it('renderar om med det nya tillgodot vid retry och skickar samma belopp i PDF och mejl', async () => {
    const { service, prisma, mail, pdf, row } = rig()
    pdf.generateFromHtml.mockImplementationOnce(async (html: string) => {
      prisma.rentNotice.findFirst.mockResolvedValue({
        ...row,
        payments: [
          { amount: D(25), source: RentNoticePaymentSource.CUSTOMER_CREDIT },
          { amount: D(25), source: RentNoticePaymentSource.CUSTOMER_CREDIT },
        ],
      })
      return Buffer.from(html)
    })

    await expect(service.processNoticeSendJob('org-1', 'notice-1')).rejects.toBeInstanceOf(
      ConflictException,
    )
    expect(mail.sendRentNotice).not.toHaveBeenCalled()
    await service.processNoticeSendJob('org-1', 'notice-1')

    expect(pdf.generateFromHtml).toHaveBeenCalledTimes(2)
    const html = pdf.generateFromHtml.mock.calls[1]![0]
    expectAmount(html, 9725)
    expect(html).toContain(`<td>−${fmt(50)} kr</td>`)
    expect(html).toContain('# 1234567890 # 9725 00 ')
    expect(mail.sendRentNotice).toHaveBeenCalledTimes(1)
    expect(mail.sendRentNotice).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 9725,
        pdfBuffer: Buffer.from(html),
        idempotencyKey: 'rent-notice-notice-1',
      }),
    )
  })
})
