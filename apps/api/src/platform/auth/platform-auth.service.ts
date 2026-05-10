import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { ConfigService } from '@nestjs/config'
import * as bcrypt from 'bcryptjs'
import * as crypto from 'crypto'
import { generateSecret, generateURI, verify as verifyOtp } from 'otplib'
import * as QRCode from 'qrcode'
import { v4 as uuidv4 } from 'uuid'
import { PrismaService } from '../../common/prisma/prisma.service'
import { normalizeEmail } from '../../common/utils/normalize-email'
import type { PlatformJwtPayload, PlatformTokenPair } from '../platform-token.types'

export interface PlatformAuthUser {
  id: string
  email: string
  firstName: string
  lastName: string
  totpEnabled: boolean
}

export interface PlatformAuthResponse extends PlatformTokenPair {
  user: PlatformAuthUser
}

function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex')
}

@Injectable()
export class PlatformAuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private config: ConfigService,
  ) {}

  async login(email: string, password: string, totpCode?: string): Promise<PlatformAuthResponse> {
    const user = await this.prisma.platformUser.findUnique({
      where: { email: normalizeEmail(email) },
    })
    if (!user) throw new UnauthorizedException('Felaktiga inloggningsuppgifter')

    const valid = await bcrypt.compare(password, user.passwordHash)
    if (!valid) throw new UnauthorizedException('Felaktiga inloggningsuppgifter')

    if (user.totpEnabled) {
      if (!totpCode) {
        throw new UnauthorizedException({
          message: 'TOTP-kod krävs',
          requires2fa: true,
        })
      }
      if (!user.totpSecret || !(await verifyOtp({ token: totpCode, secret: user.totpSecret }))) {
        throw new UnauthorizedException('Ogiltig TOTP-kod')
      }
    }

    await this.prisma.platformUser.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    })

    const tokens = await this.issueTokens(user.id, user.email)
    return {
      ...tokens,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        totpEnabled: user.totpEnabled,
      },
    }
  }

  async refresh(refreshToken: string): Promise<PlatformTokenPair> {
    const tokenHash = sha256(refreshToken)
    const stored = await this.prisma.platformRefreshToken.findUnique({
      where: { token: tokenHash },
    })
    if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
      throw new UnauthorizedException('Ogiltig refresh token')
    }

    // Rotation: revokera den gamla, mint en ny — så att en eventuell stulen
    // kopia förlorar giltighet så fort legitim klient refreshar.
    await this.prisma.platformRefreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date() },
    })

    const user = await this.prisma.platformUser.findUnique({
      where: { id: stored.platformUserId },
    })
    if (!user) throw new UnauthorizedException()

    return this.issueTokens(user.id, user.email)
  }

  async logout(refreshToken?: string): Promise<void> {
    if (!refreshToken) return
    const tokenHash = sha256(refreshToken)
    await this.prisma.platformRefreshToken.updateMany({
      where: { token: tokenHash, revokedAt: null },
      data: { revokedAt: new Date() },
    })
  }

  async changePassword(
    platformUserId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<{ message: string; loggedOut: true }> {
    const user = await this.prisma.platformUser.findUnique({ where: { id: platformUserId } })
    if (!user) throw new NotFoundException()

    const valid = await bcrypt.compare(currentPassword, user.passwordHash)
    if (!valid) throw new UnauthorizedException('Felaktigt nuvarande lösenord')

    const passwordHash = await bcrypt.hash(newPassword, 12)
    await this.prisma.platformUser.update({
      where: { id: platformUserId },
      data: { passwordHash },
    })

    // Revokera alla aktiva refresh-tokens för denna admin så att alla enheter
    // (inkl. den aktuella) tappar sessionen — admin-klienten redirectar till
    // login med en flash-banner.
    await this.prisma.platformRefreshToken.updateMany({
      where: { platformUserId, revokedAt: null },
      data: { revokedAt: new Date() },
    })

    return {
      message: 'Lösenordet har bytts. Du loggas nu ut från alla enheter.',
      loggedOut: true,
    }
  }

  async generateTotpSetup(
    platformUserId: string,
  ): Promise<{ secret: string; qrCodeDataUrl: string }> {
    const user = await this.prisma.platformUser.findUnique({ where: { id: platformUserId } })
    if (!user) throw new NotFoundException()
    if (user.totpEnabled) {
      throw new BadRequestException('2FA är redan aktiverat')
    }

    const secret = await generateSecret()
    const otpauth = await generateURI({
      secret,
      label: user.email,
      issuer: 'Eveno Admin',
    })
    const qrCodeDataUrl = await QRCode.toDataURL(otpauth)

    // Spara secret men lämna totpEnabled=false tills användaren verifierar.
    await this.prisma.platformUser.update({
      where: { id: platformUserId },
      data: { totpSecret: secret },
    })

    return { secret, qrCodeDataUrl }
  }

  async enableTotp(platformUserId: string, code: string): Promise<void> {
    const user = await this.prisma.platformUser.findUnique({ where: { id: platformUserId } })
    if (!user || !user.totpSecret) throw new BadRequestException('Starta först 2FA-setup')

    if (!(await verifyOtp({ token: code, secret: user.totpSecret }))) {
      throw new BadRequestException('Ogiltig kod')
    }

    await this.prisma.platformUser.update({
      where: { id: platformUserId },
      data: { totpEnabled: true },
    })
  }

  async disableTotp(platformUserId: string, code: string): Promise<void> {
    const user = await this.prisma.platformUser.findUnique({ where: { id: platformUserId } })
    if (!user || !user.totpEnabled || !user.totpSecret) {
      throw new BadRequestException('2FA är inte aktiverat')
    }
    if (!(await verifyOtp({ token: code, secret: user.totpSecret }))) {
      throw new BadRequestException('Ogiltig kod')
    }

    await this.prisma.platformUser.update({
      where: { id: platformUserId },
      data: { totpEnabled: false, totpSecret: null },
    })
  }

  async getProfile(platformUserId: string): Promise<PlatformAuthUser> {
    const user = await this.prisma.platformUser.findUnique({ where: { id: platformUserId } })
    if (!user) throw new NotFoundException()
    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      totpEnabled: user.totpEnabled,
    }
  }

  private async issueTokens(platformUserId: string, email: string): Promise<PlatformTokenPair> {
    const payload: PlatformJwtPayload = {
      sub: platformUserId,
      email,
      type: 'platform',
    }
    const accessToken = this.jwt.sign(payload)

    const refreshToken = uuidv4()
    const refreshExpiresIn = this.config.get('PLATFORM_JWT_REFRESH_EXPIRES_IN', '30d')
    const days = parseInt(String(refreshExpiresIn).replace('d', ''), 10) || 30
    const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000)

    await this.prisma.platformRefreshToken.create({
      data: {
        platformUserId,
        token: sha256(refreshToken),
        expiresAt,
      },
    })

    return { accessToken, refreshToken }
  }
}
