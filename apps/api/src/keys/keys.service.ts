import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common'
import type { KeyHandover, KeyStatus, Prisma } from '@prisma/client'
import { PrismaService } from '../common/prisma/prisma.service'
import { SAFE_TENANT_SELECT } from '../tenants/tenants.service'
import { IssueKeysDto } from './dto/issue-keys.dto'
import { ReturnKeyDto } from './dto/return-key.dto'
import { UpdateKeyDto } from './dto/update-key.dto'

const INCLUDE = {
  tenant: { select: SAFE_TENANT_SELECT },
  unit: { select: { id: true, name: true, unitNumber: true } },
} as const

@Injectable()
export class KeysService {
  private readonly logger = new Logger(KeysService.name)

  constructor(private readonly prisma: PrismaService) {}

  // ── Läsning ─────────────────────────────────────────────────────────────────

  async findAll(
    organizationId: string,
    filters?: { leaseId?: string; unitId?: string; status?: KeyStatus },
  ): Promise<KeyHandover[]> {
    return this.prisma.keyHandover.findMany({
      where: {
        organizationId,
        ...(filters?.leaseId ? { leaseId: filters.leaseId } : {}),
        ...(filters?.unitId ? { unitId: filters.unitId } : {}),
        ...(filters?.status ? { status: filters.status } : {}),
      },
      include: INCLUDE,
      // Utlämnade först (kräver åtgärd), därefter senast utlämnad överst.
      orderBy: [{ status: 'asc' }, { issuedAt: 'desc' }],
    })
  }

  async findOne(id: string, organizationId: string): Promise<KeyHandover> {
    const key = await this.prisma.keyHandover.findFirst({
      where: { id, organizationId },
      include: INCLUDE,
    })
    if (!key) throw new NotFoundException('Nyckeln hittades inte')
    return key
  }

  /** Antal ej återlämnade nycklar (status ISSUED) för ett avtal — driver den
   *  mjuka påminnelse-badgen "X nycklar ej återlämnade". */
  async countOpenForLease(leaseId: string, organizationId: string): Promise<number> {
    return this.prisma.keyHandover.count({
      where: { leaseId, organizationId, status: 'ISSUED' },
    })
  }

  // ── Bulk-utlämning (N rader i EN transaktion) ───────────────────────────────

  async issue(dto: IssueKeysDto, organizationId: string, userId: string): Promise<KeyHandover[]> {
    const lease = await this.prisma.lease.findFirst({
      where: { id: dto.leaseId, organizationId },
      select: { id: true, unitId: true, tenantId: true },
    })
    if (!lease) throw new NotFoundException('Hyresavtalet hittades inte')

    const issuedAt = dto.issuedAt ? new Date(dto.issuedAt) : new Date()

    const data: Prisma.KeyHandoverUncheckedCreateInput = {
      organizationId,
      leaseId: lease.id,
      unitId: lease.unitId,
      tenantId: lease.tenantId,
      type: dto.type,
      status: 'ISSUED',
      issuedAt,
      issuedById: userId,
      ...(dto.label ? { label: dto.label } : {}),
      ...(dto.issuedToName ? { issuedToName: dto.issuedToName } : {}),
      ...(dto.notes ? { notes: dto.notes } : {}),
    }

    // En rad per fysisk nyckel. Individuella creates inom EN transaktion ger
    // tillbaka de exakta raderna med id (createMany returnerar inga rader) och
    // håller bulk-utlämningen atomär — allt eller inget.
    const created = await this.prisma.$transaction((tx) =>
      Promise.all(
        Array.from({ length: dto.quantity }, () =>
          tx.keyHandover.create({ data, include: INCLUDE }),
        ),
      ),
    )

    this.logger.log(
      `[keys] ISSUED ${created.length}× ${dto.type} lease=${lease.id} org=${organizationId}`,
    )
    return created
  }

  // ── Återlämning (append-only: sätter returnedAt, raderar aldrig) ────────────

  async returnKey(
    id: string,
    dto: ReturnKeyDto,
    organizationId: string,
    userId: string,
  ): Promise<KeyHandover> {
    const key = await this.findOne(id, organizationId)
    if (key.status !== 'ISSUED') {
      throw new BadRequestException('Endast utlämnade nycklar kan återlämnas')
    }

    const returnedAt = dto.returnedAt ? new Date(dto.returnedAt) : new Date()
    if (returnedAt.getTime() < key.issuedAt.getTime()) {
      throw new BadRequestException('Återlämningsdatum kan inte vara före utlämningsdatum')
    }

    return this.prisma.keyHandover.update({
      where: { id },
      data: {
        status: 'RETURNED',
        returnedAt,
        receivedById: userId,
        ...(dto.notes ? { notes: dto.notes } : {}),
      },
      include: INCLUDE,
    })
  }

  // ── Statusbyte (LOST/REPLACED) + redigering av metadata ─────────────────────

  async update(id: string, dto: UpdateKeyDto, organizationId: string): Promise<KeyHandover> {
    const key = await this.findOne(id, organizationId)

    if (dto.status) {
      // En återlämnad nyckel är låst — den är fysiskt tillbaka och utgör bevis.
      if (key.status === 'RETURNED') {
        throw new BadRequestException('En återlämnad nyckel kan inte ändras')
      }
    }

    const data: Prisma.KeyHandoverUpdateInput = {
      ...(dto.status ? { status: dto.status } : {}),
      ...(dto.type ? { type: dto.type } : {}),
      ...(dto.label !== undefined ? { label: dto.label } : {}),
      ...(dto.issuedToName !== undefined ? { issuedToName: dto.issuedToName } : {}),
      ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
    }

    return this.prisma.keyHandover.update({ where: { id }, data, include: INCLUDE })
  }
}
