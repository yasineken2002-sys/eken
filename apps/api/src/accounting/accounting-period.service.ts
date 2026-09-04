import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common'
import { CompanyForm, NotificationType, Prisma, RentNoticeType, UserRole } from '@prisma/client'
import type { AccountingPeriodEventReasonCategory } from '@prisma/client'
import { NotFoundException } from '@nestjs/common'
import { PrismaService } from '../common/prisma/prisma.service'
import { AccountingService } from './accounting.service'
import { isResultAccountNumber, YEAR_RESULT_ACCOUNT_BY_FORM } from './bas-chart'
import { fiscalYearBounds, fiscalYearOf, type FiscalYearBounds } from './fiscal-year'
import { vatPeriodLabelsForMonths } from '../avisering/vat-period.util'
import {
  stockholmCivilDate,
  stockholmMonthBounds,
  stockholmMonthDayBounds,
} from '../common/time/stockholm-period'
import {
  appendFiscalYearClose,
  appendPeriodClosedEvent,
  appendPeriodReopenedEvent,
  findFiscalYearClose,
  fiscalYearLabel,
  getClosedFiscalYears,
  getClosedPeriodStates,
  getPeriodHistory,
  getReopenCounts,
  isPeriodClosed,
  periodKeyOf,
  type PeriodHistoryEvent,
  type PeriodKey,
} from './closed-period'
import { DEFAULT_VER_SERIES, VerifikationsnummerService } from './verifikationsnummer.service'
import { PRISMA_DEFAULT_TX_LIMITS } from '../common/prisma/transaction-limits'

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

/**
 * Vem som får stänga en period. MANAGER utesluts medvetet — att låsa en månad är
 * en redovisningshandling, inte förvaltning.
 *
 * ── VARFÖR ADMIN STÅR MED (beslut 2026-08-01) ────────────────────────────────
 *
 * ADMIN är i grunden en systemadministratörsroll, inte en ekonomiroll, och i
 * större organisationer hålls "får administrera systemet" och "får röra
 * bokföringen" ofta medvetet isär. Att ADMIN ändå får stänga perioder och rätta
 * verifikat är ett MEDVETET val, inte ett förbiseende — FAR flaggade det och
 * frågan avgjordes.
 *
 * Skälet är målgruppen: 1–50 enheter, där ägaren och administratören nästan
 * alltid är samma människa. En uppdelning hade kostat verklig friktion för varje
 * kund för att skydda mot en ansvarsblandning som knappt någon av dem har.
 *
 * Beslutet är alltså kalibrerat mot dagens kundsegment och inte mot principen.
 * Tillkommer kunder med flera administratörer, där ansvarsfördelning faktiskt
 * betyder något, ska det omprövas — och då är rätt lösning sannolikt en egen
 * ekonomiroll, inte att beskära ADMIN.
 *
 * Samma resonemang gäller `REVERSAL_ROLES` i accounting.service.ts.
 *
 * ── Varför den är exporterad ─────────────────────────────────────────────────
 *
 * `accounting-role-gates.spec.ts` kräver att controllerns `@Roles`-lista säger
 * EXAKT samma sak. Två lager är ett skydd bara så länge de är överens; glider de
 * isär blir det andra lagret tyst overksamt.
 */
export const CLOSE_ROLES: UserRole[] = [UserRole.ACCOUNTANT, UserRole.ADMIN, UserRole.OWNER]

/**
 * Årsstängningen kräver mer än månadsstängningen: OWNER eller ADMIN, inte
 * ACCOUNTANT. Att stänga ett räkenskapsår bokför ett verifikat som avslutar
 * årets resultaträkning och låser året OÅTERKALLELIGT — det finns ingen
 * återöppning av ett år (se FiscalYearClose i schema.prisma). En månad kan
 * öppnas igen av OWNER; ett år kan inte öppnas alls, och då ska beslutet ligga
 * hos den som bär ansvaret för bokslutet.
 */
export const CLOSE_YEAR_ROLES: UserRole[] = [UserRole.ADMIN, UserRole.OWNER]

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
 * Nej. För alla, alltid.
 *
 * ── BESLUT 2026-08-02: regeln är LÅST, inte en platshållare ──────────────────
 *
 * Funktionen stod länge här som ett förberett undantag: "en revisor ska få göra
 * det här när revisorskonton finns". Den premissen är PRÖVAD OCH FÖRKASTAD.
 * `false` är numera ett avsiktligt låst svar, inte ett provisorium i väntan på
 * en roll som kan lyfta det.
 *
 * Frågan ställdes i R4-kartläggningen, i formen "revisorn ska få göra en sak
 * ägaren inte får". Svaret var ett bestämt nej, av skäl som gäller oavsett
 * vilken form en revisorsroll får.
 *
 * Underlaget kommer från granskarrollen FAR — projektets interna beteckning på
 * den redovisningsgranskning som görs före bokföringsnära ändringar, jämförbar
 * med security-auditor och code-reviewer. Det är alltså INTE ett uttalande från
 * branschorganisationen Föreningen Auktoriserade Revisorer; se "Öppen
 * verifieringspunkt" nedan. Beslutet att låsa regeln är produktägarens, på det
 * underlaget — samma ansvarsfördelning som CLOSE_ROLES-beslutet ovan.
 *
 * SKÄL 1 — BOKFÖRINGSPRINCIPEN ÄR ROLLAGNOSTISK. Regeln "en felaktig post rättas
 * aldrig genom att öppna den gamla perioden" är en METODfråga, inte en
 * behörighetsfråga. Verkan på räkenskaperna är identisk oavsett vems konto som
 * trycker på knappen: RAPPORTERNA för den stängda månaden — resultat- och
 * balansräkning, en redan lämnad momsdeklaration, ett fastställt årsbokslut —
 * skulle ändras utan någon markering i rapporterna själva. Spåret är inte helt
 * dolt (`reopenPeriod` skriver en append-only REOPENED-händelse oavsett orsak),
 * men den som läser periodens siffror ser en månad som ser ut att alltid ha
 * varit rätt. Att öppna hålet för en ny rollkategori efter att ha stängt det för
 * alla andra är därför inte en avvägning mellan behörigheter — det är att
 * montera ner en korrekt utformad absolut regel, och att göra det i just det
 * fall där den behövs mest.
 *
 * SKÄL 2 — OBEROENDET. Om revisorn utför eller låser upp en bokföringsåtgärd
 * uppstår ett självgranskningshot: hon skulle senare granska en bokföring hon
 * själv medverkat till att ändra. Det är dessutom medverkan i en ledningsuppgift
 * — bokföringsskyldigheten vilar på BOLAGET, inte på revisorn. Revisorns rätta
 * roll här är att UPPTÄCKA OCH PÅTALA, inte att utföra.
 *
 * SKÄL 3 — FALLET HAR REDAN EN LÖSNING, OCH DEN ÄR LAGREGLERAD. En felaktig post
 * rättas med en motverifikation i innevarande period. Bokföringslagen 5 kap 5 §
 * kräver att det vid en rättelse anges NÄR den skett och VEM som gjort den, och
 * att en granskare "utan svårighet" ska kunna få kännedom om rättelsen när den
 * sker genom en särskild rättelsepost; 5 kap 9 § ställer samma krav när en
 * verifikation rättas. Den riktade rättelseknappen (T5 PR1c2) gör exakt det:
 * rättelseposten dateras i dag, inte till originalets datum, och bär en
 * hänvisning till vilket verifikat som rättas. Ingen återöppning behövs, varken
 * för bolaget eller för en granskare. Det som ÄR tillåtet — att hämta in en GLÖMD
 * post i sin rätta period (MISSING_ENTRY) — är en annan sak och rörs inte.
 *
 * SPÄRREN ÄR TIDSOBEROENDE. Räkenskapsårsspärren i samma fil
 * (`REOPEN_WINDOW_MONTHS`) är en tidsgräns för det TILLÅTNA fallet — hur länge
 * en glömd post får hämtas in. Den här spärren är något annat: ett absolut nej
 * för det otillåtna fallet, lika giltigt dag ett efter stängning som år tre. De
 * två ska inte läsas ihop.
 *
 * ── Skälen vilar på olika slags källor. Det ska synas. ──────────────────────
 *
 * SKÄL 3 har ett VERIFIERAT lagstöd. Paragraferna ovan är hämtade ur projektets
 * egen lagkälla, `.claude/knowledge/lagar/bokforingslagen.md` (verifierad
 * 2026-05-29, med källhänvisning) — inte ur en modells minne. Regeln att AI
 * aldrig skriver lagrum i produktionskod finns för att hindra att ett
 * paragrafnummer hittas på eller minns fel; den risken finns inte när citatet
 * kommer ur en människoverifierad källa i repot, och kodbasen citerar redan
 * därifrån på flera ställen (se t.ex. verifikationsnummerkontrollen i den här
 * filen).
 *
 * SKÄL 2 har det INTE. Det vilar på professionsnormer om revisorns oberoende
 * (revisorslagen, FAR:s analysmodell), som inte finns i projektets lagkälla och
 * som FAR själv flaggade som obekräftade. Därför står skäl 2 med noll
 * paragrafnummer — och ska fortsätta göra det tills en verksam revisor bekräftat
 * normkällan. Att skriva ut ett lagrum där hade varit att låtsas om en säkerhet
 * som inte finns.
 *
 * Skillnaden är inte formalia: den avgör vilket skäl som kan ifrågasättas av en
 * granskare med lagboken i hand, och vilket som först måste stämmas av med
 * någon som yrkesmässigt kan normen.
 *
 * ── Omprövas om ─────────────────────────────────────────────────────────────
 *
 *   • en verksam revisor motsäger oberoenderesonemanget i skäl 2, ELLER
 *   • normkällan visar sig säga något annat än vad skäl 2 antar, ELLER
 *   • en rättelseform tillkommer som gör en bakdaterad post SYNLIG som rättelse
 *     i rapporterna för den stängda perioden — då faller skäl 1:s premiss, ELLER
 *   • ett verkligt fall visar sig där motverifikation i innevarande period inte
 *     ger en rättvisande bild: t.ex. ett fel som sträcker sig över flera redan
 *     avslutade räkenskapsår vars resultat redan är fastställda. Då faller
 *     skäl 3.
 *
 * SKÄL 1 BÄR BESLUTET ENSAMT. Faller dess premiss är frågan öppen igen, även om
 * skäl 3 står kvar — skäl 3 är ett understödjande argument, inte en självständig
 * pelare, och vilar dessutom på en generell lagregel som knappast kan falla i
 * praktiken. Att kräva att båda faller hade varit en hårdare låsning än skäl 1
 * motiverar, alltså ett villkor som aldrig går att uppfylla.
 *
 * Faller bara skäl 2 kvarstår regeln, men motiveringen ska skrivas om — ett skäl
 * som visat sig fel får inte ligga kvar och bära ett beslut det inte längre
 * håller uppe.
 *
 * ── Varför funktionen finns kvar ────────────────────────────────────────────
 *
 * Regeln är samlad på ett ställe i stället för utspridd som ett
 * `if (kategori === EXISTING_ENTRY_INCORRECT) throw` inne i flödet. Det var
 * ursprungligen för att undantaget skulle bli lätt att införa; nu är det i
 * stället för att beslutet ska vara lätt att HITTA. Den som söker efter var
 * regeln bor möter motiveringen på samma gång.
 *
 * Parametern behålls av samma skäl: signaturen visar att frågan "vem frågar?"
 * har ställts och besvarats med "det spelar ingen roll" — inte att den aldrig
 * ställdes.
 */
export function canReopenForCorrection(_actorRole: UserRole): boolean {
  return false
}

@Injectable()
export class AccountingPeriodService {
  private readonly logger = new Logger(AccountingPeriodService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly accounting: AccountingService,
  ) {}

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
    // TVÅ SORTERS GRÄNSER, och valet per kontroll är inte kosmetiskt (#730).
    //
    //   from/to      ÖGONBLICK — mot tidsstämpelkolumner (BankTransaction.date)
    //                och mot rå SQL, där Postgres promotar ett datum till
    //                midnatt så att jämförelsen blir rätt ändå.
    //   dagFrom/Till DAGAR — mot `@db.Date`-kolumner via Prismas ORM, som
    //                trunkerar en ögonblicksparameter till ett datum. Mätt: med
    //                ögonblicksgränser tog fönstret med föregående månads sista
    //                dag och tappade sin egen. Se stockholmMonthDayBounds.
    const { from, to } = stockholmMonthBounds(year, month)
    const { from: dagFrom, to: dagTill } = stockholmMonthDayBounds(year, month)

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
        this.checkInvoicesWithoutEntry(organizationId, dagFrom, dagTill),
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
    const prepared = await this.prepareMonthClose(organizationId, year, month, opts)

    try {
      await this.prisma.$transaction(
        async (tx) =>
          this.writeMonthClose(tx, organizationId, year, month, prepared, opts.actorUserId ?? null),
        PRISMA_DEFAULT_TX_LIMITS,
      )
    } catch (err) {
      throw this.asAlreadyClosed(err, year, month)
    }
    const { summary } = prepared

    this.logger.log(
      `[period] ${periodKeyOf({ year, month })} stängd för org ${organizationId} ` +
        `(${summary.entriesCount} verifikat, resultat ${summary.result})`,
    )

    return { year, month, summary, checks: prepared.pre.checks }
  }

  // ── Månadsstängningens delade kärna (#704 PR 2) ───────────────────────────
  //
  // Uppdelningen finns för att ÅRSSTÄNGNINGEN ska kunna stänga månad tolv med
  // exakt samma grindar, samma ögonblicksbild och samma skrivning som en vanlig
  // månadsstängning — utan att kopiera dem. En kopia hade blivit två stängningar
  // som kan glida isär, och den ena hade varit den som ingen tittar på.
  //
  // Snittet ligger där det gör därför att ALLA grindar och ALL läsning är
  // sidoeffektfria: `prepareMonthClose` kan därför köras utanför transaktionen
  // (den ska kunna neka innan något öppnats), och `writeMonthClose` är den enda
  // biten som måste ligga inuti.

  /** Alla grindar + ögonblicksbilden. Ren läsning; kastar om månaden inte får stängas. */
  private async prepareMonthClose(
    organizationId: string,
    year: number,
    month: number,
    opts: { actorRole?: UserRole; actorUserId?: string | null },
  ): Promise<{ pre: PeriodPrecheck; summary: PeriodSummary; actorLabel: string | null }> {
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
    return { pre, summary, actorLabel }
  }

  /**
   * Skrivningen. MÅSTE köras med en transaktionsklient.
   *
   * summary är en ÖGONBLICKSBILD vid stängningstillfället och räknas aldrig om i
   * efterhand (FAR: att uppdatera den retroaktivt vore att påstå att den som
   * stängde såg siffror hen aldrig såg). Därför skrivs den in i händelsen och
   * rörs sedan aldrig — en framtida omstängning lägger en NY händelse med en NY
   * bild bredvid den gamla i stället för att skriva över den.
   *
   * TILLSTÅNDSKONTROLLEN INUTI TRANSAKTIONEN är ny (#704 PR 2) och stänger ett
   * fönster som fanns förut: `prepareMonthClose` läser utanför transaktionen, så
   * två samtidiga stängningar kunde båda se "öppen". Krockade de på seq fick
   * förloraren P2002 — men hann den ena committa FÖRE den andra öppnade sin
   * transaktion räknade den andra fram seq = n+1, fick inget P2002, och kedjan
   * blev `CLOSED → CLOSED` utan mellanliggande återöppning. Ingen bokföring
   * hamnar fel av det (perioden är stängd i båda fallen), men historiken är
   * hela poängen med händelsemodellen. Samma resonemang och samma åtgärd som i
   * `appendPeriodReopenedEvent`.
   */
  private async writeMonthClose(
    tx: Prisma.TransactionClient,
    organizationId: string,
    year: number,
    month: number,
    prepared: { summary: PeriodSummary; actorLabel: string | null },
    actorUserId: string | null = null,
  ): Promise<void> {
    const { from } = stockholmMonthBounds(year, month)
    if (await isPeriodClosed(tx, organizationId, from)) {
      throw new ConflictException(`Perioden ${periodKeyOf({ year, month })} är redan stängd.`)
    }
    await appendPeriodClosedEvent(tx, {
      organizationId,
      year,
      month,
      actorUserId,
      actorLabel: prepared.actorLabel,
      summary: prepared.summary as unknown as Prisma.InputJsonValue,
    })
  }

  /**
   * Två samtidiga stängningar av samma period. Vilket av de två unika indexen
   * som slår (händelsens (org, år, månad, seq) eller speglingens
   * (org, år, månad)) spelar ingen roll — båda betyder exakt samma sak: någon
   * annan hann före, perioden är redan stängd.
   */
  private asAlreadyClosed(err: unknown, year: number, month: number): unknown {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return new ConflictException(`Perioden ${periodKeyOf({ year, month })} är redan stängd.`)
    }
    return err
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
      await this.prisma.$transaction(
        async (tx) =>
          appendPeriodReopenedEvent(tx, {
            organizationId,
            year,
            month,
            reason,
            reasonCategory: opts.reasonCategory,
            actorUserId: opts.actorUserId ?? null,
            actorLabel,
          }),
        PRISMA_DEFAULT_TX_LIMITS,
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
      // `Invoice.issueDate` är `@db.Date` — `from`/`to` MÅSTE därför vara DAGAR
      // (stockholmMonthDayBounds), inte ögonblick. Se #730 och anroparen.
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
    // `Lease.startDate` och `Lease.endDate` är BÅDA `@db.Date` — dagar, inte
    // ögonblick (#730). Den gamla formen använde `stockholmMonthBounds` och
    // `monthAfter − 1 ms`; övre gränsen blev rätt av en slump (trunkeringen
    // landade på månadens sista dag), men den undre blev fel: `endDate >=
    // 2026-11-30T23:00Z` trunkeras till `>= 2026-11-30`, så ett kontrakt som
    // upphörde 30 november räknades som aktivt i december. Mätt.
    const { from: dagFrom, to: dagTill } = stockholmMonthDayBounds(year, month)
    const leases = await this.prisma.lease.findMany({
      where: {
        organizationId,
        status: 'ACTIVE',
        // Startat senast sista dagen i månaden = startat FÖRE nästa månads
        // första dag. `lt` mot dagsgränsen, i stället för `lte` mot ett
        // ögonblick minus en millisekund.
        startDate: { lt: dagTill },
        OR: [{ endDate: null }, { endDate: { gte: dagFrom } }],
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
    // ÖGONBLICK är RÄTT här och ska inte bytas mot dagar (#730):
    // `BankTransaction.date` är en vanlig `DateTime`, inte `@db.Date`. Ingen
    // trunkering sker, och en transaktion 23:30 svensk tid den sista i månaden
    // ska räknas till den månaden — vilket bara ögonblicksgränserna ger.
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
    //
    // DAGAR, inte ögonblick (#730): `JournalEntry.date` är `@db.Date`, och
    // Prisma trunkerar en ögonblicksgräns till ett datum. Med den gamla formen
    // räknade december-sammanfattningen in 30 november och uteslöt 31 december —
    // och eftersom bilden aldrig räknas om blev felet permanent i historiken.
    // Det gällde också bokslutsposten, som dateras räkenskapsårets sista dag.
    const { from, to } = stockholmMonthDayBounds(year, month)
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

  // ── Årsstängning (#704 PR 2) ──────────────────────────────────────────────
  //
  // ÅRSSTÄNGNINGEN ÄR STÄNGNINGEN AV MÅNAD TOLV. Det är inte en förenkling utan
  // upplösningen av en motsägelse i #704:s egen kravtext, som ville BÅDE att
  // alla månader skulle vara stängda före årsstängningen OCH att årsavsluts-
  // verifikatet skulle dateras räkenskapsårets sista dag. Den sista dagen ligger
  // i månad tolv, så med alla tolv stängda hade månadsspärren avvisat verifikatet
  // (mätt i `closed-fiscal-year.db.spec.ts`, PR 1). Med årsstängningen SOM månad
  // tolvs stängning finns ingen motsägelse: verifikatet bokförs medan månaden
  // ännu är öppen, och månaden stängs i samma transaktion direkt efteråt.
  //
  // FÖRUTSÄTTNINGEN blir därför: månad 1–11 STÄNGDA, månad 12 ÖPPEN.
  //
  // ── VAD SOM MEDVETET INTE BYGGS ───────────────────────────────────────────
  //
  // 2099 → 2091 (årets resultat till balanserat resultat). Det är bolagsstämmans
  // dispositionsbeslut — utdelning eller balansering — och fattas efter fastställd
  // årsredovisning, av människor. Systemet får förbereda underlaget och föreslå
  // posten; det får inte bokföra den. Samma karaktär som #535.
  //
  // MOMSKONTONA rörs inte. De är LIABILITY (2000–2999) och ligger per definition
  // utanför resultatkontomängden, men det är inte därför de utelämnas: moms-
  // avräkning hör till MOMSREDOVISNINGSPERIODEN, inte till räkenskapsåret — en
  // decemberperiods moms kan deklareras i februari. Avräknade årsstängningen dem
  // skulle en ännu oreglerad skuld tystas bort ur balansräkningen. Ett kvarstående
  // saldo på 2611/2641/2650 efter stängning är RÄTT UTFALL, inte ett tecken på
  // att något saknas.

  /**
   * Förhandsbesked: vad skulle årsstängningen göra, och får den göras?
   *
   * Ren läsning — det här är underlaget PR 3:s dialog visar innan människan
   * bekräftar. Samma beräkning som `closeFiscalYear`, samma grindar, inga
   * skrivningar. Att de två delar kod är poängen: en förhandsvisning som räknar
   * på egen hand visar något annat än det som sedan bokförs.
   */
  async previewFiscalYearClose(
    organizationId: string,
    fiscalYear: number,
  ): Promise<FiscalYearClosePreview> {
    this.assertValidFiscalYear(fiscalYear)
    const org = await this.loadOrgForYearClose(organizationId)
    const bounds = fiscalYearBounds(fiscalYear, org.fiscalYearStartMonth)

    const [checks, draft] = await Promise.all([
      this.fiscalYearChecks(organizationId, org, bounds),
      this.buildYearEndDraft(this.prisma, organizationId, org, bounds),
    ])

    return {
      fiscalYear,
      label: fiscalYearLabel(fiscalYear, org.fiscalYearStartMonth),
      startMonth: org.fiscalYearStartMonth,
      fiscalStart: bounds.fiscalStart.toISOString().slice(0, 10),
      yearEndDate: bounds.yearEndDate.toISOString().slice(0, 10),
      months: bounds.months,
      canClose: !checks.some((c) => c.severity === 'blocking'),
      checks,
      entry: draft,
    }
  }

  /**
   * Stänger räkenskapsåret: bokför resultatavräkningen, stänger månad tolv och
   * skriver `FiscalYearClose` — allt i EN transaktion.
   *
   * ORDNINGEN INUTI TRANSAKTIONEN ÄR TVINGANDE, inte en stilfråga:
   *
   *   1. verifikatet   månad tolv är ännu öppen, året ännu inte stängt, så
   *                    `assertPeriodOpen` släpper igenom dateringen
   *   2. månad tolv    stängs med `writeMonthClose` — samma skrivning som en
   *                    vanlig månadsstängning, inte en kopia
   *   3. FiscalYearClose  skrivs SIST, med `journalEntryId` satt. Raden är
   *                    append-only (PR 1), så fältet går inte att fylla i
   *                    efterhand — triggern avvisar en UPDATE.
   *
   * Kastar steg 3 P2002 på (organizationId, fiscalYear) rullas HELA
   * transaktionen tillbaka: inget verifikat, ingen stängd månad. Det är
   * idempotensen, och den bor i databasen — inte i kontrollen på raden ovanför.
   */
  async closeFiscalYear(
    organizationId: string,
    fiscalYear: number,
    now: Date,
    actor: { actorRole?: UserRole; actorUserId?: string | null },
  ): Promise<FiscalYearCloseResult> {
    if (!actor.actorRole || !CLOSE_YEAR_ROLES.includes(actor.actorRole)) {
      throw new ForbiddenException('Du saknar behörighet att stänga ett räkenskapsår')
    }
    this.assertValidFiscalYear(fiscalYear)

    const org = await this.loadOrgForYearClose(organizationId)
    const bounds = fiscalYearBounds(fiscalYear, org.fiscalYearStartMonth)
    const label = fiscalYearLabel(fiscalYear, org.fiscalYearStartMonth)

    const checks = await this.fiscalYearChecks(organizationId, org, bounds)
    const blocking = checks.filter((c) => c.severity === 'blocking')
    if (blocking.length > 0) {
      throw new ConflictException(
        `Räkenskapsåret ${label} kan inte stängas: ${blocking.map((b) => b.message).join(' ')}`,
      )
    }

    // Månad tolvs egna grindar och dess ögonblicksbild. Läses FÖRE verifikatet
    // bokförs, och det är avsiktligt: `summary` ska betyda samma sak för månad
    // tolv som för varje annan månad — månadens egen omsättning. Räknades den
    // efter resultatavräkningen hade månad tolv fått hela ÅRETS intäkter
    // avdragna och visat ett stort negativt tal som inte beskriver någonting.
    const twelfth = bounds.months[11] as PeriodKey
    const prepared = await this.prepareMonthClose(
      organizationId,
      twelfth.year,
      twelfth.month,
      actor,
    )

    const actorLabel = prepared.actorLabel
    const result = await this.prisma.$transaction(async (tx) => {
      const draft = await this.buildYearEndDraft(tx, organizationId, org, bounds)

      let journalEntryId: string | null = null
      if (draft.lines.length > 0) {
        const entry = await this.accounting.createYearEndResultEntry({
          organizationId,
          fiscalYear,
          date: bounds.yearEndDate,
          lines: draft.lines.map((l) => ({
            accountId: l.accountId,
            ...(l.debit != null ? { debit: l.debit } : {}),
            ...(l.credit != null ? { credit: l.credit } : {}),
            description: l.description,
          })),
          createdById: actor.actorUserId ?? null,
          tx,
        })
        journalEntryId = entry.id
      }

      await this.writeMonthClose(
        tx,
        organizationId,
        twelfth.year,
        twelfth.month,
        prepared,
        actor.actorUserId ?? null,
      )

      const summary: FiscalYearCloseSummary = {
        fiscalYear,
        label,
        startMonth: org.fiscalYearStartMonth,
        fiscalStart: bounds.fiscalStart.toISOString().slice(0, 10),
        yearEndDate: bounds.yearEndDate.toISOString().slice(0, 10),
        result: draft.result,
        accountsZeroed: draft.lines.filter((l) => l.accountNumber !== draft.resultAccountNumber)
          .length,
        resultAccountNumber: draft.resultAccountNumber,
        // Nollresultat i betydelsen INGET ATT NOLLSTÄLLA: inget resultatkonto
        // hade saldo, så inget verifikat skrevs. Raden skrivs ändå — året ÄR
        // stängt, och att det saknas ett verifikat är ett faktum som ska framgå
        // av stängningen i stället för att se ut som en utebliven bokföring.
        noEntryReason: journalEntryId == null ? 'inga resultatkonton med saldo' : null,
        closedAt: now.toISOString(),
        generatedAt: new Date().toISOString(),
      }

      await appendFiscalYearClose(tx, {
        organizationId,
        fiscalYear,
        closedAt: now,
        closedById: actor.actorUserId ?? null,
        journalEntryId,
        summary: summary as unknown as Prisma.InputJsonValue,
      })

      return { journalEntryId, summary }
    }, PRISMA_DEFAULT_TX_LIMITS)

    this.logger.log(
      `[fiscal-year] ${label} stängt för org ${organizationId} ` +
        `(resultat ${result.summary.result}, ${result.summary.accountsZeroed} konton nollade, ` +
        `verifikat ${result.journalEntryId ?? '—'}, av ${actorLabel ?? 'system'})`,
    )

    return {
      fiscalYear,
      label,
      journalEntryId: result.journalEntryId,
      summary: result.summary,
      monthClosed: twelfth,
      checks,
    }
  }

  // ── Årsstängningens hjälpare ──────────────────────────────────────────────

  private async loadOrgForYearClose(
    organizationId: string,
  ): Promise<{ fiscalYearStartMonth: number; companyForm: CompanyForm }> {
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { fiscalYearStartMonth: true, companyForm: true },
    })
    if (!org) throw new NotFoundException('Organisationen hittades inte')
    return { fiscalYearStartMonth: org.fiscalYearStartMonth ?? 1, companyForm: org.companyForm }
  }

  private assertValidFiscalYear(fiscalYear: number): void {
    if (!Number.isInteger(fiscalYear) || fiscalYear < 2000 || fiscalYear > 2100) {
      throw new BadRequestException('Ogiltigt räkenskapsår')
    }
  }

  /**
   * Alla förutsättningar för årsstängningen, som en LISTA i stället för en kedja
   * av kast.
   *
   * Formen är vald för att förhandsvisningen ska kunna visa ALLT som är i vägen
   * på en gång. Kastar man på det första hindret får operatören rätta en sak,
   * försöka igen, och mötas av nästa — och en årsstängning görs en gång om året,
   * av någon som inte gjort den nyligen.
   */
  private async fiscalYearChecks(
    organizationId: string,
    org: { fiscalYearStartMonth: number; companyForm: CompanyForm },
    bounds: FiscalYearBounds,
  ): Promise<FiscalYearCheck[]> {
    const checks: FiscalYearCheck[] = []
    const label = fiscalYearLabel(bounds.fiscalYear, org.fiscalYearStartMonth)
    const twelfth = bounds.months[11] as PeriodKey

    const [redanStängt, stängdaPerioder, konton, tidigareDatum] = await Promise.all([
      findFiscalYearClose(this.prisma, organizationId, bounds.fiscalYear),
      getClosedPeriodStates(this.prisma, organizationId),
      this.prisma.account.findMany({
        where: { organizationId },
        select: { id: true, number: true, name: true, type: true },
      }),
      // DISTINKTA DATUM, inte en beräkning i SQL: räkenskapsåret ett datum
      // tillhör härleds på ETT ställe (`fiscalYearOf` → `stockholmFiscalYear`).
      // En CASE-sats i SQL hade varit en andra härledning, och den hade dessutom
      // behövt upprepa den civila tidens subtilitet.
      this.prisma.journalEntry.findMany({
        where: { organizationId, date: { lt: bounds.fiscalStart } },
        select: { date: true },
        distinct: ['date'],
      }),
    ])

    // (1) IDEMPOTENSEN, som ett besked i stället för ett databasfel.
    if (redanStängt) {
      checks.push({
        code: 'fiscal-year-already-closed',
        severity: 'blocking',
        message:
          `Räkenskapsåret ${label} är redan stängt ` +
          `(${redanStängt.closedAt.toISOString().slice(0, 10)}).`,
      })
    }

    // (2) MÅNAD 1–11 STÄNGDA, MÅNAD 12 ÖPPEN — se docblocket ovanför
    // previewFiscalYearClose för varför just den formen.
    const stängda = new Set(stängdaPerioder.map(periodKeyOf))
    const saknas = bounds.months.slice(0, 11).filter((m) => !stängda.has(periodKeyOf(m)))
    if (saknas.length > 0) {
      checks.push({
        code: 'months-not-closed',
        severity: 'blocking',
        message:
          `Följande månader måste stängas först: ${saknas.map(periodKeyOf).join(', ')}. ` +
          'Årsstängningen är stängningen av årets sista månad.',
      })
    }
    if (stängda.has(periodKeyOf(twelfth))) {
      checks.push({
        code: 'final-month-already-closed',
        severity: 'blocking',
        message:
          `Årets sista månad (${periodKeyOf(twelfth)}) är redan stängd, så ` +
          'årsavslutsverifikatet kan inte längre bokföras i den. Öppna månaden igen ' +
          'och stäng räkenskapsåret i stället för månaden.',
      })
    }

    // (3) TOLVMÅNADERSÅR I v1. Ett förkortat eller förlängt FÖRSTA räkenskapsår
    // går inte att uttrycka: `Organization` bär `fiscalYearStartMonth` men inget
    // faktiskt start- och slutdatum. Spärren är därför formulerad som en fråga
    // koden KAN svara på — finns bokföring före det här årets första dag som
    // inte tillhör ett stängt år? — i stället för att låtsas veta något om
    // årets längd. Se följdärendet som PR 2 öppnade.
    const tidigareÅr = [
      ...new Set(tidigareDatum.map((d) => fiscalYearOf(d.date, org.fiscalYearStartMonth))),
    ].sort((a, b) => a - b)
    if (tidigareÅr.length > 0) {
      const stängdaÅrSet = await getClosedFiscalYears(this.prisma, organizationId, tidigareÅr)
      const öppna = tidigareÅr.filter((y) => !stängdaÅrSet.has(y))
      if (öppna.length > 0) {
        checks.push({
          code: 'earlier-fiscal-year-open',
          severity: 'blocking',
          message:
            `Det finns bokföring i tidigare räkenskapsår som inte är stängda: ` +
            `${öppna.map((y) => fiscalYearLabel(y, org.fiscalYearStartMonth)).join(', ')}. ` +
            'Stäng dem i ordning först — ingående balanser för det här året vilar på dem.',
        })
      }
    }

    // (4) PARTITIONERNA MÅSTE VARA ENSE OM MÄNGDEN (#716). Mängden avgörs av
    // numret; att `type` säger samma sak kontrolleras här i stället för att
    // antas. Mätt i dag: noll avvikelser i hela BAS-planen. Men organisationen
    // kan lägga till egna konton, och ett balanskonto som råkat få type=EXPENSE
    // (eller ett resultatkonto numrerat i 2-serien) skulle antingen nollas fel
    // eller missas helt — tyst, i ett verifikat ingen läser rad för rad.
    const oeniga = konton.filter(
      (a) => isResultAccountNumber(a.number) !== (a.type === 'REVENUE' || a.type === 'EXPENSE'),
    )
    if (oeniga.length > 0) {
      checks.push({
        code: 'account-partition-mismatch',
        severity: 'blocking',
        message:
          'Kontoplanen är motsägelsefull: följande konton klassas olika av kontonumret ' +
          `och av kontotypen — ${oeniga
            .map((a) => `${a.number} ${a.name} (type=${a.type})`)
            .join(', ')}. ` +
          'Rätta klassificeringen innan året stängs; annars kan resultatavräkningen ' +
          'nollställa fel konton.',
      })
    }

    // (5) MOTKONTOT MÅSTE FINNAS. Numret beror på bolagsformen — 2099 gäller
    // bara aktiebolag (se YEAR_RESULT_ACCOUNT_BY_FORM).
    const resultNumber = YEAR_RESULT_ACCOUNT_BY_FORM[org.companyForm]
    if (!konton.some((a) => a.number === resultNumber)) {
      checks.push({
        code: 'year-result-account-missing',
        severity: 'blocking',
        message:
          `Kontot ${resultNumber} (Årets resultat) saknas i kontoplanen. ` +
          'Seeda BAS-kontoplanen innan räkenskapsåret stängs.',
      })
    }

    // (6) BOKSLUTSPOSTER — icke-blockerande med flit. Systemet kan inte avgöra
    // om periodiseringarna är kompletta; det kräver kännedom om verksamheten.
    // Ett blockerande krav hade därför bara producerat falska stopp. Men steget
    // är oåterkalleligt åt ett håll: efter stängningen går bokslutsposter inte
    // längre att bokföra i året.
    checks.push({
      code: 'accruals-before-close',
      severity: 'warning',
      message:
        'Kontrollera att bokslutsposter och periodiseringar är bokförda innan året stängs — ' +
        'efteråt går det inte. Den automatiska periodiseringen av omätt förbrukning körs ' +
        'separat (bokslutspost IMD) och måste köras först.',
    })

    // (7) MOMSEN STÅR KVAR, och det är rätt. Sägs uttryckligen så att ett
    // kvarstående saldo inte läses som ett fel av den som stänger.
    checks.push({
      code: 'vat-accounts-untouched',
      severity: 'warning',
      message:
        'Momskonton avräknas inte av årsstängningen. Moms hör till momsredovisnings-' +
        'perioden, inte till räkenskapsåret — ett kvarstående saldo är väntat.',
    })

    return checks
  }

  /**
   * ÅRSAVSLUTSVERIFIKATET, SALDOBASERAT.
   *
   * ── VARFÖR SALDOT OCH INTE KLASSIFICERINGEN AVGÖR RIKTNINGEN ─────────────
   *
   * Belägget är #716: kodbasen har tre partitioner av kontoplanen och de är
   * oeniga om två verkliga konton — 8131 och 8313 har `type=REVENUE` men ligger
   * i nummerklass 4–8, som `ACCOUNT_CLASS_RANGES` kallar EXPENSE. En typbaserad
   * och en intervallbaserad regel ger alltså OLIKA riktning på just de kontona.
   *
   * Och även om de vore ense vore klassificeringen fel verktyg: den säger vilken
   * sida kontot NORMALT ligger på, inte vilken sida det faktiskt ligger på. Ett
   * kostnadskonto kan lagligt bära kreditsaldo (återförd kostnad, för hög
   * periodisering). Saldot vet; klassificeringen gissar.
   *
   *   kreditsaldo (saldo < 0)  →  DEBITERA kontot med beloppet
   *   debetsaldo  (saldo > 0)  →  KREDITERA kontot med beloppet
   *   saldo = 0                →  ingen rad; ett konto utan saldo har inget att
   *                               nollställa, och en nollrad i ett verifikat är
   *                               brus för den som granskar
   *
   * Nettot går mot Årets resultat på den sida som gör verifikatet balanserat.
   * `createNumberedEntry`s globala balansgrind är därför inte bara ett skyddsnät
   * här utan en riktig kontroll av uträkningen ovan.
   *
   * ── DECIMAL HELA VÄGEN ────────────────────────────────────────────────────
   *
   * Beloppen är Decimal(10,2) och summeras i Decimal, aldrig via Number. Ett öre
   * är ett fel, inte brus — mätningen på #704 hade med flit en öresfordran
   * (0,01) i sitt provfall, och en flyttalskonvertering hade kunnat flytta den.
   */
  private async buildYearEndDraft(
    client: Pick<Prisma.TransactionClient, 'journalEntryLine' | 'account'>,
    organizationId: string,
    org: { fiscalYearStartMonth: number; companyForm: CompanyForm },
    bounds: FiscalYearBounds,
  ): Promise<FiscalYearEntryDraft> {
    const resultAccountNumber = YEAR_RESULT_ACCOUNT_BY_FORM[org.companyForm]

    const konton = await client.account.findMany({
      where: { organizationId },
      select: { id: true, number: true, name: true },
    })
    const resultatkonton = konton.filter((a) => isResultAccountNumber(a.number))
    const motkonto = konton.find((a) => a.number === resultAccountNumber)

    const summor = await client.journalEntryLine.groupBy({
      by: ['accountId'],
      where: {
        accountId: { in: resultatkonton.map((a) => a.id) },
        journalEntry: { organizationId, date: { gte: bounds.from, lt: bounds.to } },
      },
      _sum: { debit: true, credit: true },
    })
    const perKonto = new Map(summor.map((r) => [r.accountId, r]))

    const lines: FiscalYearEntryLine[] = []
    let debetSumma = new Prisma.Decimal(0)
    let kreditSumma = new Prisma.Decimal(0)

    // Stigande kontonummer: verifikatet ska gå att läsa uppifrån och ned som
    // kontoplanen, inte i den ordning databasen råkade returnera raderna.
    for (const konto of [...resultatkonton].sort((a, b) => a.number - b.number)) {
      const rad = perKonto.get(konto.id)
      const debet = new Prisma.Decimal(rad?._sum.debit ?? 0)
      const kredit = new Prisma.Decimal(rad?._sum.credit ?? 0)
      const saldo = debet.minus(kredit)
      if (saldo.isZero()) continue

      if (saldo.isPositive()) {
        kreditSumma = kreditSumma.plus(saldo)
        lines.push({
          accountId: konto.id,
          accountNumber: konto.number,
          accountName: konto.name,
          credit: saldo.toNumber(),
          description: `Nollställning ${konto.number} ${konto.name}`,
        })
      } else {
        const belopp = saldo.negated()
        debetSumma = debetSumma.plus(belopp)
        lines.push({
          accountId: konto.id,
          accountNumber: konto.number,
          accountName: konto.name,
          debit: belopp.toNumber(),
          description: `Nollställning ${konto.number} ${konto.name}`,
        })
      }
    }

    // Resultatet: summan av (kredit − debet) över resultatkontona. Positivt =
    // vinst. Uttryckt ur samma tal som raderna byggdes av, inte omräknat.
    const resultat = debetSumma.minus(kreditSumma)

    if (lines.length > 0 && !resultat.isZero()) {
      if (!motkonto) {
        // Kan inte inträffa via `closeFiscalYear` — check (5) har redan fällt.
        // Förhandsvisningen når hit när kontot saknas, och ska då visa raderna
        // den KAN visa i stället för att kasta.
        return {
          lines,
          result: resultat.toNumber(),
          resultAccountNumber,
          resultAccountMissing: true,
          date: bounds.yearEndDate.toISOString().slice(0, 10),
        }
      }
      if (resultat.isPositive()) {
        lines.push({
          accountId: motkonto.id,
          accountNumber: motkonto.number,
          accountName: motkonto.name,
          credit: resultat.toNumber(),
          description: `Årets resultat ${bounds.fiscalYear}`,
        })
      } else {
        lines.push({
          accountId: motkonto.id,
          accountNumber: motkonto.number,
          accountName: motkonto.name,
          debit: resultat.negated().toNumber(),
          description: `Årets resultat ${bounds.fiscalYear}`,
        })
      }
    }

    return {
      lines,
      result: resultat.toNumber(),
      resultAccountNumber,
      resultAccountMissing: false,
      date: bounds.yearEndDate.toISOString().slice(0, 10),
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

// ─── Årsstängningens typer (#704 PR 2) ───────────────────────────────────────

/** En förutsättning för årsstängningen — uppfylld eller inte. */
export interface FiscalYearCheck {
  /** Maskinläsbar kod, t.ex. 'months-not-closed'. */
  code: string
  /** 'blocking' = stängning nekas. 'warning' = operatören får avgöra. */
  severity: 'blocking' | 'warning'
  message: string
}

/** En rad i årsavslutsverifikatet. Kontonamn följer med för UI:ts skull. */
export interface FiscalYearEntryLine {
  accountId: string
  accountNumber: number
  accountName: string
  debit?: number
  credit?: number
  description: string
}

/** Det föreslagna (eller bokförda) årsavslutsverifikatet. */
export interface FiscalYearEntryDraft {
  lines: FiscalYearEntryLine[]
  /** Positivt = vinst, negativt = förlust. Samma tal som plug-posten. */
  result: number
  /** Motkontots nummer för organisationens bolagsform (2099 för AB). */
  resultAccountNumber: number
  /** true = kontot saknas i kontoplanen; plug-raden kunde inte läggas till. */
  resultAccountMissing: boolean
  /** Räkenskapsårets sista dag, `YYYY-MM-DD`. */
  date: string
}

/** Ögonblicksbilden som skrivs på `FiscalYearClose.summary`. Räknas aldrig om. */
export interface FiscalYearCloseSummary {
  fiscalYear: number
  label: string
  startMonth: number
  fiscalStart: string
  yearEndDate: string
  result: number
  /** Antal resultatkonton som nollställdes (plug-raden inte inräknad). */
  accountsZeroed: number
  resultAccountNumber: number
  /** Varför inget verifikat skrevs, eller null när ett skrevs. */
  noEntryReason: string | null
  closedAt: string
  generatedAt: string
}

/** Vad förhandsvisningen svarar — underlaget PR 3:s dialog visar. */
export interface FiscalYearClosePreview {
  fiscalYear: number
  label: string
  startMonth: number
  fiscalStart: string
  yearEndDate: string
  months: PeriodKey[]
  canClose: boolean
  checks: FiscalYearCheck[]
  entry: FiscalYearEntryDraft
}

/** Vad en genomförd årsstängning svarar. */
export interface FiscalYearCloseResult {
  fiscalYear: number
  label: string
  /** null när inget resultatkonto hade saldo — se `summary.noEntryReason`. */
  journalEntryId: string | null
  summary: FiscalYearCloseSummary
  /** Månaden som stängdes som en del av årsstängningen (årets tolfte). */
  monthClosed: PeriodKey
  checks: FiscalYearCheck[]
}
