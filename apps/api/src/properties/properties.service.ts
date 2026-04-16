import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common'
import type { PrismaService } from '../common/prisma/prisma.service'
import type { CreatePropertyInput, UpdatePropertyInput } from '@eken/shared'

type PrismaPropertyWithCount = {
  id: string
  organizationId: string
  name: string
  propertyDesignation: string
  type: string
  street: string
  city: string
  postalCode: string
  country: string
  totalArea: unknown
  yearBuilt: number | null
  createdAt: Date
  updatedAt: Date
  _count: { units: number }
}

type PrismaPropertyWithUnits = PrismaPropertyWithCount & {
  units: {
    id: string
    propertyId: string
    name: string
    unitNumber: string
    type: string
    status: string
    area: unknown
    floor: number | null
    rooms: number | null
    monthlyRent: unknown
    createdAt: Date
    updatedAt: Date
  }[]
}

@Injectable()
export class PropertiesService {
  constructor(private prisma: PrismaService) {}

  async findAll(orgId: string) {
    const rows = await this.prisma.property.findMany({
      where: { organizationId: orgId },
      include: { _count: { select: { units: true } } },
      orderBy: { createdAt: 'desc' },
    })
    return rows.map((r) => this.mapProperty(r as PrismaPropertyWithCount))
  }

  async findOne(id: string, orgId: string) {
    const property = await this.prisma.property.findFirst({
      where: { id, organizationId: orgId },
      include: {
        _count: { select: { units: true } },
        units: { orderBy: { name: 'asc' } },
      },
    })
    if (!property) throw new NotFoundException('Fastigheten hittades inte')
    return this.mapPropertyWithUnits(property as PrismaPropertyWithUnits)
  }

  async create(orgId: string, dto: CreatePropertyInput) {
    const row = await this.prisma.property.create({
      data: {
        organizationId: orgId,
        name: dto.name,
        propertyDesignation: dto.propertyDesignation,
        type: dto.type,
        street: dto.address.street,
        city: dto.address.city,
        postalCode: dto.address.postalCode,
        country: dto.address.country,
        totalArea: dto.totalArea,
        yearBuilt: dto.yearBuilt ?? null,
      },
      include: { _count: { select: { units: true } } },
    })
    return this.mapProperty(row as PrismaPropertyWithCount)
  }

  async update(id: string, orgId: string, dto: UpdatePropertyInput) {
    await this.ensureOwnership(id, orgId)
    const row = await this.prisma.property.update({
      where: { id },
      data: {
        ...(dto.name ? { name: dto.name } : {}),
        ...(dto.propertyDesignation ? { propertyDesignation: dto.propertyDesignation } : {}),
        ...(dto.type ? { type: dto.type } : {}),
        ...(dto.address?.street ? { street: dto.address.street } : {}),
        ...(dto.address?.city ? { city: dto.address.city } : {}),
        ...(dto.address?.postalCode ? { postalCode: dto.address.postalCode } : {}),
        ...(dto.address?.country ? { country: dto.address.country } : {}),
        ...(dto.totalArea ? { totalArea: dto.totalArea } : {}),
        ...(dto.yearBuilt ? { yearBuilt: dto.yearBuilt } : {}),
      },
      include: { _count: { select: { units: true } } },
    })
    return this.mapProperty(row as PrismaPropertyWithCount)
  }

  async remove(id: string, orgId: string): Promise<void> {
    await this.ensureOwnership(id, orgId)

    const unitWithActiveLease = await this.prisma.unit.findFirst({
      where: { propertyId: id, leases: { some: { status: 'ACTIVE' } } },
    })
    if (unitWithActiveLease) {
      throw new BadRequestException('Fastigheten har aktiva kontrakt och kan inte tas bort.')
    }

    await this.prisma.property.delete({ where: { id } })
  }

  private async ensureOwnership(id: string, orgId: string) {
    const property = await this.prisma.property.findFirst({ where: { id, organizationId: orgId } })
    if (!property) throw new NotFoundException('Fastigheten hittades inte')
    return property
  }

  private mapProperty(row: PrismaPropertyWithCount) {
    return {
      id: row.id,
      organizationId: row.organizationId,
      name: row.name,
      propertyDesignation: row.propertyDesignation,
      type: row.type,
      address: {
        street: row.street,
        city: row.city,
        postalCode: row.postalCode,
        country: row.country,
      },
      totalArea: Number(row.totalArea),
      yearBuilt: row.yearBuilt ?? undefined,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      _count: row._count,
    }
  }

  private mapPropertyWithUnits(row: PrismaPropertyWithUnits) {
    return {
      ...this.mapProperty(row),
      units: row.units.map((u) => ({
        id: u.id,
        propertyId: u.propertyId,
        name: u.name,
        unitNumber: u.unitNumber,
        type: u.type,
        status: u.status,
        area: Number(u.area),
        floor: u.floor ?? undefined,
        rooms: u.rooms ?? undefined,
        monthlyRent: Number(u.monthlyRent),
        createdAt: u.createdAt.toISOString(),
        updatedAt: u.updatedAt.toISOString(),
      })),
    }
  }
}
