import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'

import { PrismaService } from '../../common/prisma/prisma.service'
import { CronErrorSink } from '../../common/cron/cron-error-sink'
import { runCronSafely } from '../../common/cron/cron-safety'
import { LockService } from '../../common/redis/lock.service'
import { NotificationsService } from '../../notifications/notifications.service'
import { ångravägen, type Ångravägen } from './undo-hint'
import { prövaDuglighet } from './assignment-eligibility'
import { traffgradPerFalt, type Traffgrad } from '../shadow/shadow-fields'
import { SKUGGFALT_BETALNING } from '../shadow/payment/payment-fields'
import { ReconciliationService } from '../../reconciliation/reconciliation.service'
import { INKORG_SIDSTORLEK_MAX, INKORG_SIDSTORLEK_STANDARD } from './dto/query-assignments.dto'

import { Prisma } from '@prisma/client'

import type { AiAssignment } from '@prisma/client'

/**
 * UPPDRAGSKÖN — den persistenta, serverburna varianten av "AI:n föreslår,
 * människan bestämmer".
 *
 * ── VAD DEN HÄR TJÄNSTEN INTE KAN SE ────────────────────────────────────────
 *
 * Den skapar, visar, beslutar och låter förfalla. Den UTFÖR ingenting: det
 * finns ingen kodväg härifrån till `ToolExecutorService`, ingen import av den,
 * och inget läge som kan flippas. `APPROVED` är därför ett tillstånd som väntar
 * på en utförare som byggs i etapp 8–9.
 *
 * Den vet heller ingenting om huruvida uppdragets förutsättningar fortfarande
 * håller. Omprövningen sker FÖRE effekten och hör hemma hos utföraren; grinden
 * här är den vid skapandet (`assignment-eligibility.ts`), som avgör om ett
 * uppdrag för verktyget alls får finnas.
 *
 * ── OCH INGENTING PRODUCERAR UPPDRAG ÄN ─────────────────────────────────────
 *
 * Det är avsiktligt och ska inte läsas som ett hål. Producenten är etapp 8–9.
 * En tom kö med en läsare är ärlig; en full kö utan läsare är det tysta stoppet
 * vi rensat bort. Läsytan säger det rakt ut i sitt tomma tillstånd.
 */

/** Låsets livslängd för utgångspasset. Passet tar millisekunder. */
const LAS_TTL_SEC = 60

/** Hur många utgångna uppdrag ett pass stänger. Ett tak som SYNS — se nedan. */
export const UTGANG_BATCH = 500

/**
 * Hur många besvarade förslag träffgraden räknar på.
 *
 * Ett tak, och det står här därför att jämförelsen sker i minnet: `prediction`
 * och `outcome` är JSON och jämförs per fält. Talet är MEDVETET inte samma som
 * `UTGANG_BATCH` — de svarar på olika frågor (hur många som stängs per pass mot
 * hur många som mäts), och en delad konstant hade flyttat den ena varje gång
 * någon justerade den andra.
 */
export const TRAFFGRAD_TAK = 1000

export interface SkapaUppdrag {
  toolName: string
  toolInput: Prisma.InputJsonValue
  title: string
  reasoning: string
  consequence: string
  undoHint: string
  evidence?: Prisma.InputJsonValue
  /**
   * UPPDRAGETS EGEN TIDSGRÄNS. Obligatorisk, utan default.
   *
   * Det finns med flit ingen modulkonstant att falla tillbaka på. En
   * rörmokarbokning och ett hyreshöjningsbesked har olika brådska, och ett tal
   * för båda blir fel för minst en. Den som skapar uppdraget vet vilken brådska
   * det har; den här filen gör det inte.
   *
   * Och gränsen får inte härledas ur `PENDING_ACTION_TTL_MS` — den konstanten
   * är redan dubbelanvänd av återupptagningsmotorns tak, så en tredje
   * användning hade flyttat det taket varje gång någon justerade uppdragens
   * gräns. `check-assignment-deadline.mjs` fäller den härledningen.
   */
  deadline: Date
  assignedToUserId: string

  /**
   * UPPDRAGETS OMFÅNG — vad det handlar om. Alla tre valfria.
   *
   * Sätts av producenten ur det den redan vet, och är det som gör uppdraget
   * synligt i hyresgästens, lägenhetens och fastighetens historik. Utelämnas
   * de betyder det "rör inget enskilt objekt" — sant för 17 av de 23 dugliga
   * verktygen (`generate_rent_notices`, `export_sie4`, `import_bgmax_file` …).
   * Uppdraget finns då kvar i kön och i läsytan; det syns bara inte i någon
   * objekthistorik.
   *
   * De HÄRLEDS med flit inte ur `toolInput`. Mätt mot `71d2998`: bara sex av de
   * 23 har någon av `tenantId`/`unitId`/`propertyId` i sitt inputschema, så en
   * härledning hade varit blind för tre fjärdedelar av kön — och blind på det
   * tysta sättet.
   */
  tenantId?: string
  unitId?: string
  propertyId?: string
}

/**
 * DOMENS DELEGATION, MED I LÄSYTAN.
 *
 * Kortet ska kunna säga *"hade utförts enligt din delegation för X, avgränsad
 * till Y"* — inte bara att en dom finns. Utan villkoret hade läsytan tvingat
 * hyresvärden att öppna en annan sida för att förstå vilken rätt som åberopades,
 * och ett facit man måste slå upp är inget facit.
 *
 * BARA den säkra delmängden väljs: `villkor` och `expiresAt`. Delegationen bär
 * inget känsligt, men en `include` utan `select` växer tyst med varje ny kolumn.
 */
export type UppdragMedDom = AiAssignment & {
  verdictDelegation: { id: string; villkor: Prisma.JsonValue; expiresAt: Date } | null
}

const DOM_INCLUDE = {
  verdictDelegation: { select: { id: true, villkor: true, expiresAt: true } },
} as const

@Injectable()
export class AiAssignmentsService {
  private readonly logger = new Logger(AiAssignmentsService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly locks: LockService,
    private readonly cronErrors: CronErrorSink,
    // ── AGENT 2: ETT JA UTFÖR MATCHNINGEN ────────────────────────────────
    //
    // Och det sker genom avstämningens EGEN tjänstemetod (`manualMatch`), med
    // den godkännande människan som aktör. Det är avsiktligt att det inte finns
    // någon andra skrivväg: en `PAYMENT_MATCH_PROPOSAL` som godkänns är exakt
    // det som händer när samma människa trycker Matcha i /reconciliation —
    // bara startad från en annan skärm. En egen matchningsimplementation här
    // hade varit en andra väg förbi radlåset, status-guarden och
    // verifikatskrivningen.
    //
    // `AiModule` importerar redan `ReconciliationModule`, och avstämningen
    // importerar aldrig AI-lagret (den når skuggkön genom `@Global`). Riktningen
    // är alltså oförändrad och det finns ingen modulcykel.
    private readonly reconciliation: ReconciliationService,
  ) {}

  /**
   * Skapa ett uppdrag. FAIL-CLOSED: grinden sitter här, inte vid utförandet.
   */
  async skapa(organizationId: string, input: SkapaUppdrag): Promise<AiAssignment> {
    const duglighet = prövaDuglighet(input.toolName)
    if (!duglighet.duglig) {
      // Grinden svarar med SITT EGET skäl, inte med en allmän avvisning. Den
      // som får felet ska kunna se vilken av de tre spärrarna som föll.
      throw new BadRequestException(duglighet.text)
    }

    // Tidsgränsen prövas mot NU, inte mot ett tak. Ett uppdrag vars gräns redan
    // passerat vore fött förfallet — och hade behövt notifieras om sitt eget
    // förfall i samma andetag.
    if (!(input.deadline instanceof Date) || Number.isNaN(input.deadline.getTime())) {
      throw new BadRequestException('Uppdraget saknar en giltig tidsgräns.')
    }
    if (input.deadline.getTime() <= Date.now()) {
      throw new BadRequestException('Uppdragets tidsgräns måste ligga i framtiden.')
    }

    // Mottagaren måste finnas I ORGANISATIONEN. Utan den kontrollen kan ett
    // uppdrag adresseras till en användare i en annan tenant, och läsytan hade
    // då visat det för fel person.
    const mottagare = await this.prisma.user.findFirst({
      where: { id: input.assignedToUserId, organizationId },
      select: { id: true },
    })
    if (!mottagare) {
      throw new BadRequestException('Mottagaren finns inte i organisationen.')
    }

    // OMFÅNGET MÅSTE LIGGA I ORGANISATIONEN, av samma skäl som mottagaren.
    // Utan kontrollen kan ett uppdrag peka på en annan organisations hyresgäst;
    // historikläsningen är visserligen org-scopad och hade inte visat raden,
    // men FK:n hade ändå bundit två organisationer till varandra — och en
    // felskriven producent hade inte fått veta det förrän någon undrade varför
    // uppdraget inte syns någonstans.
    //
    // `Unit` bär ingen egen `organizationId` — den scopas via sin fastighet,
    // samma villkor som `assertSubjectInOrg` använder.
    await this.prövaOmfång(organizationId, input)

    const uppdrag = await this.prisma.aiAssignment.create({
      data: {
        organizationId,
        toolName: input.toolName,
        toolInput: input.toolInput,
        title: input.title,
        reasoning: input.reasoning,
        consequence: input.consequence,
        undoHint: input.undoHint,
        evidence: input.evidence ?? [],
        deadline: input.deadline,
        assignedToUserId: input.assignedToUserId,
        tenantId: input.tenantId ?? null,
        unitId: input.unitId ?? null,
        propertyId: input.propertyId ?? null,
      },
    })

    // KALLELSEN. Uppdragsraden är sanningen, notisen är puffen till den — och
    // den är hela skälet till att kön inte är en tabell ingen läser.
    await this.notifications.create(
      organizationId,
      input.assignedToUserId,
      'AI_ASSIGNMENT_AWAITING',
      'Ett uppdrag väntar på ditt beslut',
      uppdrag.title,
      { relatedEntityType: 'AI_ASSIGNMENT', relatedEntityId: uppdrag.id },
    )

    return uppdrag
  }

  /**
   * Omfångets tre id:n, vart och ett prövat mot organisationen.
   *
   * Ett id som inte finns i organisationen avvisas — det är ett
   * programmeringsfel hos producenten, inte ett tillstånd att tolerera.
   */
  private async prövaOmfång(organizationId: string, input: SkapaUppdrag): Promise<void> {
    if (input.tenantId) {
      const finns = await this.prisma.tenant.findFirst({
        where: { id: input.tenantId, organizationId },
        select: { id: true },
      })
      if (!finns) throw new BadRequestException('Hyresgästen finns inte i organisationen.')
    }
    if (input.unitId) {
      const finns = await this.prisma.unit.findFirst({
        where: { id: input.unitId, property: { organizationId } },
        select: { id: true },
      })
      if (!finns) throw new BadRequestException('Lägenheten finns inte i organisationen.')
    }
    if (input.propertyId) {
      const finns = await this.prisma.property.findFirst({
        where: { id: input.propertyId, organizationId },
        select: { id: true },
      })
      if (!finns) throw new BadRequestException('Fastigheten finns inte i organisationen.')
    }
  }

  /**
   * Organisationens uppdrag, närmast deadline först.
   *
   * ── TAKET SYNS, DET KRYMPER INTE TYST ─────────────────────────────────────
   *
   * Den gamla formen returnerade `take: 200` utan att säga hur många som fanns.
   * En inkorg med 201 förslag hade sett ut att ha 200, och skillnaden hade varit
   * osynlig för den som läser. Svaret bär nu `total` från en egen `count`, så en
   * trunkering går att LÄSA i stället för att gissa — samma hållning som
   * utgångspassets `kandidater`.
   */

  async lista(
    organizationId: string,
    filter: {
      status?: AiAssignment['status']
      shadow?: boolean
      limit?: number
      offset?: number
    } = {},
  ): Promise<{ rader: UppdragMedDom[]; total: number; limit: number; offset: number }> {
    const limit = Math.min(filter.limit ?? INKORG_SIDSTORLEK_STANDARD, INKORG_SIDSTORLEK_MAX)
    const offset = filter.offset ?? 0
    const where = {
      organizationId,
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.shadow === undefined ? {} : { shadow: filter.shadow }),
    }
    const [rader, total] = await Promise.all([
      this.prisma.aiAssignment.findMany({
        where,
        orderBy: [{ status: 'asc' }, { deadline: 'asc' }],
        take: limit,
        skip: offset,
        include: DOM_INCLUDE,
      }),
      this.prisma.aiAssignment.count({ where }),
    ])
    return { rader, total, limit, offset }
  }

  /**
   * ── "GJORT": DE UTFÖRDA ÅTGÄRDERNA ────────────────────────────────────────
   *
   * En EGEN metod och inte ett filter i `lista`. De två frågorna skiljer sig i
   * mer än ett `where`: den här bär vad som faktiskt hände (spårets id, vilken
   * delegation, när) och ÅNGRAVÄGEN, som `lista` varken behöver eller ska
   * beräkna för hundra väntande rader.
   *
   * Sorterad på `decidedAt` fallande — nyast först. Väntande uppdrag sorteras på
   * `deadline` stigande, för där är frågan "vad brådskar"; här är den "vad hände
   * nyss", och det är olika ordningar av olika skäl.
   */
  async gjorda(
    organizationId: string,
    filter: { limit?: number; offset?: number } = {},
  ): Promise<{
    rader: Array<UppdragMedDom & { ångra: Ångravägen; ångraBegärd: Date | null }>
    total: number
    limit: number
    offset: number
  }> {
    const limit = Math.min(filter.limit ?? INKORG_SIDSTORLEK_STANDARD, INKORG_SIDSTORLEK_MAX)
    const offset = filter.offset ?? 0
    // ALLA TRE UTFÖRANDESTATUSARNA. En sektion som bara visar `EXECUTED` hade
    // sagt att agenten aldrig misslyckas — och `FAILED`/`LAPSED` är precis det
    // hyresvärden behöver se för att lita på växeln.
    const where = {
      organizationId,
      status: { in: ['EXECUTED', 'FAILED', 'LAPSED'] as AiAssignment['status'][] },
    }
    const [rader, total] = await Promise.all([
      this.prisma.aiAssignment.findMany({
        where,
        orderBy: [{ decidedAt: 'desc' }],
        take: limit,
        skip: offset,
        include: {
          ...DOM_INCLUDE,
          delegation: { select: { id: true, toolName: true, villkor: true } },
          events: {
            where: { type: 'UNDO_REQUESTED' as const },
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: { createdAt: true },
          },
        },
      }),
      this.prisma.aiAssignment.count({ where }),
    ])
    return {
      rader: rader.map((r) => ({
        ...r,
        ångra: ångravägen(r.toolName),
        // FÖRSTA begäran räknas: fältet svarar på "har någon redan sagt ifrån",
        // inte på "hur många gånger". Listan är `take: 1` fallande, så raden
        // bär den SENASTE — och för den frågan duger vilken som helst.
        ångraBegärd: r.events[0]?.createdAt ?? null,
      })),
      total,
      limit,
      offset,
    }
  }

  /**
   * ÅNGRA-BEGÄRAN — en händelse, aldrig en backning.
   *
   * Skälet står i `undo-hint.ts`: att anropa varje verktygs `supportsUndo`-väg
   * generiskt hade varit en andra utförandeväg utan någon av grindarna.
   *
   * IDEMPOTENT PÅ EFFEKTEN, inte på raden: en andra begäran skriver en andra
   * händelse (append-only, och två gånger betyder något — hyresvärden sa ifrån
   * igen), men svaret är detsamma. Ingen räknare, inget tak.
   */
  async begärÅngra(
    organizationId: string,
    id: string,
    användare: { userId: string },
    note?: string,
  ): Promise<{ ångra: Ångravägen }> {
    const rad = await this.prisma.aiAssignment.findFirst({
      where: { id, organizationId },
      select: { id: true, toolName: true, status: true },
    })
    if (!rad) throw new NotFoundException('Uppdraget hittades inte.')
    // BARA en UTFÖRD åtgärd går att ångra. En som misslyckades eller förföll har
    // ingen effekt att backa, och en knapp där hade lovat något som inte finns.
    if (rad.status !== 'EXECUTED') {
      throw new BadRequestException('Bara en utförd åtgärd går att ångra. Den här utfördes aldrig.')
    }
    await this.prisma.aiAssignmentEvent.create({
      data: {
        assignmentId: rad.id,
        type: 'UNDO_REQUESTED',
        // HANDLINGEN är människans, även om systemet skriver raden. Se
        // `AiDelegationEvent` för varför fältet inte heter `actorKind`.
        handlingAv: 'HUMAN',
        actorUserId: användare.userId,
        ...(note ? { note } : {}),
      },
    })
    this.logger.log(`[inkorg] ångra begärd för uppdrag ${rad.id} (${rad.toolName}).`)
    return { ångra: ångravägen(rad.toolName) }
  }

  /**
   * ETT uppdrag, org-scopat.
   *
   * Kastar 404 för ett id i en annan organisation — samma svar som för ett id
   * som inte finns alls, så att en främmande org:s id inte går att skilja från
   * ett påhittat.
   */
  async hamta(organizationId: string, id: string): Promise<UppdragMedDom> {
    const rad = await this.prisma.aiAssignment.findFirst({
      where: { id, organizationId },
      include: DOM_INCLUDE,
    })
    if (!rad) throw new NotFoundException('Uppdraget hittades inte.')
    return rad
  }

  /**
   * SAMMANFATTNINGEN som inkorgens KPI-kort läser.
   *
   * BERÄKNAD, aldrig lagrad — samma hållning som "skuld är ett beräknat
   * tillstånd". En lagrad räknare hade kunnat glida isär från raderna den
   * påstod sig sammanfatta, och avvikelsen hade varit osynlig.
   */
  async sammanfattning(
    organizationId: string,
    shadow?: boolean,
  ): Promise<{
    status: Record<AiAssignment['status'], number>
    traffgrad: Record<string, Traffgrad>
    traffgradBetalningar: Record<string, Traffgrad>
  }> {
    // TYPEN KRÄVER `organizationId` (S2 i check-spread-where). `{ ...undefined }`
    // ger `{}`, och ett uppslag utan org-avgränsning korsar tenant-gränsen
    // tyst — #703. Typen gör felet omöjligt i stället för osannolikt.
    const bas: { organizationId: string } & Record<string, unknown> = {
      organizationId,
      ...(shadow === undefined ? {} : { shadow }),
    }
    const grupper = await this.prisma.aiAssignment.groupBy({
      by: ['status'],
      where: bas,
      _count: { _all: true },
    })
    const ut = {
      AWAITING_APPROVAL: 0,
      APPROVED: 0,
      REJECTED: 0,
      EXPIRED: 0,
    } as Record<AiAssignment['status'], number>
    for (const g of grupper) ut[g.status] = g._count._all

    // ── TRÄFFGRADEN ÄR EN FRÅGA, ALDRIG EN LAGRAD PROCENT ─────────────────
    //
    // Nämnaren är rader med FACIT (`outcome`), inte alla rader. Ett förslag som
    // ingen ännu avslutat ärendet för är varken träff eller miss, och att räkna
    // det som en miss hade gjort träffgraden till ett mått på hur snabbt
    // hyresvärden stänger ärenden — en egenskap hos människan, inte hos agenten.
    //
    // Beräknas i minnet och inte i SQL därför att `prediction`/`outcome` är
    // JSON och jämförelsen sker per fält enligt `SKUGGFALT`. Taket nedan gör
    // kostnaden bunden; överskrids det syns det som ett tal, inte som en tyst
    // trunkering.
    const medFacit = await this.prisma.aiAssignment.findMany({
      where: { ...bas, outcome: { not: Prisma.JsonNull } },
      select: { prediction: true, outcome: true },
      take: TRAFFGRAD_TAK,
    })
    const traffgrad = traffgradPerFalt(
      medFacit.map((r) => ({
        prediction: (r.prediction ?? null) as Record<string, unknown> | null,
        outcome: (r.outcome ?? null) as Record<string, unknown> | null,
      })),
    )

    // ── EGEN RAD FÖR BETALNINGAR, INTE EN VIDGAD MÄNGD ────────────────────
    //
    // Agent 2 jämförs mot `SKUGGFALT_BETALNING` (avi, belopp, motpart), agent 1
    // mot `SKUGGFALT` (kategori, prioritet, hantverkare). Att slå ihop dem hade
    // gett en procentsats som är ett medelvärde av två olika frågor om två
    // olika objekt — ett tal som alltid går att räkna och aldrig betyder något.
    //
    // BLANDNINGEN ÄR OFARLIG ÅT ANDRA HÅLLET, och det är mätt i `jamforSkuggfalt`
    // och inte antaget: ett fält som saknas på BÅDA sidor ger `null` och räknas
    // inte. En betalningsrad kan alltså inte sänka felanmälans träffgrad, och
    // tvärtom. Avgränsningen nedan är därför för LÄSBARHETEN — så att nämnaren
    // säger vad den räknar — inte för att skydda talet.
    const betalningsrader = await this.prisma.aiAssignment.findMany({
      where: { ...bas, kind: 'PAYMENT_MATCH_PROPOSAL', outcome: { not: Prisma.JsonNull } },
      select: { prediction: true, outcome: true },
      take: TRAFFGRAD_TAK,
    })
    const traffgradBetalningar = traffgradPerFalt(
      betalningsrader.map((r) => ({
        prediction: (r.prediction ?? null) as Record<string, unknown> | null,
        outcome: (r.outcome ?? null) as Record<string, unknown> | null,
      })),
      SKUGGFALT_BETALNING,
    )

    return { status: ut, traffgrad, traffgradBetalningar }
  }

  /**
   * Godkänn eller avslå.
   *
   * ANSPRÅKET är atomiskt: `status: 'AWAITING_APPROVAL'` i WHERE gör att exakt
   * ett av två samtidiga beslut vinner — samma updateMany+count-mönster som
   * resten av kodbasen.
   *
   * ⚠️ Det är BESLUTET som är atomiskt, inte förhållandet mellan omprövningen
   * och effekten. Den senare beskrivs aldrig så: uppdragets skydd mot en
   * dubblett är verktygets egen nyckel, och omprövningen sker FÖRE effekten.
   * Se `assignment-eligibility.ts`. De två sakerna blandas lätt ihop just
   * därför att samma ord passar på båda.
   *
   * `statusReason` vid avslag är inte pynt: planens Del 11 säger att skälet är
   * minnesmat. Det är därför obligatoriskt just för avslag.
   */
  async besluta(
    organizationId: string,
    id: string,
    userId: string,
    beslut: 'APPROVED' | 'REJECTED',
    skäl?: string,
  ): Promise<AiAssignment> {
    if (beslut === 'REJECTED' && !skäl?.trim()) {
      throw new BadRequestException('Ett avslag kräver ett skäl.')
    }

    const anspråk = await this.prisma.aiAssignment.updateMany({
      where: { id, organizationId, status: 'AWAITING_APPROVAL' },
      data: {
        status: beslut,
        statusReason: beslut === 'REJECTED' ? (skäl?.trim() ?? null) : null,
        decidedAt: new Date(),
        decidedByUserId: userId,
      },
    })

    const uppdrag = await this.prisma.aiAssignment.findFirst({ where: { id, organizationId } })
    if (!uppdrag) throw new NotFoundException('Uppdraget hittades inte.')

    if (anspråk.count !== 1) {
      // TRE UTFALL, INTE ETT. "Redan beslutat", "hann förfalla" och "finns
      // inte" är olika saker för den som läser — att kalla dem alla ogiltiga
      // är precis den tvetydighet consumePendingAction en gång hade.
      throw new BadRequestException(
        uppdrag.status === 'EXPIRED'
          ? 'Uppdraget hann förfalla innan beslutet — tidsgränsen passerade.'
          : `Uppdraget är redan ${uppdrag.status === 'APPROVED' ? 'godkänt' : 'avslaget'}.`,
      )
    }

    // ── ETT JA PÅ EN BETALNINGSMATCHNING UTFÖR DEN ────────────────────────
    //
    // EFTER anspråket, så exakt ett av två samtidiga ja kan nå hit. Före
    // anspråket hade två klick kunnat matcha samma rad två gånger — och den
    // andra hade fallit på avstämningens egen status-guard, alltså med rätt
    // utfall men fel felmeddelande.
    //
    // Skiljer sig FRÅN skuggläget för felanmälan, där ett godkännande
    // uttryckligen inte utför någonting. Det är därför sorten är en egen
    // enum-medlem och inte ett `TOOL_PROPOSAL`: två rader som betyder olika
    // saker vid samma knapptryck måste gå att skilja åt i databasen.
    if (beslut === 'APPROVED' && uppdrag.kind === 'PAYMENT_MATCH_PROPOSAL') {
      await this.utförBetalningsmatchning(organizationId, uppdrag, userId)
    }
    return uppdrag
  }

  /**
   * Utför den godkända matchningen genom avstämningens egen tjänstemetod.
   *
   * ── FEL HÄR ÄR ETT FEL FÖR ANVÄNDAREN, INTE EN SVÄLJD LOGGRAD ────────────
   *
   * Beslutet är redan skrivet när vi kommer hit, och det ska det vara: en
   * matchning som inte gick igenom får inte göra att uppdraget ser obeslutat ut
   * nästa gång någon tittar. Men felet KASTAS, så hyresvärden ser att
   * matchningen inte blev av. Ett sväljt fel här hade betytt att hen tror att
   * pengarna är bokförda.
   *
   * `statusReason` bär skälet, så det syns i inkorgen och inte bara i en logg.
   */
  private async utförBetalningsmatchning(
    organizationId: string,
    uppdrag: AiAssignment,
    userId: string,
  ): Promise<void> {
    const input = (uppdrag.toolInput ?? {}) as Record<string, unknown>
    const transactionId = typeof input['transactionId'] === 'string' ? input['transactionId'] : null
    const rentNoticeId = typeof input['rentNoticeId'] === 'string' ? input['rentNoticeId'] : null
    const invoiceId = typeof input['invoiceId'] === 'string' ? input['invoiceId'] : null

    if (!transactionId || (!rentNoticeId && !invoiceId)) {
      // FÖRSLAGET VAR "INGEN AVI PASSAR". Ett ja betyder då att hyresvärden
      // HÅLLER MED om att raden inte hör någonstans — och rätt handling är att
      // inte göra något. Att kasta här hade gjort ett giltigt svar till ett fel.
      this.logger.log(
        `[ai-payment-shadow] uppdrag ${uppdrag.id} godkändes utan matchningsmål — ` +
          'hyresvärden höll med om att ingen avi passar. Ingenting utförs.',
      )
      return
    }

    try {
      await this.reconciliation.manualMatch(
        transactionId,
        rentNoticeId ? { rentNoticeId } : { invoiceId: invoiceId as string },
        organizationId,
        userId,
      )
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err)
      await this.prisma.aiAssignment.updateMany({
        where: { id: uppdrag.id, organizationId },
        data: { statusReason: `Matchningen gick inte igenom: ${text}` },
      })
      this.logger.warn(`[ai-payment-shadow] uppdrag ${uppdrag.id}: matchningen föll — ${text}`)
      throw err
    }
  }

  // ── KLASSIFICERING: A — LÅST (cron:ai-assignment-expiry) ──────────────────
  /**
   * DET SYNLIGA FÖRFALLET.
   *
   * Ett uppdrag vars tidsgräns passerat utan beslut stängs — och mottagaren får
   * veta det. Ett tyst förfall är förbjudet (planens Del 12): utan notisen är
   * "uppdraget utfördes aldrig" och "uppdraget fanns aldrig" samma upplevelse
   * för hyresvärden, och det är den farligare av de två som ser normal ut.
   *
   * Varje minut, av samma skäl som återupptagningsmotorn: gränsen är per
   * uppdrag och kan vara kort, så en gles kadens hade gjort passets intervall
   * till den verkliga gränsen.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async utgångspass(): Promise<void> {
    const utfall = await this.locks.runIfUnlocked(
      'cron:ai-assignment-expiry',
      () => this.utgångspassUnsafe(),
      { ttlSec: LAS_TTL_SEC },
    )
    if (!utfall.ran) {
      // Ett tyst överhopp är oskiljbart från "cronen kördes aldrig".
      this.logger.log(
        `[cron:ai-assignment-expiry] Kördes redan av en annan replik — hoppar över. ` +
          `Låset hållet i ${utfall.heldForSec ?? '?'} s av ${LAS_TTL_SEC} s.`,
      )
    }
  }

  private async utgångspassUnsafe(): Promise<void> {
    await runCronSafely('ai-assignment-expiry', () => this.stängUtgångna(), {
      logger: this.logger,
      sink: this.cronErrors,
    })
  }

  /**
   * @param nu injiceras av proven; ett pass mäter alla rader mot samma klocka.
   * @returns antal stängda, och om taket slog i.
   */
  async stängUtgångna(nu: Date = new Date()): Promise<{ stängda: number; takNått: boolean }> {
    // TAKET SYNS, DET KRYMPER INTE TYST. `kandidater` räknas separat: att
    // rapportera radlängden hade gjort ett tak till en mätning.
    const kandidater = await this.prisma.aiAssignment.count({
      where: { status: 'AWAITING_APPROVAL', deadline: { lt: nu } },
    })
    const rader = await this.prisma.aiAssignment.findMany({
      where: { status: 'AWAITING_APPROVAL', deadline: { lt: nu } },
      orderBy: { deadline: 'asc' },
      take: UTGANG_BATCH,
      select: { id: true, organizationId: true, title: true, assignedToUserId: true },
    })

    let stängda = 0
    for (const rad of rader) {
      // Anspråket per rad, av samma skäl som i `besluta`: en människa kan hinna
      // besluta i samma sekund som passet läser. Den ska vinna.
      const anspråk = await this.prisma.aiAssignment.updateMany({
        where: { id: rad.id, status: 'AWAITING_APPROVAL' },
        data: {
          status: 'EXPIRED',
          statusReason: 'Tidsgränsen passerade utan beslut — ingenting utfördes.',
        },
      })
      if (anspråk.count !== 1) continue
      stängda++

      if (rad.assignedToUserId) {
        // Notisen är hela poängen med det synliga förfallet. Den får därför
        // inte tyst svälja ett fel: faller den loggas det, och passet fortsätter
        // med nästa rad i stället för att lämna resten ostängda.
        await this.notifications
          .create(
            rad.organizationId,
            rad.assignedToUserId,
            'AI_ASSIGNMENT_EXPIRED',
            'Ett uppdrag förföll utan beslut',
            `${rad.title} — tidsgränsen passerade, och ingenting utfördes.`,
            { relatedEntityType: 'AI_ASSIGNMENT', relatedEntityId: rad.id },
          )
          .catch((err: unknown) => {
            this.logger.error(
              `[cron:ai-assignment-expiry] Uppdrag ${rad.id} stängdes men kallelsen om förfallet ` +
                `gick inte fram — förfallet är osynligt för mottagaren: ${String(err)}`,
            )
          })
      }
    }

    const takNått = kandidater > rader.length
    if (takNått) {
      this.logger.warn(
        `[cron:ai-assignment-expiry] ${kandidater} utgångna uppdrag, taket är ${UTGANG_BATCH} — ` +
          `${kandidater - rader.length} väntar till nästa pass.`,
      )
    }
    return { stängda, takNått }
  }
}
