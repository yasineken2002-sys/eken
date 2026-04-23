import { Injectable, UnauthorizedException, ConflictException } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { ConfigService } from '@nestjs/config'
import * as bcrypt from 'bcryptjs'
import { v4 as uuidv4 } from 'uuid'
import { PrismaService } from '../common/prisma/prisma.service'
import type { JwtPayload, TokenPair } from '@eken/shared'
import type { LoginInput } from '@eken/shared'

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

    const tokens = await this.issueTokens(user.id, user.email, org.id, user.role)
    return {
      ...tokens,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        organizationId: user.organizationId,
      },
      organization: { id: org.id, name: org.name, orgNumber: org.orgNumber ?? null },
    }
  }

  async login(dto: LoginInput): Promise<AuthResponse> {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
      include: { organization: true },
    })
    if (!user || !user.isActive) throw new UnauthorizedException('Felaktiga inloggningsuppgifter')

    const valid = await bcrypt.compare(dto.password, user.passwordHash)
    if (!valid) throw new UnauthorizedException('Felaktiga inloggningsuppgifter')

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    })

    const tokens = await this.issueTokens(user.id, user.email, user.organizationId, user.role)
    return {
      ...tokens,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        organizationId: user.organizationId,
      },
      organization: {
        id: user.organization.id,
        name: user.organization.name,
        orgNumber: user.organization.orgNumber ?? null,
      },
    }
  }

  async refresh(token: string): Promise<TokenPair> {
    const stored = await this.prisma.refreshToken.findUnique({ where: { token } })
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

    return this.issueTokens(user.id, user.email, user.organizationId, user.role)
  }

  async logout(userId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    })
  }

  private async issueTokens(
    userId: string,
    email: string,
    organizationId: string,
    role: string,
  ): Promise<TokenPair> {
    const payload: JwtPayload = {
      sub: userId,
      email,
      organizationId,
      role: role as JwtPayload['role'],
    }
    const accessToken = this.jwt.sign(payload)

    const refreshToken = uuidv4()
    const refreshExpiresIn = this.config.get('JWT_REFRESH_EXPIRES_IN', '30d')
    const days = parseInt(refreshExpiresIn.replace('d', ''), 10) || 30
    const expiresAt = new Date()
    expiresAt.setDate(expiresAt.getDate() + days)

    await this.prisma.refreshToken.create({
      data: { userId, token: refreshToken, expiresAt },
    })

    return { accessToken, refreshToken }
  }
}
