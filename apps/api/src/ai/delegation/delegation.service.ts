import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common'

import { PrismaService } from '../../common/prisma/prisma.service'
import { beräknaStatus } from './delegation-status'
import { delegerbaraVerktyg, kräverFrekvensvillkor, prövaDelegerbarhet } from './delegation-scope'
import { TYPFÄLT, förifylltVillkor, typenFörFörslaget, villkoretSnävas } from './delegation-birth'

import type { AiDelegation, Prisma, UserRole } from '@prisma/client'
import type { DelegationStatus } from './delegation-status'

/** Standardlivslängd. Ett beslut, inte en härledning ur någon annan konstant. */
export const DELEGATION_DAGAR = 90

/** Roller som får ge bort en rätt. Samma grind som skuggagentens växel. */
const FAR_DELEGERA: readonly UserRole[] = ['OWNER']

/** Villkorets form. `null` på delegationen betyder UTAN avgränsning. */
export interface DelegationVillkor {
  propertyId?: string
  unitId?: string
  kategori?: string
  maxBelopp?: number
}

/** Frekvensvillkorets form. */
export interface Frekvensvillkor {
  maxAntal: number
  periodDagar: number
}

/** Vad grinden får veta om det konkreta fallet. */
export interface DelegationKontext {
  propertyId?: string | undefined
  unitId?: string | undefined
  kategori?: string | undefined
  belopp?: number | undefined
}

export type DelegationsSvar =
  | { delegerad: true; delegationId: string }
  | {
      delegerad: false
      skäl:
        | 'INGEN_DELEGATION'
        | 'EJ_AKTIV'
        | 'VILLKORET_MATCHAR_INTE'
        | 'FREKVENSEN_ÖVERSKRIDEN'
        | 'EJ_DELEGERBART'
      text: string
    }

/**
 * DELEGATIONEN (G2, etapp 7).
 *
 * ── GRINDEN PRODUCERAR INGET BEVIS ──────────────────────────────────────────
 *
 * Planens Del 6, ordagrant: *"delegationen ska inte producera `ActionProof` utan
 * vara en separat `assertDelegated`. Två producenter av samma bevis är hur en
 * spärr blir otydlig."*
 *
 * `assertDelegated` svarar därför JA eller NEJ MED SKÄL, och returnerar bara
 * delegationens id. Den skriver ingenting, sätter ingen flagga och rör inte
 * `claimed`. Vem som helst kan fråga; ingen kan bli auktoriserad av att fråga.
 *
 * ── INGEN ANROPARE UTÖVER PROVEN, OCH DET ÄR AVSIKTLIGT ─────────────────────
 *
 * `ToolExecutorService` anropar inte den här tjänsten. Utföraren som skulle göra
 * det är etapp 8–9, och en grind utan anropare är ärligare än en grind som
 * anropas från en väg ingen prövat. Att den saknar anropare står i planen och
 * ska inte läsas som ett hål.
 */
@Injectable()
export class DelegationService {
  private readonly logger = new Logger(DelegationService.name)

  constructor(private readonly prisma: PrismaService) {}

  /** Mängden verktyg som alls kan delegeras. Härledd ur katalogen. */
  delegerbara(sänkorPerVerktyg: Record<string, unknown> = {}): string[] {
    return delegerbaraVerktyg(undefined, sänkorPerVerktyg)
  }

  /**
   * Skapa en delegation.
   *
   * Fail-closed i tre steg, alla FÖRE skrivningen: rollen, delegerbarheten och
   * frekvensvillkoret. En delegation som inte får finnas ska inte kunna skapas —
   * inte upptäckas när den används.
   */
  async skapa(
    organizationId: string,
    input: {
      toolName: string
      villkor?: DelegationVillkor | null
      frekvensvillkor?: Frekvensvillkor | null
      expiresAt?: Date
      bornFromAssignmentId?: string
    },
    aktör: { userId: string; roll: UserRole },
    sänkorPerVerktyg: Record<string, unknown> = {},
  ): Promise<AiDelegation> {
    if (!FAR_DELEGERA.includes(aktör.roll)) {
      throw new ForbiddenException('Bara organisationens ägare får delegera till agenten.')
    }

    const d = prövaDelegerbarhet(input.toolName, undefined, sänkorPerVerktyg)
    if (!d.delegerbar) throw new BadRequestException(d.text)

    // FREKVENSVILLKORET ÄR OBLIGATORISKT FÖR DEDUPLICERBARA VERKTYG. En
    // omkörning ger då en andra rad, och en delegation utan tak hade gjort en
    // obevakad loop till en obegränsad.
    if (kräverFrekvensvillkor(input.toolName) && !giltigFrekvens(input.frekvensvillkor)) {
      throw new BadRequestException(
        `Verktyget ${input.toolName} är DEDUPLICERBAR — en omkörning ger en andra rad. ` +
          'En delegation för det kräver ett frekvensvillkor: { maxAntal, periodDagar }.',
      )
    }

    const expiresAt =
      input.expiresAt ?? new Date(Date.now() + DELEGATION_DAGAR * 24 * 60 * 60 * 1000)
    if (expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException('Delegationens tidsgräns måste ligga i framtiden.')
    }

    const scope = kopieraScope(input.toolName)

    return this.prisma.aiDelegation.create({
      data: {
        organizationId,
        toolName: input.toolName,
        // KOPIERAD, inte uppslagen vid läsning: hyresvärden gav rätt till något,
        // och vad det var får inte skrivas om i efterhand.
        authorityScope: scope,
        // Spridd och inte satt till `undefined`: med `exactOptionalPropertyTypes`
        // är "fältet saknas" och "fältet är undefined" olika saker för Prisma.
        ...(input.villkor ? { villkor: input.villkor as unknown as Prisma.InputJsonObject } : {}),
        ...(input.frekvensvillkor
          ? { frekvensvillkor: input.frekvensvillkor as unknown as Prisma.InputJsonObject }
          : {}),
        expiresAt,
        createdByUserId: aktör.userId,
        ...(input.bornFromAssignmentId ? { bornFromAssignmentId: input.bornFromAssignmentId } : {}),
        events: {
          create: {
            type: 'CREATED',
            // En människa gav rätten. Aldrig SYSTEM — det hade varit en maskin
            // som påstod sig ha fått rätten av sig själv.
            handlingAv: 'HUMAN',
            actorUserId: aktör.userId,
          },
        },
      },
    })
  }

  /**
   * ── "GÖR ALLTID DETTA" — delegationen föds ur ett godkänt förslag ─────────
   *
   * Planens Del 6: *"Vägen är: observation → förslag → mänskligt tryck →
   * delegation. Först när människan trycker Gör alltid detta får en delegation
   * skapas."* Den här metoden är det trycket, och den är den ENDA vägen till en
   * delegation som bär `bornFromAssignmentId`.
   *
   * ── VARFÖR DET ANDRA GODKÄNNANDET, INTE DET FÖRSTA ───────────────────────
   *
   * Planens exempel är *"du har godkänt det här sju gånger"* — ett MÖNSTER, inte
   * en händelse. Ett enda ja kan vara ett undantag; två är en vana. Kravet är
   * satt till två därför att det är det minsta tal som alls kan skilja de två
   * åt, och därför att en högre tröskel hade gjort funktionen oåtkomlig för en
   * hyresvärd med få ärenden — den som mest behöver automatiseringen.
   *
   * Villkoret prövas i TJÄNSTEN och inte i knappen: en grå knapp är en artighet,
   * och `POST` går att anropa utan den.
   */
  async skapaUrFörslag(
    organizationId: string,
    assignmentId: string,
    aktör: { userId: string; roll: UserRole },
    val: { villkor?: DelegationVillkor; frekvensvillkor?: Frekvensvillkor } = {},
    sänkorPerVerktyg: Record<string, unknown> = {},
  ): Promise<AiDelegation> {
    if (!FAR_DELEGERA.includes(aktör.roll)) {
      throw new ForbiddenException('Bara organisationens ägare får delegera till agenten.')
    }

    const a = await this.prisma.aiAssignment.findFirst({
      where: { id: assignmentId, organizationId },
      select: {
        id: true,
        toolName: true,
        status: true,
        prediction: true,
        propertyId: true,
        unitId: true,
        decidedByUserId: true,
        createdAt: true,
      },
    })
    // 404 och inte 403 för en annan organisations id: ett id i en annan org ska
    // inte gå att skilja från ett påhittat.
    if (!a) throw new NotFoundException('Förslaget hittades inte.')

    if (a.status !== 'APPROVED') {
      throw new ConflictException(
        'Bara ett GODKÄNT förslag kan bli en delegation. Godkänn förslaget först.',
      )
    }
    // En människa måste ha sagt ja. `decidedByUserId` sätts bara av `besluta`,
    // som nås enbart från `@Patch(':id/decision')` med `user.sub` — det finns
    // ingen AI-väg dit.
    if (!a.decidedByUserId) {
      throw new ConflictException(
        'Förslaget saknar en människas beslut och kan inte bli en delegation.',
      )
    }

    const d = prövaDelegerbarhet(a.toolName, undefined, sänkorPerVerktyg)
    if (!d.delegerbar) throw new BadRequestException(d.text)

    const typ = typenFörFörslaget(a.prediction)
    if (!typ) {
      // Ett förslag utan typ kan inte bli "gör alltid så här för DEN HÄR typen".
      // Utan typen vore rätten "det här verktyget, alltid", vilket är något helt
      // annat än det hyresvärden såg.
      throw new ConflictException(
        `Förslaget saknar ${TYPFÄLT} och kan därför inte bli en delegation för en TYP av ärende.`,
      )
    }

    // ── IDEMPOTENSEN ────────────────────────────────────────────────────────
    // Samma förslag två gånger ger EN delegation. Prövas här och inte med ett
    // unikt index, därför att `bornFromAssignmentId` är nullbar och ett index
    // över den hade förbjudit flera delegationer utan ursprung.
    const redan = await this.prisma.aiDelegation.findFirst({
      where: { organizationId, bornFromAssignmentId: a.id },
      select: { id: true },
    })
    if (redan) {
      throw new ConflictException('Det här förslaget har redan blivit en delegation.')
    }

    // ── MÖNSTRET: MINST ETT TIDIGARE GODKÄNNANDE AV SAMMA VERKTYG OCH TYP ───
    const tidigare = await this.prisma.aiAssignment.findMany({
      where: {
        organizationId,
        toolName: a.toolName,
        status: 'APPROVED',
        decidedByUserId: { not: null },
        id: { not: a.id },
      },
      select: { prediction: true },
    })
    const antalSammaTyp = tidigare.filter((t) => typenFörFörslaget(t.prediction) === typ).length
    if (antalSammaTyp < 1) {
      throw new ConflictException(
        `Du har godkänt det här en gång. En delegation skapas först när du godkänt ` +
          `samma typ av förslag (${a.toolName}, ${typ}) en gång till.`,
      )
    }

    // ── SCOPE FÖRIFYLLT UR FALLET, OCH BARA SNÄVBART ────────────────────────
    const förifyllt = förifylltVillkor(a)
    const villkor = val.villkor ?? förifyllt
    const fel = villkoretSnävas(förifyllt, villkor)
    if (fel.length > 0) {
      throw new BadRequestException(`Villkoret får bara snävas, aldrig vidgas. ${fel.join(' ')}`)
    }

    return this.skapa(
      organizationId,
      {
        toolName: a.toolName,
        villkor,
        ...(val.frekvensvillkor ? { frekvensvillkor: val.frekvensvillkor } : {}),
        bornFromAssignmentId: a.id,
      },
      aktör,
      sänkorPerVerktyg,
    )
  }

  /**
   * Kan det här förslaget bli en delegation just nu?
   *
   * Läsytans fråga — knappen är grå tills svaret är ja. Samma villkor som
   * `skapaUrFörslag` prövar, men utan att skriva: en grå knapp är en artighet,
   * spärren ligger i tjänsten.
   */
  async kanBliDelegation(
    organizationId: string,
    assignmentId: string,
    sänkorPerVerktyg: Record<string, unknown> = {},
  ): Promise<{ kan: boolean; skäl?: string; förifylltVillkor?: DelegationVillkor }> {
    try {
      const a = await this.prisma.aiAssignment.findFirst({
        where: { id: assignmentId, organizationId },
        select: {
          id: true,
          toolName: true,
          status: true,
          prediction: true,
          propertyId: true,
          unitId: true,
          decidedByUserId: true,
        },
      })
      if (!a) return { kan: false, skäl: 'Förslaget hittades inte.' }
      if (a.status !== 'APPROVED' || !a.decidedByUserId)
        return { kan: false, skäl: 'Förslaget är inte godkänt av en människa.' }
      const d = prövaDelegerbarhet(a.toolName, undefined, sänkorPerVerktyg)
      if (!d.delegerbar) return { kan: false, skäl: d.text }
      const typ = typenFörFörslaget(a.prediction)
      if (!typ) return { kan: false, skäl: `Förslaget saknar ${TYPFÄLT}.` }
      const redan = await this.prisma.aiDelegation.findFirst({
        where: { organizationId, bornFromAssignmentId: a.id },
        select: { id: true },
      })
      if (redan) return { kan: false, skäl: 'Det här förslaget har redan blivit en delegation.' }
      const tidigare = await this.prisma.aiAssignment.findMany({
        where: {
          organizationId,
          toolName: a.toolName,
          status: 'APPROVED',
          decidedByUserId: { not: null },
          id: { not: a.id },
        },
        select: { prediction: true },
      })
      if (tidigare.filter((t) => typenFörFörslaget(t.prediction) === typ).length < 1)
        return {
          kan: false,
          skäl: 'Aktiveras efter att du godkänt samma typ av förslag en gång till.',
        }
      return { kan: true, förifylltVillkor: förifylltVillkor(a) }
    } catch {
      // Fail-closed: en fråga som inte gick att besvara är inte ett ja.
      return { kan: false, skäl: 'Kunde inte avgöra just nu.' }
    }
  }

  /** En händelse på en delegation. Append-only — raden skrivs, aldrig om. */
  private async skrivHändelse(
    delegationId: string,
    type: 'PAUSED' | 'RESUMED' | 'REVOKED' | 'EXPIRED' | 'EXTENDED',
    aktör: { kind: 'HUMAN' | 'SYSTEM'; userId?: string | undefined },
    note?: string,
  ): Promise<void> {
    await this.prisma.aiDelegationEvent.create({
      data: {
        delegationId,
        type,
        handlingAv: aktör.kind,
        ...(aktör.userId ? { actorUserId: aktör.userId } : {}),
        ...(note ? { note } : {}),
      },
    })
  }

  /** Återkalla. Slutgiltigt — och ett skäl är minnesmat. */
  async återkalla(
    organizationId: string,
    id: string,
    aktör: { userId: string; roll: UserRole },
    skäl?: string,
  ): Promise<void> {
    if (!FAR_DELEGERA.includes(aktör.roll)) {
      throw new ForbiddenException('Bara organisationens ägare får återkalla en delegation.')
    }
    const d = await this.prisma.aiDelegation.findFirst({
      where: { id, organizationId },
      select: { id: true },
    })
    if (!d) throw new BadRequestException('Delegationen hittades inte.')
    await this.skrivHändelse(id, 'REVOKED', { kind: 'HUMAN', userId: aktör.userId }, skäl)
  }

  /**
   * Pausa alla delegationer i en organisation — när skuggagenten slås av.
   *
   * PAUSAD OCH INTE ÅTERKALLAD, och det är beslutet: att stänga av växeln är
   * inte att ta tillbaka en rättighet. Hyresvärden som slår på den igen ska få
   * tillbaka det hen gav, inte behöva ge det på nytt — och historiken ska visa
   * att pausen var systemets, inte människans.
   */
  async pausaAlla(organizationId: string): Promise<number> {
    return this.växlaAlla(organizationId, 'PAUSED', 'AKTIV')
  }

  /** Återuppta alla pausade. Motsatsen till `pausaAlla`. */
  async återupptaAlla(organizationId: string): Promise<number> {
    return this.växlaAlla(organizationId, 'RESUMED', 'PAUSAD')
  }

  private async växlaAlla(
    organizationId: string,
    type: 'PAUSED' | 'RESUMED',
    frånStatus: DelegationStatus,
  ): Promise<number> {
    const rader = await this.prisma.aiDelegation.findMany({
      where: { organizationId },
      select: { id: true, expiresAt: true, events: { select: { type: true, createdAt: true } } },
    })
    let n = 0
    for (const r of rader) {
      // BARA de som faktiskt står i utgångsläget. Utan det hade en omkörning
      // skrivit en andra PAUSED på en redan pausad delegation, och historiken
      // hade fått händelser som inte motsvarar något som hände.
      if (beräknaStatus(r.events, r.expiresAt) !== frånStatus) continue
      await this.skrivHändelse(r.id, type, { kind: 'SYSTEM' })
      n++
    }
    if (n > 0) this.logger.log(`[delegation] ${type} för ${n} delegationer i ${organizationId}.`)
    return n
  }

  /**
   * ── GRINDEN ────────────────────────────────────────────────────────────────
   *
   * Svarar JA eller NEJ MED SKÄL. Producerar inget bevis, skriver ingenting.
   *
   * Ordningen är billigast först och mest specifik sist, men den bär också
   * mening: `EJ_DELEGERBART` prövas FÖRE uppslaget, så att en delegation som
   * blivit ogiltig av en katalogändring nekas även om raden finns kvar.
   */
  async assertDelegated(
    organizationId: string,
    toolName: string,
    kontext: DelegationKontext = {},
    nu: Date = new Date(),
    sänkorPerVerktyg: Record<string, unknown> = {},
  ): Promise<DelegationsSvar> {
    const d = prövaDelegerbarhet(toolName, undefined, sänkorPerVerktyg)
    if (!d.delegerbar) {
      return { delegerad: false, skäl: 'EJ_DELEGERBART', text: d.text }
    }

    const kandidater = await this.prisma.aiDelegation.findMany({
      where: { organizationId, toolName },
      select: {
        id: true,
        villkor: true,
        frekvensvillkor: true,
        expiresAt: true,
        events: { select: { type: true, createdAt: true } },
      },
    })
    if (kandidater.length === 0) {
      return {
        delegerad: false,
        skäl: 'INGEN_DELEGATION',
        text: `Ingen delegation finns för ${toolName} i organisationen.`,
      }
    }

    const aktiva = kandidater.filter((k) => beräknaStatus(k.events, k.expiresAt, nu) === 'AKTIV')
    if (aktiva.length === 0) {
      return {
        delegerad: false,
        skäl: 'EJ_AKTIV',
        text: `Delegationen för ${toolName} är pausad, återkallad eller utgången.`,
      }
    }

    const matchande = aktiva.filter((k) =>
      villkoretMatchar(k.villkor as DelegationVillkor | null, kontext),
    )
    if (matchande.length === 0) {
      return {
        delegerad: false,
        skäl: 'VILLKORET_MATCHAR_INTE',
        text: `Delegationen för ${toolName} täcker inte det här fallet.`,
      }
    }

    for (const k of matchande) {
      const f = k.frekvensvillkor as Frekvensvillkor | null
      if (!f) return { delegerad: true, delegationId: k.id }
      const från = new Date(nu.getTime() - f.periodDagar * 24 * 60 * 60 * 1000)
      // Räknas på UTFÖRANDEN som pekar på delegationen, inte på försök. Ett
      // nekat anrop ska inte förbruka kvoten — annars kan en trasig anropare
      // tysta en giltig delegation.
      const antal = await this.prisma.aiToolExecution.count({
        where: { organizationId, delegationId: k.id, createdAt: { gte: från } },
      })
      if (antal < f.maxAntal) return { delegerad: true, delegationId: k.id }
    }

    return {
      delegerad: false,
      skäl: 'FREKVENSEN_ÖVERSKRIDEN',
      text: `Delegationen för ${toolName} har nått sitt tak för perioden.`,
    }
  }
}

/** Katalogens scope, kopierat vid skapandet. */
function kopieraScope(toolName: string): string {
  // Importeras lokalt för att hålla modulens toppimporter fria från katalogen
  // i den heta vägen — och för att göra det uppenbart att värdet är en KOPIA.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EFFECT_DECLARATIONS } = require('../tools/effect-idempotency') as {
    EFFECT_DECLARATIONS: Record<string, { authorityScope: string }>
  }
  return EFFECT_DECLARATIONS[toolName]?.authorityScope ?? 'EGEN_ORG'
}

export function giltigFrekvens(f: Frekvensvillkor | null | undefined): f is Frekvensvillkor {
  return (
    !!f &&
    Number.isInteger(f.maxAntal) &&
    f.maxAntal > 0 &&
    Number.isInteger(f.periodDagar) &&
    f.periodDagar > 0
  )
}

/**
 * Matchar villkoret kontexten?
 *
 * `null` betyder UTAN AVGRÄNSNING och matchar allt — det är lagligt och mycket
 * bredare än det fall delegationen föddes ur, och läsytan ska säga det i
 * klartext. Ett tomt objekt `{}` behandlas likadant, men det är en form
 * skapandet inte producerar.
 *
 * Varje SATT nyckel måste matcha. Ett villkor som anger `propertyId` men får en
 * kontext utan `propertyId` matchar INTE — fail-closed: en okänd kontext ska
 * inte kunna passera en avgränsning genom att utelämna fältet den avgränsar på.
 */
export function villkoretMatchar(
  villkor: DelegationVillkor | null,
  kontext: DelegationKontext,
): boolean {
  if (!villkor) return true
  if (villkor.propertyId !== undefined && villkor.propertyId !== kontext.propertyId) return false
  if (villkor.unitId !== undefined && villkor.unitId !== kontext.unitId) return false
  if (villkor.kategori !== undefined && villkor.kategori !== kontext.kategori) return false
  if (villkor.maxBelopp !== undefined) {
    // Ett belopp som saknas kan inte prövas mot ett tak. Fail-closed.
    if (kontext.belopp === undefined) return false
    if (kontext.belopp > villkor.maxBelopp) return false
  }
  return true
}
