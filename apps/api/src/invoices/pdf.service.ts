import { Injectable, NotFoundException, OnModuleDestroy } from '@nestjs/common'
import { Logger } from '@nestjs/common'
import puppeteer, { type Browser, type Page } from 'puppeteer'
import { DEFAULT_BRAND_COLOR } from '@eken/shared'
import { PrismaService } from '../common/prisma/prisma.service'
import { StorageService } from '../storage/storage.service'
import { detectMime, generateInvoiceHtml } from './templates/invoice-pdf.template'
import { PDF_WAIT_UNTIL } from './pdf-wait-until'
import { getLogoDataUrl } from '../common/branding/logo.util'
import {
  documentContext,
  INITIAL_RENDERING_CODE,
  renderingCodeIdentity,
  pdfEnvironmentIdentity,
  renderingDigest,
  renderingLogo,
  stampPdfDates,
  type PdfRenderingContext,
} from './rendering-context'
import { SAFE_CUSTOMER_SELECT } from '../customers/customers.service'
import { SAFE_TENANT_SELECT } from '../tenants/tenants.service'

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
  // Överlevnadsflaggor för Railways restriktiva microVM-runtime (Firecracker).
  // Utan dem dör Chromium vid start ("Failed to launch the browser process:
  // Code: null") — multiprocess-modellen (zygote) och crashpad-hanteraren kan
  // inte initiera i den avskalade miljön (saknar dbus + /sys/.../cpufreq).
  //   --no-zygote        : ingen fork-server-process (klarar clone-restriktionen)
  //   --disable-crashpad : starta inte crash-reportern (choke:ar på saknad sysfs)
  '--no-zygote',
  '--disable-crashpad',
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
  private renderingEnvironment = ''
  private controlled: PdfService | null = null

  // Lättviktig semaphore. queue håller resolves som väntar på en ledig slot,
  // active räknar hur många pages som körs just nu.
  private active = 0
  private readonly waiters: Array<() => void> = []

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  async onModuleDestroy(): Promise<void> {
    await this.controlled?.onModuleDestroy()
    if (this.browser) {
      try {
        await this.browser.close()
      } catch (err) {
        this.logger.warn(`Failed to close Puppeteer browser cleanly: ${String(err)}`)
      }
      this.browser = null
    }
  }

  async collectRenderingContext(logoKey: string | null) {
    return this.createRenderingContext(new Date(), await getLogoDataUrl(this.storage, logoKey))
  }

  async createRenderingContext(asOf: Date, logo: string | null): Promise<PdfRenderingContext> {
    const code = renderingCodeIdentity()
    if (code !== INITIAL_RENDERING_CODE) throw new Error('RENDER_IDENTITY_CONFLICT')
    const environment = renderingDigest(JSON.stringify([await pdfEnvironmentIdentity(), code]))
    return { ...documentContext(asOf, logo), environment }
  }

  async generateFromHtml(html: string, context?: PdfRenderingContext): Promise<Buffer> {
    return this.withPage(async (page) => {
      await page.setContent(html, { waitUntil: PDF_WAIT_UNTIL })
      const pdf = await page.pdf({
        format: 'A4',
        printBackground: true,
        margin: { top: '20mm', right: '15mm', bottom: '20mm', left: '15mm' },
      })
      return context ? stampPdfDates(Buffer.from(pdf), context) : Buffer.from(pdf)
    }, context)
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
      await page.setContent(html, { waitUntil: PDF_WAIT_UNTIL })

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
        tenant: { select: SAFE_TENANT_SELECT },
        customer: { select: SAFE_CUSTOMER_SELECT },
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

    const data = {
      invoiceColor: invoice.organization.invoiceColor ?? DEFAULT_BRAND_COLOR,
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
          // Skatteinformation — F-skatt-status trycks som frivillig uppgift,
          // inte som lagkrav (kanonisk not i invoice-pdf.template.ts, #392).
          // Fälten inkluderas så att mottagaren ser fullständig identifiering.
          hasFSkatt: invoice.organization.hasFSkatt,
          fSkattApprovedDate: invoice.organization.fSkattApprovedDate,
          vatNumber: invoice.organization.vatNumber ?? null,
          companyForm: invoice.organization.companyForm,
        },
      },
      logoBase64,
    }
    const logo =
      logoBase64 === null
        ? null
        : `data:${detectMime(invoice.organization.logoStorageKey ?? '')};base64,${logoBase64}`
    return this.renderInvoice(data, await this.createRenderingContext(new Date(), logo))
  }

  async renderInvoice(
    data: Parameters<typeof generateInvoiceHtml>[0],
    context: PdfRenderingContext,
  ): Promise<Buffer> {
    const logo = renderingLogo(context)
    const expectedLogo =
      data.logoBase64 === null
        ? null
        : `data:${detectMime(data.invoice.organization.logoUrl ?? '')};base64,${data.logoBase64}`
    if (logo !== expectedLogo) throw new Error('RENDER_IDENTITY_CONFLICT')
    const html = generateInvoiceHtml(data)
    return this.withPage(async (page) => {
      await page.setContent(html, { waitUntil: PDF_WAIT_UNTIL })
      const pdf = await page.pdf({
        format: 'A4',
        printBackground: true,
        margin: { top: '0', right: '0', bottom: '0', left: '0' },
      })
      return stampPdfDates(Buffer.from(pdf), context)
    }, context)
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
  private async withPage<T>(
    fn: (page: Page) => Promise<T>,
    context?: PdfRenderingContext,
  ): Promise<T> {
    await this.acquireSlot()
    let page: Page | null = null
    try {
      let browser: Browser
      if (context) {
        const current = await this.createRenderingContext(
          new Date(context.asOf),
          renderingLogo(context),
        )
        this.renderingEnvironment ||= current.environment
        if (
          context.environment !== current.environment ||
          current.environment !== this.renderingEnvironment
        )
          throw new Error('RENDER_IDENTITY_CONFLICT')
        this.controlled ??= new PdfService(this.prisma, this.storage)
        browser = await this.controlled.getBrowser()
        if (
          (await this.createRenderingContext(new Date(context.asOf), renderingLogo(context)))
            .environment !== current.environment
        )
          throw new Error('RENDER_IDENTITY_CONFLICT')
      } else browser = await this.getBrowser()
      page = await browser.newPage()
      let externalRequest = false
      if (context) {
        await page.setJavaScriptEnabled(false)
        await page.setRequestInterception(true)
        page.on('request', (request) => {
          if (/^(data:|about:blank$)/.test(request.url())) void request.continue()
          else {
            externalRequest = true
            void request.abort()
          }
        })
      }
      const result = await fn(page)
      if (externalRequest) throw new Error('External rendering resource rejected')
      return result
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
