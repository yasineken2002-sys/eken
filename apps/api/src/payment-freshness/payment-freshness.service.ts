import { randomUUID } from 'node:crypto'

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
   * under `read committed`.
   *
   * ── RÄTTAT (G2-AVSLUT) ──────────────────────────────────────────────────
   *
   * Här stod att en rad som commitas efteråt "inte stoppar den, och ska inte
   * göra det — effekten inträffade före raden". Det följde inte av någonting.
   * Räkningen sker vid T1 och commiten vid T2 > T1; en rad som commitas
   * däremellan är i väggklockstid FÖRE att effekten fanns. Med delat lås på
   * ena sidan och inget lås på den andra var ordningen odefinierad, och
   * påståendet var en förhoppning. Mätt falskt i tre fall, se
   * `kravpaus-samtidighet.db.spec.ts`.
   *
   * Numera ÄR det sant, men av en annan anledning: skrivsidan tar det
   * EXKLUSIVA låset (`lasOrdningForOlostGranskning`), så ordningen är total.
   * "Efteråt" betyder därmed verkligen efter effektens commit — alltså att
   * kravet bevisligen var taget i anspråk innan pausen fanns.
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
   * G2-AVSLUT — SKRIVSIDANS HALVA AV DEN GEMENSAMMA ORDNINGEN.
   *
   * Spärren tog ett DELAT lås och räknade. Granskningsraden skrevs med ett bart
   * `bankTransaction.create` — ingen transaktion, inget lås — och
   * `unmatchTransaction` återöppnade i en egen transaktion, också utan låset.
   * Det fanns alltså ingen gemensam ordning mellan sidorna.
   *
   * MÄTT mot `3fa095a6` (`kravpaus-samtidighet.db.spec.ts`), inte resonerat:
   *
   *   S1  avgiften BOKFÖRDES trots commitad granskningsrad
   *   S2  brevet KÖADES — mätt vid kögränsen, inte på en räknare
   *   S3  avgiften BOKFÖRDES trots återöppning via `unmatchTransaction`
   *
   * Den här metoden tar det EXKLUSIVA låset i den transaktion som gör raden
   * olöst. Mot effektsidans DELADE lås ger det en total ordning:
   *
   *   skrivaren först  → effekten ser raden och PAUSAS
   *   effekten först   → skrivaren väntar tills effektens transaktion COMMITAT,
   *                      alltså är kravet bevisat taget i anspråk före pausen
   *
   * Ingen tredje utgång finns kvar. Det är hela kravet.
   *
   * FÖRST I TRANSAKTIONEN, samma regel som `assertAutomaticEffectAllowed`:
   * `unmatchTransaction` tar `FOR UPDATE` på BankTransaction och Invoice, och
   * läggs det här efter dem uppstår en cykel mellan två låsordningar.
   */
  async lasOrdningForOlostGranskning(
    tx: Prisma.TransactionClient,
    organizationId: string,
  ): Promise<void> {
    if ('$transaction' in tx) throw new Error('PAYMENT_EFFECT_REQUIRES_TRANSACTION')
    await this.lockOrganization(tx, organizationId)
  }

  /**
   * G2-AVSLUT — ÖPPNA en granskningsperiod. Anropas i SAMMA transaktion som
   * gör raden olöst, alltså under det exklusiva låset.
   *
   * IDEMPOTENT VIA DATABASEN. Det partiella unika indexet
   * `bank_identity_review_pause_open_unique` gör två samtidiga öppnanden till
   * ett. Ingen läs-sedan-skriv — den kan passeras av två importer samtidigt,
   * och då hade operatören fått två brev för samma paus.
   *
   * ── VARFÖR `ON CONFLICT` OCH INTE create-och-fånga-P2002 ────────────────
   *
   * Första versionen fångade P2002 i JavaScript. Det FUNGERAR INTE här, och
   * mitt eget prov (P2) fann det: den här metoden körs inne i anroparens
   * transaktion, och ett misslyckat statement FÖRGIFTAR transaktionen i
   * Postgres. Att fånga felet i JS häver inte det — nästa statement föll med
   *
   *     25P02  current transaction is aborted, commands ignored until end of
   *            transaction block
   *
   * och granskningsraden skrevs aldrig. Importen rapporterade radfel och status
   * DELVIS, alltså blev skyddet en ny lucka i stället för en stängd.
   *
   * `INSERT … ON CONFLICT DO NOTHING` löser konflikten INNE i databasen. Inget
   * fel kastas, transaktionen förblir användbar, och kapplöpningen avgörs
   * fortfarande av indexet. Konfliktmålet anger indexets predikat, så det är
   * det PARTIELLA indexet som används och inte något annat.
   *
   * (create-och-fånga är rätt i `ingestFromFile`, där create:t är transaktionens
   * SISTA handling och ett förgiftat tillstånd därför inte hinner märkas.)
   *
   * Returnerar periodens id när en NY period öppnades, annars null. Det är den
   * signalen anroparen använder för att avgöra om ett aviseringstillfälle ska
   * tas efter commit — fler rader i en pågående paus ger inget nytt brev.
   */
  async oppnaGranskningsperiod(
    tx: Prisma.TransactionClient,
    organizationId: string,
  ): Promise<string | null> {
    const id = randomUUID()
    const rader = await tx.$queryRaw<Array<{ id: string }>>`
      INSERT INTO "BankIdentityReviewPause" ("id", "organizationId", "startedAt")
      VALUES (${id}, ${organizationId}, NOW())
      ON CONFLICT ("organizationId") WHERE "endedAt" IS NULL DO NOTHING
      RETURNING "id"
    `
    return rader[0]?.id ?? null
  }

  /**
   * G2-AVSLUT — AVSLUTA perioden när den sista raden är löst.
   *
   * Tar det exklusiva låset själv: annars kan en avslutning och ett öppnande
   * korsa varandra och lämna organisationen utan öppen period trots att en
   * olöst rad finns kvar — alltså en tyst paus utan aviseringstillfälle.
   *
   * RÄKNAR INNE I LÅSET. Att lita på anroparens bild av hur många rader som är
   * kvar vore att lita på en läsning som gjordes före dess egen skrivning.
   */
  async avslutaGranskningsperiodOmLost(organizationId: string): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockOrganization(tx, organizationId)
      const kvar = await tx.bankTransaction.count({
        where: olostGranskningForOrg(organizationId),
      })
      if (kvar > 0) return false
      const r = await tx.bankIdentityReviewPause.updateMany({
        where: { organizationId, endedAt: null },
        data: { endedAt: new Date() },
      })
      return r.count > 0
    }, paymentFreshnessTransactionOptions(PRISMA_DEFAULT_TX_LIMITS))
  }

  /**
   * G2-AVSLUT — GÖR PAUSEN UPPTÄCKBAR UTAN BESÖK PÅ AVSTÄMNINGSSIDAN.
   *
   * ── VARFÖR TRE TILLSTÅND OCH INTE EN FLAGGA ─────────────────────────────
   *
   * `notifiedAt` (beständig notis skapad), `mailQueuedAt` (kön ACCEPTERADE
   * jobbet) och levererad är tre olika saker. Bara de två första är våra;
   * leveransen äger kön. En enda markör hade tvingat fram ett val mellan att
   * sätta den FÖRE köandet — då blir varje köfel en evig "redan aviserat" — och
   * EFTER, då en timeout som ändå köade ger ett andra brev.
   *
   * `enqueueSafely` avbryter uttryckligen INTE det underliggande anropet vid
   * timeout, så det andra fallet är verkligt och inte teoretiskt.
   *
   * ── VAD SOM GÖR ÅTERFÖRSÖK OFARLIGT ─────────────────────────────────────
   *
   * `idempotencyKey` blir Bulls `jobId`. Nyckeln bär PERIODENS id, som är
   * varaktigt och överlever omstart. Ett återförsök efter en timeout kollapsar
   * därför i kön i stället för att skicka två brev — det är den befintliga
   * idempotensen som bär, inte en ny uppfinning. Samma form som
   * `sendStaleAlert` redan använder med sin periodnyckel.
   *
   * ── ORDNINGEN ───────────────────────────────────────────────────────────
   *
   * Notisen skrivs FÖRST och i en egen transaktion tillsammans med sin markör:
   * den är ren databas, kan inte "halvt lyckas", och är det billigaste sättet
   * att göra pausen synlig. Mejlet köas DÄREFTER, utanför transaktionen — att
   * dra ett nätverksanrop in i en DB-transaktion gör den inte atomär, bara lång,
   * och skulle hålla organisationens lås medan kön funderar.
   *
   * `mailAttempts` räknas upp FÖRE försöket. Går kön sönder syns det som ett
   * växande tal i stället för som tystnad.
   *
   * ── INGEN SIDOEFFEKT FRÅN EN LÄSNING ────────────────────────────────────
   *
   * Metoden anropas av importen, avmatchningen och sveparen — aldrig av en
   * `GET`. Att öppna avstämningssidan får inte skicka brev.
   */
  async aviseraGranskningspaus(organizationId: string): Promise<{
    period: string | null
    notisSkapad: boolean
    mejlKoat: boolean
  }> {
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { name: true },
    })
    const period = await this.prisma.bankIdentityReviewPause.findFirst({
      where: { organizationId, endedAt: null },
      select: { id: true, notifiedAt: true, mailQueuedAt: true, startedAt: true },
    })
    if (!period) return { period: null, notisSkapad: false, mejlKoat: false }

    const antal = await this.raknaOlostIdentitetsgranskning(organizationId)
    if (antal === 0) return { period: period.id, notisSkapad: false, mejlKoat: false }

    const rubrik = 'Automatiska krav är pausade'
    const text =
      `${antal} importerad(e) betalning(ar) väntar på identitetsgranskning. ` +
      'Påminnelser, avgifter, ränta och kravsteg är pausade för hela organisationen ' +
      'tills raderna är avgjorda. Öppna bankavstämningen och matcha dem mot rätt ' +
      'underlag, eller lägg dem åt sidan.'

    // ── 1. NOTISEN ────────────────────────────────────────────────────────
    let notisSkapad = false
    if (!period.notifiedAt) {
      const mottagare = await this.prisma.user.findMany({
        where: { organizationId, isActive: true, role: { in: ALERT_RECIPIENT_ROLES } },
        select: { id: true },
      })
      if (mottagare.length > 0) {
        // Notiser och markör i EN transaktion: en halvskriven notislista med
        // satt markör hade tystat återförsöket utan att någon fått beskedet.
        await this.prisma.$transaction(async (tx) => {
          const claim = await tx.bankIdentityReviewPause.updateMany({
            where: { id: period.id, notifiedAt: null },
            data: { notifiedAt: new Date() },
          })
          if (claim.count === 0) return // någon annan hann före
          await tx.notification.createMany({
            data: mottagare.map((u) => ({
              organizationId,
              userId: u.id,
              type: 'SYSTEM' as const,
              title: `⚠️ ${rubrik}`,
              message: text,
              link: '/reconciliation',
            })),
          })
          notisSkapad = true
          // MEDVETEN GRÄNS. Ren databas, inga nätverksanrop, och lika många
          // notisrader som organisationen har behöriga operatörer — alltså en
          // kort transaktion. `PRISMA_DEFAULT_TX_LIMITS` säger uttryckligen
          // "dagens beteende", vilket är rätt här, till skillnad från att ärva
          // det av att ingen skrev något.
        }, paymentFreshnessTransactionOptions(PRISMA_DEFAULT_TX_LIMITS))
      }
    }

    // ── 2. MEJLET ─────────────────────────────────────────────────────────
    let mejlKoat = false
    if (!period.mailQueuedAt) {
      const mottagare = await this.prisma.user.findMany({
        where: { organizationId, isActive: true, role: { in: ALERT_RECIPIENT_ROLES } },
        select: { email: true, firstName: true },
      })
      if (mottagare.length > 0) {
        await this.prisma.bankIdentityReviewPause.update({
          where: { id: period.id },
          data: { mailAttempts: { increment: 1 } },
        })
        try {
          let sista = ''
          for (const u of mottagare) {
            sista = await this.mail.sendCustomEmail({
              to: u.email,
              organizationId,
              organizationName: org?.name ?? 'Organisationen',
              // Mottagaren är en OPERATÖR, inte en hyresgäst. Fältet heter
              // `tenantName` i mallen och bär tilltalsnamnet.
              tenantName: u.firstName ?? '',
              subject: `${rubrik} — åtgärd krävs`,
              bodyHtml:
                `<p>Hej ${escHtml(u.firstName ?? '')},</p><p>${escHtml(text)}</p>` +
                '<p><a href="/reconciliation">Öppna bankavstämningen</a></p>',
              // PERIODENS ID ÄR NYCKELN. Varaktig, överlever omstart, och gör
              // ett återförsök efter timeout till samma jobb i kön.
              idempotencyKey: `bank-review-pause:${period.id}:${u.email}`,
            })
          }
          // Markören sätts BARA när kön svarat. Ett fel lämnar den null, och då
          // försöker sveparen igen — ingen evig "redan aviserat".
          await this.prisma.bankIdentityReviewPause.update({
            where: { id: period.id },
            data: { mailQueuedAt: new Date(), mailJobId: sista || null },
          })
          mejlKoat = true
        } catch (err) {
          this.logger.error(
            `[granskningspaus] e-post kunde inte köas för org ${organizationId} ` +
              `(period ${period.id}): ${err instanceof Error ? err.message : String(err)}. ` +
              'Tillfället är kvar och försöks igen — idempotensnyckeln bär periodens id.',
          )
        }
      }
    }

    return { period: period.id, notisSkapad, mejlKoat }
  }

  /**
   * Sveparen: tar igen aviseringstillfällen som inte fullbordats — efter ett
   * köfel, en omstart, eller en period som öppnades medan kön var nere.
   *
   * IDEMPOTENT PER PERIOD, inte per dygn. En pågående paus som redan aviserats
   * ger ingenting; det är det som hindrar en nattlig storm.
   */
  async sveparGranskningspauser(): Promise<{ behandlade: number }> {
    const öppna = await this.prisma.bankIdentityReviewPause.findMany({
      where: { endedAt: null, OR: [{ notifiedAt: null }, { mailQueuedAt: null }] },
      select: { organizationId: true },
      take: 200,
    })
    for (const p of öppna) {
      await this.aviseraGranskningspaus(p.organizationId).catch((err: unknown) =>
        this.logger.error(
          `[granskningspaus] svep misslyckades för org ${p.organizationId}: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        ),
      )
    }
    return { behandlade: öppna.length }
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
