import {
  Injectable,
  Logger,
  UnauthorizedException,
  ConflictException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { ConfigService } from '@nestjs/config'
import * as bcrypt from 'bcryptjs'
import * as crypto from 'crypto'
import { CompanyForm } from '@prisma/client'
import { PrismaService } from '../common/prisma/prisma.service'
import { CustomerNumberService } from '../common/customer-number/customer-number.service'
import { MailService } from '../mail/mail.service'
import { AccountingService } from '../accounting/accounting.service'
import { validateSwedishOrgNumber } from '../common/validators/swedish-org-number'
import { normalizeEmail } from '../common/utils/normalize-email'
import type { JwtPayload, TokenPair } from '@eken/shared'
import type { LoginInput } from '@eken/shared'
import { TRIAL_DAYS, CURRENT_TERMS_VERSION } from '@eken/shared'

const MAX_LOGIN_ATTEMPTS = 10
const LOCKOUT_DURATION_MS = 15 * 60 * 1000 // 15 minuter

function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex')
}

interface RegisterPayload {
  email: string
  password: string
  firstName: string
  lastName: string
  organizationName: string
  orgNumber?: string
  accountType?: string
  companyForm?: CompanyForm
  hasFSkatt?: boolean
  fSkattApprovedDate?: string
  vatNumber?: string
  // Måste vara true. DTO-lagret validerar med @Equals(true) men vi
  // dubbelkollar i service:en så att inget request-flöde kan kringgå det.
  acceptTerms: boolean
}

export interface AuthUser {
  id: string
  email: string
  firstName: string
  lastName: string
  role: string
  organizationId: string
  mustChangePassword: boolean
}

export interface AuthOrganization {
  id: string
  name: string
  orgNumber: string | null
  // Snapshot av den juridiska version som organisationen senast accepterat.
  // Frontend jämför med CURRENT_TERMS_VERSION och visar re-acceptance-modal
  // om versionen är lägre. Null = legacy-konto innan dessa fält fanns,
  // behandlas som "behöver acceptera".
  termsVersion: string | null
}

export interface AuthResponse extends TokenPair {
  user: AuthUser
  organization: AuthOrganization
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name)

  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private config: ConfigService,
    private mail: MailService,
    private accounting: AccountingService,
    private customerNumber: CustomerNumberService,
  ) {}

  async register(dto: RegisterPayload): Promise<AuthResponse> {
    // Defense-in-depth: även om DTO-validering avvisat acceptTerms=false
    // kontrollerar vi en gång till. Vi får aldrig spara en användare som
    // inte aktivt godkänt villkoren — det är en GDPR-bevisbördekrav.
    if (dto.acceptTerms !== true) {
      throw new BadRequestException('Du måste acceptera Användarvillkor och Integritetspolicy')
    }

    // Normalisera direkt på input — alla downstream-skrivningar och ev.
    // jämförelser ska se samma kanoniska form.
    const email = normalizeEmail(dto.email)
    const existing = await this.prisma.user.findUnique({ where: { email } })
    if (existing) throw new ConflictException('E-postadressen är redan registrerad')

    // Härled företagsform: explicit val går först, sedan accountType-bryggan
    // för bakåtkompatibilitet (PRIVATE = enskild firma), annars AB.
    const companyForm: CompanyForm =
      dto.companyForm ?? (dto.accountType === 'PRIVATE' ? 'ENSKILD_FIRMA' : 'AB')

    // Orgnummer-validering mot vald företagsform — släng tydligt fel
    // istället för att låta databas-constraint smälla. Tomt orgnummer är OK.
    let normalizedOrgNumber: string | undefined
    if (dto.orgNumber && dto.orgNumber.trim()) {
      const result = validateSwedishOrgNumber(dto.orgNumber, companyForm)
      if (!result.valid) {
        throw new BadRequestException(result.error ?? 'Ogiltigt organisationsnummer')
      }
      normalizedOrgNumber = result.normalized ?? dto.orgNumber
    }

    // F-skatt: datum bara om checkboxen är ikryssad. Skickas datum utan
    // checkbox så ignorerar vi det istället för att kasta — schemat på
    // shared-sidan har redan blockerat den kombinationen.
    const hasFSkatt = dto.hasFSkatt ?? false
    const fSkattApprovedDate =
      hasFSkatt && dto.fSkattApprovedDate ? new Date(dto.fSkattApprovedDate) : null

    const passwordHash = await bcrypt.hash(dto.password, 12)

    // Trial: 30 dagars gratisperiod. Sätts vid signup och kontrolleras av
    // ai-usage-notifier-cronen — vid utgång byts status till PAST_DUE +
    // utskickad uppgraderingspåminnelse.
    const trialEndsAt = new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000)

    // Allokera plattformsglobalt kundnummer (K-100001 …). Atomär och
    // race-säker på egen hand; ett ev. hål om create:t failar är ofarligt.
    const customerNumber = await this.customerNumber.allocate()

    const org = await this.prisma.organization.create({
      data: {
        name: dto.organizationName,
        customerNumber,
        ...(normalizedOrgNumber ? { orgNumber: normalizedOrgNumber } : {}),
        accountType: dto.accountType ?? (companyForm === 'ENSKILD_FIRMA' ? 'PRIVATE' : 'COMPANY'),
        companyForm,
        hasFSkatt,
        fSkattApprovedDate,
        ...(dto.vatNumber ? { vatNumber: dto.vatNumber } : {}),
        email,
        street: '',
        city: '',
        postalCode: '',
        subscriptionPlan: 'TRIAL',
        status: 'TRIAL',
        trialEndsAt,
        planStartedAt: new Date(),
        // Snapshot:a versionen för hela organisationen vid signup. När
        // CURRENT_TERMS_VERSION höjs visar inloggningsflödet en
        // re-acceptance-modal tills den nya versionen bekräftats.
        termsAcceptedAt: new Date(),
        termsVersion: CURRENT_TERMS_VERSION,
      },
    })

    // Seeda BAS-kontoplan automatiskt vid registrering så att första
    // fakturan/journalposten hittar konton. Eget kapital-serien väljs per
    // företagsform (2080 för AB, 2010 för enskild firma — se
    // AccountingService.seedDefaultAccounts).
    await this.accounting.seedDefaultAccounts(org.id, companyForm)

    const user = await this.prisma.user.create({
      data: {
        organizationId: org.id,
        email,
        passwordHash,
        firstName: dto.firstName,
        lastName: dto.lastName,
        role: 'OWNER',
        // Spara även på User-nivå — på sikt kan organisationer ha flera
        // användare där var och en accepterar sin egen version. För
        // OWNER:n vid signup är det samma version som org-snapshoten.
        acceptedTermsAt: new Date(),
        termsVersion: CURRENT_TERMS_VERSION,
      },
    })

    // Välkomstmejl — fire-and-forget. Får aldrig blockera signup-flödet.
    void this.mail
      .enqueue({
        template: 'custom',
        priority: 'high',
        to: email,
        subject: 'Välkommen till Eveno — din 30-dagars trial är aktiv',
        props: {
          preview: 'Din Eveno-trial är aktiv i 30 dagar',
          tenantName: dto.firstName,
          organizationName: 'Eveno',
          whyReceived: 'Du fick det här mejlet eftersom du nyss skapade ett konto på Eveno.',
          bodyHtml: `
            <h1 style="color:#111827;font-size:22px;margin:0 0 16px;">Välkommen, ${dto.firstName}!</h1>
            <p>Ditt konto för <strong>${dto.organizationName}</strong> är klart och din 30-dagars gratis trial är aktiv.</p>
            <p>Under trial-perioden får du:</p>
            <ul>
              <li>Tillgång till alla funktioner i Eveno</li>
              <li>100 AI-anrop per månad</li>
              <li>Obegränsat antal hyresobjekt</li>
            </ul>
            <p>Din trial löper ut <strong>${trialEndsAt.toLocaleDateString('sv-SE')}</strong>. Inga betalningsuppgifter krävs förrän du själv väljer en plan.</p>
            <p>Hör av dig om du behöver hjälp att komma igång — vi svarar inom 24 timmar.</p>
            <p style="margin-top:24px;padding-top:16px;border-top:1px solid #eaedf0;color:#6b7280;font-size:13px;">
              Genom att skapa kontot har du accepterat våra
              <a href="https://eveno.se/legal/villkor" style="color:#2563eb;">Användarvillkor</a>
              och
              <a href="https://eveno.se/legal/integritet" style="color:#2563eb;">Integritetspolicy</a>
              (version ${CURRENT_TERMS_VERSION}). Du kan när som helst läsa dem på
              eveno.se/legal/villkor.
            </p>
          `,
        },
        idempotencyKey: `welcome-${org.id}`,
      })
      .catch((err: unknown) =>
        this.logger.warn(
          `Kunde inte skicka välkomstmejl till ${email}: ${err instanceof Error ? err.message : String(err)}`,
        ),
      )

    const tokens = await this.issueTokens(
      user.id,
      user.email,
      org.id,
      user.role,
      user.mustChangePassword,
    )
    return {
      ...tokens,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        organizationId: user.organizationId,
        mustChangePassword: user.mustChangePassword,
      },
      organization: {
        id: org.id,
        name: org.name,
        orgNumber: org.orgNumber ?? null,
        termsVersion: org.termsVersion ?? null,
      },
    }
  }

  async login(dto: LoginInput): Promise<AuthResponse> {
    const user = await this.prisma.user.findUnique({
      where: { email: normalizeEmail(dto.email) },
      include: { organization: true },
    })
    // En icke-aktiverad eller inbjuden-men-ej-accepterad användare avvisas med
    // exakt samma fel som ett felaktigt lösenord — ingen enumeration.
    if (!user || !user.isActive || !user.passwordHash) {
      throw new UnauthorizedException('Felaktiga inloggningsuppgifter')
    }

    // Brute-force-skydd: konto låst tills lockedUntil passerat. Ger samma
    // generiska fel utåt så att en angripare inte kan skilja på "låst" vs
    // "fel lösenord", men loggar internt.
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new UnauthorizedException('Felaktiga inloggningsuppgifter')
    }

    const valid = await bcrypt.compare(dto.password, user.passwordHash)
    if (!valid) {
      const attempts = (user.loginAttempts ?? 0) + 1
      const shouldLock = attempts >= MAX_LOGIN_ATTEMPTS
      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          loginAttempts: shouldLock ? 0 : attempts,
          lockedUntil: shouldLock ? new Date(Date.now() + LOCKOUT_DURATION_MS) : user.lockedUntil,
        },
      })
      throw new UnauthorizedException('Felaktiga inloggningsuppgifter')
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date(), loginAttempts: 0, lockedUntil: null },
    })

    const tokens = await this.issueTokens(
      user.id,
      user.email,
      user.organizationId,
      user.role,
      user.mustChangePassword,
    )
    return {
      ...tokens,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        organizationId: user.organizationId,
        mustChangePassword: user.mustChangePassword,
      },
      organization: {
        id: user.organization.id,
        name: user.organization.name,
        orgNumber: user.organization.orgNumber ?? null,
        termsVersion: user.organization.termsVersion ?? null,
      },
    }
  }

  async refresh(token: string): Promise<TokenPair> {
    // Refresh-tokens lagras som SHA-256-hash. Token från klient är den
    // ohashade slumpsträngen — vi hashar och slår upp.
    const tokenHash = sha256(token)
    const stored = await this.prisma.refreshToken.findUnique({ where: { token: tokenHash } })
    if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
      throw new UnauthorizedException('Ogiltig refresh token')
    }

    // Rotate: revoke old, issue new
    await this.prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date() },
    })

    const user = await this.prisma.user.findUnique({ where: { id: stored.userId } })
    if (!user || !user.isActive) throw new UnauthorizedException()

    return this.issueTokens(
      user.id,
      user.email,
      user.organizationId,
      user.role,
      user.mustChangePassword,
    )
  }

  async logout(userId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    })
  }

  async me(userId: string, organizationId: string) {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, organizationId },
      include: { organization: true },
    })
    if (!user) throw new UnauthorizedException()
    return {
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        organizationId: user.organizationId,
        mustChangePassword: user.mustChangePassword,
      },
      organization: {
        id: user.organization.id,
        name: user.organization.name,
        orgNumber: user.organization.orgNumber ?? null,
        termsVersion: user.organization.termsVersion ?? null,
      },
    }
  }

  // ── Re-acceptance av juridiska dokument ──────────────────────────────────

  /**
   * Användaren bekräftar att hen accepterar den nya versionen av
   * Användarvillkor och Integritetspolicy. Kallas från re-acceptance-modalen
   * i frontend när Organization.termsVersion är lägre än
   * CURRENT_TERMS_VERSION i @eken/shared. Vi snapshot:ar versionen både på
   * User- och Organization-nivå så att vi har en revision för individen och
   * för bolaget.
   */
  async acceptTerms(
    userId: string,
    organizationId: string,
    version: string,
  ): Promise<{ termsVersion: string; acceptedAt: string }> {
    if (version !== CURRENT_TERMS_VERSION) {
      throw new BadRequestException(`Förväntad version ${CURRENT_TERMS_VERSION}, mottog ${version}`)
    }
    const acceptedAt = new Date()
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: { acceptedTermsAt: acceptedAt, termsVersion: version },
      }),
      this.prisma.organization.update({
        where: { id: organizationId },
        data: { termsAcceptedAt: acceptedAt, termsVersion: version },
      }),
    ])
    return { termsVersion: version, acceptedAt: acceptedAt.toISOString() }
  }

  // ── Lösenord & inbjudan ─────────────────────────────────────────────────────

  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<{ message: string; loggedOut: true }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } })
    if (!user) throw new NotFoundException('Användaren hittades inte')
    if (!user.passwordHash) {
      // Ska inte gå att nå i praktiken (login-guard avvisar null), men vi är
      // defensiva i fall någon kallar denna med en orphan-token.
      throw new BadRequestException('Konto saknar lösenord')
    }

    const valid = await bcrypt.compare(currentPassword, user.passwordHash)
    if (!valid) throw new UnauthorizedException('Felaktigt nuvarande lösenord')

    if (currentPassword === newPassword) {
      throw new BadRequestException('Det nya lösenordet måste skilja sig från det gamla')
    }

    const passwordHash = await bcrypt.hash(newPassword, 12)
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash, mustChangePassword: false },
    })

    // Invalidera alla aktiva refresh tokens — användaren måste logga in på
    // nytt på sina andra enheter (och även den aktuella sessionen). Klienten
    // använder `loggedOut`-flaggan för att redirecta till login med en
    // success-banner i stället för att tappa sessionen tyst.
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    })

    return {
      message: 'Lösenordet har bytts. Du loggas nu ut från alla enheter.',
      loggedOut: true,
    }
  }

  async forgotPassword(email: string): Promise<void> {
    // Vi svarar alltid 200 även om emailen inte finns — annars läcker vi om
    // ett konto existerar (enumeration attack).
    const user = await this.prisma.user.findUnique({
      where: { email: normalizeEmail(email) },
      include: { organization: true },
    })
    if (!user || !user.isActive) return

    const token = crypto.randomBytes(32).toString('hex')
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000) // 1h

    await this.prisma.passwordResetToken.create({
      data: { userId: user.id, token, expiresAt },
    })

    const webUrl = this.config.get<string>('WEB_URL') ?? 'http://localhost:5173'
    const resetUrl = `${webUrl}/reset-password?token=${token}`
    const recipientName = `${user.firstName} ${user.lastName}`.trim() || user.email

    await this.mail
      .sendPasswordReset({
        to: user.email,
        recipientName,
        resetUrl,
        organizationName: user.organization.name,
        validForHours: 1,
        idempotencyKey: `pwreset:${token}`,
      })
      .catch((err: unknown) => {
        this.logger.error(
          'Password reset mail failed',
          err instanceof Error ? err.stack : String(err),
        )
      })
  }

  async resetPassword(token: string, newPassword: string): Promise<void> {
    const stored = await this.prisma.passwordResetToken.findUnique({ where: { token } })
    if (!stored) throw new BadRequestException('Ogiltig eller utgången återställningslänk')
    if (stored.usedAt) throw new BadRequestException('Återställningslänken har redan använts')
    if (stored.expiresAt < new Date()) {
      throw new BadRequestException('Återställningslänken har gått ut')
    }

    const passwordHash = await bcrypt.hash(newPassword, 12)

    await this.prisma.$transaction([
      this.prisma.passwordResetToken.update({
        where: { id: stored.id },
        data: { usedAt: new Date() },
      }),
      this.prisma.user.update({
        where: { id: stored.userId },
        data: { passwordHash, mustChangePassword: false },
      }),
      // Invalidera alla aktiva sessioner — om någon obehörig haft access så
      // tappar de den nu.
      this.prisma.refreshToken.updateMany({
        where: { userId: stored.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ])
  }

  async acceptInvite(token: string, newPassword: string): Promise<{ email: string }> {
    const invite = await this.prisma.userInvitation.findUnique({
      where: { token },
    })
    if (!invite) throw new BadRequestException('Ogiltig inbjudningslänk')
    if (invite.usedAt) throw new BadRequestException('Inbjudningslänken har redan använts')
    if (invite.expiresAt < new Date()) {
      throw new BadRequestException('Inbjudningslänken har gått ut')
    }

    const passwordHash = await bcrypt.hash(newPassword, 12)

    // Sätt lösenord + aktivera användaren. INGEN auto-login — användaren
    // skickas tillbaka till /login där hen loggar in med det nya lösenordet.
    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.userInvitation.update({
        where: { id: invite.id },
        data: { usedAt: new Date() },
      })
      return tx.user.update({
        where: { id: invite.userId },
        data: {
          passwordHash,
          isActive: true,
          mustChangePassword: false,
        },
        select: { email: true },
      })
    })

    return { email: updated.email }
  }

  // ── Tokens ──────────────────────────────────────────────────────────────────

  private async issueTokens(
    userId: string,
    email: string,
    organizationId: string,
    role: string,
    mustChangePassword: boolean,
  ): Promise<TokenPair> {
    const payload: JwtPayload = {
      sub: userId,
      email,
      organizationId,
      role: role as JwtPayload['role'],
      mustChangePassword,
    }
    const accessToken = this.jwt.sign(payload)

    // 256 bitars slumpmässig token. Vi lagrar SHA-256 av token, inte token
    // själv, så ett databasintrång inte räcker för att kapa sessioner.
    const refreshToken = crypto.randomBytes(32).toString('hex')
    const refreshTokenHash = sha256(refreshToken)
    const refreshExpiresIn = this.config.get('JWT_REFRESH_EXPIRES_IN', '30d')
    const days = parseInt(refreshExpiresIn.replace('d', ''), 10) || 30
    const expiresAt = new Date()
    expiresAt.setDate(expiresAt.getDate() + days)

    await this.prisma.refreshToken.create({
      data: { userId, token: refreshTokenHash, expiresAt },
    })

    return { accessToken, refreshToken }
  }
}
