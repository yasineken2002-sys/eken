import { Injectable, NotFoundException } from '@nestjs/common'
import type { RentNoticeEvent, RentNoticeEventType, EventActorType, Prisma } from '@prisma/client'
import { PrismaService } from '../common/prisma/prisma.service'

/**
 * Append-only krav-/leveranslogg för hyresavier (inkasso-serien). Speglar
 * InvoiceEventsService men med EN viktig skärpning som föddes ur PR 1:s
 * säkerhetsgranskning (security-LOW): läsvägen org-verifierar ALLTID att avin
 * tillhör organisationen INNAN händelser returneras. RentNoticeEvent saknar egen
 * organizationId och scopas via avin — utan denna kontroll kunde ett läckt
 * rentNoticeId exponera en annan organisations kravlogg (cross-tenant-läsning).
 */
@Injectable()
export class RentNoticeEventsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Skriv en ny händelse till audit-loggen. Anropas i en transaktion när en
   * statusövergång sker (opts.tx), eller fristående för "mjuka" händelser
   * (leveranskvittens, notering). organizationId behövs inte vid skrivning —
   * rentNoticeId pekar entydigt på en avi i en betrodd server-flödesväg.
   */
  async record(
    rentNoticeId: string,
    type: RentNoticeEventType,
    actorType: EventActorType,
    actorId: string | null,
    payload: Record<string, unknown> = {},
    opts: { tx?: Prisma.TransactionClient } = {},
  ): Promise<RentNoticeEvent> {
    const db = opts.tx ?? this.prisma

    // Denormalisera aktörsetiketten vid skrivtillfället — finns kvar i
    // historiken även om användaren senare tas bort.
    let actorLabel: string | undefined
    if (actorType === 'USER' && actorId) {
      const user = await this.prisma.user.findUnique({
        where: { id: actorId },
        select: { firstName: true, lastName: true },
      })
      if (user) actorLabel = `${user.firstName} ${user.lastName}`
    } else if (actorType === 'SYSTEM') {
      actorLabel = 'System'
    } else if (actorType === 'WEBHOOK') {
      actorLabel = 'E-postleverantör'
    }

    const data: Prisma.RentNoticeEventUncheckedCreateInput = {
      rentNoticeId,
      type,
      actorType,
      payload: payload as Prisma.InputJsonValue,
      ...(actorId != null ? { actorId } : {}),
      ...(actorLabel != null ? { actorLabel } : {}),
    }
    return db.rentNoticeEvent.create({ data })
  }

  /**
   * Hämta komplett tidslinje för en hyresavi, äldst till nyast.
   *
   * ORG-VERIFIERAD: avin måste tillhöra `organizationId`, annars NotFound. Detta
   * är det säkra mönstret som ALLA RentNoticeEvent-läsvägar måste följa — kontroll
   * av ägarskap FÖRE läsning, så ett läckt rentNoticeId aldrig kan exponera en
   * annan organisations logg.
   */
  async getTimeline(rentNoticeId: string, organizationId: string): Promise<RentNoticeEvent[]> {
    const notice = await this.prisma.rentNotice.findFirst({
      where: { id: rentNoticeId, organizationId },
      select: { id: true },
    })
    if (!notice) throw new NotFoundException('Avi hittades inte')

    return this.prisma.rentNoticeEvent.findMany({
      where: { rentNoticeId },
      orderBy: { createdAt: 'asc' },
    })
  }
}
