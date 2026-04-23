import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common'
import { PrismaService } from '../common/prisma/prisma.service'
import { CreateUnitDto } from './dto/create-unit.dto'
import { UpdateUnitDto } from './dto/update-unit.dto'

@Injectable()
export class UnitsService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(organizationId: string, propertyId?: string) {
    return this.prisma.unit.findMany({
      where: {
        property: { organizationId },
        ...(propertyId ? { propertyId } : {}),
      },
      include: {
        property: { select: { id: true, name: true } },
        _count: { select: { leases: true } },
      },
      orderBy: { unitNumber: 'asc' },
    })
  }

  async findOne(id: string, organizationId: string) {
    const unit = await this.prisma.unit.findFirst({
      where: { id, property: { organizationId } },
      include: {
        property: { select: { id: true, name: true } },
        leases: {
          include: { tenant: true },
          orderBy: { createdAt: 'desc' },
        },
        _count: { select: { leases: true } },
      },
    })
    if (!unit) throw new NotFoundException('Enheten hittades inte')
    return unit
  }

  async create(dto: CreateUnitDto, organizationId: string) {
    const property = await this.prisma.property.findFirst({
      where: { id: dto.propertyId, organizationId },
    })
    if (!property) throw new NotFoundException('Fastigheten hittades inte')

    const existing = await this.prisma.unit.findFirst({
      where: { propertyId: dto.propertyId, unitNumber: dto.unitNumber },
    })
    if (existing) {
      throw new BadRequestException('Enhetsnummer används redan i denna fastighet')
    }

    return this.prisma.unit.create({
      data: {
        propertyId: dto.propertyId,
        name: dto.name,
        unitNumber: dto.unitNumber,
        type: dto.type,
        status: dto.status ?? 'VACANT',
        area: dto.area,
        ...(dto.floor != null ? { floor: dto.floor } : {}),
        ...(dto.rooms != null ? { rooms: dto.rooms } : {}),
        monthlyRent: dto.monthlyRent,
      },
      include: {
        property: { select: { id: true, name: true } },
        _count: { select: { leases: true } },
      },
    })
  }

  async update(id: string, dto: UpdateUnitDto, organizationId: string) {
    const unit = await this.prisma.unit.findFirst({
      where: { id, property: { organizationId } },
    })
    if (!unit) throw new NotFoundException('Enheten hittades inte')

    return this.prisma.unit.update({
      where: { id },
      data: {
        ...(dto.name != null ? { name: dto.name } : {}),
        ...(dto.unitNumber != null ? { unitNumber: dto.unitNumber } : {}),
        ...(dto.type != null ? { type: dto.type } : {}),
        ...(dto.status != null ? { status: dto.status } : {}),
        ...(dto.area != null ? { area: dto.area } : {}),
        ...(dto.floor != null ? { floor: dto.floor } : {}),
        ...(dto.rooms != null ? { rooms: dto.rooms } : {}),
        ...(dto.monthlyRent != null ? { monthlyRent: dto.monthlyRent } : {}),
      },
      include: {
        property: { select: { id: true, name: true } },
        _count: { select: { leases: true } },
      },
    })
  }

  async remove(id: string, organizationId: string): Promise<void> {
    const unit = await this.prisma.unit.findFirst({
      where: { id, property: { organizationId } },
    })
    if (!unit) throw new NotFoundException('Enheten hittades inte')

    const activeLeaseCount = await this.prisma.lease.count({
      where: { unitId: id, status: 'ACTIVE' },
    })
    if (activeLeaseCount > 0) {
      throw new BadRequestException('Enheten har ett aktivt kontrakt och kan inte tas bort.')
    }

    await this.prisma.unit.delete({ where: { id } })
  }
}
