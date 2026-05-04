import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { ConfigService } from '@nestjs/config'
import * as bcrypt from 'bcryptjs'
import * as crypto from 'crypto'
import { PrismaService } from '../common/prisma/prisma.service'
import { MailService } from '../mail/mail.service'
import type { JwtPayload, TokenPair } from '@eken/shared'
import type { LoginInput } from '@eken/shared'

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
}

export interface AuthResponse extends TokenPair {
  user: AuthUser
  organization: AuthOrganization
}

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private config: ConfigService,
    private mail: MailService,
  ) {}

  async register(dto: RegisterPayload): Promise<AuthResponse> {
    const existing = await this.prisma.user.findUnique({ where: { email: dto.email } })
    if (existing) throw new ConflictException('E-postadressen är redan registrerad')

    const passwordHash = await bcrypt.hash(dto.password, 12)

    const org = await this.prisma.organization.create({
      data: {
        name: dto.organizationName,
        ...(dto.orgNumber ? { orgNumber: dto.orgNumber } : {}),
        accountType: dto.accountType ?? 'COMPANY',
        email: dto.email,
        street: '',
        city: '',
        postalCode: '',
      },
    })

    const user = await this.prisma.user.create({
      data: {
        organizationId: org.id,
        email: dto.email,
        passwordHash,
        firstName: dto.firstName,
        lastName: dto.lastName,
        role: 'OWNER',
      },
    })

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
      organization: { id: org.id, name: org.name, orgNumber: org.orgNumber ?? null },
    }
  }

  async login(dto: LoginInput): Promise<AuthResponse> {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
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
      },
    }
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
      where: { email },
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
        console.error('[auth] password reset mail failed', String(err))
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
