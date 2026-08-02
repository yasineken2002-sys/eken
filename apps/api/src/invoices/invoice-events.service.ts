import { Injectable } from '@nestjs/common'
import type { InvoiceEvent, InvoiceEventType, EventActorType, Prisma } from '@prisma/client'
import { PrismaService } from '../common/prisma/prisma.service'

@Injectable()
export class InvoiceEventsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Skriv en ny händelse till audit-loggen.
   * Anropas alltid i en transaktion när status ändras.
   * Kan anropas utan transaktion för "mjuka" händelser (visning, notering).
   */
  async record(
    invoiceId: string,
    type: InvoiceEventType,
    actorType: EventActorType,
    actorId: string | null,
    payload: Record<string, unknown> = {},
    opts: { ip?: string; userAgent?: string; tx?: Prisma.TransactionClient } = {},
  ): Promise<InvoiceEvent> {
    const db = opts.tx ?? this.prisma

    // Denormalisera aktörsetikett vid skrivtillfället.
    // Om användaren senare tas bort finns etiketten kvar i historiken.
    //
    // Uppslagningen går via `db`, inte `this.prisma` (#288). Den låg förut alltid
    // på den poolade klienten, även när anroparen skickat med en transaktion —
    // alltså en andra anslutning ockuperad under hela tiden transaktionen håller
    // sitt radlås. Det märktes inte när den enda anroparen med tx var
    // bankmatchningen; sedan #288 går varje manuell betalning samma väg, och en
    // liten pool (Prismas default är num_cpus*2+1) hade då kunnat svälta sig
    // själv och trigga maxWait i onödan.
    let actorLabel: string | undefined
    if (actorType === 'USER' && actorId) {
      const user = await db.user.findUnique({
        where: { id: actorId },
        select: { firstName: true, lastName: true },
      })
      if (user) actorLabel = `${user.firstName} ${user.lastName}`
    } else if (actorType === 'SYSTEM') {
      actorLabel = 'System'
    } else if (actorType === 'WEBHOOK') {
      actorLabel = 'E-postleverantör'
    }

    // Bygg data-objekt utan undefined-fält (krav från exactOptionalPropertyTypes)
    const data: Prisma.InvoiceEventUncheckedCreateInput = {
      invoiceId,
      type,
      actorType,
      payload: payload as Prisma.InputJsonValue,
      ...(actorId != null ? { actorId } : {}),
      ...(actorLabel != null ? { actorLabel } : {}),
      ...(opts.ip != null ? { ipAddress: opts.ip } : {}),
      ...(opts.userAgent != null ? { userAgent: opts.userAgent } : {}),
    }
    return db.invoiceEvent.create({ data })
  }

  /**
   * Hämta komplett tidslinje för en faktura, äldst till nyast.
   */
  async getTimeline(invoiceId: string): Promise<InvoiceEvent[]> {
    return this.prisma.invoiceEvent.findMany({
      where: { invoiceId },
      orderBy: { createdAt: 'asc' },
    })
  }

  /**
   * Tracking-pixel och PDF-länk anropar denna med ett token istället för ett ID.
   * Deduplicerar EMAIL_OPENED inom ett 1-timmes fönster för att hantera
   * Apple Mail Privacy Protection och andra proxy-baserade pre-fetchers.
   */
  async recordByToken(
    token: string,
    type: 'EMAIL_OPENED' | 'PDF_VIEWED',
    opts: { ip?: string; userAgent?: string },
  ): Promise<InvoiceEvent | null> {
    const invoice = await this.prisma.invoice.findUnique({
      where: { trackingToken: token },
      select: { id: true },
    })
    if (!invoice) return null

    if (type === 'EMAIL_OPENED') {
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000)
      const recent = await this.prisma.invoiceEvent.findFirst({
        where: {
          invoiceId: invoice.id,
          type: 'EMAIL_OPENED',
          createdAt: { gte: oneHourAgo },
        },
      })
      if (recent) return null // Deduplicera
    }

    return this.record(invoice.id, type, 'WEBHOOK', null, {}, opts)
  }

  /**
   * Slå upp faktura via tracking-token (används av PDF-redirect).
   */
  async getInvoiceByToken(token: string) {
    return this.prisma.invoice.findUnique({
      where: { trackingToken: token },
      select: { id: true },
    })
  }
}
