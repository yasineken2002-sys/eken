import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { ConfigService } from '@nestjs/config'
import { PrismaService } from '../../common/prisma/prisma.service'
import type { JwtPayload } from '@eken/shared'

export interface ImpersonationStartResult {
  accessToken: string
  logId: string
  organization: { id: string; name: string }
  user: { id: string; email: string; firstName: string; lastName: string; role: string }
  expiresInSeconds: number
}

@Injectable()
export class ImpersonationService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private config: ConfigService,
  ) {}

  async start(params: {
    platformUserId: string
    organizationId: string
    userId?: string
    reason?: string
    ipAddress?: string
    userAgent?: string
  }): Promise<ImpersonationStartResult> {
    const org = await this.prisma.organization.findUnique({
      where: { id: params.organizationId },
      select: { id: true, name: true, status: true },
    })
    if (!org) throw new NotFoundException('Organisationen hittades inte')
    if (org.status === 'CANCELLED') {
      throw new ForbiddenException('Organisationen är avslutad')
    }

    const targetUser = await this.selectTargetUser(params.organizationId, params.userId)

    const log = await this.prisma.impersonationLog.create({
      data: {
        platformUserId: params.platformUserId,
        organizationId: params.organizationId,
        targetUserId: targetUser.id,
        ...(params.reason ? { reason: params.reason } : {}),
        ...(params.ipAddress ? { ipAddress: params.ipAddress } : {}),
        ...(params.userAgent ? { userAgent: params.userAgent } : {}),
      },
    })

    const payload: JwtPayload & { impersonatedBy: string; impersonationLogId: string } = {
      sub: targetUser.id,
      email: targetUser.email,
      organizationId: org.id,
      role: targetUser.role as JwtPayload['role'],
      impersonatedBy: params.platformUserId,
      impersonationLogId: log.id,
    }

    const accessToken = this.jwt.sign(payload, {
      secret: this.config.getOrThrow<string>('JWT_SECRET'),
      expiresIn: '1h',
    })

    return {
      accessToken,
      logId: log.id,
      organization: { id: org.id, name: org.name },
      user: {
        id: targetUser.id,
        email: targetUser.email,
        firstName: targetUser.firstName,
        lastName: targetUser.lastName,
        role: targetUser.role,
      },
      expiresInSeconds: 3600,
    }
  }

  async end(platformUserId: string, logId: string): Promise<void> {
    const log = await this.prisma.impersonationLog.findUnique({ where: { id: logId } })
    if (!log) throw new NotFoundException('Logg hittades inte')
    if (log.platformUserId !== platformUserId) throw new ForbiddenException()
    if (log.endedAt) return
    await this.prisma.impersonationLog.update({
      where: { id: logId },
      data: { endedAt: new Date() },
    })
  }

  /**
   * Avslutar en session där anroparen har SJÄLVA impersonation-JWT (dvs
   * web-tabben). Vi kräver att `impersonationLogId` i JWT-payloaden matchar
   * den inskickade `logId` — det betyder att tokenet faktiskt utfärdades
   * för exakt denna session och ingen annan. Platform-user-id:t läses ur
   * loggen och behöver inte valideras på nytt.
   */
  async endFromImpersonatedToken(
    impersonationLogIdFromPayload: string,
    bodyLogId: string,
  ): Promise<void> {
    if (impersonationLogIdFromPayload !== bodyLogId) {
      throw new ForbiddenException('Log-id matchar inte token')
    }
    const log = await this.prisma.impersonationLog.findUnique({ where: { id: bodyLogId } })
    if (!log) throw new NotFoundException('Logg hittades inte')
    if (log.endedAt) return
    await this.prisma.impersonationLog.update({
      where: { id: bodyLogId },
      data: { endedAt: new Date() },
    })
  }

  async listRecent(platformUserId?: string, limit = 50) {
    const logs = await this.prisma.impersonationLog.findMany({
      where: platformUserId ? { platformUserId } : {},
      orderBy: { startedAt: 'desc' },
      take: limit,
      include: {
        organization: { select: { id: true, name: true } },
        targetUser: { select: { id: true, email: true, firstName: true, lastName: true } },
        platformUser: { select: { id: true, email: true } },
      },
    })
    return logs.map((l) => ({
      id: l.id,
      platformUser: l.platformUser,
      organization: l.organization,
      targetUser: l.targetUser,
      startedAt: l.startedAt.toISOString(),
      endedAt: l.endedAt?.toISOString() ?? null,
      reason: l.reason,
      ipAddress: l.ipAddress,
    }))
  }

  private async selectTargetUser(organizationId: string, userId?: string) {
    if (userId) {
      const u = await this.prisma.user.findFirst({
        where: { id: userId, organizationId, isActive: true },
      })
      if (!u) throw new NotFoundException('Användaren hittades inte i organisationen')
      return u
    }
    // Fallback: första OWNER, sedan ADMIN, sedan valfri aktiv user.
    const ordering: ('OWNER' | 'ADMIN' | 'MANAGER' | 'ACCOUNTANT' | 'VIEWER')[] = [
      'OWNER',
      'ADMIN',
      'MANAGER',
      'ACCOUNTANT',
      'VIEWER',
    ]
    for (const role of ordering) {
      const u = await this.prisma.user.findFirst({
        where: { organizationId, role, isActive: true },
      })
      if (u) return u
    }
    throw new NotFoundException('Ingen aktiv användare i organisationen')
  }
}
