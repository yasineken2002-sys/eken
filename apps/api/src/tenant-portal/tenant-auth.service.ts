import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  Logger,
  Inject,
  forwardRef,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Cron } from '@nestjs/schedule'
import * as bcrypt from 'bcryptjs'
import * as crypto from 'crypto'
import { Prisma } from '@prisma/client'
import type { Tenant } from '@prisma/client'
import { PrismaService } from '../common/prisma/prisma.service'
import { CronErrorSink } from '../common/cron/cron-error-sink'
import { runCronSafely } from '../common/cron/cron-safety'
import { MailService } from '../mail/mail.service'
import { ContractTemplateService } from '../contracts/contract-template.service'
import { normalizeEmail } from '../common/utils/normalize-email'
import { SAFE_TENANT_SELECT } from '../tenants/tenants.service'
import { validatePasswordStrength } from '@eken/shared'
import { stripTenantCredentialKeys } from '../tenants/tenant-credential-keys'
import {
  readTenantWithCredentials,
  findTenantWithCredentials,
  readManyTenantsWithCredentials,
} from './tenant-credential-read'
import { LockService } from '../common/redis/lock.service'

/**
 * SELECT för en hyresgäst som autentiserats via portal-session och returneras
 * till portalen (bl.a. GET /tenant-portal/me). Återanvänder det hyresvärds-
 * vända SAFE_TENANT_SELECT (alla icke-känsliga kolumner) och lägger till
 * organisationsrelationen som portalen behöver. portal-credentials
 * (passwordHash, *TokenHash, *TokenExpiresAt) ingår ALDRIG — se
 * TENANT_CREDENTIAL_KEYS i tenants.service.ts.
 */
const SAFE_PORTAL_TENANT_SELECT = {
  ...SAFE_TENANT_SELECT,
  // Hyresgästen får se sitt EGET personnummer i portalprofilen. Chiffertexten
  // väljs explicit (SAFE_TENANT_SELECT bär inte personnumret) och dekrypteras
  // först i mapMe, vid visningen.
  personalNumberEnc: true,
  organization: { select: { id: true, name: true } },
} satisfies Prisma.TenantSelect

const ACTIVATION_TTL_MS = 72 * 60 * 60 * 1000 // 72 timmar
const RESET_TTL_MS = 24 * 60 * 60 * 1000 // 24 timmar
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 dagar

// Påminnelsemejl skickas när hyresgästen haft tokenen i 48 h utan att ha
// aktiverat. Det ger 24 h kvar att klicka innan utgång (72 h totalt). Vi
// markerar `activationReminderSentAt` så samma token bara genererar en
// påminnelse — om hyresvärden återskickar token nollas markeringen.
const REMINDER_AFTER_MS = 48 * 60 * 60 * 1000

function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex')
}

function assertStrongPassword(password: string): void {
  const result = validatePasswordStrength(password)
  if (!result.valid) {
    throw new BadRequestException(result.errors.join('. '))
  }
}

/**
 * Strippar credential-kolumnerna ur ett tenant-objekt innan det lämnar servicen.
 *
 * SECURITY (B1, defense-in-depth): login()/activate()/resetPassword() hämtar
 * tenant med full `include` (passwordHash krävs för bcrypt-jämförelsen i login).
 * Här garanterar vi att SessionResult.tenant aldrig bär credentials — så att en
 * framtida controller som returnerar result.tenant rakt av (samma misstag som
 * orsakade B1) inte kan läcka dem.
 *
 * Listan är DELAD med hyresvärds-API:ts mapTenant sedan uppföljningen till #445.
 * Den låg tidigare duplicerad här och hade divergerat: de två
 * personnummerkolumnerna saknades, så en direktreturnerad SessionResult.tenant
 * hade läckt chiffertext OCH blind-index trots att funktionen såg ut att skydda.
 */
const stripTenantCredentials = stripTenantCredentialKeys

interface SessionResult {
  sessionToken: string
  expiresAt: Date
  tenant: Tenant & { organization: { id: string; name: string } }
}

/**
 * TTL för aktiveringspåminnelsernas cron-lås.
 *
 * INVARIANT: jobbets körtid < TTL < cron-intervallet. Se den utförliga
 * motiveringen i `notifications.service.ts` — båda olikheterna måste hålla, och
 * den övre är den `runIfUnlocked` införde: ett lås som överlever till nästa
 * schemalagda körning stänger av jobbet tyst.
 *
 * Uppmätt, och bevakat av `cron-lock-interval.spec.ts`:
 *
 *   tenant-activation-reminders  `0 9 * * *`  intervall 24 h  TTL 15 min
 *
 * Jobbet itererar hyresgäster med utestående aktiveringstoken och gör ett
 * mejlutskick per hyresgäst; 15 minuter är marginal för det. Marginalen uppåt är
 * 96 gånger.
 */
const ACTIVATION_REMINDER_LOCK_TTL_SEC = 15 * 60

@Injectable()
export class TenantAuthService {
  private readonly logger = new Logger(TenantAuthService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly config: ConfigService,
    @Inject(forwardRef(() => ContractTemplateService))
    private readonly contracts: ContractTemplateService,
    private readonly locks: LockService,
    /**
     * #605 batch 2 — VARAKTIG FELSÄNKA. Två jobb i den här filen, med OLIKA form:
     *
     *   sendActivationReminders  per-tenant-loop som fångar, loggar och fortsätter
     *                            (batch 1:s form) → sänkan läggs BREDVID loggen
     *   cleanupStaleSessions     ingen felhantering alls → felhanteringen LÄGGS TILL
     *
     * Skillnaden är värd att skriva ut: den första ändrar ingenting utom att felet
     * blir varaktigt, den andra ändrar var felet tar vägen. Ingen av dem gör något
     * tystare.
     */
    private readonly cronErrors: CronErrorSink,
  ) {}

  // ── Aktiveringstoken ─────────────────────────────────────────────────────────

  /**
   * Skapa eller rotera en aktiveringstoken för en hyresgäst och returnera den
   * råa token (som skickas i mejl). Endast SHA-256-hashen sparas i DB — vid
   * läcka går databasvärdet inte att använda för att aktivera kontot.
   *
   * Anropas från LeasesService när ett kontrakt blir ACTIVE och från
   * admin-resend-endpointen.
   */
  async issueActivationToken(tenantId: string, ttlMs = ACTIVATION_TTL_MS): Promise<string> {
    const token = crypto.randomBytes(32).toString('hex')
    const expiresAt = new Date(Date.now() + ttlMs)

    await this.prisma.tenant.update({
      where: { id: tenantId },
      data: {
        activationTokenHash: sha256(token),
        activationTokenExpiresAt: expiresAt,
        // Nollställ påminnelse-markeringen så en återskickad token leder till
        // en ny påminnelse efter 48 h (annars skulle hyresgäster som fick en
        // ny länk aldrig få en påminnelse).
        activationReminderSentAt: null,
      },
    })

    return token
  }

  /**
   * Skapa en separat lösenordsåterställningstoken. Använder en egen kolumn
   * (passwordResetTokenHash) så att aktiveringsflödet inte överskrivs.
   */
  async issuePasswordResetToken(tenantId: string, ttlMs = RESET_TTL_MS): Promise<string> {
    const token = crypto.randomBytes(32).toString('hex')
    const expiresAt = new Date(Date.now() + ttlMs)

    await this.prisma.tenant.update({
      where: { id: tenantId },
      data: {
        passwordResetTokenHash: sha256(token),
        passwordResetTokenExpiresAt: expiresAt,
      },
    })

    return token
  }

  buildActivationUrl(token: string): string {
    const portalUrl = this.config.get<string>('PORTAL_URL') ?? 'http://localhost:5174'
    return `${portalUrl}/activate?token=${token}`
  }

  buildResetUrl(token: string): string {
    const portalUrl = this.config.get<string>('PORTAL_URL') ?? 'http://localhost:5174'
    return `${portalUrl}/reset-password?token=${token}`
  }

  /**
   * Slå upp en hyresgäst på aktiveringstoken. Kastar 401 om token saknas
   * eller har gått ut. Används av portalens activate-flöde för att hämta
   * kontrakts-/hyresgästinfo innan signering.
   */
  async findTenantByActivationToken(token: string): Promise<
    Tenant & {
      organization: { id: string; name: string }
      leases: Array<{
        id: string
        status: string
        startDate: Date
        endDate: Date | null
        monthlyRent: unknown
        depositAmount: unknown
        noticePeriodMonths: number
        leaseType: string
        unit: {
          id: string
          name: string
          unitNumber: string
          property: { name: string; street: string; city: string; postalCode: string }
        }
      }>
    }
  > {
    const tenant = await readTenantWithCredentials(this.prisma, {
      where: { activationTokenHash: sha256(token) },
      include: {
        organization: { select: { id: true, name: true } },
        leases: {
          where: { status: { in: ['ACTIVE', 'DRAFT'] } },
          orderBy: { createdAt: 'desc' },
          take: 1,
          include: { unit: { include: { property: true } } },
        },
      },
    })

    if (!tenant || !tenant.activationTokenExpiresAt) {
      throw new UnauthorizedException('Ogiltig aktiveringslänk')
    }
    if (tenant.activationTokenExpiresAt < new Date()) {
      throw new UnauthorizedException('Aktiveringslänken har gått ut')
    }

    return tenant as unknown as Tenant & {
      organization: { id: string; name: string }
      leases: Array<{
        id: string
        status: string
        startDate: Date
        endDate: Date | null
        monthlyRent: unknown
        depositAmount: unknown
        noticePeriodMonths: number
        leaseType: string
        unit: {
          id: string
          name: string
          unitNumber: string
          property: { name: string; street: string; city: string; postalCode: string }
        }
      }>
    }
  }

  // ── Aktivering (signering + lösenord) ────────────────────────────────────────

  async activate(
    token: string,
    password: string,
    signature: {
      ip: string | null
      userAgent: string | null
      signatureName?: string | null
    } = { ip: null, userAgent: null, signatureName: null },
  ): Promise<SessionResult> {
    assertStrongPassword(password)

    const tokenHash = sha256(token)
    const tenant = await readTenantWithCredentials(this.prisma, {
      where: { activationTokenHash: tokenHash },
      include: { organization: { select: { id: true, name: true } } },
    })
    if (!tenant || !tenant.activationTokenExpiresAt) {
      throw new UnauthorizedException('Ogiltig aktiveringslänk')
    }
    if (tenant.activationTokenExpiresAt < new Date()) {
      throw new UnauthorizedException('Aktiveringslänken har gått ut')
    }

    const passwordHash = await bcrypt.hash(password, 12)

    const updated = await this.prisma.tenant.update({
      where: { id: tenant.id },
      data: {
        passwordHash,
        portalActivated: true,
        portalActivatedAt: tenant.portalActivated ? tenant.portalActivatedAt : new Date(),
        activationTokenHash: null,
        activationTokenExpiresAt: null,
        activationReminderSentAt: null,
      },
      include: { organization: { select: { id: true, name: true } } },
    })

    // Lås den senaste kontrakts-PDF:en för hyresgästens aktiva kontrakt och
    // skriv signaturmetadata. Vi inväntar låsningen så att vi vet exakt vilket
    // dokument som signerades — bekräftelsemejlet behöver dess id som
    // idempotency-nyckel. Misslyckas låsningen blir aktiveringen ändå klar:
    // hyresgästen får sitt konto, men vi loggar och skippar bekräftelsemejlet
    // (mejlas inget om vi inte kan bevisa vilket dokument det gäller).
    let signedDocumentId: string | null = null
    try {
      signedDocumentId = await this.lockLatestContractForTenant(
        updated.id,
        updated.organizationId,
        signature,
      )
    } catch (err) {
      this.logger.warn(`[TenantAuth] kunde inte låsa kontraktsdokument: ${String(err)}`)
    }

    if (signedDocumentId) {
      void this.sendSignatureConfirmation(updated.id, signedDocumentId).catch((err) => {
        this.logger.warn(`[TenantAuth] kvittensmejl misslyckades: ${String(err)}`)
      })
    }

    return this.createSession(updated)
  }

  private async lockLatestContractForTenant(
    tenantId: string,
    organizationId: string,
    signature: {
      ip: string | null
      userAgent: string | null
      signatureName?: string | null
    },
  ): Promise<string | null> {
    // Hitta senaste aktiva kontraktet för hyresgästen.
    const lease = await this.prisma.lease.findFirst({
      where: { tenantId, status: { in: ['DRAFT', 'ACTIVE'] } },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    })
    if (!lease) return null

    const doc = await this.contracts.findLatestContract(lease.id, organizationId)
    if (!doc || doc.locked) return null

    await this.contracts.lockContractAfterSignature(doc.id, {
      tenantId,
      ip: signature.ip,
      userAgent: signature.userAgent,
      signatureName: signature.signatureName ?? null,
    })
    return doc.id
  }

  // ── Lösenordsinloggning ──────────────────────────────────────────────────────

  async login(email: string, password: string, organizationId?: string): Promise<SessionResult> {
    // E-post lagras alltid som lowercase i DB (normalizeEmail vid alla writes).
    // Vi normaliserar också input här — så B-tree-indexet för email kan
    // användas av Postgres istället för en sekvensskanning som
    // mode: 'insensitive' annars hade tvingat fram.
    const normalizedEmail = normalizeEmail(email)
    const where = organizationId
      ? { email: normalizedEmail, organizationId }
      : { email: normalizedEmail }
    const tenant = await findTenantWithCredentials(this.prisma, {
      where,
      include: { organization: { select: { id: true, name: true } } },
    })
    if (!tenant || !tenant.portalActivated || !tenant.passwordHash) {
      // Samma generiska fel oavsett orsak — ingen enumeration
      throw new UnauthorizedException('Felaktig e-post eller lösenord')
    }

    const valid = await bcrypt.compare(password, tenant.passwordHash)
    if (!valid) {
      throw new UnauthorizedException('Felaktig e-post eller lösenord')
    }

    return this.createSession(tenant)
  }

  // ── Glömt lösenord ───────────────────────────────────────────────────────────

  /**
   * Skicka mejl med återställningslänk. Returnerar void även om mejlet inte gick
   * iväg eller hyresgästen inte finns — för att undvika enumeration. Loggas vid
   * fel så hyresvärden kan felsöka.
   */
  async sendForgotPassword(email: string): Promise<void> {
    const tenant = await findTenantWithCredentials(this.prisma, {
      where: { email: normalizeEmail(email) },
      include: { organization: { select: { id: true, name: true } } },
    })
    if (!tenant || !tenant.portalActivated) {
      this.logger.warn(`Forgot password för ${email} — ingen aktiverad hyresgäst`)
      return
    }

    const token = await this.issuePasswordResetToken(tenant.id, RESET_TTL_MS)
    const resetUrl = this.buildResetUrl(token)

    const tenantName = tenant.firstName
      ? `${tenant.firstName} ${tenant.lastName ?? ''}`.trim()
      : (tenant.companyName ?? tenant.email)

    await this.mail
      .sendPasswordReset({
        to: tenant.email,
        organizationId: tenant.organizationId,
        recipientName: tenantName,
        resetUrl,
        organizationName: tenant.organization.name,
        validForHours: 24,
        // Stabil nyckel per (tenant, token-prefix) — Bull-jobId dedupar dubbla
        // enqueues och Resend dedupar dubbla worker-körningar.
        idempotencyKey: `tenant-reset-${tenant.id}-${token.substring(0, 8)}`,
      })
      .catch((err: unknown) => {
        this.logger.warn(`Forgot-password mail för ${email} failade: ${String(err)}`)
      })
  }

  async resetPassword(token: string, password: string): Promise<SessionResult> {
    assertStrongPassword(password)

    const tokenHash = sha256(token)
    const tenant = await readTenantWithCredentials(this.prisma, {
      where: { passwordResetTokenHash: tokenHash },
      include: { organization: { select: { id: true, name: true } } },
    })
    if (!tenant || !tenant.passwordResetTokenExpiresAt) {
      throw new UnauthorizedException('Ogiltig återställningslänk')
    }
    if (tenant.passwordResetTokenExpiresAt < new Date()) {
      throw new UnauthorizedException('Återställningslänken har gått ut')
    }

    const passwordHash = await bcrypt.hash(password, 12)

    const updated = await this.prisma.tenant.update({
      where: { id: tenant.id },
      data: {
        passwordHash,
        portalActivated: true,
        portalActivatedAt: tenant.portalActivated ? tenant.portalActivatedAt : new Date(),
        passwordResetTokenHash: null,
        passwordResetTokenExpiresAt: null,
      },
      include: { organization: { select: { id: true, name: true } } },
    })

    return this.createSession(updated)
  }

  // ── Sessionshantering ────────────────────────────────────────────────────────

  /**
   * Session för en hyresgäst som redan är AUTENTISERAD någon annanstans.
   *
   * Finns för BankID-inloggningen (#745 PR 4), som styrker identiteten med en
   * BankID-order i stället för med ett lösenord. Metoden gör INGEN
   * behörighetskontroll — den skapar en session för den hyresgäst den får — och
   * är därför medvetet smal: den laddar raden själv, så en anropare inte kan
   * skicka in ett hopplockat objekt, och den går genom `createSession` så att det
   * bara finns EN väg som skriver en `TenantSession`.
   *
   * Samma sessionsform som magic-link- och lösenordsvägen: slumpad token till
   * klienten, SHA-256 i kolumnen, samma TTL. En BankID-inloggad hyresgäst är
   * inte en annan sorts session.
   */
  async createSessionForTenant(tenantId: string): Promise<SessionResult> {
    const tenant = await findTenantWithCredentials(this.prisma, {
      where: { id: tenantId },
      include: { organization: { select: { id: true, name: true } } },
    })
    if (!tenant) throw new UnauthorizedException('Inloggningen kunde inte slutföras')
    return this.createSession(
      tenant as unknown as Tenant & { organization: { id: string; name: string } },
    )
  }

  private async createSession(
    tenant: Tenant & { organization: { id: string; name: string } },
  ): Promise<SessionResult> {
    const sessionToken = crypto.randomBytes(32).toString('hex')
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS)
    // Lagra SHA-256-hash av token, inte token själv. Klienten håller den
    // ohashade token i Authorization-headern; vid validering hashar vi
    // inkommande och slår upp.
    await this.prisma.tenantSession.create({
      data: { tenantId: tenant.id, token: sha256(sessionToken), expiresAt },
    })
    // Strippa portal-credentials innan tenant returneras (B1 defense-in-depth).
    const safeTenant = stripTenantCredentials(
      tenant as unknown as Record<string, unknown>,
    ) as unknown as Tenant & { organization: { id: string; name: string } }
    return { sessionToken, expiresAt, tenant: safeTenant }
  }

  async validateSession(
    token: string,
  ): Promise<Tenant & { organization: { id: string; name: string } }> {
    const session = await this.prisma.tenantSession.findUnique({
      where: { token: sha256(token) },
      // SECURITY (launch-blocker B1): selektera EXPLICIT icke-känsliga
      // Tenant-kolumner. Tidigare `include: { tenant: true }` drog med
      // passwordHash + alla *TokenHash/*TokenExpiresAt-kolumner, som sedan
      // läckte rakt ut via GET /tenant-portal/me (getMe returnerar tenant-
      // objektet oförändrat). Samma princip som SAFE_TENANT_SELECT på det
      // hyresvärds-vända API:t — credentials lämnar aldrig Postgres.
      // Behöver portalen fler icke-känsliga fält: LÄGG TILL dem här, lägg
      // ALDRIG till passwordHash, *TokenHash eller *TokenExpiresAt.
      include: {
        tenant: { select: SAFE_PORTAL_TENANT_SELECT },
      },
    })

    if (!session || session.expiresAt < new Date()) {
      throw new UnauthorizedException('Sessionen är ogiltig eller har gått ut')
    }

    return session.tenant as unknown as Tenant & {
      organization: { id: string; name: string }
    }
  }

  async logout(token: string): Promise<void> {
    await this.prisma.tenantSession.deleteMany({ where: { token: sha256(token) } })
  }

  // ── Mejlhjälpare ─────────────────────────────────────────────────────────────

  /**
   * Skicka välkomstmejl med aktiveringslänk när ett kontrakt aktiveras.
   * Anropas av LeasesService efter DRAFT→ACTIVE-övergången. Felar mejlet
   * loggas det men kontraktsaktiveringen rullas inte tillbaka.
   */
  async sendWelcomeWithContract(tenantId: string): Promise<void> {
    const tenant = await readTenantWithCredentials(this.prisma, {
      where: { id: tenantId },
      include: { organization: { select: { name: true } } },
    })
    if (!tenant) {
      this.logger.warn(`sendWelcomeWithContract: tenant ${tenantId} hittades inte`)
      return
    }

    const token = await this.issueActivationToken(tenant.id, ACTIVATION_TTL_MS)
    const activationUrl = this.buildActivationUrl(token)
    const tenantName = tenant.firstName
      ? `${tenant.firstName} ${tenant.lastName ?? ''}`.trim()
      : (tenant.companyName ?? tenant.email)

    await this.mail
      .sendTenantWelcomeWithContract({
        to: tenant.email,
        organizationId: tenant.organizationId,
        tenantName,
        organizationName: tenant.organization.name,
        activationUrl,
        validForHours: 72,
        // Stabil nyckel per (tenant, token-prefix). Bull-jobId dedupar dubbla
        // enqueues, Resend dedupar dubbla worker-körningar (samma fix som
        // morgonrapporten — utan den kan worker-stall ge två mejl).
        idempotencyKey: `tenant-welcome-${tenant.id}-${token.substring(0, 8)}`,
      })
      .catch((err: unknown) => {
        this.logger.error(`Välkomstmejl för tenant ${tenantId} failade: ${String(err)}`)
      })
  }

  /**
   * Bekräftelsemejl efter genomförd signering. Skickas direkt efter att
   * Document-raden låsts. Vi använder dokumentets id som idempotency-nyckel
   * eftersom det är ett-till-ett med en signering — admin kan inte dubbel-
   * trigga genom att retra aktiveringen (det blir en ny token + nytt doc-id).
   */
  async sendSignatureConfirmation(tenantId: string, documentId: string): Promise<void> {
    const tenant = await readTenantWithCredentials(this.prisma, {
      where: { id: tenantId },
      include: { organization: { select: { name: true } } },
    })
    if (!tenant) return

    const tenantName = tenant.firstName
      ? `${tenant.firstName} ${tenant.lastName ?? ''}`.trim()
      : (tenant.companyName ?? tenant.email)

    const portalUrl = this.config.get<string>('PORTAL_URL') ?? 'http://localhost:5174'
    const documentsUrl = `${portalUrl}/documents`

    await this.mail.sendTenantSignatureConfirmation({
      to: tenant.email,
      organizationId: tenant.organizationId,
      tenantName,
      organizationName: tenant.organization.name,
      documentsUrl,
      signedAt: new Date().toLocaleDateString('sv-SE', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      }),
      idempotencyKey: `tenant-signature-confirm-${documentId}`,
    })
  }

  // ── Cron-jobs ────────────────────────────────────────────────────────────────

  /**
   * Städa utgångna sessions och tokens. Körs nattetid när belastningen är låg.
   *
   * - TenantSession: hård radering (sessionsraden behövs inte historiskt).
   * - activationTokenHash + passwordResetTokenHash: nollas så att råtoken
   *   som hyresgästen ev. har sparat (mejl, bookmark) ger ett rent 401 vid
   *   användning. Tenant-raden i sig får aldrig raderas — kvarvarande hyresavtal
   *   och fakturor är räkenskapsmaterial enligt Bokföringslagen 7 kap. 2 §.
   */
  // ── KLASSIFICERING: B — SKYDDAT AV INVARIANT ─────────────────────────
  // TenantSession deleteMany på utgångna sessioner — idempotent radering, en
  // andra körning träffar noll rader.
  //
  // Bevakas av check-cron-classification.mjs: ett @Cron utan klassificering
  // fäller CI, och ett B utan namngiven invariant likaså.
  @Cron('0 3 * * *')
  async cleanupStaleSessions(): Promise<void> {
    await runCronSafely('tenant-portal-session-cleanup', () => this.cleanupStaleSessionsUnsafe(), {
      logger: this.logger,
      sink: this.cronErrors,
    })
  }

  private async cleanupStaleSessionsUnsafe(): Promise<void> {
    const sessions = await this.prisma.tenantSession.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    })
    this.logger.log(`Cleaned up ${sessions.count} stale session(s)`)

    const expiredActivations = await this.prisma.tenant.updateMany({
      where: {
        activationTokenHash: { not: null },
        activationTokenExpiresAt: { lt: new Date() },
      },
      data: {
        activationTokenHash: null,
        activationTokenExpiresAt: null,
        activationReminderSentAt: null,
      },
    })
    this.logger.log(`Cleaned up ${expiredActivations.count} expired activation token(s)`)

    const expiredResets = await this.prisma.tenant.updateMany({
      where: {
        passwordResetTokenHash: { not: null },
        passwordResetTokenExpiresAt: { lt: new Date() },
      },
      data: {
        passwordResetTokenHash: null,
        passwordResetTokenExpiresAt: null,
      },
    })
    this.logger.log(`Cleaned up ${expiredResets.count} expired password-reset token(s)`)
  }

  /**
   * Skicka påminnelsemejl till hyresgäster som fått en aktiveringslänk för
   * mer än 48 h sedan men inte använt den. Det ger 24 h kvar att klicka
   * (token är giltig i 72 h totalt) — perfekt timing för att fånga
   * hyresgäster som fått mejlet på fredagen och försvunnit över helgen.
   *
   * activationReminderSentAt sätts så samma token bara påminns en gång.
   * Återskickar hyresvärden token via admin-endpointen nollas markeringen
   * automatiskt i issueActivationToken.
   */
  @Cron('0 9 * * *')
  async sendActivationReminders(): Promise<void> {
    const result = await this.locks.runIfUnlocked(
      'cron:tenant-activation-reminders',
      () => this.sendActivationRemindersUnsafe(),
      { ttlSec: ACTIVATION_REMINDER_LOCK_TTL_SEC },
    )
    if (!result.ran) {
      // Ett tyst överhopp är oskiljbart från "cronen kördes aldrig". Säg det —
      // och säg hur gammalt låset var, så ett normalt överhopp går att skilja
      // från ett hängt lås som stängt av jobbet.
      this.logger.log(
        '[cron:tenant-activation-reminders] Aktiveringspåminnelserna kördes redan av en ' +
          `annan replik — hoppar över. Låset hållet i ${result.heldForSec ?? '?'} s av ` +
          `${ACTIVATION_REMINDER_LOCK_TTL_SEC} s.`,
      )
    }
  }

  /**
   * ── VARFÖR JUST DET HÄR JOBBET INTE TÅL ATT KÖRAS TVÅ GÅNGER ──────────────
   *
   * De tre rapportjobben skickar samma mejl med samma `idempotencyKey`, så
   * Resend deduplicerar dem — en dubbelkörning där kostar dubbla AI-anrop men
   * ger ett mejl.
   *
   * Här är det inte så, och skillnaden ligger i EN rad: `issueActivationToken`
   * roterar token vid varje körning. Två repliker ger därför
   *
   *   - två OLIKA tokens
   *   - två OLIKA idempotensnycklar (nyckeln innehåller tokenprefixet)
   *   - alltså TVÅ levererade mejl
   *   - och den andra rotationen gör länken i det FÖRSTA mejlet ogiltig
   *
   * Hyresgästen får två påminnelser och den ena leder till en död länk.
   * Markören `activationReminderSentAt` hjälper inte: båda replikerna läser
   * kandidaterna innan någon hinner skriva.
   */
  private async sendActivationRemindersUnsafe(): Promise<void> {
    const now = Date.now()
    const reminderCutoff = new Date(now - REMINDER_AFTER_MS)

    const candidates = await readManyTenantsWithCredentials(this.prisma, {
      where: {
        activationTokenHash: { not: null },
        activationTokenExpiresAt: { gt: new Date() },
        activationReminderSentAt: null,
        portalActivated: false,
      },
      include: { organization: { select: { name: true } } },
    })

    let sent = 0
    for (const tenant of candidates) {
      // Vi har ingen kolumn för "när token utfärdades" — beräknar från
      // expiresAt - TTL. Om token utfärdades för mindre än REMINDER_AFTER_MS
      // sedan väntar vi.
      const issuedAt = new Date(tenant.activationTokenExpiresAt!.getTime() - ACTIVATION_TTL_MS)
      if (issuedAt > reminderCutoff) continue

      const tenantName = tenant.firstName
        ? `${tenant.firstName} ${tenant.lastName ?? ''}`.trim()
        : (tenant.companyName ?? tenant.email)

      // Vi har bara hashen lagrad — kan inte återgenerera samma råtoken.
      // Lösningen: rotera till en NY token och skicka den i påminnelsen.
      // Det innebär att den gamla länken (om hyresgästen ändå hittar mejlet
      // efter påminnelsen) blir ogiltig, men praktiken är att påminnelsen
      // är den de använder. issueActivationToken nollar
      // activationReminderSentAt — vi sätter den explicit efter mejlet.
      const newToken = await this.issueActivationToken(tenant.id, ACTIVATION_TTL_MS)
      const activationUrl = this.buildActivationUrl(newToken)

      try {
        await this.mail.sendTenantActivationReminder({
          to: tenant.email,
          organizationId: tenant.organizationId,
          tenantName,
          organizationName: tenant.organization.name,
          activationUrl,
          validForHours: 72,
          idempotencyKey: `tenant-activation-reminder-${tenant.id}-${newToken.substring(0, 8)}`,
        })
        await this.prisma.tenant.update({
          where: { id: tenant.id },
          data: { activationReminderSentAt: new Date() },
        })
        sent++
      } catch (err) {
        this.logger.error(`Aktiveringspåminnelse för ${tenant.email} failade: ${String(err)}`)
        await this.cronErrors.report('tenant-activation-reminders', err, {
          organizationId: tenant.organizationId,
          detail: { steg: 'påminnelseutskick', tenantId: tenant.id },
        })
      }
    }

    this.logger.log(`Sent ${sent} activation reminder(s)`)
  }
}
