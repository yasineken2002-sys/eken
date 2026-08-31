import { Injectable, NotFoundException } from '@nestjs/common'
import { PrismaService } from '../common/prisma/prisma.service'
import { HISTORY_SOURCES } from './history-sources.registry'
import type { HistoryEvent } from './history-event'
import type { UserRole } from '@prisma/client'

/**
 * SAMMANSTÄLLNING VID LÄSNING.
 *
 * Ingen egen händelsetabell, ingen dubbelskrivning — domäntabellerna förblir
 * enda sanningskälla (planens Del 8). Priset är att varje läsning kostar N
 * frågor; vinsten är att historiken inte KAN glida isär från domänen, eftersom
 * det inte finns någon andra kopia att glida isär från.
 *
 * Skulle mätning visa att det är för långsamt läggs en projektion OVANPÅ. Den
 * ordningen är avsiktlig: en projektion som tappat en händelse ser komplett ut,
 * och då måste domänen finnas kvar att jämföra mot.
 */
@Injectable()
export class TenantHistoryService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Hela historiken för en hyresgäst, nyast först.
   *
   * Multi-tenant: `organizationId` går in i VARJE källas `where`, inte bara i
   * kontrollen nedan. Kontrollen svarar på om hyresgästen finns i organisationen;
   * scopingen i källorna gör att en felskriven laddare inte kan läcka ändå.
   *
   * `userRole` styr VILKA källor som läses — se `restrictedToRoles`.
   */
  async forTenant(
    organizationId: string,
    tenantId: string,
    userRole: UserRole,
  ): Promise<HistoryEvent[]> {
    const tenant = await this.prisma.tenant.findFirst({
      where: { id: tenantId, organizationId },
      select: { id: true },
    })
    if (!tenant) throw new NotFoundException('Hyresgäst hittades inte')

    // ETT AGGREGAT FÅR INTE VIDGA ÅTKOMST. Två källor har en snävare grind än
    // historik-endpointen; de utelämnas för roller som inte når dem någon
    // annanstans. Se `restrictedToRoles` i registret för mätningen bakom.
    const synliga = HISTORY_SOURCES.filter(
      (s) => !s.restrictedToRoles || s.restrictedToRoles.includes(userRole),
    )

    const q = { prisma: this.prisma, organizationId, tenantId }
    // Källorna är oberoende av varandra och läser olika tabeller — de kan köras
    // parallellt. Faller EN ska hela svaret falla: en historik som tyst tappar
    // en källa är exakt den defekt registret finns för att förhindra, så här
    // används `all` och inte `allSettled`.
    const perSource = await Promise.all(synliga.map((s) => s.load(q)))

    return perSource.flat().sort((a, b) => b.at.getTime() - a.at.getTime())
  }
}
