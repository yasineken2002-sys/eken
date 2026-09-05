import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'

import { PrismaService } from '../../common/prisma/prisma.service'
import { CronErrorSink } from '../../common/cron/cron-error-sink'
import { runCronSafely } from '../../common/cron/cron-safety'
import { LockService } from '../../common/redis/lock.service'
import { NotificationsService } from '../../notifications/notifications.service'
import { prövaDuglighet } from './assignment-eligibility'
import { INKORG_SIDSTORLEK_MAX, INKORG_SIDSTORLEK_STANDARD } from './dto/query-assignments.dto'

import type { AiAssignment, Prisma } from '@prisma/client'

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

@Injectable()
export class AiAssignmentsService {
  private readonly logger = new Logger(AiAssignmentsService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly locks: LockService,
    private readonly cronErrors: CronErrorSink,
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
  ): Promise<{ rader: AiAssignment[]; total: number; limit: number; offset: number }> {
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
      }),
      this.prisma.aiAssignment.count({ where }),
    ])
    return { rader, total, limit, offset }
  }

  /**
   * ETT uppdrag, org-scopat.
   *
   * Kastar 404 för ett id i en annan organisation — samma svar som för ett id
   * som inte finns alls, så att en främmande org:s id inte går att skilja från
   * ett påhittat.
   */
  async hamta(organizationId: string, id: string): Promise<AiAssignment> {
    const rad = await this.prisma.aiAssignment.findFirst({ where: { id, organizationId } })
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
  ): Promise<Record<AiAssignment['status'], number>> {
    const bas = { organizationId, ...(shadow === undefined ? {} : { shadow }) }
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
    return ut
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
    return uppdrag
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
