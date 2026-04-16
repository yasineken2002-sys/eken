import { Controller, Get, Param, Ip, Headers, Res, HttpCode } from '@nestjs/common'
import { Public } from '../common/decorators/public.decorator'
import type { InvoiceEventsService } from './invoice-events.service'

// 1×1 transparent GIF – branschstandard för e-postspårningspixlar
// Samma teknik som Fortnox, Visma, Mailchimp m.fl. använder
const TRACKING_PIXEL = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64',
)

@Controller('track')
export class TrackingController {
  constructor(private readonly eventsService: InvoiceEventsService) {}

  /**
   * GET /track/open/:token
   *
   * Tracking-pixel för e-postöppning. Inbäddas som en 1×1 transparent bild
   * i faktura-e-postens HTML-body. Returnerar omedelbart – event skrivs asynkront.
   *
   * OBS: Apple Mail Privacy Protection (iOS 15+) och Gmail kan pre-fetcha pixeln
   * vid leverans, inte vid öppning. EMAIL_OPENED är därför ett "mjukt" signal.
   * Deduplicering inom 1 timme hanteras i InvoiceEventsService.
   */
  @Public()
  @Get('open/:token')
  @HttpCode(200)
  async trackOpen(
    @Param('token') token: string,
    @Ip() ip: string,
    @Headers('user-agent') userAgent: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    @Res() res: any,
  ) {
    // Fire-and-forget – blockera aldrig pixelsvaret
    this.eventsService
      .recordByToken(token, 'EMAIL_OPENED', { ip, userAgent })
      .catch((err) => console.error('[tracking] pixel error', err))

    res
      .header('Content-Type', 'image/gif')
      .header('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
      .header('Pragma', 'no-cache')
      .header('Expires', '0')
      .send(TRACKING_PIXEL)
  }

  /**
   * GET /track/view/:token
   *
   * Spårad PDF-länk. Skickas med i faktura-e-posten istället för en direkt PDF-URL.
   * Registrerar PDF_VIEWED och redirectar sedan till den faktiska PDF-filen.
   */
  @Public()
  @Get('view/:token')
  async trackPdfView(
    @Param('token') token: string,
    @Ip() ip: string,
    @Headers('user-agent') userAgent: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    @Res() res: any,
  ) {
    await this.eventsService.recordByToken(token, 'PDF_VIEWED', { ip, userAgent })

    const invoice = await this.eventsService.getInvoiceByToken(token)
    if (!invoice) {
      res.status(404).send({ message: 'Ogiltig länk' })
      return
    }

    // Redirect till faktisk PDF-endpoint
    res.redirect(`/api/invoices/${invoice.id}/pdf`)
  }
}
