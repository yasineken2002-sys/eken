import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import * as crypto from 'crypto'
import { PrismaService } from '../common/prisma/prisma.service'
import { MailService } from '../mail/mail.service'
import type { InvitableRole } from './dto/invite-user.dto'
import type { AssignableRole } from './dto/update-user-role.dto'
import type { UserRole } from '@eken/shared'

const ROLE_LABELS: Record<UserRole, string> = {
  OWNER: 'Ägare',
  ADMIN: 'Administratör',
  MANAGER: 'Förvaltare',
  ACCOUNTANT: 'Ekonomi',
  VIEWER: 'Läsbehörighet',
}

const PUBLIC_USER_FIELDS = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  role: true,
  isActive: true,
  mustChangePassword: true,
  lastLoginAt: true,
  avatarUrl: true,
  createdAt: true,
  updatedAt: true,
} as const

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly config: ConfigService,
  ) {}

  async findAll(organizationId: string) {
    return this.prisma.user.findMany({
      where: { organizationId },
      select: PUBLIC_USER_FIELDS,
      orderBy: [{ isActive: 'desc' }, { createdAt: 'asc' }],
    })
  }

  async invite(
    dto: { email: string; firstName: string; lastName: string; role: InvitableRole },
    organizationId: string,
    invitedByUserId: string,
  ) {
    const inviter = await this.prisma.user.findFirst({
      where: { id: invitedByUserId, organizationId },
      select: { firstName: true, lastName: true, email: true },
    })
    if (!inviter) throw new ForbiddenException('Otillräckliga rättigheter')
    const existing = await this.prisma.user.findUnique({ where: { email: dto.email } })
    if (existing) {
      // Konflikt även om användaren råkar tillhöra en annan organisation —
      // email är ett globalt unikt fält i schemat.
      throw new ConflictException('En användare med den e-postadressen finns redan')
    }

    // INGET tillfälligt lösenord skapas. Användaren har passwordHash=null
    // tills inbjudan accepteras via /v1/auth/accept-invite, då lösenordet
    // sätts för första gången. Login() avvisar passwordHash=null som
    // "felaktiga inloggningsuppgifter".
    const token = crypto.randomBytes(32).toString('hex')
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // 7 dagar

    const created = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          organizationId,
          email: dto.email,
          firstName: dto.firstName,
          lastName: dto.lastName,
          role: dto.role,
          passwordHash: null,
          isActive: false, // aktiveras vid accept-invite
        },
        select: PUBLIC_USER_FIELDS,
      })

      await tx.userInvitation.create({
        data: { userId: user.id, token, expiresAt },
      })

      return user
    })

    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { name: true },
    })

    const webUrl = this.config.get<string>('WEB_URL') ?? 'http://localhost:5173'
    const acceptUrl = `${webUrl}/accept-invite?token=${token}`

    const inviterName = `${inviter.firstName} ${inviter.lastName}`.trim() || inviter.email

    await this.mail
      .sendUserInvite({
        to: created.email,
        recipientName: `${created.firstName} ${created.lastName}`.trim(),
        roleLabel: ROLE_LABELS[created.role],
        invitedBy: inviterName,
        acceptUrl,
        organizationName: org?.name ?? 'Eveno',
        validForDays: 7,
        idempotencyKey: `invite:${token}`,
      })
      .catch((err: unknown) => {
        console.error('[users] invite mail failed', String(err))
      })

    return created
  }

  async updateRole(
    targetUserId: string,
    role: AssignableRole,
    organizationId: string,
    actorUserId: string,
  ) {
    if (targetUserId === actorUserId) {
      throw new BadRequestException('Du kan inte ändra din egen roll')
    }

    const target = await this.prisma.user.findFirst({
      where: { id: targetUserId, organizationId },
      select: PUBLIC_USER_FIELDS,
    })
    if (!target) throw new NotFoundException('Användaren hittades inte')
    if (target.role === 'OWNER') {
      throw new ForbiddenException('Ägarens roll kan inte ändras här')
    }

    return this.prisma.user.update({
      where: { id: targetUserId },
      data: { role },
      select: PUBLIC_USER_FIELDS,
    })
  }

  async deactivate(targetUserId: string, organizationId: string, actorUserId: string) {
    if (targetUserId === actorUserId) {
      throw new BadRequestException('Du kan inte inaktivera dig själv')
    }

    const target = await this.prisma.user.findFirst({
      where: { id: targetUserId, organizationId },
      select: PUBLIC_USER_FIELDS,
    })
    if (!target) throw new NotFoundException('Användaren hittades inte')
    if (target.role === 'OWNER') {
      throw new ForbiddenException('Ägaren kan inte inaktiveras')
    }

    // Inaktivera + revoke alla aktiva sessioner så användaren tappar access
    // omedelbart utan att vänta på att JWT går ut.
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id: targetUserId },
        data: { isActive: false },
        select: PUBLIC_USER_FIELDS,
      })
      await tx.refreshToken.updateMany({
        where: { userId: targetUserId, revokedAt: null },
        data: { revokedAt: new Date() },
      })
      return updated
    })
  }

  async reactivate(targetUserId: string, organizationId: string) {
    const target = await this.prisma.user.findFirst({
      where: { id: targetUserId, organizationId },
      select: PUBLIC_USER_FIELDS,
    })
    if (!target) throw new NotFoundException('Användaren hittades inte')

    return this.prisma.user.update({
      where: { id: targetUserId },
      data: { isActive: true },
      select: PUBLIC_USER_FIELDS,
    })
  }
}
