import { Injectable, UnauthorizedException, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Cron } from '@nestjs/schedule'
import * as crypto from 'crypto'
import { PrismaService } from '../common/prisma/prisma.service'
import { MailService } from '../mail/mail.service'
import type { Tenant } from '@prisma/client'

const MAGIC_LINK_COOLDOWN_MS = 2 * 60 * 1000

@Injectable()
export class TenantAuthService {
  private readonly logger = new Logger(TenantAuthService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly config: ConfigService,
  ) {}

  async sendMagicLink(email: string, organizationId?: string): Promise<void> {
    const where = organizationId ? { email, organizationId } : { email }
    const tenant = await this.prisma.tenant.findFirst({ where })
    if (!tenant) return

    if (!organizationId) {
      const matches = await this.prisma.tenant.count({ where: { email } })
      if (matches > 1) {
        this.logger.warn(
          `Magic link request for ${email} matched ${matches} tenants — sent to tenant ${tenant.id} (org ${tenant.organizationId}). Caller should pass organizationId.`,
        )
      }
    }

    const cooldownSince = new Date(Date.now() - MAGIC_LINK_COOLDOWN_MS)
    const recent = await this.prisma.tenantMagicLink.findFirst({
      where: { tenantId: tenant.id, createdAt: { gte: cooldownSince } },
      select: { id: true },
    })
    if (recent) {
      this.logger.warn(`Magic link cooldown active for tenant ${tenant.id}`)
      return
    }

    const token = crypto.randomBytes(32).toString('hex')
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000)

    await this.prisma.tenantMagicLink.create({
      data: { tenantId: tenant.id, token, expiresAt },
    })

    const portalUrl = this.config.get<string>('PORTAL_URL') ?? 'http://localhost:5174'
    const magicUrl = `${portalUrl}/auth/verify?token=${token}`
    const tenantName = tenant.firstName
      ? `${tenant.firstName} ${tenant.lastName ?? ''}`.trim()
      : (tenant.companyName ?? tenant.email)

    await this.mail
      .sendCustomEmail({
        to: email,
        subject: 'Din inloggningslänk till hyresgästportalen',
        tenantName,
        organizationName: 'Eken Fastigheter',
        bodyHtml: `
        <h2 style="color:#1a6b3c;margin:0 0 16px">Logga in på din hyresgästportal</h2>
        <p>Klicka på knappen nedan för att logga in. Länken är giltig i 24 timmar.</p>
        <a href="${magicUrl}"
           style="display:inline-block;background:#1a6b3c;color:white;
                  padding:12px 24px;border-radius:6px;text-decoration:none;
                  font-weight:bold;margin:16px 0">
          Öppna min portal →
        </a>
        <p style="color:#999;font-size:12px;margin-top:16px">
          Om du inte begärde denna länk kan du ignorera detta mail.
          Länken kan bara användas en gång.
        </p>
      `,
      })
      .catch((err: unknown) => {
        this.logger.warn(`Magic link email failed for ${email}: ${String(err)}`)
      })
  }

  async sendInvitationLink(tenantId: string): Promise<void> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      include: { organization: true },
    })
    if (!tenant) return

    const token = crypto.randomBytes(32).toString('hex')
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)

    await this.prisma.tenantMagicLink.create({
      data: { tenantId: tenant.id, token, expiresAt },
    })

    const portalUrl = this.config.get<string>('PORTAL_URL') ?? 'http://localhost:5174'
    const magicUrl = `${portalUrl}/auth/verify?token=${token}`
    const tenantName = tenant.firstName
      ? `${tenant.firstName} ${tenant.lastName ?? ''}`.trim()
      : (tenant.companyName ?? tenant.email)
    const orgName = tenant.organization.name

    await this.mail
      .sendCustomEmail({
        to: tenant.email,
        subject: 'Du är inbjuden till din hyresgästportal',
        tenantName,
        organizationName: orgName,
        bodyHtml: `
        <h2 style="color:#1a6b3c;margin:0 0 16px">Välkommen till hyresgästportalen</h2>
        <p>Hej ${tenantName},</p>
        <p>Din hyresvärd <strong>${orgName}</strong> har skapat ett konto åt dig i hyresgästportalen Eken.</p>
        <a href="${magicUrl}"
           style="display:inline-block;background:#1a6b3c;color:white;
                  padding:12px 24px;border-radius:6px;text-decoration:none;
                  font-weight:bold;margin:16px 0">
          Logga in på portalen →
        </a>
        <p style="color:#555;margin-top:16px">I portalen kan du:</p>
        <ul style="color:#555;line-height:1.8">
          <li>Se dina hyresavier och fakturor</li>
          <li>Anmäla fel i lägenheten</li>
          <li>Läsa nyheter från din hyresvärd</li>
          <li>Se ditt hyreskontrakt</li>
        </ul>
        <p style="color:#999;font-size:12px;margin-top:16px">
          Länken är giltig i 7 dagar och kan bara användas en gång.
        </p>
      `,
      })
      .catch((err: unknown) => {
        this.logger.warn(`Invitation email failed for tenant ${tenantId}: ${String(err)}`)
      })
  }

  async verifyMagicLink(token: string): Promise<{ sessionToken: string; tenant: Tenant }> {
    const link = await this.prisma.tenantMagicLink.findUnique({
      where: { token },
      include: { tenant: { include: { organization: true } } },
    })

    if (!link) throw new UnauthorizedException('Ogiltig länk')
    if (link.usedAt) throw new UnauthorizedException('Länken har redan använts')
    if (link.expiresAt < new Date()) throw new UnauthorizedException('Länken har gått ut')

    await this.prisma.tenantMagicLink.update({
      where: { id: link.id },
      data: { usedAt: new Date() },
    })

    const sessionToken = crypto.randomBytes(32).toString('hex')
    await this.prisma.tenantSession.create({
      data: {
        tenantId: link.tenantId,
        token: sessionToken,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    })

    return { sessionToken, tenant: link.tenant }
  }

  async validateSession(
    token: string,
  ): Promise<Tenant & { organization: { id: string; name: string } }> {
    const session = await this.prisma.tenantSession.findUnique({
      where: { token },
      include: { tenant: { include: { organization: { select: { id: true, name: true } } } } },
    })

    if (!session || session.expiresAt < new Date()) {
      throw new UnauthorizedException('Sessionen är ogiltig eller har gått ut')
    }

    return session.tenant as Tenant & { organization: { id: string; name: string } }
  }

  async logout(token: string): Promise<void> {
    await this.prisma.tenantSession.deleteMany({ where: { token } })
  }

  @Cron('0 3 * * *')
  async cleanupStaleMagicLinks(): Promise<void> {
    const result = await this.prisma.tenantMagicLink.deleteMany({
      where: {
        OR: [{ expiresAt: { lt: new Date() } }, { usedAt: { not: null } }],
      },
    })
    this.logger.log(`Cleaned up ${result.count} stale magic link(s)`)
  }
}
