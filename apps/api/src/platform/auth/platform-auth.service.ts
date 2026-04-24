import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { ConfigService } from '@nestjs/config'
import * as bcrypt from 'bcryptjs'
import { generateSecret, generateURI, verify as verifyOtp } from 'otplib'
import * as QRCode from 'qrcode'
import { v4 as uuidv4 } from 'uuid'
import { PrismaService } from '../../common/prisma/prisma.service'
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

interface StoredRefreshToken {
  platformUserId: string
  expiresAt: number
  revoked: boolean
}

@Injectable()
export class PlatformAuthService {
  // Refresh tokens förvaras i minne (en långlivad prod-deployment bör migrera
  // detta till en platform_refresh_token-tabell — men för första iterationen
  // räcker in-memory tills vi introducerar horisontell skalning).
  private refreshStore = new Map<string, StoredRefreshToken>()

  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private config: ConfigService,
  ) {}

  async login(email: string, password: string, totpCode?: string): Promise<PlatformAuthResponse> {
    const user = await this.prisma.platformUser.findUnique({ where: { email } })
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

    const tokens = this.issueTokens(user.id, user.email)
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
    const stored = this.refreshStore.get(refreshToken)
    if (!stored || stored.revoked || stored.expiresAt < Date.now()) {
      throw new UnauthorizedException('Ogiltig refresh token')
    }

    stored.revoked = true
    this.refreshStore.set(refreshToken, stored)

    const user = await this.prisma.platformUser.findUnique({
      where: { id: stored.platformUserId },
    })
    if (!user) throw new UnauthorizedException()

    return this.issueTokens(user.id, user.email)
  }

  async logout(refreshToken?: string): Promise<void> {
    if (refreshToken) {
      const stored = this.refreshStore.get(refreshToken)
      if (stored) {
        stored.revoked = true
        this.refreshStore.set(refreshToken, stored)
      }
    }
  }

  async changePassword(
    platformUserId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    const user = await this.prisma.platformUser.findUnique({ where: { id: platformUserId } })
    if (!user) throw new NotFoundException()

    const valid = await bcrypt.compare(currentPassword, user.passwordHash)
    if (!valid) throw new UnauthorizedException('Felaktigt nuvarande lösenord')

    const passwordHash = await bcrypt.hash(newPassword, 12)
    await this.prisma.platformUser.update({
      where: { id: platformUserId },
      data: { passwordHash },
    })
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
      issuer: 'Eken Admin',
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

  private issueTokens(platformUserId: string, email: string): PlatformTokenPair {
    const payload: PlatformJwtPayload = {
      sub: platformUserId,
      email,
      type: 'platform',
    }
    const accessToken = this.jwt.sign(payload)

    const refreshToken = uuidv4()
    const refreshExpiresIn = this.config.get('PLATFORM_JWT_REFRESH_EXPIRES_IN', '30d')
    const days = parseInt(String(refreshExpiresIn).replace('d', ''), 10) || 30
    const expiresAt = Date.now() + days * 24 * 60 * 60 * 1000
    this.refreshStore.set(refreshToken, { platformUserId, expiresAt, revoked: false })

    return { accessToken, refreshToken }
  }
}
