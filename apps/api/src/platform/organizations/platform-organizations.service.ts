import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import * as bcrypt from 'bcryptjs'
import { randomBytes } from 'crypto'
import { PrismaService } from '../../common/prisma/prisma.service'
import type { CreateOrganizationDto, UpdateOrganizationDto } from './dto/platform-organization.dto'

type OrgStatus = 'ACTIVE' | 'SUSPENDED' | 'CANCELLED'
type OrgPlan = 'TRIAL' | 'BASIC' | 'STANDARD' | 'PREMIUM'

export interface PlatformOrganizationListItem {
  id: string
  name: string
  orgNumber: string | null
  email: string
  plan: OrgPlan
  status: OrgStatus
  trialEndsAt: string | null
  monthlyFee: number
  billingEmail: string | null
  createdAt: string
  updatedAt: string
  propertyCount: number
  tenantCount: number
  userCount: number
}

@Injectable()
export class PlatformOrganizationsService {
  constructor(private prisma: PrismaService) {}

  async list(params: {
    search?: string
    status?: OrgStatus
    plan?: OrgPlan
    page?: number
    pageSize?: number
  }) {
    const page = Math.max(1, params.page ?? 1)
    const pageSize = Math.min(200, Math.max(1, params.pageSize ?? 50))
    const skip = (page - 1) * pageSize

    const where: Record<string, unknown> = {}
    if (params.search) {
      where['OR'] = [
        { name: { contains: params.search, mode: 'insensitive' } },
        { orgNumber: { contains: params.search, mode: 'insensitive' } },
        { email: { contains: params.search, mode: 'insensitive' } },
      ]
    }
    if (params.status) where['status'] = params.status
    if (params.plan) where['plan'] = params.plan

    const [total, rows] = await Promise.all([
      this.prisma.organization.count({ where }),
      this.prisma.organization.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: pageSize,
        include: {
          _count: { select: { properties: true, tenants: true, users: true } },
        },
      }),
    ])

    return {
      total,
      page,
      pageSize,
      items: rows.map((r) => this.mapListItem(r)),
    }
  }

  async findOne(id: string) {
    const org = await this.prisma.organization.findUnique({
      where: { id },
      include: {
        _count: {
          select: {
            properties: true,
            tenants: true,
            users: true,
            invoices: true,
            platformInvoices: true,
          },
        },
        users: {
          select: {
            id: true,
            email: true,
            firstName: true,
            lastName: true,
            role: true,
            isActive: true,
            lastLoginAt: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    })
    if (!org) throw new NotFoundException('Organisationen hittades inte')

    return {
      id: org.id,
      name: org.name,
      orgNumber: org.orgNumber,
      vatNumber: org.vatNumber,
      accountType: org.accountType,
      email: org.email,
      phone: org.phone,
      address: {
        street: org.street,
        city: org.city,
        postalCode: org.postalCode,
        country: org.country,
      },
      plan: org.plan,
      status: org.status,
      trialEndsAt: org.trialEndsAt?.toISOString() ?? null,
      monthlyFee: Number(org.monthlyFee),
      billingEmail: org.billingEmail,
      suspendedAt: org.suspendedAt?.toISOString() ?? null,
      cancellationReason: org.cancellationReason,
      createdAt: org.createdAt.toISOString(),
      updatedAt: org.updatedAt.toISOString(),
      counts: org._count,
      users: org.users.map((u) => ({
        id: u.id,
        email: u.email,
        firstName: u.firstName,
        lastName: u.lastName,
        role: u.role,
        isActive: u.isActive,
        lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
        createdAt: u.createdAt.toISOString(),
      })),
    }
  }

  async create(dto: CreateOrganizationDto) {
    const existingOrg = dto.orgNumber
      ? await this.prisma.organization.findUnique({ where: { orgNumber: dto.orgNumber } })
      : null
    if (existingOrg) throw new ConflictException('Organisationsnumret är redan registrerat')

    const existingUser = await this.prisma.user.findUnique({ where: { email: dto.adminEmail } })
    if (existingUser) throw new ConflictException('Admin-mailen är redan registrerad')

    const tempPassword = dto.adminPassword ?? this.generateTempPassword()
    const passwordHash = await bcrypt.hash(tempPassword, 12)

    const trialDays = dto.trialDays ?? 30
    const plan = dto.plan ?? 'TRIAL'
    const trialEndsAt =
      plan === 'TRIAL' ? new Date(Date.now() + trialDays * 24 * 60 * 60 * 1000) : null

    const org = await this.prisma.organization.create({
      data: {
        name: dto.name,
        ...(dto.orgNumber ? { orgNumber: dto.orgNumber } : {}),
        ...(dto.vatNumber ? { vatNumber: dto.vatNumber } : {}),
        email: dto.email,
        ...(dto.phone ? { phone: dto.phone } : {}),
        street: dto.street,
        city: dto.city,
        postalCode: dto.postalCode,
        country: dto.country ?? 'SE',
        plan,
        status: 'ACTIVE',
        ...(trialEndsAt ? { trialEndsAt } : {}),
        ...(dto.billingEmail ? { billingEmail: dto.billingEmail } : {}),
        ...(dto.monthlyFee !== undefined ? { monthlyFee: dto.monthlyFee } : {}),
      },
    })

    const adminUser = await this.prisma.user.create({
      data: {
        organizationId: org.id,
        email: dto.adminEmail,
        passwordHash,
        firstName: dto.adminFirstName,
        lastName: dto.adminLastName,
        role: 'ADMIN',
      },
    })

    return {
      organization: await this.findOne(org.id),
      admin: {
        id: adminUser.id,
        email: adminUser.email,
        temporaryPassword: tempPassword,
      },
    }
  }

  async update(id: string, dto: UpdateOrganizationDto) {
    await this.ensureExists(id)
    const data: Record<string, unknown> = {}
    if (dto.name !== undefined) data['name'] = dto.name
    if (dto.orgNumber !== undefined) data['orgNumber'] = dto.orgNumber
    if (dto.vatNumber !== undefined) data['vatNumber'] = dto.vatNumber
    if (dto.email !== undefined) data['email'] = dto.email
    if (dto.phone !== undefined) data['phone'] = dto.phone
    if (dto.street !== undefined) data['street'] = dto.street
    if (dto.city !== undefined) data['city'] = dto.city
    if (dto.postalCode !== undefined) data['postalCode'] = dto.postalCode
    if (dto.country !== undefined) data['country'] = dto.country
    if (dto.plan !== undefined) data['plan'] = dto.plan
    if (dto.billingEmail !== undefined) data['billingEmail'] = dto.billingEmail
    if (dto.monthlyFee !== undefined) data['monthlyFee'] = dto.monthlyFee

    if (dto.trialDays !== undefined) {
      data['trialEndsAt'] = new Date(Date.now() + dto.trialDays * 24 * 60 * 60 * 1000)
    }

    await this.prisma.organization.update({ where: { id }, data })
    return this.findOne(id)
  }

  async suspend(id: string, reason?: string) {
    await this.ensureExists(id)
    await this.prisma.organization.update({
      where: { id },
      data: {
        status: 'SUSPENDED',
        suspendedAt: new Date(),
        ...(reason ? { cancellationReason: reason } : {}),
      },
    })
    return this.findOne(id)
  }

  async unsuspend(id: string) {
    const org = await this.ensureExists(id)
    if (org.status !== 'SUSPENDED') {
      throw new BadRequestException('Organisationen är inte suspenderad')
    }
    await this.prisma.organization.update({
      where: { id },
      data: {
        status: 'ACTIVE',
        suspendedAt: null,
        cancellationReason: null,
      },
    })
    return this.findOne(id)
  }

  async cancel(id: string, reason?: string) {
    await this.ensureExists(id)
    await this.prisma.organization.update({
      where: { id },
      data: {
        status: 'CANCELLED',
        ...(reason ? { cancellationReason: reason } : {}),
      },
    })
    return this.findOne(id)
  }

  private async ensureExists(id: string) {
    const org = await this.prisma.organization.findUnique({ where: { id } })
    if (!org) throw new NotFoundException('Organisationen hittades inte')
    return org
  }

  private mapListItem(r: {
    id: string
    name: string
    orgNumber: string | null
    email: string
    plan: OrgPlan
    status: OrgStatus
    trialEndsAt: Date | null
    monthlyFee: unknown
    billingEmail: string | null
    createdAt: Date
    updatedAt: Date
    _count: { properties: number; tenants: number; users: number }
  }): PlatformOrganizationListItem {
    return {
      id: r.id,
      name: r.name,
      orgNumber: r.orgNumber,
      email: r.email,
      plan: r.plan,
      status: r.status,
      trialEndsAt: r.trialEndsAt?.toISOString() ?? null,
      monthlyFee: Number(r.monthlyFee),
      billingEmail: r.billingEmail,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
      propertyCount: r._count.properties,
      tenantCount: r._count.tenants,
      userCount: r._count.users,
    }
  }

  private generateTempPassword(): string {
    // 12 tecken, base64url-aktigt utan tvetydiga symboler
    return randomBytes(9).toString('base64').replace(/[+/=]/g, 'A').slice(0, 12) + '!1'
  }
}
