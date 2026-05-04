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
import type { Tenant } from '@prisma/client'
import { PrismaService } from '../common/prisma/prisma.service'
import { MailService } from '../mail/mail.service'
import { ContractTemplateService } from '../contracts/contract-template.service'
import { validatePasswordStrength } from '@eken/shared'

const ACTIVATION_TTL_MS = 72 * 60 * 60 * 1000 // 72 timmar
const RESET_TTL_MS = 24 * 60 * 60 * 1000 // 24 timmar
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 dagar

function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex')
}

function assertStrongPassword(password: string): void {
  const result = validatePasswordStrength(password)
  if (!result.valid) {
    throw new BadRequestException(result.errors.join('. '))
  }
}

interface SessionResult {
  sessionToken: string
  expiresAt: Date
  tenant: Tenant & { organization: { id: string; name: string } }
}

@Injectable()
export class TenantAuthService {
  private readonly logger = new Logger(TenantAuthService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly config: ConfigService,
    @Inject(forwardRef(() => ContractTemplateService))
    private readonly contracts: ContractTemplateService,
  ) {}

  // ── Aktiveringstoken ─────────────────────────────────────────────────────────

  /**
   * Skapa eller rotera en aktiveringstoken för en hyresgäst och returnera den
   * fulla aktiveringslänken. Anropas från LeasesService när ett kontrakt blir
   * ACTIVE och från admin-resend-endpointen.
   */
  async issueActivationToken(tenantId: string, ttlMs = ACTIVATION_TTL_MS): Promise<string> {
    const token = crypto.randomBytes(32).toString('hex')
    const expiresAt = new Date(Date.now() + ttlMs)

    await this.prisma.tenant.update({
      where: { id: tenantId },
      data: { activationToken: token, activationTokenExpiresAt: expiresAt },
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
    const tenant = await this.prisma.tenant.findUnique({
      where: { activationToken: token },
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
    signature: { ip: string | null; userAgent: string | null } = { ip: null, userAgent: null },
  ): Promise<SessionResult> {
    assertStrongPassword(password)

    const tenant = await this.prisma.tenant.findUnique({
      where: { activationToken: token },
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
        activationToken: null,
        activationTokenExpiresAt: null,
      },
      include: { organization: { select: { id: true, name: true } } },
    })

    // Lås den senaste kontrakts-PDF:en för hyresgästens aktiva kontrakt och
    // skriv signaturmetadata. Fire-and-forget: en signering ska inte blockera
    // aktiveringen men låsdata bör finnas på dokumentet.
    void this.lockLatestContractForTenant(updated.id, updated.organizationId, signature).catch(
      (err) => this.logger.warn(`[TenantAuth] kunde inte låsa kontraktsdokument: ${String(err)}`),
    )

    return this.createSession(updated)
  }

  private async lockLatestContractForTenant(
    tenantId: string,
    organizationId: string,
    signature: { ip: string | null; userAgent: string | null },
  ): Promise<void> {
    // Hitta senaste aktiva kontraktet för hyresgästen.
    const lease = await this.prisma.lease.findFirst({
      where: { tenantId, status: { in: ['DRAFT', 'ACTIVE'] } },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    })
    if (!lease) return

    const doc = await this.contracts.findLatestContract(lease.id, organizationId)
    if (!doc || doc.locked) return

    await this.contracts.lockContractAfterSignature(doc.id, {
      tenantId,
      ip: signature.ip,
      userAgent: signature.userAgent,
    })
  }

  // ── Lösenordsinloggning ──────────────────────────────────────────────────────

  async login(email: string, password: string, organizationId?: string): Promise<SessionResult> {
    const where = organizationId ? { email, organizationId } : { email }
    const tenant = await this.prisma.tenant.findFirst({
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
    const tenant = await this.prisma.tenant.findFirst({
      where: { email },
      include: { organization: { select: { id: true, name: true } } },
    })
    if (!tenant || !tenant.portalActivated) {
      this.logger.warn(`Forgot password för ${email} — ingen aktiverad hyresgäst`)
      return
    }

    const token = await this.issueActivationToken(tenant.id, RESET_TTL_MS)
    const resetUrl = this.buildResetUrl(token)

    const tenantName = tenant.firstName
      ? `${tenant.firstName} ${tenant.lastName ?? ''}`.trim()
      : (tenant.companyName ?? tenant.email)

    await this.mail
      .sendPasswordReset({
        to: tenant.email,
        recipientName: tenantName,
        resetUrl,
        organizationName: tenant.organization.name,
        validForHours: 24,
      })
      .catch((err: unknown) => {
        this.logger.warn(`Forgot-password mail för ${email} failade: ${String(err)}`)
      })
  }

  async resetPassword(token: string, password: string): Promise<SessionResult> {
    assertStrongPassword(password)

    const tenant = await this.prisma.tenant.findUnique({
      where: { activationToken: token },
      include: { organization: { select: { id: true, name: true } } },
    })
    if (!tenant || !tenant.activationTokenExpiresAt) {
      throw new UnauthorizedException('Ogiltig återställningslänk')
    }
    if (tenant.activationTokenExpiresAt < new Date()) {
      throw new UnauthorizedException('Återställningslänken har gått ut')
    }

    const passwordHash = await bcrypt.hash(password, 12)

    const updated = await this.prisma.tenant.update({
      where: { id: tenant.id },
      data: {
        passwordHash,
        portalActivated: true,
        portalActivatedAt: tenant.portalActivated ? tenant.portalActivatedAt : new Date(),
        activationToken: null,
        activationTokenExpiresAt: null,
      },
      include: { organization: { select: { id: true, name: true } } },
    })

    return this.createSession(updated)
  }

  // ── Sessionshantering ────────────────────────────────────────────────────────

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
    return { sessionToken, expiresAt, tenant }
  }

  async validateSession(
    token: string,
  ): Promise<Tenant & { organization: { id: string; name: string } }> {
    const session = await this.prisma.tenantSession.findUnique({
      where: { token: sha256(token) },
      include: { tenant: { include: { organization: { select: { id: true, name: true } } } } },
    })

    if (!session || session.expiresAt < new Date()) {
      throw new UnauthorizedException('Sessionen är ogiltig eller har gått ut')
    }

    return session.tenant as Tenant & { organization: { id: string; name: string } }
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
    const tenant = await this.prisma.tenant.findUnique({
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
        tenantName,
        organizationName: tenant.organization.name,
        activationUrl,
        validForHours: 72,
      })
      .catch((err: unknown) => {
        this.logger.error(`Välkomstmejl för tenant ${tenantId} failade: ${String(err)}`)
      })
  }

  // ── Cron-städning ────────────────────────────────────────────────────────────

  @Cron('0 3 * * *')
  async cleanupStaleSessions(): Promise<void> {
    const result = await this.prisma.tenantSession.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    })
    this.logger.log(`Cleaned up ${result.count} stale session(s)`)
  }
}
