import { Injectable } from '@nestjs/common'
import type { UserRole } from '@prisma/client'
import { PrismaService } from '../common/prisma/prisma.service'
import { HISTORY_SOURCES } from './history-sources.registry'
import { assertSubjectInOrg, type HistorySubjectRef } from './history-subject'
import type { HistoryEvent } from './history-event'

/**
 * SAMMANSTÄLLNING VID LÄSNING — för alla tre dimensionerna.
 *
 * Ingen egen händelsetabell, ingen dubbelskrivning — domäntabellerna förblir
 * enda sanningskälla (planens Del 8). Priset är att varje läsning kostar N
 * frågor; vinsten är att historiken inte KAN glida isär från domänen, och att
 * det anonymiseringen nollar är borta ur svaret i samma ögonblick — det finns
 * ingen andra kopia att glömma att skrubba.
 *
 * Skulle mätning visa att det är för långsamt läggs en projektion OVANPÅ. Den
 * ordningen är avsiktlig: en projektion som tappat en händelse ser komplett ut,
 * och då måste domänen finnas kvar att jämföra mot.
 */
@Injectable()
export class HistoryService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Historiken för ett subjekt, nyast först.
   *
   * Multi-tenant: `organizationId` går in i VARJE källas `where`, inte bara i
   * existenskontrollen. Kontrollen svarar på om subjektet finns i
   * organisationen; scopingen i källorna gör att en felskriven laddare inte
   * kan läcka ändå.
   *
   * `userRole` styr VILKA källor som läses: ETT AGGREGAT FÅR INTE VIDGA
   * ÅTKOMST, så en källa med snävare grind någon annanstans i API:t behåller
   * den här — deklarerad som `restrictedToRoles` på källan, inte som en `if` i
   * den här läsvägen. Se registret.
   */
  async forSubject(
    organizationId: string,
    subject: HistorySubjectRef,
    userRole: UserRole,
  ): Promise<HistoryEvent[]> {
    await assertSubjectInOrg(this.prisma, organizationId, subject)

    const dimension = subject.kind.toLowerCase() as 'tenant' | 'unit' | 'property'
    const synliga = HISTORY_SOURCES.filter(
      (s) =>
        s.relations[dimension] !== undefined &&
        (!s.restrictedToRoles || s.restrictedToRoles.includes(userRole)),
    )

    const q = { prisma: this.prisma, organizationId, subject }
    // Källorna är oberoende av varandra och läser olika tabeller — de kan köras
    // parallellt. Faller EN ska hela svaret falla: en historik som tyst tappar
    // en källa är exakt den defekt registret finns för att förhindra, så här
    // används `all` och inte `allSettled`.
    const perSource = await Promise.all(synliga.map((s) => s.load(q)))

    return perSource.flat().sort((a, b) => b.at.getTime() - a.at.getTime())
  }

  async forTenant(
    organizationId: string,
    tenantId: string,
    userRole: UserRole,
  ): Promise<HistoryEvent[]> {
    return this.forSubject(organizationId, { kind: 'TENANT', id: tenantId }, userRole)
  }

  async forUnit(
    organizationId: string,
    unitId: string,
    userRole: UserRole,
  ): Promise<HistoryEvent[]> {
    return this.forSubject(organizationId, { kind: 'UNIT', id: unitId }, userRole)
  }

  async forProperty(
    organizationId: string,
    propertyId: string,
    userRole: UserRole,
  ): Promise<HistoryEvent[]> {
    return this.forSubject(organizationId, { kind: 'PROPERTY', id: propertyId }, userRole)
  }
}
