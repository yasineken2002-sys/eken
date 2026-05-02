import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import type { Tenant, Lease } from '@prisma/client'
import { PrismaService } from '../common/prisma/prisma.service'
import { CreateTenantDto } from './dto/create-tenant.dto'
import { UpdateTenantDto } from './dto/update-tenant.dto'

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
  constructor(private readonly prisma: PrismaService) {}

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
        leases: {
          where: { status: { in: ['ACTIVE', 'DRAFT'] } },
          orderBy: { createdAt: 'desc' },
          take: 1,
          include: { unit: { include: { property: true } } },
        },
      },
      orderBy: { createdAt: 'desc' },
    })
    return tenants.map((t) => {
      const { leases, ...rest } = t
      return {
        ...mapTenant(rest),
        activeLease: leases[0] ?? null,
      }
    })
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
        leases: {
          orderBy: { createdAt: 'desc' },
          include: { unit: { include: { property: true } } },
        },
        _count: { select: { invoices: true } },
      },
    })
    if (!tenant) throw new NotFoundException('Hyresgästen hittades inte')
    const { leases, ...rest } = tenant
    return {
      ...mapTenant(rest),
      leases,
      activeLease: leases.find((l) => l.status === 'ACTIVE' || l.status === 'DRAFT') ?? null,
    }
  }

  async create(dto: CreateTenantDto, organizationId: string) {
    if (dto.type === 'INDIVIDUAL' && (!dto.firstName?.trim() || !dto.lastName?.trim())) {
      throw new BadRequestException('Förnamn och efternamn krävs för privatperson')
    }
    if (dto.type === 'COMPANY' && !dto.companyName?.trim()) {
      throw new BadRequestException('Företagsnamn krävs för företag')
    }

    // Dubblett-check innan transaktionen så användaren får ett tydligt fel
    // istället för en rå P2002 från Postgres.
    const duplicate = await this.prisma.tenant.findFirst({
      where: { organizationId, email: dto.email },
      select: { id: true },
    })
    if (duplicate) {
      throw new BadRequestException(
        'En hyresgäst med denna e-postadress finns redan i organisationen',
      )
    }

    // Verifiera att enheten finns och tillhör samma organisation.
    const unit = await this.prisma.unit.findFirst({
      where: { id: dto.lease.unitId },
      include: { property: true },
    })
    if (!unit || unit.property.organizationId !== organizationId) {
      throw new NotFoundException('Enheten hittades inte')
    }

    let result: { tenant: Tenant; lease: Lease }
    try {
      result = await this.prisma.$transaction(async (tx) => {
        const tenant = await tx.tenant.create({
          data: {
            organizationId,
            type: dto.type,
            email: dto.email,
            ...(dto.firstName != null ? { firstName: dto.firstName } : {}),
            ...(dto.lastName != null ? { lastName: dto.lastName } : {}),
            ...(dto.companyName != null ? { companyName: dto.companyName } : {}),
            ...(dto.phone != null ? { phone: dto.phone } : {}),
            ...(dto.personalNumber != null ? { personalNumber: dto.personalNumber } : {}),
            ...(dto.orgNumber != null ? { orgNumber: dto.orgNumber } : {}),
            ...(dto.street != null ? { street: dto.street } : {}),
            ...(dto.city != null ? { city: dto.city } : {}),
            ...(dto.postalCode != null ? { postalCode: dto.postalCode } : {}),
          },
        })

        const lease = await tx.lease.create({
          data: {
            organizationId,
            unitId: dto.lease.unitId,
            tenantId: tenant.id,
            startDate: new Date(dto.lease.startDate),
            ...(dto.lease.endDate != null ? { endDate: new Date(dto.lease.endDate) } : {}),
            monthlyRent: dto.lease.monthlyRent,
            depositAmount: dto.lease.depositAmount ?? 0,
            status: 'DRAFT',
          },
        })

        return { tenant, lease }
      })
    } catch (err) {
      // P2002 = unique constraint violation. Race-skydd för dubblett-check
      // ovan om två förfrågningar skapar samma e-post samtidigt.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const target = (err.meta as { target?: unknown } | undefined)?.target
        if (Array.isArray(target) && target.includes('email')) {
          throw new BadRequestException(
            'En hyresgäst med denna e-postadress finns redan i organisationen',
          )
        }
        throw new BadRequestException('Konflikt vid skapande – försök igen')
      }
      throw err
    }

    // Tenant skapas utan portalkonto — välkomstmejl med aktiveringslänk
    // skickas först när det första kontraktet aktiveras (lease → ACTIVE).
    return mapTenant(result.tenant)
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

    // Blockera om hyresgästen har aktiva eller pågående kontrakt – dessa måste
    // avslutas via /v1/leases först.
    const blockingLeaseCount = await this.prisma.lease.count({
      where: { tenantId: id, status: { in: ['ACTIVE', 'DRAFT'] } },
    })
    if (blockingLeaseCount > 0) {
      throw new BadRequestException(
        'Hyresgästen har aktiva eller pågående kontrakt och kan inte tas bort.',
      )
    }

    const activeInvoiceCount = await this.prisma.invoice.count({
      where: { tenantId: id, status: { notIn: ['VOID', 'DRAFT'] } },
    })
    if (activeInvoiceCount > 0) {
      throw new BadRequestException('Hyresgästen har aktiva fakturor och kan inte tas bort.')
    }

    await this.prisma.tenant.delete({ where: { id } })
  }
}
