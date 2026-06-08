import { Injectable, Logger } from '@nestjs/common'
import { Prisma, UserRole } from '@prisma/client'
import { PrismaService } from '../common/prisma/prisma.service'
import { MailService } from '../mail/mail.service'

/**
 * Bankavstämnings-härdning PR 4 (B) — betalningsdatans FÄRSKHET.
 *
 * Kravtrappan får inte eskalera i blindo när systemet saknar FÄRSK betalningsdata.
 * Idag är cron-eskaleringen frikopplad från om avstämning körts: laddar ingen upp
 * en bankfil rullar trappan vidare mot hyresgäster som kan ha betalat.
 *
 * Denna tjänst är DATAKÄLLS-AGNOSTISK. Den känner bara till ett per-org-datum,
 * `paymentDataThrough` (t.o.m. vilket betalningsdatan är komplett). Idag matas det
 * av bankimporterna (CSV/BgMax/PDF); en framtida aggregator (Tink/Enable Banking)
 * matar SAMMA fält med sin lastSyncedAt utan att en rad här behöver skrivas om. Det
 * skyddar alltså även den automatiska bankkopplingen om den går ner.
 *
 * PENGANEUTRAL: tjänsten LÄSER ett datum, PAUSAR cron-steg (returnerar en mängd
 * stale-org-id) och LARMAR. Inga verifikat, ingen bokföring, ingen matchningslogik.
 */

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
  paymentDataStaleDays: true,
  paymentDataStaleAlertedAt: true,
} satisfies Prisma.OrganizationSelect

type OrgFreshness = Prisma.OrganizationGetPayload<{ select: typeof ORG_FRESHNESS_SELECT }>

export interface StaleEvaluation {
  stale: boolean
  /** t.o.m.-datum för känd komplett betalningsdata (null = ingen data ingestad). */
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

  /**
   * Avgör om en organisations betalningsdata är inaktuell (äldre än tröskeln).
   *
   * NULL `paymentDataThrough` → INTE stale: en org som aldrig matat in betalningsdata
   * (rent manuell avstämning) ska inte få sin kravtrappa pausad. Grinden engagerar
   * FÖRST när data väl matats och sedan blivit gammal — exakt det som skyddar mot en
   * nedbruten bankkoppling/uteblivna filuppladdningar.
   */
  evaluate(
    org: Pick<OrgFreshness, 'paymentDataThrough' | 'paymentDataStaleDays'>,
    now: Date,
  ): StaleEvaluation {
    const thresholdDays = org.paymentDataStaleDays
    if (!org.paymentDataThrough) {
      return { stale: false, through: null, ageDays: Infinity, thresholdDays }
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
   * komplett (senaste transaktionsdatum, PDF-periodslut, eller framtida lastSyncedAt).
   *
   * När datan åter blir FÄRSK nollställs stale-larmets idempotensmarkör så att en
   * KOMMANDE stale-period kan larma på nytt (en notis per period).
   *
   * Penganeutral: rör bara `paymentDataThrough`/`paymentDataStaleAlertedAt`.
   * Valfri `tx` så ingest-anroparen kan köra det i sin egen transaktion.
   */
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

    const orgName = escHtml(org.name)
    const bodyHtml = `
      <h2 style="color:#111827;font-size:20px;font-weight:600;margin:0 0 8px">Kravtrappan är pausad</h2>
      <p style="color:#374151;font-size:14px;line-height:1.6;margin:0 0 16px">
        Den automatiska kravtrappan (påminnelseavgift, inkasso-redo och befarad kundförlust)
        har <strong>pausats</strong> för ${orgName} eftersom betalningsdatan är inaktuell.
      </p>
      <p style="color:#374151;font-size:14px;line-height:1.6;margin:0 0 16px">
        Senast kända kompletta betalningsdata: <strong>${throughLabel}</strong>
        (äldre än gränsen på ${result.thresholdDays} dagar). För att inte riskera att
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
        subject: `Eveno — Kravtrappan pausad: betalningsdatan behöver uppdateras`,
        bodyHtml,
        organizationName: org.name,
        tenantName: user.firstName ?? org.name,
        idempotencyKey: `payment-data-stale:${org.id}:${periodKey}:${user.email}`,
      })
    }
  }
}
