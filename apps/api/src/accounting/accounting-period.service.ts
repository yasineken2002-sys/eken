import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common'
import { NotificationType, Prisma, RentNoticeType, UserRole } from '@prisma/client'
import type { AccountingPeriodEventReasonCategory } from '@prisma/client'
import { PrismaService } from '../common/prisma/prisma.service'
import { vatPeriodLabelsForMonths } from '../avisering/vat-period.util'
import { stockholmCivilDate, stockholmMonthBounds } from '../common/time/stockholm-period'
import {
  appendPeriodClosedEvent,
  appendPeriodReopenedEvent,
  getClosedPeriodStates,
  getPeriodHistory,
  getReopenCounts,
  isPeriodClosed,
  periodKeyOf,
  type PeriodHistoryEvent,
  type PeriodKey,
} from './closed-period'
import { DEFAULT_VER_SERIES, VerifikationsnummerService } from './verifikationsnummer.service'

/**
 * Bokföringsperioder — stängning, förhandskontroll och översikt.
 *
 * VIKTIGT om ansvarsfördelningen (PR1a): den här tjänsten VERKSTÄLLER inget nytt
 * lås. Spärren som faktiskt hindrar en bokföring i en stängd period är och
 * förblir `VerifikationsnummerService.allocate` — den rörs inte. Tjänsten gör
 * stängningsmekanismen nåbar utanför AI-assistenten, och ger operatören ett
 * besked om vad som är ofullständigt innan hen låser.
 *
 * Stängningen har EN väg — AI-verktyget `close_period` delegerar hit, så det
 * finns inte två stängningsvägar som kan glida isär.
 *
 * PR1b: stängningen skriver numera en append-only CLOSED-HÄNDELSE
 * (`AccountingPeriodEvent`) i stället för en mutbar rad per period, och
 * "är perioden stängd?" härleds ur den senaste händelsen. Skrivningen ligger i
 * `appendPeriodClosedEvent` (closed-period.ts) tillsammans med uppslagningen —
 * en fil äger både frågan och svaret.
 *
 * PR1c: ÅTERÖPPNING finns nu (`reopenPeriod`), bakom fyra grindar som alla
 * ligger HÄR i tjänsten och inte bara i controllern — se metodens docblock.
 * Det finns MEDVETET inget AI-verktyg för återöppning: en väg förbi grindarna
 * vore en väg förbi hela poängen.
 */

/** En upptäckt som förhandskontrollen gjorde inför en stängning. */
export interface PeriodCheck {
  /** Maskinläsbar kod, t.ex. 'unbalanced-entries'. */
  code: string
  /** 'blocking' = stängning nekas. 'warning' = operatören får avgöra. */
  severity: 'blocking' | 'warning'
  /** Människoläsbar sammanfattning på svenska. */
  message: string
  /** Antal berörda poster (0 när kontrollen inte är antalsbaserad). */
  count: number
}

export interface PeriodPrecheck {
  year: number
  month: number
  alreadyClosed: boolean
  /** Sant om ingen BLOCKERANDE upptäckt finns — varningar hindrar inte. */
  canClose: boolean
  checks: PeriodCheck[]
  /** Momsperioder månaden berör (org:ens redovisningsperiod). Tom om okänt. */
  vatPeriods: string[]
}

export interface PeriodOverviewItem {
  year: number
  month: number
  closed: boolean
  closedAt: Date | null
  /** Antal gånger perioden återöppnats. > 0 → perioden har en historia att visa. */
  reopenedCount: number
}

export interface PeriodOverview {
  items: PeriodOverviewItem[]
  /** Senast stängda perioden (högsta år/månad), eller null om ingen stängts. */
  lastClosed: PeriodKey | null
  /** Öppna perioder i intervallet, äldst först — det operatören ska agera på. */
  open: PeriodKey[]
}

/** Allt återöppningsdialogen behöver för att visa läget INNAN något skickas. */
export interface PeriodDetail {
  year: number
  month: number
  closed: boolean
  /** Hela kedjan, äldst först. `seq` är intern ordning — visas aldrig i UI. */
  events: PeriodHistoryEvent[]
  /** Momsperioder månaden berör — underlag för varningen, aldrig ett påstående. */
  vatPeriods: string[]
  /** Räkenskapsåret perioden tillhör. */
  fiscalYear: number
  /** Räkenskapsårets sista dag (ISO). */
  fiscalYearEnd: string
  /** Falskt om räkenskapsårsspärren stänger dörren — roll/kategori avgörs vid POST. */
  withinReopenWindow: boolean
}

const CLOSE_ROLES: UserRole[] = [UserRole.ACCOUNTANT, UserRole.ADMIN, UserRole.OWNER]

/** Vilka som får veta att en period öppnats igen. VIEWER/MANAGER utelämnas. */
const REOPEN_NOTIFICATION_ROLES: UserRole[] = [UserRole.OWNER, UserRole.ADMIN, UserRole.ACCOUNTANT]

/** Speglar CHECK-villkoret i DB (`length(btrim(reason)) >= 10`). */
const REOPEN_REASON_MIN_LENGTH = 10

/** Sex månader efter räkenskapsårets slut — se reopenWindow. */
const REOPEN_WINDOW_MONTHS = 6

/**
 * Beskedet när någon vill öppna en period för att RÄTTA en befintlig post.
 *
 * Det nekar inte bara — det förklarar varför, och vad man ska göra i stället.
 * Den pedagogiska kärnan är att dagens datum på rättelsen är själva poängen: det
 * visar NÄR felet upptäcktes. En "rättelse" bakåt i den gamla perioden hade i
 * efterhand sett ut som att posten alltid varit rätt.
 *
 * Samma text visas i UI:t innan något skickas — det här är sista utposten för
 * den som når endpointen direkt.
 */
const CORRECTION_NOT_A_REOPEN_MESSAGE =
  'Perioden behöver inte öppnas för det här. En bokförd post ändras aldrig i ' +
  'efterhand — inte i någon månad, hur ny den än är. Ett fel rättas i stället ' +
  'genom att du bokför en ny post idag som tar ut den felaktiga, och en ny ' +
  'korrekt post bredvid. Den felaktiga posten står kvar precis som den var: det ' +
  'ska gå att se vad som faktiskt bokfördes, när felet upptäcktes och hur det ' +
  'rättades. Gör så här i stället: öppna Verifikationer, klicka på den felaktiga ' +
  'posten och välj "Rätta verifikatet" — systemet bokför motsatsen åt dig.'

/**
 * Får den här aktören återöppna en period för att RÄTTA en befintlig post?
 *
 * Svaret är i dag alltid nej, för alla. Rätt åtgärd vid en felaktig bokförd post
 * är en rättelse i innevarande period — inte att öppna den gamla månaden och
 * ändra där, vilket i efterhand hade sett ut som att posten alltid varit rätt.
 *
 * VARFÖR EN NAMNGIVEN FUNKTION SOM ALLTID RETURNERAR FALSE, i stället för ett
 * `if (kategori === EXISTING_ENTRY_INCORRECT) throw` inne i flödet: undantaget
 * ÄR planerat. En revisor ska få göra det här (med varning och spårning) när
 * revisorskonton finns. Med regeln samlad på ett ställe blir det undantaget en
 * ändring på en rad i den här funktionen — inte en utgrävning genom flödet efter
 * varje ställe som råkar resonera om kategorier.
 *
 * Undantaget går INTE att uttrycka i dagens rollsystem: RolesGuard är strikt
 * hierarkisk (`userLevel >= krav`), så allt som ges till ACCOUNTANT ges
 * automatiskt till ADMIN och OWNER — och spärren hade blivit verkningslös för
 * just hyresvärden, som är den den finns för. Revisor blir därför en egen
 * kontotyp, inte ett femte UserRole, och den här funktionen får då ta emot den.
 */
export function canReopenForCorrection(_actorRole: UserRole): boolean {
  return false
}

@Injectable()
export class AccountingPeriodService {
  private readonly logger = new Logger(AccountingPeriodService.name)

  constructor(private readonly prisma: PrismaService) {}

  // ── Översikt ───────────────────────────────────────────────────────────────
  /**
   * Perioder för de senaste `months` månaderna (inkl. innevarande), nyast först.
   * Passiv synlighet: hyresvärden ska kunna se "senast stängda: mars · öppna:
   * april, maj" utan att någon nagg-mekanism finns.
   */
  async getOverview(organizationId: string, months = 12): Promise<PeriodOverview> {
    const span = Math.min(Math.max(months, 1), 36)
    // Innevarande månad i svensk tid — annars kan fönstret hoppa ett dygn i
    // förtid nära månadsskiftet.
    const today = stockholmCivilDate(new Date())
    const keys: PeriodKey[] = []
    let y = today.year
    let m = today.month
    for (let i = 0; i < span; i++) {
      keys.push({ year: y, month: m })
      m--
      if (m < 1) {
        m = 12
        y--
      }
    }

    // Perioder som är stängda JUST NU, härlett ur den senaste händelsen per
    // period (samma härledning som spärren i allocate använder — översikten kan
    // aldrig visa "öppen" för en period som spärren anser stängd, eller tvärtom).
    // `closedAt` är den GÄLLANDE stängningens tidpunkt.
    const [rows, reopenCounts] = await Promise.all([
      getClosedPeriodStates(this.prisma, organizationId),
      getReopenCounts(this.prisma, organizationId),
    ])
    const closedByKey = new Map(rows.map((r) => [periodKeyOf(r), r.closedAt]))

    const items: PeriodOverviewItem[] = keys.map((k) => {
      const closedAt = closedByKey.get(periodKeyOf(k))
      return {
        year: k.year,
        month: k.month,
        closed: closedAt != null,
        closedAt: closedAt ?? null,
        reopenedCount: reopenCounts.get(periodKeyOf(k)) ?? 0,
      }
    })

    // Senast stängda = högsta år/månad bland ALLA stängda (inte bara i fönstret).
    const lastClosed = rows.reduce<PeriodKey | null>((best, r) => {
      if (!best) return { year: r.year, month: r.month }
      const isLater = r.year > best.year || (r.year === best.year && r.month > best.month)
      return isLater ? { year: r.year, month: r.month } : best
    }, null)

    const open = items
      .filter((i) => !i.closed)
      .map((i) => ({ year: i.year, month: i.month }))
      .reverse() // äldst först — den perioden är mest angelägen att stänga

    return { items, lastClosed, open }
  }

  // ── Förhandskontroll ───────────────────────────────────────────────────────
  /**
   * Vad ser ofullständigt ut i perioden? Kallas både av UI:t (för att visa
   * beskedet innan operatören låser) och av `closePeriod` (som grind).
   *
   * KALIBRERING (FAR): exakt EN kontroll blockerar — obalanserat verifikat. Det
   * är en objektiv korrekthetsfråga; att låsa perioden över ett känt obalanserat
   * verifikat är att lägga lock på ett fel i stället för att åtgärda det. Allt
   * annat är FULLSTÄNDIGHETS-bedömningar som en redovisningskonsult måste kunna
   * väga in och ändå stänga (t.ex. stänga tidigt av rapporteringsskäl medan
   * städning pågår).
   */
  async precheck(organizationId: string, year: number, month: number): Promise<PeriodPrecheck> {
    this.assertValidPeriod(year, month)
    // Svenska månadsgränser, inte UTC: `allocate` placerar en post i den period
    // datumet tillhör I SVERIGE, och kontrollerna MÅSTE räkna samma post till
    // samma månad. En post 22:30 UTC den 31 mars är 00:30 svensk tid den 1 april.
    const { from, to } = stockholmMonthBounds(year, month)

    // PUNKTfrågan, inte bulkformen: det här gäller EN period. Bulkformen hämtar
    // hela organisationens periodhistorik och sållar i Node — rätt för
    // backfillens gap-detektion, fel här. `from` är månadens första ögonblick i
    // svensk tid, så uppslaget landar på exakt (year, month).
    const alreadyClosed = await isPeriodClosed(this.prisma, organizationId, from)

    // Kontrollerna är oberoende av varandra — kör dem parallellt. precheck
    // anropas både när stängningsdialogen öppnas och en gång till i closePeriod.
    const checks = (
      await Promise.all([
        this.checkUnbalancedEntries(organizationId, from, to),
        this.checkNoticesWithoutEntry(organizationId, year, month),
        this.checkInvoicesWithoutEntry(organizationId, from, to),
        this.checkUnbilledLeases(organizationId, year, month),
        this.checkUnmatchedBankTransactions(organizationId, from, to),
        this.checkVerificationNumberGaps(organizationId, from),
      ])
    ).filter((c): c is PeriodCheck => c != null)

    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { vatReportingPeriod: true, fiscalYearStartMonth: true },
    })
    // Återanvänder T1.4 PR3:s etikettering (#195) — bygger ingen egen.
    const vatPeriods = vatPeriodLabelsForMonths(
      [{ year, month }],
      org?.vatReportingPeriod ?? 'QUARTERLY',
      org?.fiscalYearStartMonth ?? 1,
    )
    if (vatPeriods.length > 0 && (org?.vatReportingPeriod ?? 'QUARTERLY') !== 'MONTHLY') {
      checks.push({
        code: 'vat-period-spans-months',
        severity: 'warning',
        message:
          `Månaden ingår i momsperioden ${vatPeriods.join(', ')}, som omfattar fler månader. ` +
          'Kontrollera att hela perioden är avstämd innan du förlitar dig på att den är ' +
          'komplett för momsändamål.',
        count: 0,
      })
    }

    return {
      year,
      month,
      alreadyClosed,
      canClose: !alreadyClosed && !checks.some((c) => c.severity === 'blocking'),
      checks,
      vatPeriods,
    }
  }

  // ── Stängning ──────────────────────────────────────────────────────────────
  /**
   * Stänger perioden. Samma skrivning mot `ClosedAccountingPeriod` som tidigare
   * bara gick att nå via AI-verktyget — ingen ny mekanism.
   *
   * Rollgrinden ligger HÄR (chokepunkten), inte bara i controllern, så att även
   * AI-vägen och framtida interna anropare grindas. Fail-closed: okänd/saknad
   * roll nekas.
   */
  async closePeriod(
    organizationId: string,
    year: number,
    month: number,
    opts: { actorRole?: UserRole; actorUserId?: string | null },
  ): Promise<{ year: number; month: number; summary: PeriodSummary; checks: PeriodCheck[] }> {
    if (!opts.actorRole || !CLOSE_ROLES.includes(opts.actorRole)) {
      throw new ForbiddenException('Du saknar behörighet att stänga en bokföringsperiod')
    }
    this.assertValidPeriod(year, month)

    const pre = await this.precheck(organizationId, year, month)
    if (pre.alreadyClosed) {
      throw new ConflictException(`Perioden ${periodKeyOf({ year, month })} är redan stängd.`)
    }
    const blocking = pre.checks.filter((c) => c.severity === 'blocking')
    if (blocking.length > 0) {
      throw new ConflictException(
        `Perioden kan inte stängas: ${blocking.map((b) => b.message).join(' ')}`,
      )
    }

    const summary = await this.buildSummary(organizationId, year, month)

    // Aktörsnamnet denormaliseras in i händelsen: loggen ska gå att läsa om sju
    // år, när User-raden kan vara borttagen eller personen ha bytt namn. Saknas
    // användaren lämnas etiketten tom — vi fabricerar aldrig en aktör.
    const actorLabel = await this.actorLabelFor(opts.actorUserId ?? null)

    // summary är en ÖGONBLICKSBILD vid stängningstillfället och räknas aldrig om
    // i efterhand (FAR: att uppdatera den retroaktivt vore att påstå att den som
    // stängde såg siffror hen aldrig såg). Därför skrivs den in i händelsen och
    // rörs sedan aldrig — en framtida omstängning lägger en NY händelse med en
    // NY bild bredvid den gamla i stället för att skriva över den.
    //
    // Transaktionen omsluter både händelsen och speglingen till den gamla
    // tabellen: de två får aldrig kunna hamna i otakt.
    try {
      await this.prisma.$transaction(async (tx) =>
        appendPeriodClosedEvent(tx, {
          organizationId,
          year,
          month,
          actorUserId: opts.actorUserId ?? null,
          actorLabel,
          summary: summary as unknown as Prisma.InputJsonValue,
        }),
      )
    } catch (err) {
      // Två samtidiga stängningar av samma period. Vilket av de två unika indexen
      // som slår (händelsens (org, år, månad, seq) eller speglingens
      // (org, år, månad)) spelar ingen roll — båda betyder exakt samma sak:
      // någon annan hann före, perioden är redan stängd.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException(`Perioden ${periodKeyOf({ year, month })} är redan stängd.`)
      }
      throw err
    }

    this.logger.log(
      `[period] ${periodKeyOf({ year, month })} stängd för org ${organizationId} ` +
        `(${summary.entriesCount} verifikat, resultat ${summary.result})`,
    )

    return { year, month, summary, checks: pre.checks }
  }

  // ── Återöppning (PR1c) ─────────────────────────────────────────────────────

  /**
   * Periodens hela historik + underlaget dialogen behöver innan något skickas.
   * Ren läsning.
   */
  async getDetail(organizationId: string, year: number, month: number): Promise<PeriodDetail> {
    this.assertValidPeriod(year, month)
    const { from } = stockholmMonthBounds(year, month)

    const [events, closed, org] = await Promise.all([
      getPeriodHistory(this.prisma, organizationId, year, month),
      isPeriodClosed(this.prisma, organizationId, from),
      this.prisma.organization.findUnique({
        where: { id: organizationId },
        select: { vatReportingPeriod: true, fiscalYearStartMonth: true },
      }),
    ])

    const startMonth = org?.fiscalYearStartMonth ?? 1
    const window = this.reopenWindow(year, month, startMonth)

    return {
      year,
      month,
      closed,
      events,
      vatPeriods: vatPeriodLabelsForMonths(
        [{ year, month }],
        org?.vatReportingPeriod ?? 'QUARTERLY',
        startMonth,
      ),
      fiscalYear: window.fiscalYear,
      fiscalYearEnd: window.lastDay.toISOString().slice(0, 10),
      withinReopenWindow: window.within,
    }
  }

  /**
   * Öppnar en stängd period igen. FYRA GRINDAR, alla här i tjänsten och inte
   * bara i controllern — det här är chokepunkten, och en framtida intern
   * anropare (eller ett AI-verktyg som någon lägger till) ska träffa samma
   * spärrar. Alla fail-closed: saknad/okänd indata nekas.
   *
   *  1. ROLL — endast OWNER. Stängning är rutinmässig redovisningshygien och
   *     räcker med ACCOUNTANT; återöppning rör ett läge som kan ligga till grund
   *     för en fastställd årsredovisning eller en lämnad momsdeklaration. Den som
   *     upptäcker behovet (ofta ACCOUNTANT) kan alltså inte själv trycka på
   *     knappen utan måste förklara varför för den som bär bokföringsansvaret.
   *
   *  2. ORSAK — `canReopenForCorrection`. En saknad post får hämtas in i sin
   *     period; en FELAKTIG post rättas i innevarande period och aldrig genom att
   *     öppna den gamla månaden. Se funktionens docblock.
   *
   *  3. RÄKENSKAPSÅR — perioder vars räkenskapsår slutade för mer än sex månader
   *     sedan öppnas inte, utan override. Det är inte bara en produktbegränsning:
   *     fel som upptäcks efter att ett räkenskapsår avslutats hanteras som en
   *     justering i innevarande period med notering om vilket år felet avser. En
   *     bakväg här hade uppmuntrat fel praxis.
   *
   *  4. TILLSTÅND — perioden måste faktiskt vara stängd. En redan öppen period
   *     kan inte öppnas igen (409), och en period utan historik har aldrig
   *     stängts.
   *
   * Skrivningen rör bara `AccountingPeriodEvent` — se appendPeriodReopenedEvent
   * för varför speglingen lämnas orörd.
   */
  async reopenPeriod(
    organizationId: string,
    year: number,
    month: number,
    opts: {
      actorRole?: UserRole
      actorUserId?: string | null
      reason: string
      reasonCategory: AccountingPeriodEventReasonCategory
    },
  ): Promise<{
    year: number
    month: number
    reopenedAt: Date
    reason: string
    reasonCategory: AccountingPeriodEventReasonCategory
    /** Ögonblicksbilden från den stängning som nu hävts — oförändrad, aldrig omräknad. */
    previousSummary: PeriodSummary | null
  }> {
    // GRIND 1 — roll.
    if (opts.actorRole !== UserRole.OWNER) {
      throw new ForbiddenException(
        'Endast kontoägaren (OWNER) får öppna en stängd bokföringsperiod igen.',
      )
    }
    this.assertValidPeriod(year, month)

    const reason = opts.reason?.trim() ?? ''
    if (reason.length < REOPEN_REASON_MIN_LENGTH) {
      throw new BadRequestException(
        `Ange varför perioden öppnas igen (minst ${REOPEN_REASON_MIN_LENGTH} tecken). ` +
          'Skälet sparas i periodens historik och går inte att ändra i efterhand.',
      )
    }

    // GRIND 2 — orsak. Regeln bor i canReopenForCorrection, inte här.
    if (
      opts.reasonCategory === 'EXISTING_ENTRY_INCORRECT' &&
      !canReopenForCorrection(opts.actorRole)
    ) {
      throw new ConflictException(CORRECTION_NOT_A_REOPEN_MESSAGE)
    }

    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { fiscalYearStartMonth: true },
    })
    const window = this.reopenWindow(year, month, org?.fiscalYearStartMonth ?? 1)

    // GRIND 3 — räkenskapsår. Hård, ingen override.
    if (!window.within) {
      throw new ConflictException(
        `Räkenskapsåret ${window.fiscalYear} avslutades ${window.lastDay
          .toISOString()
          .slice(0, 10)} och kan inte öppnas igen. ` +
          'Fel som upptäcks efter att ett räkenskapsår avslutats rättas i innevarande ' +
          'period, med en notering om vilket år felet gäller. Stäm av med din ' +
          'redovisningskonsult.',
      )
    }

    // GRIND 4 — tillstånd. Samma härledning som spärren i allocate använder.
    //
    // OBS: det här är ett SNABB-NEJ, inte den verkställande kontrollen. Den
    // riktiga ligger inuti transaktionen i `appendPeriodReopenedEvent` — mellan
    // den här läsningen och skrivningen finns annars ett fönster där två
    // samtidiga återöppningar båda kan slinka igenom och ge kedjan
    // `CLOSED → REOPENED → REOPENED`. Den här kontrollen finns kvar för att
    // slippa göra org-uppslag och räkenskapsårsberäkning för en period som
    // uppenbart redan är öppen.
    const { from } = stockholmMonthBounds(year, month)
    if (!(await isPeriodClosed(this.prisma, organizationId, from))) {
      throw new ConflictException(
        `Perioden ${periodKeyOf({ year, month })} är inte stängd och kan därför inte öppnas igen.`,
      )
    }

    // Ögonblicksbilden från stängningen som nu hävs — läses ut FÖRE skrivningen
    // så svaret kan visa vad den som låste faktiskt såg. Den rörs aldrig.
    const history = await getPeriodHistory(this.prisma, organizationId, year, month)
    const lastClosed = [...history].reverse().find((e) => e.type === 'CLOSED')

    const actorLabel = await this.actorLabelFor(opts.actorUserId ?? null)

    try {
      await this.prisma.$transaction(async (tx) =>
        appendPeriodReopenedEvent(tx, {
          organizationId,
          year,
          month,
          reason,
          reasonCategory: opts.reasonCategory,
          actorUserId: opts.actorUserId ?? null,
          actorLabel,
        }),
      )
    } catch (err) {
      // Äkta samtidighet: två återöppningar som läser samma max(seq) och båda
      // försöker skriva seq N+1 — unik-indexet låter en vinna. Utan den här
      // översättningen hade förloraren fått en rå 500 och en CRITICAL i Sentry
      // för vad som i praktiken är ett dubbelklick. Samma mönster som
      // closePeriod redan använder.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException(`Perioden ${periodKeyOf({ year, month })} är redan öppen.`)
      }
      throw err
    }

    this.logger.warn(
      `[period] ${periodKeyOf({ year, month })} ÅTERÖPPNAD för org ${organizationId} ` +
        `av ${opts.actorUserId ?? 'okänd'} (${opts.reasonCategory})`,
    )

    void this.notifyReopened(organizationId, year, month, actorLabel, reason)

    return {
      year,
      month,
      reopenedAt: new Date(),
      reason,
      reasonCategory: opts.reasonCategory,
      previousSummary: (lastClosed?.summary as unknown as PeriodSummary | null) ?? null,
    }
  }

  /**
   * Räkenskapsårsfönstret för en period.
   *
   * Sex månader räknas från RÄKENSKAPSÅRETS SLUT, inte från månaden — en period
   * i mars kan höra till ett räkenskapsår som nyss avslutats (brutet år) eller
   * till ett som stängde för länge sedan (kalenderår). Aritmetiken är CIVIL
   * månadsräkning, inte 180 dagar: månader är olika långa och Sverige växlar
   * sommartid.
   */
  private reopenWindow(
    year: number,
    month: number,
    fiscalYearStartMonth: number,
  ): { fiscalYear: number; lastDay: Date; deadline: Date; within: boolean } {
    const { from: periodStart } = stockholmMonthBounds(year, month)
    const fiscalYear = VerifikationsnummerService.fiscalYearFor(periodStart, fiscalYearStartMonth)

    // Ögonblicket EFTER räkenskapsårets sista dag = första ögonblicket i nästa
    // räkenskapsår. Håller för både kalenderår (fym=1) och brutet år.
    const endBoundary = stockholmMonthBounds(fiscalYear + 1, fiscalYearStartMonth).from
    const lastDay = new Date(endBoundary.getTime() - 1)

    const c = stockholmCivilDate(endBoundary)
    let m = c.month + REOPEN_WINDOW_MONTHS
    let y = c.year
    if (m > 12) {
      m -= 12
      y += 1
    }
    const deadline = stockholmMonthBounds(y, m).from

    return { fiscalYear, lastDay, deadline, within: Date.now() <= deadline.getTime() }
  }

  /**
   * Denormaliserat aktörsnamn — loggen ska gå att läsa om sju år, när User-raden
   * kan vara borttagen. Saknas användaren lämnas etiketten tom; vi fabricerar
   * aldrig en aktör.
   */
  private async actorLabelFor(actorUserId: string | null): Promise<string | null> {
    if (!actorUserId) return null
    const actor = await this.prisma.user.findUnique({
      where: { id: actorUserId },
      select: { firstName: true, lastName: true },
    })
    return actor ? `${actor.firstName} ${actor.lastName}`.trim() || null : null
  }

  /**
   * Notis till dem som bär ansvar för bokföringen. Best-effort: en utebliven
   * notis får aldrig rulla tillbaka en genomförd återöppning — händelsen i
   * loggen är det som räknas.
   */
  private async notifyReopened(
    organizationId: string,
    year: number,
    month: number,
    actorLabel: string | null,
    reason: string,
  ): Promise<void> {
    try {
      // Skrivs direkt i stället för via NotificationsService: NotificationsModule
      // importerar redan AccountingModule, så ett beroende åt andra hållet vore
      // en modulcykel som bara går att lösa med forwardRef på båda sidor. Tio
      // rader här är billigare än den kopplingen.
      //
      // ROLLFILTRERAT: VIEWER och MANAGER utelämnas — en återöppnad period är en
      // redovisningshändelse, och en notis som når fel publik lär folk att
      // ignorera notiser.
      const recipients = await this.prisma.user.findMany({
        where: { organizationId, isActive: true, role: { in: REOPEN_NOTIFICATION_ROLES } },
        select: { id: true },
      })
      if (recipients.length === 0) return
      await this.prisma.notification.createMany({
        data: recipients.map((u) => ({
          organizationId,
          userId: u.id,
          type: NotificationType.SYSTEM,
          title: 'Bokföringsperiod öppnad igen',
          message:
            `${periodKeyOf({ year, month })} har öppnats igen` +
            `${actorLabel ? ` av ${actorLabel}` : ''}. Angivet skäl: ${reason}`,
          link: '/accounting',
        })),
      })
    } catch (err) {
      this.logger.error(
        `[period] kunde inte notifiera om återöppning av ${periodKeyOf({ year, month })}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }
  }

  // ── Kontrollerna ───────────────────────────────────────────────────────────

  /**
   * HÅRD SPÄRR: verifikat där debet ≠ kredit. Ska vara strukturellt omöjligt
   * (C1-balansgrinden i createNumberedEntry), men om det ändå finns — datafel,
   * migrerad historik, manuellt DB-ingrepp — får perioden inte låsas över det.
   */
  private async checkUnbalancedEntries(
    organizationId: string,
    from: Date,
    to: Date,
  ): Promise<PeriodCheck | null> {
    const rows = await this.prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::bigint AS count FROM (
        SELECT jel."journalEntryId"
        FROM "JournalEntryLine" jel
        JOIN "JournalEntry" je ON je.id = jel."journalEntryId"
        WHERE je."organizationId" = ${organizationId}
          AND je.date >= ${from} AND je.date < ${to}
        GROUP BY jel."journalEntryId"
        HAVING COALESCE(SUM(jel.debit), 0) <> COALESCE(SUM(jel.credit), 0)
      ) unbalanced
    `
    const count = Number(rows[0]?.count ?? 0)
    if (count === 0) return null
    return {
      code: 'unbalanced-entries',
      severity: 'blocking',
      message: `${count} verifikat i perioden balanserar inte (debet ≠ kredit). Rätta dem innan perioden stängs.`,
      count,
    }
  }

  /** Hyresavier i perioden som saknar sitt intäktsverifikat (A0-konventionen). */
  private async checkNoticesWithoutEntry(
    organizationId: string,
    year: number,
    month: number,
  ): Promise<PeriodCheck | null> {
    const notices = await this.prisma.rentNotice.findMany({
      where: { organizationId, year, month, type: RentNoticeType.RENT },
      select: { id: true },
    })
    if (notices.length === 0) return null
    // Accrual-nyckeln är source='INVOICE' + sourceId='rent-notice:<id>'
    // (konvention fastställd i T5 A0-auditen — INTE source='RENT_NOTICE').
    const booked = await this.prisma.journalEntry.findMany({
      where: {
        organizationId,
        sourceId: { in: notices.map((n) => `rent-notice:${n.id}`) },
      },
      select: { sourceId: true },
    })
    const bookedIds = new Set(booked.map((b) => b.sourceId))
    const missing = notices.filter((n) => !bookedIds.has(`rent-notice:${n.id}`)).length
    if (missing === 0) return null
    return {
      code: 'notices-without-entry',
      severity: 'warning',
      message: `${missing} hyresavi(er) i perioden saknar intäktsverifikat.`,
      count: missing,
    }
  }

  /**
   * Fakturor i perioden utan verifikat — samma princip på fakturasidan.
   *
   * NYCKELKONVENTIONEN ÄR INTE ENHETLIG: en vanlig faktura bokförs under
   * sourceId=invoice.id, men en DEPOSITIONSfaktura bokförs av depositionsflödet
   * under sourceId='deposit-invoice:<depositId>' (1510/2890 — en skuld, inte en
   * intäkt). Slås bara den första nyckeln upp flaggas varje korrekt bokförd
   * deposition som saknande verifikat — ett dagligt falsklarm för i praktiken
   * alla bostadsuthyrare, och den sortens brus lär operatören att ignorera
   * varningar. Samma tvånyckel-hantering finns redan i
   * accounting.service.assertInvoiceReceivableBacked (A2).
   */
  private async checkInvoicesWithoutEntry(
    organizationId: string,
    from: Date,
    to: Date,
  ): Promise<PeriodCheck | null> {
    const invoices = await this.prisma.invoice.findMany({
      where: { organizationId, issueDate: { gte: from, lt: to }, status: { not: 'DRAFT' } },
      select: { id: true },
    })
    if (invoices.length === 0) return null

    // Depositionsfakturor: verifikatet hänger på Deposit-id:t, inte fakturans.
    const deposits = await this.prisma.deposit.findMany({
      where: { organizationId, invoiceId: { in: invoices.map((i) => i.id) } },
      select: { id: true, invoiceId: true },
    })
    const depositKeyByInvoice = new Map(
      deposits
        .filter((d): d is typeof d & { invoiceId: string } => d.invoiceId != null)
        .map((d) => [d.invoiceId, `deposit-invoice:${d.id}`]),
    )
    const keyFor = (invoiceId: string): string => depositKeyByInvoice.get(invoiceId) ?? invoiceId

    const booked = await this.prisma.journalEntry.findMany({
      where: { organizationId, sourceId: { in: invoices.map((i) => keyFor(i.id)) } },
      select: { sourceId: true },
    })
    const bookedIds = new Set(booked.map((b) => b.sourceId))
    const missing = invoices.filter((i) => !bookedIds.has(keyFor(i.id))).length
    if (missing === 0) return null
    return {
      code: 'invoices-without-entry',
      severity: 'warning',
      message: `${missing} faktura(or) i perioden saknar verifikat.`,
      count: missing,
    }
  }

  /** Aktiva kontrakt som saknar hyresavi för månaden (oaviserat). */
  private async checkUnbilledLeases(
    organizationId: string,
    year: number,
    month: number,
  ): Promise<PeriodCheck | null> {
    const { from: monthStart, to: monthAfter } = stockholmMonthBounds(year, month)
    const monthEnd = new Date(monthAfter.getTime() - 1)
    const leases = await this.prisma.lease.findMany({
      where: {
        organizationId,
        status: 'ACTIVE',
        startDate: { lte: monthEnd },
        OR: [{ endDate: null }, { endDate: { gte: monthStart } }],
      },
      select: { id: true },
    })
    if (leases.length === 0) return null
    const billed = await this.prisma.rentNotice.findMany({
      where: {
        organizationId,
        year,
        month,
        type: RentNoticeType.RENT,
        leaseId: { in: leases.map((l) => l.id) },
      },
      select: { leaseId: true },
    })
    const billedIds = new Set(billed.map((b) => b.leaseId))
    const missing = leases.filter((l) => !billedIds.has(l.id)).length
    if (missing === 0) return null
    return {
      code: 'unbilled-leases',
      severity: 'warning',
      message: `${missing} aktivt kontrakt saknar hyresavi för månaden.`,
      count: missing,
    }
  }

  /** Omatchade banktransaktioner i perioden = möjliga obokförda affärshändelser. */
  private async checkUnmatchedBankTransactions(
    organizationId: string,
    from: Date,
    to: Date,
  ): Promise<PeriodCheck | null> {
    const count = await this.prisma.bankTransaction.count({
      where: { organizationId, date: { gte: from, lt: to }, status: 'UNMATCHED' },
    })
    if (count === 0) return null
    return {
      code: 'unmatched-bank-transactions',
      severity: 'warning',
      message: `${count} banktransaktion(er) i perioden är omatchade — de kan dölja obokförda affärshändelser.`,
      count,
    }
  }

  /**
   * Sanity-check på verifikationsnummer-serien för räkenskapsåret perioden
   * tillhör. Ska aldrig slå (allocate ger en obruten serie), men en lucka vore
   * ett BFL 5:6-problem och är billig att titta efter innan låsning.
   */
  private async checkVerificationNumberGaps(
    organizationId: string,
    periodStart: Date,
  ): Promise<PeriodCheck | null> {
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { fiscalYearStartMonth: true },
    })
    const fiscalYear = VerifikationsnummerService.fiscalYearFor(
      periodStart,
      org?.fiscalYearStartMonth ?? 1,
    )
    // Aggregat i DB i stället för att hämta hem hela årets verifikationsnummer
    // och sortera dem i Node — en aktiv org har tusentals rader per år.
    const agg = await this.prisma.journalEntry.aggregate({
      where: { organizationId, fiscalYear, series: DEFAULT_VER_SERIES },
      _min: { verNumber: true },
      _max: { verNumber: true },
      _count: { verNumber: true },
    })
    const count = agg._count.verNumber
    const min = agg._min.verNumber
    const max = agg._max.verNumber
    if (count === 0 || min == null || max == null) return null
    const gaps = max - min + 1 - count
    if (gaps <= 0) return null
    return {
      code: 'verification-number-gaps',
      severity: 'warning',
      message: `Verifikationsserien för räkenskapsåret ${fiscalYear} har ${gaps} lucka/luckor (BFL 5 kap 6 § kräver obruten nummerföljd).`,
      count: gaps,
    }
  }

  // ── Sammanfattning (ögonblicksbild vid stängning) ──────────────────────────
  private async buildSummary(
    organizationId: string,
    year: number,
    month: number,
  ): Promise<PeriodSummary> {
    // Samma svenska gränser som precheck — summaryn är en ögonblicksbild som
    // ALDRIG räknas om, så en post som hamnar i fel månad blir permanent fel.
    const { from, to } = stockholmMonthBounds(year, month)
    const lines = await this.prisma.journalEntryLine.findMany({
      where: { journalEntry: { organizationId, date: { gte: from, lt: to } } },
      include: { account: true },
    })
    let revenue = 0
    let expenses = 0
    for (const l of lines) {
      const num = l.account.number
      const debit = Number(l.debit ?? 0)
      const credit = Number(l.credit ?? 0)
      if (num >= 3000 && num < 4000) revenue += credit - debit
      else if (num >= 5000 && num < 9000) expenses += debit - credit
    }
    return {
      month,
      year,
      revenue,
      expenses,
      result: revenue - expenses,
      entriesCount: new Set(lines.map((l) => l.journalEntryId)).size,
      generatedAt: new Date().toISOString(),
    }
  }

  private assertValidPeriod(year: number, month: number): void {
    if (!Number.isInteger(month) || month < 1 || month > 12) {
      throw new BadRequestException('Månad måste vara 1–12')
    }
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      throw new BadRequestException('Ogiltigt år')
    }
  }
}

/** Resultat-ögonblicksbild som sparas på den stängda perioden. */
export interface PeriodSummary {
  month: number
  year: number
  revenue: number
  expenses: number
  result: number
  entriesCount: number
  generatedAt: string
}
