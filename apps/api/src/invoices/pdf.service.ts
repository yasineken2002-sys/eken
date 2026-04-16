import { Injectable, NotFoundException } from '@nestjs/common'
import * as fs from 'fs/promises'
import * as path from 'path'
import puppeteer from 'puppeteer'
import type { PrismaService } from '../common/prisma/prisma.service'
import { generateInvoiceHtml } from './templates/invoice-pdf.template'

@Injectable()
export class PdfService {
  constructor(private readonly prisma: PrismaService) {}

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
        organization: true,
      },
    })
    if (!invoice) throw new NotFoundException('Faktura hittades inte')

    // 2. Read logo and encode as base64 (fail-safe: null on any error)
    let logoBase64: string | null = null
    if (invoice.organization.logoUrl) {
      try {
        const filePath = path.join(process.cwd(), invoice.organization.logoUrl)
        const buffer = await fs.readFile(filePath)
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
          ...invoice.tenant,
          // Map flat Prisma address fields → nested shape the template expects
          address: invoice.tenant.street
            ? {
                street: invoice.tenant.street,
                city: invoice.tenant.city ?? '',
                postalCode: invoice.tenant.postalCode ?? '',
              }
            : null,
        },
        organization: {
          name: invoice.organization.name,
          orgNumber: invoice.organization.orgNumber,
          email: invoice.organization.email,
          street: invoice.organization.street,
          city: invoice.organization.city,
          postalCode: invoice.organization.postalCode,
          bankgiro: invoice.organization.bankgiro ?? null,
          logoUrl: invoice.organization.logoUrl,
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
