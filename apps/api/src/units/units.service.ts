import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common'
import { PrismaService } from '../common/prisma/prisma.service'
import { CreateUnitDto } from './dto/create-unit.dto'
import { UpdateUnitDto } from './dto/update-unit.dto'
import { SAFE_TENANT_SELECT } from '../tenants/tenants.service'

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
          include: { tenant: { select: SAFE_TENANT_SELECT } },
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

    // ── ATT FLYTTA ETT OBJEKT MELLAN FASTIGHETER ÄR INGEN STÖDD OPERATION ────
    //
    // `propertyId` går igenom hela kontraktskedjan — `UpdateUnitSchema` är
    // `CreateUnitSchema.partial()`, `UpdateUnitDto` ärver fältet via
    // `PartialType`, och pipens `whitelist` strippar det INTE eftersom DTO:n
    // känner det. Fram till den här raden mappades det ändå aldrig ned i
    // `data` nedan, så ett byte svarade 200 OK, ekade tillbaka den GAMLA
    // fastigheten och lämnade raden orörd. Hyresvärden fick alltså besked om
    // att flytten gått igenom, och den hade aldrig skett.
    //
    // Rättningen är en avvisning och INTE en assignment, därför att en flytt
    // inte är en befintlig operation med garantier att bevara: ingen skrivväg
    // i kodbasen rör `Unit.propertyId` efter create (de enda två update-vägarna
    // mot en befintlig rad är den här och `unit-status.sync.ts`, som bara rör
    // `status`). Att lägga till raden hade infört ny funktion med följder som
    // ingen ännu beslutat om:
    //
    //   • `UnitEquipment` bär en NOT NULL `propertyId` vid sidan av `unitId`,
    //     och schemat skriver ut invarianten: en satt `unitId` pekar på en
    //     enhet i SAMMA fastighet som `propertyId`. En FK kan inte uttrycka
    //     det, och `unit-equipment.db.spec.ts` prövar det med negativ kontroll.
    //     En flytt här hade brutit den tyst.
    //   • Samma denormalisering finns på `Document`, `Inspection`,
    //     `MaintenanceTicket` och `AiAssignment` — alla stämplade vid
    //     skapandet. Historiken hade delats i två utan att något syns.
    //   • Intäkt per fastighet (`monthly-report.service.ts`) och tariffen för
    //     förbrukning (`consumption.service.ts`) härleds vid LÄSNING ur
    //     `unit.propertyId`. En flytt skriver om redan fakturerade månader.
    //   • `@@unique([propertyId, unitNumber])` hade gett ett rått `P2002`, och
    //     målfastighetens organisation prövas ingenstans här — bara enhetens.
    //
    // Fältet får inte lova en ändring som ignoreras. Ett OFÖRÄNDRAT värde
    // släpps däremot igenom: webbformuläret skickar alltid `propertyId`
    // (`UnitForm.tsx:89`), och med `forbidNonWhitelisted: true` hade ett
    // borttaget DTO-fält gjort varje vanlig redigering till ett 400.
    if (dto.propertyId != null && dto.propertyId !== unit.propertyId) {
      throw new BadRequestException(
        'Objektet kan inte flyttas till en annan fastighet. ' +
          'Fastighetstillhörigheten sätts när objektet skapas.',
      )
    }

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
