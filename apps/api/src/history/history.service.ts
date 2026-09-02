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

    const händelser = await this.märkAgentskrivna(organizationId, perSource.flat())
    return händelser.sort((a, b) => b.at.getTime() - a.at.getTime())
  }

  /**
   * Uppgraderar `UNKNOWN` till `AGENT` för de rader en AI-körning skrev.
   *
   * ── VARFÖR HÄR OCH INTE I KÄLLORNA ──────────────────────────────────────
   *
   * Varje `HistoryEvent` bär redan `source: { table, id }` — exakt paret
   * `AiToolEffect` indexerar på (`@@index([organizationId, entityType,
   * entityId])`). Uppslaget kan därför göras EN gång för hela svaret i stället
   * för elva gånger i registret, och en ny källa ärver det utan att någon
   * kopplar in den.
   *
   * ── RIKTNINGEN ÄR ENVÄGS, OCH DET ÄR HELA POÄNGEN ───────────────────────
   *
   * En träff BEKRÄFTAR agent. En utebliven träff bekräftar ingenting — se
   * docblocket vid `humanOrUnknown`: `entityId` är NULL för `updateMany`, och
   * revisionsskrivningen sväljer tyst. Därför uppgraderar den här funktionen
   * bara; den nedgraderar aldrig, och den kan aldrig producera `HUMAN`.
   *
   * ── VAD DEN INTE SER ────────────────────────────────────────────────────
   *
   * Effektposterna gallras MED sin `AiToolExecution` (365 dagar för
   * action-verktyg, 90 för läsande) medan domänraden lever kvar. En AI-skriven
   * rad äldre än fristen faller alltså tillbaka till `UNKNOWN` — inte till
   * `HUMAN`, vilket är skälet att riktningen är enkelriktad. Det varaktiga
   * faktumet kommer i G1 steg 3.
   */
  private async märkAgentskrivna(
    organizationId: string,
    händelser: HistoryEvent[],
  ): Promise<HistoryEvent[]> {
    // Gruppera per tabell: indexet är (organizationId, entityType, entityId),
    // så en fråga per tabell använder det medan ett stort OR inte gör det.
    const perTabell = new Map<string, Set<string>>()
    for (const h of händelser) {
      if (h.actor.kind !== 'UNKNOWN') continue
      if (!h.source?.id) continue
      const s = perTabell.get(h.source.table) ?? new Set<string>()
      s.add(h.source.id)
      perTabell.set(h.source.table, s)
    }
    if (perTabell.size === 0) return händelser

    const körningPer = new Map<string, string>()
    await Promise.all(
      [...perTabell].map(async ([entityType, ids]) => {
        const rader = await this.prisma.aiToolEffect.findMany({
          where: { organizationId, entityType, entityId: { in: [...ids] } },
          select: { entityId: true, aiToolExecutionId: true },
        })
        for (const r of rader) {
          if (r.entityId) körningPer.set(`${entityType}\u0000${r.entityId}`, r.aiToolExecutionId)
        }
      }),
    )
    if (körningPer.size === 0) return händelser

    return händelser.map((h) => {
      if (h.actor.kind !== 'UNKNOWN' || !h.source?.id) return h
      const exec = körningPer.get(`${h.source.table}\u0000${h.source.id}`)
      if (!exec) return h
      // `id` byter betydelse med `kind`: för AGENT är det körningen som
      // utförde, inte uppdragsgivaren. Typen dokumenterar båda formerna.
      return { ...h, actor: { kind: 'AGENT' as const, id: exec, label: h.actor.label } }
    })
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
