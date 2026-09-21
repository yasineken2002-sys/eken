import { Injectable, Logger } from '@nestjs/common'
import { Prisma, UserRole } from '@prisma/client'
import { PrismaService } from '../common/prisma/prisma.service'
import { MailService } from '../mail/mail.service'
import { PRISMA_DEFAULT_TX_LIMITS, TransactionLimits } from '../common/prisma/transaction-limits'
// G2 — VILLKORET, inte tjänsten. En ren konstant ur avstämningen; ingen
// modulkant och därmed ingen cykel (se filens egen not).
import {
  OLOST_IDENTITETSGRANSKNING,
  olostGranskningForOrg,
} from '../reconciliation/identitetsgranskning'

/**
 * Nivå 1 mäter registrerat första importförsök och det befintliga datumets ålder.
 * Den kan inte se fullständig banktäckning, ospårade äldre försök eller bevisad
 * manuell avstämning. NULL utan försök behåller enbart tidigare passage.
 * Penganeutral: inga verifikat, belopp eller matchningsregler.
 */

/** Anroparen väljer tidsgränserna uttryckligt; färskhetsporten kräver ReadCommitted. */
export function paymentFreshnessTransactionOptions(limits: TransactionLimits) {
  return { ...limits, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }
}

export class PaymentDataPausedError extends Error {
  constructor() {
    super('Automatiska krav är pausade: betalningsunderlaget behöver uppdateras.')
    this.name = 'PaymentDataPausedError'
  }
}

/**
 * G2 — automatiska krav pausade av en OLÖST IDENTITETSGRANSKNING.
 *
 * EGEN KLASS OCH INTE ETT SKÄL PÅ `PaymentDataPausedError`, därför att de två
 * pauserna svarar på olika frågor och åtgärdas på olika sätt:
 *
 *   färskhet  → "vi vet inte om nyare betalningar finns"   → importera en fil
 *   granskning→ "vi vet inte om EN viss betalning finns"   → avgör raden
 *
 * En operatör som får fel besked gör fel sak. Att slå ihop dem hade dessutom
 * gjort det omöjligt för en anropare att skilja ett tillstånd som en import
 * löser från ett som kräver ett mänskligt beslut om en enskild rad.
 *
 * `antal` bärs med så att HTTP-lagret kan säga hur många rader det gäller utan
 * att fråga databasen en andra gång.
 */
export class IdentityReviewPausedError extends Error {
  readonly code = 'GRANSKNING_PAGAR'
  constructor(readonly antal: number) {
    super(
      `Automatiska krav är pausade: ${antal} importerad(e) betalning(ar) väntar på ` +
        'identitetsgranskning. Avgör raderna i bankavstämningen — matcha dem mot rätt ' +
        'underlag, eller lägg dem åt sidan — innan krav går vidare.',
    )
    this.name = 'IdentityReviewPausedError'
  }
}

// Samma mottagarroller som morgonrapporten/övriga org-aviseringar.
const ALERT_RECIPIENT_ROLES: UserRole[] = [
  UserRole.OWNER,
  UserRole.ADMIN,
  UserRole.MANAGER,
  UserRole.ACCOUNTANT,
]

const ORG_FRESHNESS_SELECT = {
  id: true,
  name: true,
  paymentDataThrough: true,
  paymentImportStartedAt: true,
  paymentDataStaleDays: true,
  paymentDataStaleAlertedAt: true,
} satisfies Prisma.OrganizationSelect

type OrgFreshness = Prisma.OrganizationGetPayload<{ select: typeof ORG_FRESHNESS_SELECT }>

export interface StaleEvaluation {
  stale: boolean
  /** Registrerat t.o.m.-datum; null betyder att datum saknas. */
  through: Date | null
  /** Antal hela dygn mellan `through` och nu (Infinity om through saknas). */
  ageDays: number
  thresholdDays: number
}

const MS_PER_DAY = 24 * 60 * 60 * 1000

/** Hela kalenderdygn mellan två datum (golv, aldrig negativt). */
function wholeDaysBetween(from: Date, to: Date): number {
  const fromDay = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate())
  const toDay = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate())
  return Math.max(0, Math.floor((toDay - fromDay) / MS_PER_DAY))
}

/** UTC-midnatt för ett datum — matchar @db.Date-lagringen och gör monoton-
 *  jämförelsen dygnsgranulär (ingen intra-dag-redundans). */
function toUtcMidnight(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
}

/** Minimal HTML-escaping av DB-data som interpoleras i larm-mailets bodyHtml
 *  (self-XSS-skydd — org.name renderas i mottagarens webmail). */
function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
}

@Injectable()
export class PaymentFreshnessService {
  private readonly logger = new Logger(PaymentFreshnessService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
  ) {}

  /** Egen commit före importarbete; samma förstmarkör från HTTP och tjänst. */
  async recordImportStarted(organizationId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.lockOrganization(tx, organizationId)
      const org = await tx.organization.findUniqueOrThrow({
        where: { id: organizationId },
        select: { paymentImportStartedAt: true },
      })
      if (!org.paymentImportStartedAt) {
        await tx.organization.update({
          where: { id: organizationId },
          data: { paymentImportStartedAt: new Date() },
        })
      }
    }, paymentFreshnessTransactionOptions(PRISMA_DEFAULT_TX_LIMITS))
  }

  /** Måste vara första steget i effektens EGEN transaktion, före andra lås. */
  async assertAutomaticEffectAllowed(
    tx: Prisma.TransactionClient,
    organizationId: string,
    now: Date = new Date(),
  ): Promise<void> {
    if ('$transaction' in tx) throw new Error('PAYMENT_EFFECT_REQUIRES_TRANSACTION')
    const [settings] = await tx.$queryRaw<
      Array<{ isolation: string }>
    >`SELECT current_setting('transaction_isolation') AS isolation`
    if (settings?.isolation !== 'read committed') {
      throw new Error('PAYMENT_EFFECT_REQUIRES_READ_COMMITTED')
    }
    await this.lockOrganization(tx, organizationId, true)
    // Separat statement EFTER låsväntan: ser den vinnande markörens commit.
    const org = await tx.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: ORG_FRESHNESS_SELECT,
    })
    if (this.evaluate(org, now).stale) throw new PaymentDataPausedError()

    // ── G2: OLÖST IDENTITETSGRANSKNING PAUSAR OCKSÅ ─────────────────────
    //
    // EFTER färskhetskontrollen med flit. En organisation som är både ofärsk
    // och har olösta rader ska få EXAKT samma svar som förut — den nya spärren
    // får inte ändra vad en befintlig paus säger, bara lägga till ett fall som
    // tidigare släpptes igenom.
    await this.assertIngenOlostIdentitetsgranskning(tx, organizationId)
  }

  /**
   * G2 — kravklockan stannar medan en importerad betalnings identitet är
   * oavgjord.
   *
   * ── VARFÖR SPÄRREN BEHÖVS ───────────────────────────────────────────────
   *
   * #F034c lät importen lagra en betalning den inte kunde identifiera och
   * aldrig matcha den. Beslutet var rätt, men det stannade vid matchningen:
   * raden ger ingen allokering, avin förblir OVERDUE, och påminnelse, avgift,
   * ränta och kravsteg fortsatte enligt schema — mot en hyresgäst som kan ha
   * betalat. Före spärren i `matchTransaction` var det en fördröjning, eftersom
   * nästa `autoMatchAll` kunde lösa raden. Efter den är enda utgången ett
   * mänskligt beslut, så fönstret stänger sig inte längre självt.
   *
   * ── ORGANISATIONSNIVÅ, MED FLIT TRUBBIGT ────────────────────────────────
   *
   * Organisationen är känd för varje granskningsrad. Kopplingen till en viss
   * avi är det som INTE går att veta — det är hela skälet att raden väntar. Att
   * pausa "den avi raden kan höra till" skulle pausa antingen ingenting eller
   * en gissning, och gissningen är precis vad granskningsutfallet vägrar.
   *
   * En enda oavgjord rad pausar därför hela organisationens automatiska krav.
   * Det är den säkra riktningen: kostnaden är en fördröjd påminnelse, priset
   * för motsatsen är ett krav mot någon som redan betalat.
   *
   * ── SAMTIDIGHET ─────────────────────────────────────────────────────────
   *
   * Körs inne i effektens transaktion, efter det delade rådgivande låset och
   * under `read committed`. Garantin: varje granskningsrad som är COMMITAD före
   * räkningens statement stoppar effekten. En rad som commitas efteråt stoppar
   * den inte, och ska inte göra det — effekten inträffade före raden.
   *
   * Upplösningsriktningen är fail-safe: en för gammal läsning kan bara göra
   * pausen för lång, aldrig för kort.
   *
   * ── INGEN FÖRFALSKAD FÄRSKHET ───────────────────────────────────────────
   *
   * `paymentDataThrough` rörs inte. Att backa färskhetsdatumet hade gett samma
   * paus med fel orsak, och sedan ljugit för nästa läsare om vad som var känt.
   */
  async assertIngenOlostIdentitetsgranskning(
    tx: Prisma.TransactionClient,
    organizationId: string,
  ): Promise<void> {
    if ('$transaction' in tx) throw new Error('PAYMENT_EFFECT_REQUIRES_TRANSACTION')
    // Samma delade lås som färskheten. Att ta det två gånger i samma
    // transaktion är gratis (rådgivande lås är reentranta per transaktion), och
    // metoden måste kunna stå ensam: fakturavägen anropar den UTAN
    // `assertAutomaticEffectAllowed`, eftersom den vägen aldrig har haft någon
    // färskhetsgrind och inte ska få en nu.
    await this.lockOrganization(tx, organizationId, true)
    const antal = await tx.bankTransaction.count({
      where: olostGranskningForOrg(organizationId),
    })
    if (antal > 0) throw new IdentityReviewPausedError(antal)
  }

  /**
   * Samma fråga utan transaktion — för operatörens vy och för cronens
   * förhandsgallring.
   *
   * LARMAR INTE och SPÄRRAR INTE. Skilt från assert-varianten av samma skäl som
   * `evaluateForOrg` är skilt från `evaluateAndAlert`: att titta på en sida ska
   * inte kunna utlösa något.
   */
  async raknaOlostIdentitetsgranskning(organizationId: string): Promise<number> {
    return this.prisma.bankTransaction.count({
      where: olostGranskningForOrg(organizationId),
    })
  }

  /**
   * Vilka organisationer i en mängd som är pausade av olöst granskning.
   *
   * EN fråga för hela mängden, inte en per organisation. Fakturacronen går över
   * alla organisationers förfallna fakturor i en loop, och ett uppslag per
   * faktura hade varit N frågor för ett svar som är detsamma för alla fakturor
   * i samma organisation.
   *
   * DEN HÄR ÄR EN GALLRING, INTE GARANTIN. Svaret läses före loopen och kan
   * hinna bli gammalt medan loopen går — åt båda håll. Garantin bärs av
   * `assertIngenOlostIdentitetsgranskning` inne i varje effekts egen
   * transaktion.
   */
  async pausadeAvGranskning(organizationIds: string[]): Promise<Set<string>> {
    if (organizationIds.length === 0) return new Set()
    const rader = await this.prisma.bankTransaction.groupBy({
      by: ['organizationId'],
      where: { organizationId: { in: organizationIds }, ...OLOST_IDENTITETSGRANSKNING },
      _count: { _all: true },
    })
    return new Set(rader.map((r) => r.organizationId))
  }

  private async lockOrganization(
    tx: Prisma.TransactionClient,
    organizationId: string,
    shared = false,
  ): Promise<void> {
    // Flera effekter får läsa samtidigt; första importen behöver exklusiv rätt.
    if (shared) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtextextended('payment-freshness:' || ${organizationId}, 0))`
    } else {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('payment-freshness:' || ${organizationId}, 0))`
    }
  }

  evaluate(
    org: Pick<
      OrgFreshness,
      'paymentDataThrough' | 'paymentDataStaleDays' | 'paymentImportStartedAt'
    >,
    now: Date,
  ): StaleEvaluation {
    const thresholdDays = org.paymentDataStaleDays
    if (!org.paymentDataThrough) {
      return {
        stale: org.paymentImportStartedAt !== null,
        through: null,
        ageDays: Infinity,
        thresholdDays,
      }
    }
    const ageDays = wholeDaysBetween(org.paymentDataThrough, now)
    return {
      stale: ageDays > thresholdDays,
      through: org.paymentDataThrough,
      ageDays,
      thresholdDays,
    }
  }

  /**
   * Flyttar fram `paymentDataThrough` MONOTONT (bara framåt) vid varje
   * betalningsdata-ingest. `through` = datum t.o.m. vilket den ingestade datan är
   * registrerat av importen (senaste transaktionsdatum eller PDF-periodslut).
   * Det är inte ett separat bevis för fullständighet.
   *
   * När datan åter blir FÄRSK nollställs stale-larmets idempotensmarkör så att en
   * KOMMANDE stale-period kan larma på nytt (en notis per period).
   *
   * Penganeutral: rör bara `paymentDataThrough`/`paymentDataStaleAlertedAt`.
   * Valfri `tx` så ingest-anroparen kan köra det i sin egen transaktion.
   */
  /**
   * Färskhetsläget för EN organisation, läst ur databasen.
   *
   * ── VARFÖR HÄR OCH INTE HOS ANROPAREN ────────────────────────────────────
   *
   * Frågan "är betalningsdatan färsk?" ska besvaras av den tjänst som äger
   * begreppet, inte av var och en som råkar behöva svaret. Alternativet var att
   * injicera den här tjänsten i `NotificationsService` — det mättes och kostade
   * åtta specrigg:ar som konstruerar tjänsten med attrapper. En ny DI-kant för
   * ett svar som redan finns här är fel pris.
   *
   * LARMAR INTE, till skillnad från `evaluateAndAlert`. Att öppna en sida ska
   * inte kunna skicka ett driftlarm, och en hyresvärd som tittar på en knapp
   * har inte gjort något som förtjänar en notis. Den skillnaden är hela skälet
   * till att metoden inte bara anropar `evaluateAndAlert([id])`.
   */
  async evaluateForOrg(organizationId: string, now: Date = new Date()): Promise<StaleEvaluation> {
    const org = await this.prisma.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: {
        paymentDataThrough: true,
        paymentDataStaleDays: true,
        paymentImportStartedAt: true,
      },
    })
    return this.evaluate(org, now)
  }

  async recordPaymentDataThrough(
    organizationId: string,
    through: Date,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const db = tx ?? this.prisma
    const now = new Date()
    // Dygnsgranulärt + klampa bort orimliga FRAMTIDA datum (en CSV med en rad daterad
    // 2099 får aldrig sätta datan "färsk i 70 år" och därmed avaktivera grinden).
    const throughDay = toUtcMidnight(through > now ? now : through)

    // ATOMISK monoton compare-and-set (TOCTOU-säker — kritiskt för framtida samtidiga
    // aggregator-synkar): flytta fram BARA om strikt framåt. Hela monotonin avgörs i
    // WHERE-villkoret, inte i en läs-sedan-skriv i appen → ingen import kan skriva bakåt.
    const advanced = await db.organization.updateMany({
      where: {
        id: organizationId,
        OR: [{ paymentDataThrough: null }, { paymentDataThrough: { lt: throughDay } }],
      },
      data: { paymentDataThrough: throughDay },
    })
    if (advanced.count === 0) return

    // Blev datan FÄRSK igen → nollställ larm-markören så nästa stale-period kan larma.
    // staleDays är stabil konfiguration (ingen TOCTOU-känslig path); läses separat.
    const org = await db.organization.findUnique({
      where: { id: organizationId },
      select: { paymentDataStaleDays: true },
    })
    if (org && wholeDaysBetween(throughDay, now) <= org.paymentDataStaleDays) {
      await db.organization.updateMany({
        where: { id: organizationId, paymentDataStaleAlertedAt: { not: null } },
        data: { paymentDataStaleAlertedAt: null },
      })
    }
  }

  /**
   * Utvärderar färskheten för en mängd org-id, LARMAR (idempotent — en notis per
   * stale-period) för de som är inaktuella, och returnerar mängden stale-org-id som
   * cron-stegen ska PAUSA eskalering för.
   *
   * Anropas av varje pengamodifierande/inkasso-framflyttande cron. Larm-idempotensen
   * via `paymentDataStaleAlertedAt` är delad över alla cron-steg → även om tre crons
   * pausar samma org en stale-period skickas EXAKT ett larm.
   */
  async evaluateAndAlert(organizationIds: string[], now: Date = new Date()): Promise<Set<string>> {
    const stale = new Set<string>()
    const unique = [...new Set(organizationIds)]
    if (unique.length === 0) return stale

    const orgs = await this.prisma.organization.findMany({
      where: { id: { in: unique } },
      select: {
        ...ORG_FRESHNESS_SELECT,
        users: {
          where: { role: { in: ALERT_RECIPIENT_ROLES }, isActive: true },
          select: { email: true, firstName: true },
        },
      },
    })

    for (const org of orgs) {
      const result = this.evaluate(org, now)
      if (!result.stale) continue
      stale.add(org.id)

      // En notis per stale-period: bara om markören ännu är null.
      if (org.paymentDataStaleAlertedAt) continue

      // Race-/idempotensguard: bara EN körning vinner null→now-claimen (defense-in-
      // depth — crons är sekventiella). Den som vinner skickar larmet.
      const claim = await this.prisma.organization.updateMany({
        where: { id: org.id, paymentDataStaleAlertedAt: null },
        data: { paymentDataStaleAlertedAt: now },
      })
      if (claim.count === 0) continue

      try {
        await this.sendStaleAlert(org, result)
      } catch (err) {
        // Larmet kunde inte köas (t.ex. Redis nere) — rulla tillbaka markören så att
        // NÄSTA cron-körning försöker larma igen. En tyst paus utan notis vore värst.
        await this.prisma.organization
          .updateMany({
            where: { id: org.id, paymentDataStaleAlertedAt: now },
            data: { paymentDataStaleAlertedAt: null },
          })
          .catch(() => undefined)
        this.logger.error(
          `Stale-larm misslyckades för org ${org.id} (markör återställd för omförsök): ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }

    if (stale.size > 0) {
      this.logger.warn(
        `Betalningsdata inaktuell för ${stale.size} org — kravtrappans eskalering pausad denna körning.`,
      )
    }
    return stale
  }

  private async sendStaleAlert(
    org: OrgFreshness & { users: Array<{ email: string; firstName: string | null }> },
    result: StaleEvaluation,
  ): Promise<void> {
    if (org.users.length === 0) {
      this.logger.warn(
        `Org ${org.id} har inaktuell betalningsdata men saknar aktiva mottagare för stale-larmet.`,
      )
      return
    }

    const throughLabel = result.through
      ? result.through.toLocaleDateString('sv-SE')
      : 'ingen registrerad'
    // Stale-perioden identifieras av through-datumet (oförändrat under perioden,
    // byts när färsk data matas) → mail-lagrets idempotensnyckel dedupar per period.
    const periodKey = result.through ? result.through.toISOString().slice(0, 10) : 'never'

    const reason = result.through
      ? `Registrerat betalningsdatum: <strong>${throughLabel}</strong> (äldre än gränsen på ${result.thresholdDays} dagar).`
      : 'En import har påbörjats men betalningsdatum saknas. Kontrollera importens resultat och försök igen.'
    const orgName = escHtml(org.name)
    const bodyHtml = `
      <h2 style="color:#111827;font-size:20px;font-weight:600;margin:0 0 8px">Kravtrappan är pausad</h2>
      <p style="color:#374151;font-size:14px;line-height:1.6;margin:0 0 16px">
        Den automatiska kravtrappan (påminnelseavgift, inkasso-redo och befarad kundförlust)
        har <strong>pausats</strong> för ${orgName} eftersom aktuellt betalningsunderlag saknas.
      </p>
      <p style="color:#374151;font-size:14px;line-height:1.6;margin:0 0 16px">
        ${reason} För att inte riskera att
        påminna eller skicka till inkasso en hyresgäst som faktiskt har betalat hålls
        de stegen tillbaka tills datan uppdaterats.
      </p>
      <p style="color:#374151;font-size:14px;line-height:1.6;margin:0 0 16px">
        <strong>Vad du behöver göra:</strong> ladda upp en aktuell bankfil (eller koppla
        din bank när den funktionen lanseras). Så fort färsk betalningsdata registrerats
        återupptas kravtrappan automatiskt nästa dygn. Ren förfallomarkering
        (SENT&nbsp;→&nbsp;OVERDUE) påverkas inte — bara de steg som tar ut avgift eller
        flyttar fram ett inkassoärende.
      </p>`

    for (const user of org.users) {
      await this.mail.sendCustomEmail({
        to: user.email,
        organizationId: org.id,
        subject: `Eveno — Kravtrappan pausad: betalningsdatan behöver uppdateras`,
        bodyHtml,
        organizationName: org.name,
        tenantName: user.firstName ?? org.name,
        idempotencyKey: `payment-data-stale:${org.id}:${periodKey}:${user.email}`,
      })
    }
  }
}
