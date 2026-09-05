import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../common/prisma/prisma.service'
import { assertNoEquipmentCycle } from '../history/equipment-chain'
import { CreateEquipmentDto } from './dto/create-equipment.dto'
import { UpdateEquipmentDto } from './dto/update-equipment.dto'
import { RegisterReplacementDto } from './dto/register-replacement.dto'
import { CorrectEventDto } from './dto/correct-event.dto'

/**
 * SKRIVVÄGEN FÖR UTRUSTNING OCH BYTEN (etapp 1b).
 *
 * Läsvägen fanns sedan tidigare: `history-sources.registry.ts` svarar
 * `EQUIPMENT_INSTALLED` / `EQUIPMENT_REPLACED` / `EQUIPMENT_REMOVED` på
 * lägenhetens historik. Men INGEN produktionskod skrev raderna — noll
 * `unitEquipment.create` utanför en fixtur och två specar, och noll anropare av
 * `assertNoEquipmentCycle`. Frågan gick att STÄLLA; svaret kunde bara bli tomt.
 *
 * ── VAD SOM ÄR EN HÄNDELSE OCH VAD SOM ÄR ETT TILLSTÅND ────────────────────
 *
 * `UnitEquipment` är ett TILLSTÅND: den här saken sitter här sedan då.
 * `UnitEquipmentEvent` är en HÄNDELSE: append-only, med databastrigger.
 * Etiketten och förväntningarna får ändras (`update`); allt som utgör sakens
 * identitet får det inte, och ett registrerat byte får det aldrig.
 */
@Injectable()
export class EquipmentService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * ORG-SCOPNINGEN ÄR ETT UPPSLAG, INTE ETT FILTER PÅ SVARET.
   *
   * Lägenheten hämtas via sin fastighet, som bär `organizationId`. En annan
   * organisations lägenhet ger `NotFoundException` — inte `Forbidden`, som hade
   * bekräftat att id:t finns.
   */
  private async unitInOrg(unitId: string, organizationId: string) {
    const unit = await this.prisma.unit.findFirst({
      where: { id: unitId, property: { organizationId } },
      select: { id: true, propertyId: true },
    })
    if (!unit) throw new NotFoundException('Lägenheten hittades inte')
    return unit
  }

  private async equipmentInOrg(equipmentId: string, organizationId: string) {
    const eq = await this.prisma.unitEquipment.findFirst({
      where: { id: equipmentId, organizationId },
      select: {
        id: true,
        organizationId: true,
        propertyId: true,
        unitId: true,
        kind: true,
        label: true,
        removedAt: true,
        replacedById: true,
      },
    })
    if (!eq) throw new NotFoundException('Utrustningen hittades inte')
    return eq
  }

  async findByUnit(unitId: string, organizationId: string) {
    await this.unitInOrg(unitId, organizationId)
    return this.prisma.unitEquipment.findMany({
      where: { organizationId, unitId },
      orderBy: [{ removedAt: 'asc' }, { installedAt: 'desc' }],
      select: {
        id: true,
        kind: true,
        label: true,
        installedAt: true,
        removedAt: true,
        replacedById: true,
        expectedLifespanYears: true,
        serviceIntervalMonths: true,
        events: {
          orderBy: { occurredAt: 'desc' },
          select: {
            id: true,
            type: true,
            occurredAt: true,
            note: true,
            cost: true,
            attachmentUrl: true,
            correctsId: true,
            performedBy: { select: { id: true, firstName: true, lastName: true } },
          },
        },
      },
    })
  }

  async create(dto: CreateEquipmentDto, organizationId: string) {
    const unit = await this.unitInOrg(dto.unitId, organizationId)
    const installedAt = new Date(dto.installedAt)

    // SAKEN OCH DESS FÖRSTA HÄNDELSE I SAMMA TRANSAKTION. En utrustning utan
    // INSTALLED-händelse hade varit osynlig i händelseströmmen och synlig i
    // listan — två svar på samma fråga.
    return this.prisma.$transaction(async (tx) => {
      const skapad = await tx.unitEquipment.create({
        data: {
          organizationId,
          propertyId: unit.propertyId,
          unitId: unit.id,
          kind: dto.kind,
          ...(dto.label !== undefined ? { label: dto.label } : {}),
          installedAt,
          ...(dto.expectedLifespanYears !== undefined
            ? { expectedLifespanYears: dto.expectedLifespanYears }
            : {}),
          ...(dto.serviceIntervalMonths !== undefined
            ? { serviceIntervalMonths: dto.serviceIntervalMonths }
            : {}),
        },
        select: { id: true, kind: true, label: true, installedAt: true },
      })
      await tx.unitEquipmentEvent.create({
        data: { equipmentId: skapad.id, type: 'INSTALLED', occurredAt: installedAt },
      })
      return skapad
    })
  }

  /** Bara etikett och förväntningar — se `UpdateEquipmentDto` för vad som INTE går. */
  async update(id: string, dto: UpdateEquipmentDto, organizationId: string) {
    await this.equipmentInOrg(id, organizationId)
    return this.prisma.unitEquipment.update({
      where: { id },
      data: {
        ...(dto.label !== undefined ? { label: dto.label } : {}),
        ...(dto.expectedLifespanYears !== undefined
          ? { expectedLifespanYears: dto.expectedLifespanYears }
          : {}),
        ...(dto.serviceIntervalMonths !== undefined
          ? { serviceIntervalMonths: dto.serviceIntervalMonths }
          : {}),
      },
      select: { id: true, label: true, expectedLifespanYears: true, serviceIntervalMonths: true },
    })
  }

  /**
   * REGISTRERA ETT BYTE. Fyra skrivningar, en transaktion — se DTO:ns docblock.
   */
  async registerReplacement(
    equipmentId: string,
    dto: RegisterReplacementDto,
    organizationId: string,
  ) {
    const gammal = await this.equipmentInOrg(equipmentId, organizationId)

    // ETT REDAN BYTT OBJEKT BYTS INTE IGEN. `replacedById` är `@unique`, så
    // databasen hade avvisat den andra kopplingen ändå — men med ett P2002 som
    // säger "unique constraint" i stället för vad som faktiskt är fel.
    if (gammal.replacedById) {
      throw new BadRequestException(
        'Utrustningen är redan utbytt. Registrera bytet på efterträdaren i stället.',
      )
    }
    if (gammal.removedAt) {
      throw new BadRequestException(
        'Utrustningen är redan borttagen och kan inte bytas ut. Lägg till en ny i stället.',
      )
    }

    const occurredAt = new Date(dto.occurredAt)

    if (dto.performedById) await this.userInOrg(dto.performedById, organizationId)
    if (dto.maintenanceTicketId) {
      const ärende = await this.prisma.maintenanceTicket.findFirst({
        where: { id: dto.maintenanceTicketId, organizationId },
        select: { id: true },
      })
      if (!ärende) throw new NotFoundException('Ärendet hittades inte')
    }

    return this.prisma.$transaction(async (tx) => {
      const ny = await tx.unitEquipment.create({
        data: {
          organizationId,
          propertyId: gammal.propertyId,
          ...(gammal.unitId ? { unitId: gammal.unitId } : {}),
          kind: dto.kind ?? gammal.kind,
          ...(dto.label !== undefined ? { label: dto.label } : {}),
          installedAt: occurredAt,
          // ÄRVS INTE — se DTO:ns docblock.
          ...(dto.expectedLifespanYears !== undefined
            ? { expectedLifespanYears: dto.expectedLifespanYears }
            : {}),
          ...(dto.serviceIntervalMonths !== undefined
            ? { serviceIntervalMonths: dto.serviceIntervalMonths }
            : {}),
        },
        select: { id: true, kind: true, label: true, installedAt: true },
      })

      // CYKELSPÄRREN, anropad från produktionskod för första gången. Den fanns
      // sedan etapp 1b:s läsväg men hade bara sin egen spec som anropare — en
      // mekanism utan anropare är en mekanism som inte skyddar något.
      await assertNoEquipmentCycle(tx, gammal.id, ny.id)

      await tx.unitEquipment.update({
        where: { id: gammal.id },
        data: { removedAt: occurredAt, replacedById: ny.id },
      })

      const händelse = await tx.unitEquipmentEvent.create({
        data: {
          equipmentId: gammal.id,
          type: 'REPLACED',
          occurredAt,
          ...(dto.note !== undefined ? { note: dto.note } : {}),
          ...(dto.performedById !== undefined ? { performedById: dto.performedById } : {}),
          ...(dto.cost !== undefined ? { cost: new Prisma.Decimal(dto.cost) } : {}),
          ...(dto.attachmentUrl !== undefined ? { attachmentUrl: dto.attachmentUrl } : {}),
          ...(dto.maintenanceTicketId !== undefined
            ? { maintenanceTicketId: dto.maintenanceTicketId }
            : {}),
        },
        select: { id: true, type: true, occurredAt: true },
      })

      await tx.unitEquipmentEvent.create({
        data: {
          equipmentId: ny.id,
          type: 'INSTALLED',
          occurredAt,
          ...(dto.performedById !== undefined ? { performedById: dto.performedById } : {}),
        },
      })

      return { replacement: ny, event: händelse }
    })
  }

  /**
   * RÄTTA en registrerad händelse — med en NY händelse, aldrig en UPDATE.
   */
  async correctEvent(equipmentId: string, dto: CorrectEventDto, organizationId: string) {
    await this.equipmentInOrg(equipmentId, organizationId)

    // Originalet måste tillhöra SAMMA utrustning. Utan den kontrollen kunde en
    // rättelse peka på en annan organisations händelse — id:t är det enda som
    // behövs, och `correctsId` bär ingen egen org-kolumn.
    const original = await this.prisma.unitEquipmentEvent.findFirst({
      where: { id: dto.correctsId, equipmentId },
      select: { id: true, type: true, correctedBy: { select: { id: true } } },
    })
    if (!original) throw new NotFoundException('Händelsen hittades inte på den här utrustningen')
    if (original.correctedBy) {
      throw new BadRequestException(
        'Händelsen är redan rättad. Rätta rättelsen i stället — en förgrenad ' +
          'rättelsekedja är ingen rättelse.',
      )
    }
    if (dto.performedById) await this.userInOrg(dto.performedById, organizationId)

    return this.prisma.unitEquipmentEvent.create({
      data: {
        equipmentId,
        // Rättelsen är av SAMMA slag som det den rättar — annars är den inte en
        // rättelse utan en annan händelse.
        type: original.type,
        occurredAt: new Date(dto.occurredAt),
        note: dto.note,
        correctsId: original.id,
        ...(dto.performedById !== undefined ? { performedById: dto.performedById } : {}),
        ...(dto.cost !== undefined ? { cost: new Prisma.Decimal(dto.cost) } : {}),
        ...(dto.attachmentUrl !== undefined ? { attachmentUrl: dto.attachmentUrl } : {}),
      },
      select: { id: true, type: true, occurredAt: true, correctsId: true },
    })
  }

  private async userInOrg(userId: string, organizationId: string) {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, organizationId },
      select: { id: true },
    })
    if (!user) throw new NotFoundException('Användaren hittades inte')
    return user
  }
}
