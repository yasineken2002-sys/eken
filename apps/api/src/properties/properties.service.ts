import { Injectable, NotFoundException } from '@nestjs/common'
import type { PrismaService } from '../common/prisma/prisma.service'
import type { CreatePropertyInput, UpdatePropertyInput } from '@eken/shared'

@Injectable()
export class PropertiesService {
  constructor(private prisma: PrismaService) {}

  async findAll(orgId: string) {
    return this.prisma.property.findMany({
      where: { organizationId: orgId },
      include: {
        units: { select: { id: true, unitNumber: true, status: true, monthlyRent: true } },
      },
      orderBy: { name: 'asc' },
    })
  }

  async findOne(id: string, orgId: string) {
    const property = await this.prisma.property.findFirst({
      where: { id, organizationId: orgId },
      include: { units: true },
    })
    if (!property) throw new NotFoundException('Fastigheten hittades inte')
    return property
  }

  async create(orgId: string, dto: CreatePropertyInput) {
    return this.prisma.property.create({
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
        yearBuilt: dto.yearBuilt,
      },
    })
  }

  async update(id: string, orgId: string, dto: UpdatePropertyInput) {
    await this.ensureOwnership(id, orgId)
    return this.prisma.property.update({
      where: { id },
      data: {
        ...(dto.name ? { name: dto.name } : {}),
        ...(dto.propertyDesignation ? { propertyDesignation: dto.propertyDesignation } : {}),
        ...(dto.type ? { type: dto.type } : {}),
        ...(dto.address?.street ? { street: dto.address.street } : {}),
        ...(dto.address?.city ? { city: dto.address.city } : {}),
        ...(dto.address?.postalCode ? { postalCode: dto.address.postalCode } : {}),
        ...(dto.totalArea ? { totalArea: dto.totalArea } : {}),
        ...(dto.yearBuilt ? { yearBuilt: dto.yearBuilt } : {}),
      },
    })
  }

  async remove(id: string, orgId: string) {
    await this.ensureOwnership(id, orgId)
    return this.prisma.property.delete({ where: { id } })
  }

  private async ensureOwnership(id: string, orgId: string) {
    const property = await this.prisma.property.findFirst({ where: { id, organizationId: orgId } })
    if (!property) throw new NotFoundException('Fastigheten hittades inte')
    return property
  }
}
