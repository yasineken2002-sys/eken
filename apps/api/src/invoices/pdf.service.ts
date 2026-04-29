import { Injectable, NotFoundException } from '@nestjs/common'
import puppeteer from 'puppeteer'
import { PrismaService } from '../common/prisma/prisma.service'
import { StorageService } from '../storage/storage.service'
import { generateInvoiceHtml } from './templates/invoice-pdf.template'

@Injectable()
export class PdfService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  async generateFromHtml(html: string): Promise<Buffer> {
    const browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    })
    try {
      const page = await browser.newPage()
      await page.setContent(html, { waitUntil: 'networkidle0' })
      const pdf = await page.pdf({
        format: 'A4',
        printBackground: true,
        margin: { top: '20mm', right: '15mm', bottom: '20mm', left: '15mm' },
      })
      return Buffer.from(pdf)
    } finally {
      await browser.close()
    }
  }

  async generateInvoicePdf(invoiceId: string, organizationId: string): Promise<Buffer> {
    // 1. Fetch invoice with related data
    const invoice = await this.prisma.invoice.findFirst({
      where: { id: invoiceId, organizationId },
      include: {
        lines: true,
        tenant: true,
        customer: true,
        organization: true,
      },
    })
    if (!invoice) throw new NotFoundException('Faktura hittades inte')

    // En faktura har antingen tenant eller customer (XOR-constraint).
    // Normalisera till ett gemensamt "party"-objekt för mall-rendering.
    const party = invoice.tenant ?? invoice.customer
    if (!party) throw new NotFoundException('Fakturan saknar mottagare')

    // 2. Read logo from R2 and encode as base64 (fail-safe: null on any error)
    let logoBase64: string | null = null
    if (invoice.organization.logoStorageKey) {
      try {
        const buffer = await this.storage.getFileBuffer(invoice.organization.logoStorageKey)
        logoBase64 = buffer.toString('base64')
      } catch {
        logoBase64 = null
      }
    }

    // 3. Build HTML
    const html = generateInvoiceHtml({
      invoiceColor: invoice.organization.invoiceColor ?? '#1a6b3c',
      invoiceTemplate: invoice.organization.invoiceTemplate ?? 'classic',
      invoice: {
        ...invoice,
        tenant: {
          type: party.type,
          firstName: party.firstName,
          lastName: party.lastName,
          companyName: party.companyName,
          email: party.email ?? '',
          phone: party.phone,
          // Map flat Prisma address fields → nested shape the template expects
          address: party.street
            ? {
                street: party.street,
                city: party.city ?? '',
                postalCode: party.postalCode ?? '',
              }
            : null,
        },
        organization: {
          name: invoice.organization.name,
          orgNumber: invoice.organization.orgNumber ?? null,
          email: invoice.organization.email ?? null,
          street: invoice.organization.street ?? null,
          city: invoice.organization.city ?? null,
          postalCode: invoice.organization.postalCode ?? null,
          bankgiro: invoice.organization.bankgiro ?? null,
          logoUrl: invoice.organization.logoStorageKey ?? null,
        },
      },
      logoBase64,
    })

    // 4. Launch Puppeteer and render PDF
    const browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    })

    try {
      const page = await browser.newPage()
      await page.setContent(html, { waitUntil: 'networkidle0' })
      const pdf = await page.pdf({
        format: 'A4',
        printBackground: true,
        margin: { top: '0', right: '0', bottom: '0', left: '0' },
      })
      return Buffer.from(pdf)
    } finally {
      await browser.close()
    }
  }
}
