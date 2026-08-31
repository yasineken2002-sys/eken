import { Injectable } from '@nestjs/common'
import { PrismaService } from '../common/prisma/prisma.service'
import { HISTORY_EXPECTATIONS, type ExpectationDefinition } from './history-expectations'
import { assertSubjectInOrg, type HistorySubjectRef } from './history-subject'

/**
 * LUCKBERÄKNINGEN — beräknat tillstånd, aldrig en lagrad flagga. Nu för alla
 * tre dimensionerna, mot SAMMA deklarerade förväntningar.
 *
 * Varje utfall bär den förväntan det mättes mot, inklusive dess källa. En
 * lucka utan förväntan är en gissning, och en tom lista utan förklaring är den
 * tystnad som gör att man slutar leta.
 *
 * Dimensionen ändrar bara VILKA rader förväntan prövas mot — aldrig VAD som
 * förväntas. "En avi per månad avtalet löpt" är samma regel för hyresgästens
 * avtal, lägenhetens avtal och fastighetens alla avtal.
 */

/** Tre utfall — och det tredje är det som annars försvinner. */
export type GapStatus =
  /** Förväntan finns och är uppfylld. */
  | 'UPPFYLLD'
  /** Förväntan finns och är INTE uppfylld. */
  | 'LUCKA'
  /** Förväntan finns men gäller inte det här objektet (ännu). */
  | 'GÄLLER_EJ'
  /** Ingen förväntan är definierad — vi VET INTE vad som borde ha hänt. */
  | 'ODEFINIERAD'

export interface GapResult {
  key: string
  label: string
  status: GapStatus
  /** Var förväntan kommer ifrån. Följer med i svaret, inte bara i koden. */
  source: ExpectationDefinition['source']
  /** Svensk mening om utfallet. För ODEFINIERAD: vad som saknas. */
  detail: string
  /** Antal saknade poster när det går att räkna. */
  missingCount?: number
}

@Injectable()
export class GapsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Alla förväntningar prövade mot ett subjekt.
   *
   * Returnerar en post per förväntan — även de odefinierade och de som inte
   * gäller. Att filtrera bort dem hade gjort svaret kortare och sämre: den som
   * ser en tom lista ska kunna veta VARFÖR den är tom.
   *
   * `nu` är en parameter och inte `new Date()` inuti, så ett test kan mäta mot
   * en bestämd tidpunkt i stället för mot när det råkade köras.
   */
  async forSubject(
    organizationId: string,
    subject: HistorySubjectRef,
    nu: Date = new Date(),
  ): Promise<GapResult[]> {
    await assertSubjectInOrg(this.prisma, organizationId, subject)

    const ut: GapResult[] = []
    for (const e of HISTORY_EXPECTATIONS) {
      if (e.source.kind === 'ODEFINIERAD') {
        // INGEN beräkning. Ingen gissning. Bara det ärliga svaret.
        ut.push({
          key: e.key,
          label: e.label,
          status: 'ODEFINIERAD',
          source: e.source,
          detail: `Ingen förväntan är definierad — ingen lucka kan beräknas. ${e.source.why}`,
        })
        continue
      }
      if (e.key === 'rent-notice-per-month')
        ut.push(await this.avierPerMånad(e, organizationId, subject, nu))
      if (e.key === 'scheduled-inspection-completed')
        ut.push(await this.planeradBesiktning(e, organizationId, subject, nu))
      if (e.key === 'maintenance-plan-interval')
        ut.push(await this.underhållsplan(e, organizationId, subject, nu))
    }
    return ut
  }

  async forTenant(
    organizationId: string,
    tenantId: string,
    nu: Date = new Date(),
  ): Promise<GapResult[]> {
    return this.forSubject(organizationId, { kind: 'TENANT', id: tenantId }, nu)
  }

  async forUnit(
    organizationId: string,
    unitId: string,
    nu: Date = new Date(),
  ): Promise<GapResult[]> {
    return this.forSubject(organizationId, { kind: 'UNIT', id: unitId }, nu)
  }

  async forProperty(
    organizationId: string,
    propertyId: string,
    nu: Date = new Date(),
  ): Promise<GapResult[]> {
    return this.forSubject(organizationId, { kind: 'PROPERTY', id: propertyId }, nu)
  }

  /** Avtalen förväntan prövas mot, per dimension. */
  private leaseVillkor(
    organizationId: string,
    subject: HistorySubjectRef,
  ): Record<string, unknown> {
    if (subject.kind === 'TENANT') return { organizationId, tenantId: subject.id }
    if (subject.kind === 'UNIT') return { organizationId, unitId: subject.id }
    return { organizationId, unit: { propertyId: subject.id } }
  }

  /** Besiktningarna förväntan prövas mot, per dimension. */
  private inspektionsVillkor(
    organizationId: string,
    subject: HistorySubjectRef,
  ): Record<string, unknown> {
    if (subject.kind === 'TENANT') return { organizationId, tenantId: subject.id }
    if (subject.kind === 'UNIT') return { organizationId, unitId: subject.id }
    return { organizationId, propertyId: subject.id }
  }

  /**
   * En RENT-avi per månad avtalet löpt.
   *
   * FÖNSTRET ÄR HELA POÄNGEN. Förväntan gäller bara månader avtalet faktiskt
   * var i kraft — från `tenancyStartDate` till avslut eller `nu`. Ett avtal som
   * började förra månaden får därför EN förväntad månad, inte tolv, och kan
   * inte ge en lucka för tiden innan det fanns. En regel som larmar på allt är
   * lika värdelös som en som aldrig larmar.
   *
   * Den innevarande månaden räknas INTE: avin för den kan vara på väg.
   */
  private async avierPerMånad(
    e: ExpectationDefinition,
    organizationId: string,
    subject: HistorySubjectRef,
    nu: Date,
  ): Promise<GapResult> {
    const leases = await this.prisma.lease.findMany({
      where: {
        ...this.leaseVillkor(organizationId, subject),
        status: { in: ['ACTIVE', 'EXPIRED', 'TERMINATED'] },
      },
      select: { id: true, tenancyStartDate: true, endDate: true, terminatedAt: true },
    })
    if (leases.length === 0) {
      return {
        key: e.key,
        label: e.label,
        status: 'GÄLLER_EJ',
        source: e.source,
        detail: 'Inget avtal har löpt här — ingen avi kan förväntas.',
      }
    }

    const notices = await this.prisma.rentNotice.findMany({
      where: { organizationId, type: 'RENT', leaseId: { in: leases.map((l) => l.id) } },
      select: { leaseId: true, year: true, month: true },
    })
    const finns = new Set(notices.map((n) => `${n.leaseId}:${n.year}-${n.month}`))

    let förväntade = 0
    const saknade: string[] = []
    for (const l of leases) {
      const slut = l.terminatedAt ?? l.endDate ?? nu
      // Sista HELA månaden före `nu` — innevarande månad är inte förfallen.
      const sista = slut < nu ? slut : new Date(Date.UTC(nu.getUTCFullYear(), nu.getUTCMonth(), 0))
      let år = l.tenancyStartDate.getUTCFullYear()
      let månad = l.tenancyStartDate.getUTCMonth() + 1
      while (
        år < sista.getUTCFullYear() ||
        (år === sista.getUTCFullYear() && månad <= sista.getUTCMonth() + 1)
      ) {
        förväntade++
        if (!finns.has(`${l.id}:${år}-${månad}`))
          saknade.push(`${år}-${String(månad).padStart(2, '0')}`)
        månad++
        if (månad > 12) {
          månad = 1
          år++
        }
      }
    }

    if (förväntade === 0) {
      return {
        key: e.key,
        label: e.label,
        status: 'GÄLLER_EJ',
        source: e.source,
        detail: 'Inget avtal har löpt en hel månad ännu — ingen avi är förfallen.',
      }
    }
    if (saknade.length === 0) {
      return {
        key: e.key,
        label: e.label,
        status: 'UPPFYLLD',
        source: e.source,
        detail: `Alla ${förväntade} förväntade avier finns.`,
      }
    }
    return {
      key: e.key,
      label: e.label,
      status: 'LUCKA',
      source: e.source,
      detail: `${saknade.length} av ${förväntade} förväntade avier saknas: ${saknade.sort().join(', ')}.`,
      missingCount: saknade.length,
    }
  }

  /** Planerad besiktning vars dag passerat utan att den utförts. */
  private async planeradBesiktning(
    e: ExpectationDefinition,
    organizationId: string,
    subject: HistorySubjectRef,
    nu: Date,
  ): Promise<GapResult> {
    const villkor = this.inspektionsVillkor(organizationId, subject)
    const alla = await this.prisma.inspection.count({ where: villkor })
    if (alla === 0) {
      return {
        key: e.key,
        label: e.label,
        status: 'GÄLLER_EJ',
        source: e.source,
        detail: 'Ingen besiktning är inplanerad — förväntan uppstår först när ett datum satts.',
      }
    }
    const försenade = await this.prisma.inspection.count({
      where: { ...villkor, scheduledDate: { lt: nu }, completedAt: null },
    })
    if (försenade === 0) {
      return {
        key: e.key,
        label: e.label,
        status: 'UPPFYLLD',
        source: e.source,
        detail: `Alla ${alla} inplanerade besiktningar med passerat datum är utförda.`,
      }
    }
    return {
      key: e.key,
      label: e.label,
      status: 'LUCKA',
      source: e.source,
      detail: `${försenade} inplanerad(e) besiktning(ar) har passerat sitt datum utan att utföras.`,
      missingCount: försenade,
    }
  }

  /** Underhållsplan vars intervall löpt ut, på de fastigheter subjektet rör. */
  private async underhållsplan(
    e: ExpectationDefinition,
    organizationId: string,
    subject: HistorySubjectRef,
    nu: Date,
  ): Promise<GapResult> {
    let propertyIds: string[]
    if (subject.kind === 'PROPERTY') {
      propertyIds = [subject.id]
    } else if (subject.kind === 'UNIT') {
      const unit = await this.prisma.unit.findFirst({
        where: { id: subject.id, property: { organizationId } },
        select: { propertyId: true },
      })
      propertyIds = unit ? [unit.propertyId] : []
    } else {
      const leases = await this.prisma.lease.findMany({
        where: { organizationId, tenantId: subject.id },
        select: { unit: { select: { propertyId: true } } },
      })
      propertyIds = [...new Set(leases.map((l) => l.unit.propertyId))]
    }
    if (propertyIds.length === 0) {
      return {
        key: e.key,
        label: e.label,
        status: 'GÄLLER_EJ',
        source: e.source,
        detail: 'Subjektet är inte kopplat till någon fastighet.',
      }
    }
    // `interval` och `lastDoneYear` är båda nullbara: en plan utan dem bär
    // ingen förväntan alls och ska inte räknas som uppfylld eller bruten.
    const planer = await this.prisma.maintenancePlan.findMany({
      where: {
        organizationId,
        propertyId: { in: propertyIds },
        interval: { not: null },
        lastDoneYear: { not: null },
      },
      select: { id: true, title: true, interval: true, lastDoneYear: true },
    })
    if (planer.length === 0) {
      return {
        key: e.key,
        label: e.label,
        status: 'GÄLLER_EJ',
        source: e.source,
        detail:
          'Ingen underhållsplan på fastigheten har både intervall och senast utfört-år ifyllt.',
      }
    }
    const år = nu.getUTCFullYear()
    const försenade = planer.filter((p) => (p.lastDoneYear as number) + (p.interval as number) < år)
    if (försenade.length === 0) {
      return {
        key: e.key,
        label: e.label,
        status: 'UPPFYLLD',
        source: e.source,
        detail: `Alla ${planer.length} planer med intervall ligger inom sin period.`,
      }
    }
    return {
      key: e.key,
      label: e.label,
      status: 'LUCKA',
      source: e.source,
      detail: försenade
        .map((p) => `${p.title}: senast ${p.lastDoneYear}, intervall ${p.interval} år`)
        .join('; '),
      missingCount: försenade.length,
    }
  }
}
