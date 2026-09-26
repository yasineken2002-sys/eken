import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common'
import { PrismaService } from '../common/prisma/prisma.service'
import { CreateUnitDto } from './dto/create-unit.dto'
import { UpdateUnitDto } from './dto/update-unit.dto'
import { SAFE_TENANT_SELECT } from '../tenants/tenants.service'
import { frivilligSkattskyldighetPaverkarSatsen, type UnitType } from '@eken/shared'

/**
 * I2 — `voluntaryTaxLiability: true` får bara sparas på en typ där flaggan
 * påverkar momsregelns sats. Predikatet är härlett ur `vatRateForRent`, så
 * den här raden inför ingen egen skatteregel: den hindrar bara ett värde som
 * regeln ändå skulle ignorera, i stället för att spara det tyst. Bostadens och
 * parkeringens moms är oförändrad.
 */
function kontrolleraFrivilligSkattskyldighet(type: UnitType, flagga: boolean): void {
  if (flagga && !frivilligSkattskyldighetPaverkarSatsen(type)) {
    throw new BadRequestException(
      'Frivillig skattskyldighet kan bara anges för lokaler, förråd och övriga objekt. ' +
        'För bostad och parkering påverkar den inte momsen — ta bort markeringen.',
    )
  }
}

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

    kontrolleraFrivilligSkattskyldighet(dto.type, dto.voluntaryTaxLiability ?? false)

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
        ...(dto.voluntaryTaxLiability !== undefined
          ? { voluntaryTaxLiability: dto.voluntaryTaxLiability }
          : {}),
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
    // `!= null` HÄR FÖRUTSÄTTER DTO:NS NULL-AVVISNING.
    //
    // Jämförelsen släpper igenom `null` med flit: efter
    // `PartialType(CreateUnitDto, { skipNullProperties: false })` kan ett
    // uttryckligt `null` inte nå hit via HTTP — pipen fäller det på `@IsUUID()`
    // innan controllern körs. Typen säger också `string | undefined`, så en
    // runtime-koll mot `null` hade krävt en cast för något som inte kan hända.
    //
    // Det som gör det säkert är att vägen hit är EN: `units.controller.ts:49`,
    // och den går genom pipen. Det finns inget `update_unit`-AI-verktyg och
    // ingen annan intern anropare. Införs en sådan — ett verktyg, ett jobb, en
    // importväg — går den förbi DTO:n, och då måste den här raden bära
    // null-fallet själv. Grinden är alltså inte fristående, och den som lägger
    // till en andra anropare ska läsa den här kommentaren som ett villkor.
    if (dto.propertyId != null && dto.propertyId !== unit.propertyId) {
      throw new BadRequestException(
        'Objektet kan inte flyttas till en annan fastighet. ' +
          'Fastighetstillhörigheten sätts när objektet skapas.',
      )
    }

    // I2 — prövas bara när anropet rör typ eller flagga, mot det TILLSTÅND
    // raden får efter skrivningen. En äldre rad (t.ex. bostad med flaggan satt
    // via ett DB-ingrepp) låser därför inte redigering av andra fält; regeln
    // ignorerar flaggan för den typen ändå.
    if (dto.type !== undefined || dto.voluntaryTaxLiability !== undefined) {
      kontrolleraFrivilligSkattskyldighet(
        dto.type ?? unit.type,
        dto.voluntaryTaxLiability ?? unit.voluntaryTaxLiability,
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
        ...(dto.voluntaryTaxLiability !== undefined
          ? { voluntaryTaxLiability: dto.voluntaryTaxLiability }
          : {}),
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
