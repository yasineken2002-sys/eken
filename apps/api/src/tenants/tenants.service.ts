import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common'
import type { ConfigService } from '@nestjs/config'
import * as crypto from 'crypto'
import type { Tenant } from '@prisma/client'
import type { PrismaService } from '../common/prisma/prisma.service'
import type { MailService } from '../mail/mail.service'
import type { CreateTenantDto } from './dto/create-tenant.dto'
import type { UpdateTenantDto } from './dto/update-tenant.dto'

// Maps flat Prisma address fields → nested Address object matching @eken/shared Tenant type
function mapTenant<T extends Pick<Tenant, 'street' | 'city' | 'postalCode'>>(
  t: T,
): Omit<T, 'street' | 'city' | 'postalCode'> & {
  address?: { street: string; city: string; postalCode: string; country: string }
} {
  const { street, city, postalCode, ...rest } = t
  return {
    ...rest,
    ...(street != null
      ? { address: { street, city: city ?? '', postalCode: postalCode ?? '', country: 'SE' } }
      : {}),
  }
}

@Injectable()
export class TenantsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly config: ConfigService,
  ) {}

  async findAll(organizationId: string, search?: string) {
    const tenants = await this.prisma.tenant.findMany({
      where: {
        organizationId,
        ...(search
          ? {
              OR: [
                { firstName: { contains: search, mode: 'insensitive' } },
                { lastName: { contains: search, mode: 'insensitive' } },
                { companyName: { contains: search, mode: 'insensitive' } },
                { email: { contains: search, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      include: {
        _count: { select: { invoices: true } },
      },
      orderBy: { createdAt: 'desc' },
    })
    return tenants.map(mapTenant)
  }

  async findOne(id: string, organizationId: string) {
    const tenant = await this.prisma.tenant.findFirst({
      where: { id, organizationId },
      include: {
        invoices: {
          orderBy: { createdAt: 'desc' },
          take: 5,
          include: { lines: true },
        },
        _count: { select: { invoices: true } },
      },
    })
    if (!tenant) throw new NotFoundException('Hyresgästen hittades inte')
    return mapTenant(tenant)
  }

  async create(dto: CreateTenantDto, organizationId: string) {
    if (dto.type === 'INDIVIDUAL' && (!dto.firstName || !dto.lastName)) {
      throw new BadRequestException('Förnamn och efternamn krävs')
    }
    if (dto.type === 'COMPANY' && !dto.companyName) {
      throw new BadRequestException('Företagsnamn krävs')
    }

    const tenant = await this.prisma.tenant.create({
      data: {
        organizationId,
        type: dto.type,
        ...(dto.firstName != null ? { firstName: dto.firstName } : {}),
        ...(dto.lastName != null ? { lastName: dto.lastName } : {}),
        ...(dto.companyName != null ? { companyName: dto.companyName } : {}),
        ...(dto.email != null ? { email: dto.email } : { email: '' }),
        ...(dto.phone != null ? { phone: dto.phone } : {}),
        ...(dto.personalNumber != null ? { personalNumber: dto.personalNumber } : {}),
        ...(dto.orgNumber != null ? { orgNumber: dto.orgNumber } : {}),
        ...(dto.street != null ? { street: dto.street } : {}),
        ...(dto.city != null ? { city: dto.city } : {}),
        ...(dto.postalCode != null ? { postalCode: dto.postalCode } : {}),
      },
      include: { organization: { select: { name: true } } },
    })

    if (tenant.email) {
      void this.sendInvitationEmail(tenant).catch((err) =>
        console.error('[tenants] invitation email failed', String(err)),
      )
    }

    return mapTenant(tenant)
  }

  private async sendInvitationEmail(
    tenant: Tenant & { organization: { name: string } },
  ): Promise<void> {
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
      .catch((err: unknown) => console.warn('[tenants] invitation mail send failed', String(err)))
  }

  async update(id: string, dto: UpdateTenantDto, organizationId: string) {
    const existing = await this.prisma.tenant.findFirst({ where: { id, organizationId } })
    if (!existing) throw new NotFoundException('Hyresgästen hittades inte')

    const tenant = await this.prisma.tenant.update({
      where: { id },
      data: {
        ...(dto.type != null ? { type: dto.type } : {}),
        ...(dto.firstName != null ? { firstName: dto.firstName } : {}),
        ...(dto.lastName != null ? { lastName: dto.lastName } : {}),
        ...(dto.companyName != null ? { companyName: dto.companyName } : {}),
        ...(dto.email != null ? { email: dto.email } : {}),
        ...(dto.phone != null ? { phone: dto.phone } : {}),
        ...(dto.personalNumber != null ? { personalNumber: dto.personalNumber } : {}),
        ...(dto.orgNumber != null ? { orgNumber: dto.orgNumber } : {}),
        ...(dto.street != null ? { street: dto.street } : {}),
        ...(dto.city != null ? { city: dto.city } : {}),
        ...(dto.postalCode != null ? { postalCode: dto.postalCode } : {}),
      },
    })
    return mapTenant(tenant)
  }

  async remove(id: string, organizationId: string): Promise<void> {
    const existing = await this.prisma.tenant.findFirst({ where: { id, organizationId } })
    if (!existing) throw new NotFoundException('Hyresgästen hittades inte')

    const activeInvoiceCount = await this.prisma.invoice.count({
      where: { tenantId: id, status: { notIn: ['VOID', 'DRAFT'] } },
    })
    if (activeInvoiceCount > 0) {
      throw new BadRequestException('Hyresgästen har aktiva fakturor och kan inte tas bort.')
    }

    await this.prisma.tenant.delete({ where: { id } })
  }
}
