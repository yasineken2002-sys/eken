import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
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

// Översätt Postgres unique-konflikt på partial index lease_unit_active_unique
// till svensk BadRequest. Detta är skyddet mot race när två förfrågningar
// samtidigt försöker skapa/aktivera ACTIVE-kontrakt på samma enhet.
function isActiveUnitConflict(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) return false
  if (err.code !== 'P2002') return false
  const target = (err.meta as { target?: unknown } | undefined)?.target
  if (typeof target === 'string') return target.includes('lease_unit_active_unique')
  if (Array.isArray(target)) return target.includes('unitId')
  return false
}

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
    const unit = await this.prisma.unit.findFirst({
      where: { id: dto.unitId },
      include: { property: true },
    })
    if (!unit || unit.property.organizationId !== organizationId) {
      throw new NotFoundException('Enheten hittades inte')
    }

    const tenant = await this.prisma.tenant.findFirst({
      where: { id: dto.tenantId, organizationId },
    })
    if (!tenant) throw new NotFoundException('Hyresgästen hittades inte')

    // Optimistic check – DB-constraint fångar race
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

    // Optimistic check innan DRAFT→ACTIVE; partial unique index fångar race.
    if (newStatus === 'ACTIVE') {
      const existingActive = await this.prisma.lease.count({
        where: { unitId: lease.unitId, status: 'ACTIVE', id: { not: id } },
      })
      if (existingActive > 0) {
        throw new BadRequestException('Enheten har redan ett aktivt kontrakt')
      }
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const updated = await tx.lease.update({
          where: { id },
          data: {
            status: newStatus,
            ...(newStatus === 'ACTIVE' ? { signedAt: new Date() } : {}),
            ...(newStatus === 'TERMINATED' ? { terminatedAt: new Date() } : {}),
          },
          include: INCLUDE,
        })

        // Synka enhetens status så att fastighetsöversikten alltid stämmer.
        if (newStatus === 'ACTIVE') {
          await tx.unit.update({ where: { id: lease.unitId }, data: { status: 'OCCUPIED' } })
        } else if (newStatus === 'TERMINATED' || newStatus === 'EXPIRED') {
          // Endast om det inte fortfarande finns ett annat ACTIVE-kontrakt på enheten
          const stillActive = await tx.lease.count({
            where: { unitId: lease.unitId, status: 'ACTIVE', id: { not: id } },
          })
          if (stillActive === 0) {
            await tx.unit.update({ where: { id: lease.unitId }, data: { status: 'VACANT' } })
          }
        }

        return updated
      })
    } catch (err) {
      if (isActiveUnitConflict(err)) {
        throw new BadRequestException('Enheten har redan ett aktivt kontrakt')
      }
      throw err
    }
  }

  async createWithTenant(dto: CreateLeaseWithTenantDto, organizationId: string) {
    const unit = await this.prisma.unit.findFirst({
      where: { id: dto.unitId },
      include: { property: true },
    })
    if (!unit || unit.property.organizationId !== organizationId) {
      throw new NotFoundException('Enheten hittades inte')
    }

    const existingActive = await this.prisma.lease.count({
      where: { unitId: dto.unitId, status: 'ACTIVE' },
    })
    if (existingActive > 0) {
      throw new BadRequestException('Enheten har redan ett aktivt kontrakt')
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        let tenantId: string

        if (dto.existingTenantId) {
          const tenant = await tx.tenant.findFirst({
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

          const created = await tx.tenant.create({
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

        return tx.lease.create({
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
      })
    } catch (err) {
      if (isActiveUnitConflict(err)) {
        throw new BadRequestException('Enheten har redan ett aktivt kontrakt')
      }
      throw err
    }
  }

  async remove(id: string, organizationId: string): Promise<void> {
    const lease = await this.findOne(id, organizationId)

    if (lease.status !== 'DRAFT') {
      throw new BadRequestException('Endast utkast kan tas bort')
    }

    await this.prisma.lease.delete({ where: { id } })
  }
}
