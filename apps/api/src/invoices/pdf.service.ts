import { Injectable, NotFoundException, OnModuleDestroy } from '@nestjs/common'
import { Logger } from '@nestjs/common'
import puppeteer, { type Browser, type Page } from 'puppeteer'
import { PrismaService } from '../common/prisma/prisma.service'
import { StorageService } from '../storage/storage.service'
import { generateInvoiceHtml } from './templates/invoice-pdf.template'

// Liten HTML-escape för values vi väver in i Puppeteers header/footer-
// templates (kontraktsnummer, orgnamn). Templates tolkas som HTML, så vi
// måste skydda mot &/<>/"-tecken i orgnamn.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const BROWSER_LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
] as const

// Hur många PDF-renderingar vi tillåter samtidigt mot samma browser. Headless
// Chromium klarar fler men varje öppen page äter ~50-100 MB. 5 är en bra
// avvägning för Railway-storleken vi kör i prod (1-2 vCPU, 2 GB RAM).
const MAX_CONCURRENT_PAGES = 5

@Injectable()
export class PdfService implements OnModuleDestroy {
  private readonly logger = new Logger(PdfService.name)

  // Singleton browser-handle. Lat-initieras vid första anrop och återanvänds
  // för alla efterföljande renderingar. Att starta en ny Chromium per request
  // är ~2 s overhead + ~500 MB minnesläck över tid (Puppeteer/Chromium har
  // dokumenterade läckor när processen återstartas snabbt).
  private browser: Browser | null = null
  private launchPromise: Promise<Browser> | null = null

  // Lättviktig semaphore. queue håller resolves som väntar på en ledig slot,
  // active räknar hur många pages som körs just nu.
  private active = 0
  private readonly waiters: Array<() => void> = []

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  async onModuleDestroy(): Promise<void> {
    if (this.browser) {
      try {
        await this.browser.close()
      } catch (err) {
        this.logger.warn(`Failed to close Puppeteer browser cleanly: ${String(err)}`)
      }
      this.browser = null
    }
  }

  async generateFromHtml(html: string): Promise<Buffer> {
    return this.withPage(async (page) => {
      await page.setContent(html, { waitUntil: 'networkidle0' })
      const pdf = await page.pdf({
        format: 'A4',
        printBackground: true,
        margin: { top: '20mm', right: '15mm', bottom: '20mm', left: '15mm' },
      })
      return Buffer.from(pdf)
    })
  }

  /**
   * Genererar en kontrakts-PDF med upprepad header/footer på varje sida —
   * Chromium-versionen av CSS Paged Media `@top-center` / `@bottom-right`
   * (vilket Chromium inte stödjer). Headern visar
   * "Hyreskontrakt — KONT-NNNN · OrgName" och footern visar "Sida X av Y"
   * höger samt kontraktsnumret vänster.
   *
   * Marginalerna måste matcha @page-värdena i contract-template.shared.ts:
   *   top:25mm  right:18mm  bottom:22mm  left:18mm
   *
   * displayHeaderFooter=true tillsammans med headerTemplate/footerTemplate
   * är hur Puppeteer faktiskt utlöser detta — utan templates renderas
   * standardrubriken/-footern (URL och tid), vilket vi inte vill ha.
   */
  async generateContractFromHtml(
    html: string,
    meta: { contractNumber: string; organizationName: string },
  ): Promise<Buffer> {
    return this.withPage(async (page) => {
      await page.setContent(html, { waitUntil: 'networkidle0' })

      const headerHtml = `
        <div style="font-size:8pt;color:#6b7280;width:100%;padding:0 18mm;
                    font-family:-apple-system,system-ui,sans-serif;
                    text-align:center;">
          Hyreskontrakt — ${escapeHtml(meta.contractNumber)} · ${escapeHtml(meta.organizationName)}
        </div>`

      const footerHtml = `
        <div style="font-size:8pt;color:#6b7280;width:100%;padding:0 18mm;
                    font-family:-apple-system,system-ui,sans-serif;
                    display:flex;justify-content:space-between;">
          <span>${escapeHtml(meta.contractNumber)}</span>
          <span>Sida <span class="pageNumber"></span> av <span class="totalPages"></span></span>
        </div>`

      const pdf = await page.pdf({
        format: 'A4',
        printBackground: true,
        displayHeaderFooter: true,
        headerTemplate: headerHtml,
        footerTemplate: footerHtml,
        margin: { top: '25mm', right: '18mm', bottom: '22mm', left: '18mm' },
      })
      return Buffer.from(pdf)
    })
  }

  async generateInvoicePdf(invoiceId: string, organizationId: string): Promise<Buffer> {
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

    let logoBase64: string | null = null
    if (invoice.organization.logoStorageKey) {
      try {
        const buffer = await this.storage.getFileBuffer(invoice.organization.logoStorageKey)
        logoBase64 = buffer.toString('base64')
      } catch {
        logoBase64 = null
      }
    }

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
          // Skatteinformation — krav per 11 kap. 8 § ML att F-skatt-status
          // visas på faktura. Övriga fält är frivilliga men inkluderas så
          // att mottagaren ser fullständig identifiering.
          hasFSkatt: invoice.organization.hasFSkatt,
          fSkattApprovedDate: invoice.organization.fSkattApprovedDate,
          vatNumber: invoice.organization.vatNumber ?? null,
          companyForm: invoice.organization.companyForm,
        },
      },
      logoBase64,
    })

    return this.withPage(async (page) => {
      await page.setContent(html, { waitUntil: 'networkidle0' })
      const pdf = await page.pdf({
        format: 'A4',
        printBackground: true,
        margin: { top: '0', right: '0', bottom: '0', left: '0' },
      })
      return Buffer.from(pdf)
    })
  }

  // ── Browser pool ──────────────────────────────────────────────────────────

  /**
   * Hämtar (eller startar) singleton-browsern. Om Chromium kraschat
   * (browser.disconnect:ar) startas en ny vid nästa anrop. Två parallella
   * första-anrop delar samma launchPromise så vi aldrig startar två browsers.
   */
  private async getBrowser(): Promise<Browser> {
    if (this.browser && this.browser.connected) return this.browser
    if (this.launchPromise) return this.launchPromise

    this.launchPromise = puppeteer
      .launch({ headless: true, args: [...BROWSER_LAUNCH_ARGS] })
      .then((browser) => {
        this.browser = browser
        browser.on('disconnected', () => {
          this.logger.warn('[pdf] Puppeteer browser disconnected — startar om vid nästa request')
          this.browser = null
        })
        this.logger.log('[pdf] Puppeteer browser startad')
        return browser
      })
      .finally(() => {
        this.launchPromise = null
      })

    return this.launchPromise
  }

  /**
   * Kör en callback med en exklusiv Page. Tar en semaphore-slot före, släpper
   * efter (även vid fel). Stänger pagen alltid — Puppeteer läcker minne om
   * pages lämnas öppna.
   */
  private async withPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
    await this.acquireSlot()
    let page: Page | null = null
    try {
      const browser = await this.getBrowser()
      page = await browser.newPage()
      return await fn(page)
    } finally {
      if (page) {
        try {
          await page.close()
        } catch (err) {
          this.logger.warn(`Failed to close page: ${String(err)}`)
        }
      }
      this.releaseSlot()
    }
  }

  private acquireSlot(): Promise<void> {
    if (this.active < MAX_CONCURRENT_PAGES) {
      this.active++
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(() => {
        this.active++
        resolve()
      })
    })
  }

  private releaseSlot(): void {
    this.active--
    const next = this.waiters.shift()
    if (next) next()
  }
}
