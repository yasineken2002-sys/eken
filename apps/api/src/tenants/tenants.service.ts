import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common'
import type { Tenant } from '@prisma/client'
import type { PrismaService } from '../common/prisma/prisma.service'
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
        email: dto.email,
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
