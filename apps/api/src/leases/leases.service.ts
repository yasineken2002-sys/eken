import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common'
import type { LeaseStatus } from '@prisma/client'
import { PrismaService } from '../common/prisma/prisma.service'
import { CreateLeaseDto } from './dto/create-lease.dto'
import { UpdateLeaseDto } from './dto/update-lease.dto'
import { CreateLeaseWithTenantDto } from './dto/create-lease-with-tenant.dto'

const VALID_TRANSITIONS: Partial<Record<LeaseStatus, LeaseStatus[]>> = {
  DRAFT: ['ACTIVE', 'TERMINATED'],
  ACTIVE: ['EXPIRED', 'TERMINATED'],
}

const INCLUDE = {
  unit: { include: { property: true } },
  tenant: true,
} as const

@Injectable()
export class LeasesService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(organizationId: string) {
    return this.prisma.lease.findMany({
      where: { organizationId },
      include: INCLUDE,
      orderBy: { createdAt: 'desc' },
    })
  }

  async findOne(id: string, organizationId: string) {
    const lease = await this.prisma.lease.findFirst({
      where: { id, organizationId },
      include: INCLUDE,
    })
    if (!lease) throw new NotFoundException('Kontraktet hittades inte')
    return lease
  }

  async create(dto: CreateLeaseDto, organizationId: string) {
    // Verify unit belongs to this organization
    const unit = await this.prisma.unit.findFirst({
      where: { id: dto.unitId },
      include: { property: true },
    })
    if (!unit || unit.property.organizationId !== organizationId) {
      throw new NotFoundException('Enheten hittades inte')
    }

    // Verify tenant belongs to this organization
    const tenant = await this.prisma.tenant.findFirst({
      where: { id: dto.tenantId, organizationId },
    })
    if (!tenant) throw new NotFoundException('Hyresgästen hittades inte')

    // Check for existing ACTIVE lease on this unit
    const existingActive = await this.prisma.lease.count({
      where: { unitId: dto.unitId, status: 'ACTIVE' },
    })
    if (existingActive > 0) {
      throw new BadRequestException('Enheten har redan ett aktivt kontrakt')
    }

    return this.prisma.lease.create({
      data: {
        organizationId,
        unitId: dto.unitId,
        tenantId: dto.tenantId,
        startDate: new Date(dto.startDate),
        ...(dto.endDate != null ? { endDate: new Date(dto.endDate) } : {}),
        monthlyRent: dto.monthlyRent,
        depositAmount: dto.depositAmount ?? 0,
        status: 'DRAFT',
      },
      include: INCLUDE,
    })
  }

  async update(id: string, dto: UpdateLeaseDto, organizationId: string) {
    const existing = await this.findOne(id, organizationId)

    if (existing.status !== 'DRAFT' && existing.status !== 'ACTIVE') {
      throw new BadRequestException('Kontraktet kan inte redigeras i nuvarande status')
    }

    return this.prisma.lease.update({
      where: { id },
      data: {
        ...(dto.unitId != null ? { unitId: dto.unitId } : {}),
        ...(dto.tenantId != null ? { tenantId: dto.tenantId } : {}),
        ...(dto.startDate != null ? { startDate: new Date(dto.startDate) } : {}),
        ...(dto.endDate != null ? { endDate: new Date(dto.endDate) } : {}),
        ...(dto.monthlyRent != null ? { monthlyRent: dto.monthlyRent } : {}),
        ...(dto.depositAmount != null ? { depositAmount: dto.depositAmount } : {}),
      },
      include: INCLUDE,
    })
  }

  async transitionStatus(id: string, newStatus: LeaseStatus, organizationId: string) {
    const lease = await this.findOne(id, organizationId)
    const allowed = VALID_TRANSITIONS[lease.status] ?? []

    if (!allowed.includes(newStatus)) {
      throw new BadRequestException('Ogiltig statusövergång')
    }

    return this.prisma.lease.update({
      where: { id },
      data: { status: newStatus },
      include: INCLUDE,
    })
  }

  async createWithTenant(dto: CreateLeaseWithTenantDto, organizationId: string) {
    // 1. Verify unit belongs to this organization
    const unit = await this.prisma.unit.findFirst({
      where: { id: dto.unitId },
      include: { property: true },
    })
    if (!unit || unit.property.organizationId !== organizationId) {
      throw new NotFoundException('Enheten hittades inte')
    }

    // 2. Check unit has no ACTIVE lease
    const existingActive = await this.prisma.lease.count({
      where: { unitId: dto.unitId, status: 'ACTIVE' },
    })
    if (existingActive > 0) {
      throw new BadRequestException('Enheten har redan ett aktivt kontrakt')
    }

    // 3. Resolve tenant
    let tenantId: string

    if (dto.existingTenantId) {
      const tenant = await this.prisma.tenant.findFirst({
        where: { id: dto.existingTenantId, organizationId },
      })
      if (!tenant) throw new NotFoundException('Hyresgästen hittades inte')
      tenantId = tenant.id
    } else if (dto.newTenant) {
      const { type, firstName, lastName, companyName, email, phone } = dto.newTenant

      if (type === 'INDIVIDUAL' && (!firstName?.trim() || !lastName?.trim())) {
        throw new BadRequestException('Förnamn och efternamn krävs för privatperson')
      }
      if (type === 'COMPANY' && !companyName?.trim()) {
        throw new BadRequestException('Företagsnamn krävs för företag')
      }

      const created = await this.prisma.tenant.create({
        data: {
          organizationId,
          type,
          email,
          ...(firstName ? { firstName } : {}),
          ...(lastName ? { lastName } : {}),
          ...(companyName ? { companyName } : {}),
          ...(phone ? { phone } : {}),
        },
      })
      tenantId = created.id
    } else {
      throw new BadRequestException(
        'Ange antingen en befintlig hyresgäst eller uppgifter för en ny',
      )
    }

    // 4. Create lease
    return this.prisma.lease.create({
      data: {
        organizationId,
        unitId: dto.unitId,
        tenantId,
        monthlyRent: dto.monthlyRent,
        depositAmount: dto.depositAmount ?? 0,
        startDate: new Date(dto.startDate),
        ...(dto.endDate ? { endDate: new Date(dto.endDate) } : {}),
        status: 'DRAFT',
      },
      include: INCLUDE,
    })
  }

  async remove(id: string, organizationId: string): Promise<void> {
    const lease = await this.findOne(id, organizationId)

    if (lease.status !== 'DRAFT') {
      throw new BadRequestException('Endast utkast kan tas bort')
    }

    await this.prisma.lease.delete({ where: { id } })
  }
}
