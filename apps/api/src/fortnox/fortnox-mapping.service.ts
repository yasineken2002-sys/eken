import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { PrismaService } from '../common/prisma/prisma.service'
import { FortnoxConnectionService, FortnoxNotConnectedError } from './fortnox-connection.service'
import { RefreshingLedgerReader } from './fortnox-readback.service'
import { FORTNOX_LEDGER_READER, FortnoxReadError, type FortnoxLedgerReader } from './fortnox.types'

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
  constructor(
    private readonly prisma: PrismaService,
    private readonly connections: FortnoxConnectionService,
    @Inject(FORTNOX_LEDGER_READER) private readonly reader: FortnoxLedgerReader,
  ) {}

  /**
   * Dimensionen måste finnas i det ANSLUTNA Fortnox-företaget i samma stund som
   * kopplingen sparas (detaljläsning, inte klientens katalogkopia).
   */
  private async assertDimensionExists(organizationId: string, type: DimensionType, code: string) {
    let auth: Awaited<ReturnType<FortnoxConnectionService['accessToken']>>
    try {
      auth = await this.connections.accessToken(organizationId)
    } catch (err) {
      if (err instanceof FortnoxNotConnectedError)
        throw new ConflictException('Fortnox är inte anslutet')
      throw err
    }
    const path =
      type === 'COST_CENTER'
        ? `/3/costcenters/${code}`
        : /^\d{1,9}$/.test(code)
          ? `/3/projects/${code}`
          : null
    if (!path) throw new BadRequestException('Ogiltig projektkod')
    try {
      const body = await new RefreshingLedgerReader(
        this.reader,
        this.connections,
        organizationId,
        auth,
      ).get<{
        CostCenter?: { Code?: unknown }
        Project?: { ProjectNumber?: unknown }
      }>(auth.token, path)
      const got = type === 'COST_CENTER' ? body?.CostCenter?.Code : body?.Project?.ProjectNumber
      if (String(got ?? '') !== code) throw new FortnoxReadError('invalid')
    } catch (err) {
      if (err instanceof FortnoxReadError) {
        if (err.kind === 'auth') {
          await this.connections.markAuthLost(organizationId, 'READ_UNAUTHORIZED')
          throw new ConflictException('Fortnox-inloggningen har upphört; anslut igen')
        }
        if (err.kind === 'invalid')
          throw new BadRequestException('Dimensionen finns inte i Fortnox')
        throw new ConflictException('Fortnox kunde inte läsas just nu; försök igen')
      }
      throw err
    }
  }

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
    await this.assertDimensionExists(organizationId, type, code)
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
