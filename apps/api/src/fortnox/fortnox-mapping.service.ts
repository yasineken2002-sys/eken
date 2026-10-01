import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common'
import { PrismaService } from '../common/prisma/prisma.service'

const TYPES = ['COST_CENTER', 'PROJECT'] as const
type DimensionType = (typeof TYPES)[number]
const CODE = /^[A-Za-z0-9_-]{1,32}$/

/**
 * Uttrycklig koppling Fortnox-dimension → Eveno-fastighet. Fastigheten måste
 * tillhöra organisationen (kontrolleras server-side); ingen gissning sker någonsin
 * i återläsningen — en okopplad kod redovisas som okopplad.
 */
@Injectable()
export class FortnoxMappingService {
  constructor(private readonly prisma: PrismaService) {}

  async list(organizationId: string) {
    const rows = await this.prisma.fortnoxDimensionMapping.findMany({
      where: { organizationId },
      orderBy: [{ dimensionType: 'asc' }, { code: 'asc' }],
      select: {
        id: true,
        dimensionType: true,
        code: true,
        propertyId: true,
        property: { select: { name: true } },
      },
    })
    return rows.map((r) => ({
      id: r.id,
      dimensionType: r.dimensionType,
      code: r.code,
      propertyId: r.propertyId,
      propertyName: r.property.name,
    }))
  }

  async upsert(
    organizationId: string,
    body: { dimensionType?: unknown; code?: unknown; propertyId?: unknown },
  ) {
    const { dimensionType, code, propertyId } = body ?? {}
    if (
      !TYPES.includes(dimensionType as DimensionType) ||
      typeof code !== 'string' ||
      !CODE.test(code)
    ) {
      throw new BadRequestException('Ogiltig dimension eller kod')
    }
    if (typeof propertyId !== 'string') throw new BadRequestException('Fastighet saknas')
    const property = await this.prisma.property.findFirst({
      where: { id: propertyId, organizationId },
      select: { id: true },
    })
    if (!property) throw new NotFoundException('Fastigheten hittades inte')
    const type = dimensionType as DimensionType
    const row = await this.prisma.fortnoxDimensionMapping.upsert({
      where: { organizationId_dimensionType_code: { organizationId, dimensionType: type, code } },
      create: { organizationId, dimensionType: type, code, propertyId },
      update: { propertyId },
      select: { id: true },
    })
    return { id: row.id }
  }

  async remove(organizationId: string, id: string) {
    const res = await this.prisma.fortnoxDimensionMapping.deleteMany({
      where: { id, organizationId },
    })
    if (res.count !== 1) throw new NotFoundException('Kopplingen hittades inte')
    return { removed: true }
  }
}
