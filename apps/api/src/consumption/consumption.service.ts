import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common'
import type {
  Meter,
  MeterStatus,
  MeterReading,
  ConsumptionTariff,
  ConsumptionCharge,
  ConsumptionChargeStatus,
  ConsumptionBillingMode,
  ConsumptionVatStatus,
  ReadingType,
} from '@prisma/client'
import { PrismaService } from '../common/prisma/prisma.service'
import { AccountingService, vatRateForRent } from '../accounting/accounting.service'
import { CreateMeterDto } from './dto/create-meter.dto'
import { UpdateMeterDto } from './dto/update-meter.dto'
import { CreateTariffDto } from './dto/create-tariff.dto'
import { RecordReadingDto } from './dto/record-reading.dto'

// Avrundning till ören (2 decimaler) — samma stil som övriga belopp i koden
// (Number-baserad; charge-beloppen är aldrig större än en månads förbrukning).
function round2(n: number): number {
  return Math.round(n * 100) / 100
}

const CHARGE_INCLUDE = {
  lease: { select: { id: true } },
  tenant: { select: { id: true, firstName: true, lastName: true, companyName: true } },
  meterReading: {
    select: { id: true, value: true, readingType: true, periodStart: true, periodEnd: true },
  },
} as const

@Injectable()
export class ConsumptionService {
  private readonly logger = new Logger(ConsumptionService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly accounting: AccountingService,
  ) {}

  // ══ Mätare (Meter) ══════════════════════════════════════════════════════════

  async createMeter(dto: CreateMeterDto, organizationId: string): Promise<Meter> {
    // Org-scoping: enheten måste tillhöra anroparens organisation (via property).
    const unit = await this.prisma.unit.findFirst({
      where: { id: dto.unitId, property: { organizationId } },
      select: { id: true },
    })
    if (!unit) throw new NotFoundException('Enheten hittades inte')

    return this.prisma.meter.create({
      data: {
        organizationId,
        unitId: dto.unitId,
        type: dto.type,
        unitOfMeasure: dto.unitOfMeasure,
        ...(dto.serialNumber ? { serialNumber: dto.serialNumber } : {}),
        ...(dto.provider ? { provider: dto.provider } : {}),
        ...(dto.externalId ? { externalId: dto.externalId } : {}),
        ...(dto.installedAt ? { installedAt: new Date(dto.installedAt) } : {}),
      },
    })
  }

  async findMeters(
    organizationId: string,
    filters?: { unitId?: string; status?: MeterStatus },
  ): Promise<Meter[]> {
    return this.prisma.meter.findMany({
      where: {
        organizationId,
        ...(filters?.unitId ? { unitId: filters.unitId } : {}),
        ...(filters?.status ? { status: filters.status } : {}),
      },
      orderBy: { createdAt: 'desc' },
    })
  }

  async findMeter(id: string, organizationId: string): Promise<Meter> {
    const meter = await this.prisma.meter.findFirst({ where: { id, organizationId } })
    if (!meter) throw new NotFoundException('Mätaren hittades inte')
    return meter
  }

  async updateMeter(id: string, dto: UpdateMeterDto, organizationId: string): Promise<Meter> {
    await this.findMeter(id, organizationId)
    return this.prisma.meter.update({
      where: { id },
      data: {
        ...(dto.status ? { status: dto.status } : {}),
        ...(dto.serialNumber !== undefined ? { serialNumber: dto.serialNumber } : {}),
        ...(dto.provider !== undefined ? { provider: dto.provider } : {}),
        ...(dto.externalId !== undefined ? { externalId: dto.externalId } : {}),
        ...(dto.removedAt ? { removedAt: new Date(dto.removedAt) } : {}),
      },
    })
  }

  // ══ Tariffer (ConsumptionTariff) ════════════════════════════════════════════

  async createTariff(dto: CreateTariffDto, organizationId: string): Promise<ConsumptionTariff> {
    if (dto.scope === 'UNIT' && !dto.unitId) {
      throw new BadRequestException('UNIT-tariff kräver unitId')
    }
    if (dto.scope === 'PROPERTY' && !dto.propertyId) {
      throw new BadRequestException('PROPERTY-tariff kräver propertyId')
    }

    // Org-scoping av scope-målet.
    if (dto.unitId) {
      const unit = await this.prisma.unit.findFirst({
        where: { id: dto.unitId, property: { organizationId } },
        select: { id: true },
      })
      if (!unit) throw new NotFoundException('Enheten hittades inte')
    }
    if (dto.propertyId) {
      const property = await this.prisma.property.findFirst({
        where: { id: dto.propertyId, organizationId },
        select: { id: true },
      })
      if (!property) throw new NotFoundException('Fastigheten hittades inte')
    }

    const validFrom = new Date(dto.validFrom)
    // Historik: stäng den tidigare gällande tariffen (validTo=null) för samma
    // scope/mål/meterType dagen innan den nya börjar gälla. Priset uppdateras
    // aldrig in-place — varje prisändring blir en ny rad.
    const dayBefore = new Date(validFrom)
    dayBefore.setUTCDate(dayBefore.getUTCDate() - 1)

    return this.prisma.$transaction(async (tx) => {
      await tx.consumptionTariff.updateMany({
        where: {
          organizationId,
          scope: dto.scope,
          meterType: dto.meterType,
          propertyId: dto.propertyId ?? null,
          unitId: dto.unitId ?? null,
          validTo: null,
        },
        data: { validTo: dayBefore },
      })

      return tx.consumptionTariff.create({
        data: {
          organizationId,
          scope: dto.scope,
          meterType: dto.meterType,
          pricePerUnit: dto.pricePerUnit,
          validFrom,
          ...(dto.propertyId ? { propertyId: dto.propertyId } : {}),
          ...(dto.unitId ? { unitId: dto.unitId } : {}),
          ...(dto.fixedMonthlyFee !== undefined ? { fixedMonthlyFee: dto.fixedMonthlyFee } : {}),
        },
      })
    })
  }

  async findTariffs(
    organizationId: string,
    filters?: { meterType?: ConsumptionTariff['meterType']; scope?: ConsumptionTariff['scope'] },
  ): Promise<ConsumptionTariff[]> {
    return this.prisma.consumptionTariff.findMany({
      where: {
        organizationId,
        ...(filters?.meterType ? { meterType: filters.meterType } : {}),
        ...(filters?.scope ? { scope: filters.scope } : {}),
      },
      orderBy: [{ meterType: 'asc' }, { validFrom: 'desc' }],
    })
  }

  // Upplöser gällande tariff för (mätartyp, enhet/fastighet) vid ett datum.
  // Specificitet: UNIT > PROPERTY > ORGANIZATION. Datumet är normalt mätperiodens
  // slut (periodEnd) så att priset som gällde under perioden används.
  private async resolveTariff(
    organizationId: string,
    unitId: string,
    propertyId: string,
    meterType: ConsumptionTariff['meterType'],
    atDate: Date,
  ): Promise<ConsumptionTariff | null> {
    const tariffs = await this.prisma.consumptionTariff.findMany({
      where: {
        organizationId,
        meterType,
        validFrom: { lte: atDate },
        OR: [{ validTo: null }, { validTo: { gte: atDate } }],
      },
    })
    return (
      tariffs.find((t) => t.scope === 'UNIT' && t.unitId === unitId) ??
      tariffs.find((t) => t.scope === 'PROPERTY' && t.propertyId === propertyId) ??
      tariffs.find((t) => t.scope === 'ORGANIZATION') ??
      null
    )
  }

  // ══ Avläsningar → DRAFT-charges (intake) ════════════════════════════════════
  //
  // EN källagnostisk väg. Skapar alltid mätunderlaget (append-only) och, när
  // avläsningen är debiterbar, en ConsumptionCharge i status DRAFT. PR 2 STANNAR
  // här: inget verifikat, ingen 1510-fordran, inget på avi/faktura (PR 3/PR 4).

  async recordReading(
    dto: RecordReadingDto,
    organizationId: string,
    userId: string,
  ): Promise<{ reading: MeterReading; charge: ConsumptionCharge | null; idempotent: boolean }> {
    const meter = await this.prisma.meter.findFirst({
      where: { id: dto.meterId, organizationId },
      include: {
        unit: {
          select: {
            id: true,
            type: true,
            voluntaryTaxLiability: true,
            propertyId: true,
            property: { select: { consumptionBillingMode: true } },
          },
        },
      },
    })
    if (!meter) throw new NotFoundException('Mätaren hittades inte')

    // Idempotens (meterId + externalId): samma avläsning från API/import skapar
    // aldrig en dubblett — returnera den befintliga + dess ev. charge.
    if (dto.externalId) {
      const existing = await this.prisma.meterReading.findUnique({
        where: { meterId_externalId: { meterId: dto.meterId, externalId: dto.externalId } },
      })
      if (existing) {
        const charge = await this.prisma.consumptionCharge.findFirst({
          where: { meterReadingId: existing.id },
        })
        return { reading: existing, charge, idempotent: true }
      }
    }

    if (meter.status !== 'ACTIVE') {
      throw new BadRequestException('Mätaren är inte aktiv – avläsning kan inte registreras')
    }

    const readingType: ReadingType = dto.readingType ?? 'CUMULATIVE'
    const periodStart = new Date(dto.periodStart)
    const periodEnd = new Date(dto.periodEnd)
    if (periodEnd < periodStart) {
      throw new BadRequestException('periodEnd får inte vara före periodStart')
    }

    // ── Förbrukningsberäkning ────────────────────────────────────────────────
    // quantity = null betyder "ingen debiterbar förbrukning" (öppningsavläsning).
    const quantity = await this.computeQuantity(dto.meterId, readingType, dto.value, periodEnd)

    // Aktivt hyresförhållande för perioden (eller explicit angivet).
    const lease = await this.resolveLease(
      meter.unitId,
      organizationId,
      dto.leaseId,
      periodStart,
      periodEnd,
    )

    // Leveranssätt: lease-override → fastighetens default.
    const deliveryMode: ConsumptionBillingMode | null = lease
      ? (lease.consumptionBillingMode ?? meter.unit.property.consumptionBillingMode)
      : null

    const billable =
      quantity !== null &&
      quantity > 0 &&
      lease !== null &&
      deliveryMode !== null &&
      deliveryMode !== 'NONE'

    // Tariff + moms-snapshot beräknas FÖRE transaktionen. Saknas tariff för en
    // debiterbar avläsning är det ett konfigurationsfel → avvisa (inget skapas);
    // priset måste konfigureras innan en debiterbar förbrukning registreras.
    let chargeData: {
      pricePerUnit: number
      netAmount: number
      vatStatus: ConsumptionVatStatus
      vatRate: number
      vatAmount: number
      totalAmount: number
    } | null = null

    if (billable) {
      const tariff = await this.resolveTariff(
        organizationId,
        meter.unitId,
        meter.unit.propertyId,
        meter.type,
        periodEnd,
      )
      if (!tariff) {
        throw new BadRequestException(
          `Ingen gällande tariff för ${meter.type} vid ${dto.periodEnd}. Konfigurera en tariff innan debiterbar förbrukning registreras.`,
        )
      }
      // Moms = snapshot från unit-config (typ + frivillig skattskyldighet).
      // ALDRIG hårdkodat "bostad = momsfri" — vatRateForRent äger den regeln.
      const vatRate = vatRateForRent(meter.unit.type, meter.unit.voluntaryTaxLiability)
      const vatStatus: ConsumptionVatStatus = vatRate === 25 ? 'TAXABLE_25' : 'EXEMPT'
      const pricePerUnit = Number(tariff.pricePerUnit)
      const netAmount = round2((quantity as number) * pricePerUnit)
      const vatAmount = round2((netAmount * vatRate) / 100)
      chargeData = {
        pricePerUnit,
        netAmount,
        vatStatus,
        vatRate,
        vatAmount,
        totalAmount: round2(netAmount + vatAmount),
      }
    }

    return this.prisma.$transaction(async (tx) => {
      const reading = await tx.meterReading.create({
        data: {
          organizationId,
          meterId: dto.meterId,
          unitId: meter.unitId,
          value: dto.value,
          readingType,
          readingDate: new Date(dto.readingDate),
          periodStart,
          periodEnd,
          source: dto.source,
          registeredById: userId,
          ...(lease ? { leaseId: lease.id } : {}),
          ...(dto.externalId ? { externalId: dto.externalId } : {}),
          ...(dto.notes ? { notes: dto.notes } : {}),
        },
      })

      let charge: ConsumptionCharge | null = null
      if (billable && chargeData && lease && deliveryMode) {
        charge = await tx.consumptionCharge.create({
          data: {
            organizationId,
            leaseId: lease.id,
            unitId: meter.unitId,
            tenantId: lease.tenantId,
            meterReadingId: reading.id,
            meterType: meter.type,
            periodStart,
            periodEnd,
            quantity: quantity as number,
            pricePerUnit: chargeData.pricePerUnit,
            netAmount: chargeData.netAmount,
            vatStatus: chargeData.vatStatus,
            vatRate: chargeData.vatRate,
            vatAmount: chargeData.vatAmount,
            totalAmount: chargeData.totalAmount,
            kind: 'ACTUAL',
            status: 'DRAFT',
            deliveryMode,
          },
        })
      }

      return { reading, charge, idempotent: false }
    })
  }

  // CUMULATIVE: differens mot föregående avläsning på SAMMA mätare. Första
  // avläsningen är en baslinje (null → ingen charge). Lägre värde än föregående
  // = mätarbyte/nollställning → avvisas så att differensen ALDRIG blir negativ;
  // mätarbyte modelleras via en ny Meter (gammal REMOVED, ny får egen baslinje).
  // PERIOD_VOLUME: värdet ÄR periodförbrukningen.
  private async computeQuantity(
    meterId: string,
    readingType: ReadingType,
    value: number,
    periodEnd: Date,
  ): Promise<number | null> {
    if (readingType === 'PERIOD_VOLUME') {
      if (value < 0) throw new BadRequestException('Periodförbrukning kan inte vara negativ')
      return value
    }

    const previous = await this.prisma.meterReading.findFirst({
      where: { meterId, periodEnd: { lt: periodEnd } },
      orderBy: { periodEnd: 'desc' },
      select: { value: true },
    })
    if (!previous) return null // Öppningsavläsning – baslinje, ingen debitering.

    const delta = value - Number(previous.value)
    if (delta < 0) {
      throw new BadRequestException(
        'Mätarställningen är lägre än föregående avläsning. Vid mätarbyte: markera den ' +
          'gamla mätaren som REMOVED och registrera den nya mätarens öppningsavläsning på en ny mätare.',
      )
    }
    return delta
  }

  private async resolveLease(
    unitId: string,
    organizationId: string,
    explicitLeaseId: string | undefined,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<{
    id: string
    tenantId: string
    consumptionBillingMode: ConsumptionBillingMode | null
  } | null> {
    const select = { id: true, tenantId: true, consumptionBillingMode: true } as const
    if (explicitLeaseId) {
      const lease = await this.prisma.lease.findFirst({
        where: { id: explicitLeaseId, organizationId, unitId },
        select,
      })
      if (!lease) throw new NotFoundException('Hyresavtalet hittades inte för enheten')
      return lease
    }
    // Aktivt avtal som täcker mätperioden.
    return this.prisma.lease.findFirst({
      where: {
        unitId,
        organizationId,
        status: 'ACTIVE',
        startDate: { lte: periodEnd },
        OR: [{ endDate: null }, { endDate: { gte: periodStart } }],
      },
      select,
      orderBy: { startDate: 'desc' },
    })
  }

  // ══ Charges + readings (läsning) ════════════════════════════════════════════

  async findCharges(
    organizationId: string,
    filters?: { status?: ConsumptionChargeStatus; leaseId?: string },
  ): Promise<ConsumptionCharge[]> {
    return this.prisma.consumptionCharge.findMany({
      where: {
        organizationId,
        ...(filters?.status ? { status: filters.status } : {}),
        ...(filters?.leaseId ? { leaseId: filters.leaseId } : {}),
      },
      include: CHARGE_INCLUDE,
      orderBy: { createdAt: 'desc' },
    })
  }

  async findCharge(id: string, organizationId: string): Promise<ConsumptionCharge> {
    const charge = await this.prisma.consumptionCharge.findFirst({
      where: { id, organizationId },
      include: CHARGE_INCLUDE,
    })
    if (!charge) throw new NotFoundException('Förbrukningsposten hittades inte')
    return charge
  }

  // ── DRAFT → CONFIRMED: bokför verifikat + 1510-fordran (PR 3) ───────────────
  //
  // Här uppstår intäkten och kundfordran — oberoende av leverans (PR 4 rör detta
  // aldrig). Verifikatet skapas UTANFÖR transaktionen och är idempotent via
  // sourceId="consumption-charge:<id>": dubbel confirm skapar inte dubbla
  // verifikat. Bokföringsfel loggas men fäller aldrig confirm:en (jfr deposits/
  // avisering). Inget rörs på avi/faktura, ingen consumptionAmount, ingen
  // RentNoticeLine — det är PR 4.
  async confirmCharge(
    id: string,
    organizationId: string,
    userId: string,
  ): Promise<ConsumptionCharge> {
    // Atomär statusövergång DRAFT → CONFIRMED: en villkorad updateMany (status:
    // 'DRAFT' i WHERE) kan aldrig råka skriva över ett samtidigt CANCELLED till
    // CONFIRMED — stänger TOCTOU mot ett framtida cancel-flöde. count påverkar
    // inget: verifikat-anropet nedan körs alltid (self-heal) och är idempotent.
    await this.prisma.consumptionCharge.updateMany({
      where: { id, organizationId, status: 'DRAFT' },
      data: { status: 'CONFIRMED' },
    })

    const charge = await this.prisma.consumptionCharge.findFirst({ where: { id, organizationId } })
    if (!charge) throw new NotFoundException('Förbrukningsposten hittades inte')
    if (charge.status === 'CANCELLED') {
      throw new BadRequestException('Annullerad förbrukningspost kan inte bokföras')
    }
    // CONFIRMED/ATTACHED → redan bokförd; det idempotenta anropet nedan körs ändå
    // (self-heal om ett tidigare confirm dog efter statusbytet men före verifikatet)
    // utan att skapa dubbletter, tack vare sourceId-idempotensen.

    try {
      await this.accounting.createJournalEntryForConsumptionCharge(charge, organizationId, userId)
    } catch (err) {
      this.logger.error(
        `[Consumption] Bokföring av förbrukningspost ${charge.id} misslyckades: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }

    return this.findCharge(id, organizationId)
  }

  async findReadings(
    organizationId: string,
    filters?: { meterId?: string },
  ): Promise<MeterReading[]> {
    return this.prisma.meterReading.findMany({
      where: {
        organizationId,
        ...(filters?.meterId ? { meterId: filters.meterId } : {}),
      },
      orderBy: { periodEnd: 'desc' },
    })
  }
}
