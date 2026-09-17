import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  UnprocessableEntityException,
} from '@nestjs/common'
import type {
  Meter,
  MeterStatus,
  MeterReading,
  MeterType,
  ConsumptionTariff,
  ConsumptionCharge,
  ConsumptionChargeStatus,
  ConsumptionBillingMode,
  ConsumptionVatStatus,
  ReadingType,
  Invoice,
} from '@prisma/client'
import { PrismaService } from '../common/prisma/prisma.service'
import { assertPeriodOpen } from '../accounting/closed-period'
import { fiscalYearBounds } from '../accounting/fiscal-year'
import {
  AccountingService,
  isIdempotencyRaceConflict,
  vatRateForRent,
} from '../accounting/accounting.service'
import { InvoiceEventsService } from '../invoices/invoice-events.service'
import { CreateMeterDto } from './dto/create-meter.dto'
import { UpdateMeterDto } from './dto/update-meter.dto'
import { CreateTariffDto } from './dto/create-tariff.dto'
import { RecordReadingDto } from './dto/record-reading.dto'
import { PRISMA_DEFAULT_TX_LIMITS } from '../common/prisma/transaction-limits'

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

// Svensk etikett per mätartyp för radtext på avi/faktura.
const METER_TYPE_LABEL: Record<MeterType, string> = {
  ELECTRICITY: 'el',
  HEATING: 'värme',
  WATER_COLD: 'kallvatten',
  WATER_HOT: 'varmvatten',
}

function chargeLineDescription(meterType: MeterType, periodEnd: Date): string {
  return `Förbrukning ${METER_TYPE_LABEL[meterType]} ${periodEnd.toISOString().slice(0, 7)}`
}

@Injectable()
export class ConsumptionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accounting: AccountingService,
    // #340: händelser skrivs via record(), som denormaliserar aktörsetiketten.
    private readonly invoiceEvents: InvoiceEventsService,
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
          ...(dto.calculationBasis ? { calculationBasis: dto.calculationBasis } : {}),
        },
      })
    }, PRISMA_DEFAULT_TX_LIMITS)
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
      const totalAmount = round2(netAmount + vatAmount)

      // ── NOLL OCH NEGATIVT ÄR INTE SAMMA HÄNDELSE ─────────────────────────
      //
      // Noll betyder "inget att debitera" — en tariff satt till 0 ("ingår i
      // hyran") eller en förbrukning som avrundas bort. Den posten skapas inte,
      // se villkoret vid `consumptionCharge.create` nedan.
      //
      // NEGATIVT betyder att underlaget är fel. Kvantiteten kan inte bli
      // negativ (`computeQuantity` kastar på både fallande mätarställning och
      // negativ periodvolym), och `CreateTariffDto.pricePerUnit` har `@Min(0)`
      // — så det här ska inte kunna inträffa via API:et. En import, en
      // migrering eller en direktskrivning kan ändå lägga en negativ tariff,
      // och då får den INTE tyst falla ut genom samma hål som nollan: att inte
      // debitera för att beloppet är negativt vore att behandla ett datafel som
      // gratis förbrukning, och en negativ kundfordran är ingen produkt vi har.
      // Anropet avvisas i stället, innan något skrivs — samma linje som den
      // saknade tariffen ovan.
      if (totalAmount < 0) {
        throw new BadRequestException(
          `Beräknad förbrukningsersättning blev negativ (${totalAmount} kr) för ${meter.type} ` +
            `vid ${dto.periodEnd}. Kontrollera tariffens pris per enhet — en negativ ` +
            'debitering kan inte bokföras. Ingenting har sparats.',
        )
      }

      chargeData = {
        pricePerUnit,
        netAmount,
        vatStatus,
        vatRate,
        vatAmount,
        totalAmount,
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
      // `chargeData.totalAmount > 0` kan här bara utesluta EXAKT NOLL: negativa
      // belopp avvisades redan ovan, före transaktionen. Nollan är legitim — en
      // tariff satt till 0 ("ingår i hyran", `@Min(0)`) eller en förbrukning som
      // avrundas till 0,00 — men posten går inte att bokföra: verifikatet skulle
      // sakna belopp, och sedan #F017 avvisar `confirmCharge` en bekräftelse som
      // inte kan ge ett verifikat. Skapades posten ändå fastnade den i DRAFT för
      // alltid; det finns ingen annulleringsväg för charges. Bokslutsvägen gör
      // redan samma bedömning (`if (net <= 0) { skipped++; continue }`).
      // Avläsningen sparas som vanligt; det är bara debiteringen som uteblir.
      if (billable && chargeData && chargeData.totalAmount > 0 && lease && deliveryMode) {
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
    }, PRISMA_DEFAULT_TX_LIMITS)
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
  // aldrig). Inget rörs på avi/faktura, ingen consumptionAmount, ingen
  // RentNoticeLine — det är PR 4.
  //
  // ── STATUS OCH VERIFIKAT SKRIVS TILLSAMMANS, ELLER INTE ALLS ──────────────
  //
  // Bekräftelsen är den punkt där en MÄNNISKA säger ja till något bindande, och
  // beskedet hon får ("Posten är bokförd (verifikat skapat)") måste därför vara
  // sant. Statusflippen skrevs tidigare i ett eget anrop och bokföringen kördes
  // efteråt i ett try/catch som bara loggade. En post kunde då stå CONFIRMED
  // UTAN verifikat och UTAN 1510-fordran — och ändå plockas upp av leveransen:
  // både avi-vägen (`attachRentNoticeLineCharges`) och fakturavägen
  // (`invoiceSeparateCharges`) filtrerar ENBART på status och slår aldrig upp
  // verifikatet. Följden var ett betalningskrav på en intäkt som inte fanns i
  // huvudboken, synligt bara som en loggrad.
  //
  // Det var inte ett kantfall. Verifikatets datum är `charge.periodEnd`, alltså
  // mätperiodens slut — bakåt in i en månad som bokslutet nyss kan ha stängt —
  // och varje sent inkommen avläsning träffar därför periodspärren i
  // `assertPeriodOpen`.
  //
  // Samma princip tillämpas redan av `createJournalEntryForMiscCharge`
  // (accounting.service.ts) och av avi-/fakturavägarna längre ned i den här
  // filen: skrivningarna hör ihop, alltså hör de hemma i samma transaktion.
  //
  // IDEMPOTENSEN ÄR OFÖRÄNDRAD. Verifikatet är idempotent via
  // sourceId="consumption-charge:<id>", och statusflippen är villkorad på DRAFT.
  // Ett andra confirm (dubbelklick, self-heal av en post vars verifikat saknas)
  // hittar verifikatet, flippar ingenting och svarar samma sak som det första.
  //
  // SELF-HEAL ÄR INTE EN UPPTÄCKTSVÄG, och ska inte läsas som en. Webben visar
  // Bekräfta-knappen enbart när status är DRAFT (`ConsumptionPage.tsx:898`), så
  // en post som blev CONFIRMED utan verifikat INNAN den här rättningen kan inte
  // läkas från gränssnittet — bara genom ett direkt API-anrop. Ingenting letar
  // heller upp sådana poster. Att hitta och läka dem är ett eget arbete.
  async confirmCharge(
    id: string,
    organizationId: string,
    userId: string,
  ): Promise<ConsumptionCharge> {
    try {
      await this.bokforOchBekrafta(id, organizationId, userId)
    } catch (err) {
      // SAMTIDIGT OMFÖRSÖK. Med en inskickad transaktion äger anroparen
      // rollbacken, så `createNumberedEntry` gör INTE sin egen race-återhämtning
      // — kollisionen på idempotensindexet (org, source, sourceId) kommer hit i
      // stället. Vinnarens verifikat är svaret på förlorarens fråga: samma
      // affärshändelse, samma nyckel. Ett omtag räcker, och det andra varvet
      // träffar idempotensuppslaget i stället för att skapa något.
      //
      // Disambiguerat på err.meta.target via accounting-modulens egen
      // `isIdempotencyRaceConflict`, aldrig en blind P2002-fångst: en dubblett i
      // VERIFIKATIONSSERIEN betyder något helt annat och måste fortsätta upp.
      if (!isIdempotencyRaceConflict(err)) throw err
      await this.bokforOchBekrafta(id, organizationId, userId)
    }

    return this.findCharge(id, organizationId)
  }

  /**
   * Verifikatet och statusövergången i EN transaktion. Faller bokföringen —
   * stängd period, saknat konto, obalans — rullas statusen tillbaka med den,
   * och felet fortsätter upp till anroparen med sin egen svenska text.
   */
  private async bokforOchBekrafta(
    id: string,
    organizationId: string,
    userId: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const charge = await tx.consumptionCharge.findFirst({ where: { id, organizationId } })
      if (!charge) throw new NotFoundException('Förbrukningsposten hittades inte')
      if (charge.status === 'CANCELLED') {
        throw new BadRequestException('Annullerad förbrukningspost kan inte bokföras')
      }
      // CONFIRMED/ATTACHED → redan bokförd; anropet nedan körs ändå (self-heal
      // om ett tidigare confirm dog mellan de två skrivningarna) utan att skapa
      // dubbletter, tack vare sourceId-idempotensen.

      const entry = await this.accounting.createJournalEntryForConsumptionCharge(
        charge,
        organizationId,
        userId,
        tx,
      )

      // INGEN TYST FRAMGÅNG. `createJournalEntryForConsumptionCharge` svarar
      // `null` — inte med ett undantag — när kontoplanen saknar 1510, rätt
      // intäktskonto eller 2611, och när beloppet inte är positivt. Utan raden
      // nedan hade just de fallen gett tillbaka exakt det tillstånd den här
      // ändringen finns för att omöjliggöra: CONFIRMED, fakturerbar, utan
      // verifikat. Felet loggas redan av bokföringen; här blir det ett besked.
      //
      // 422 OCH INTE 500, till skillnad från avi- och fakturavägarna som kastar
      // InternalServerError på samma `null`. Skillnaden är medveten: de tre
      // orsakerna här är alla KONFIGURATION som hyresvärden själv äger och kan
      // rätta (kontoplanen, tariffen). Ett 500 hade sagt "systemet är trasigt"
      // om ett saknat konto, och texten nedan hade aldrig nått fram.
      if (!entry) {
        throw new UnprocessableEntityException(
          'Förbrukningsposten kunde inte bokföras och har därför inte bekräftats. ' +
            'Kontrollera att kontoplanen innehåller 1510, rätt intäktskonto ' +
            '(3920 för el/värme, 3970 för vatten) och 2611 vid momspliktig post, ' +
            'samt att beloppet är större än noll. Posten ligger kvar som utkast ' +
            'och kan bekräftas igen när felet är avhjälpt.',
        )
      }

      // Villkorad på DRAFT: en samtidig annullering kan aldrig råka skrivas över
      // till CONFIRMED (TOCTOU mot ett framtida cancel-flöde).
      const { count } = await tx.consumptionCharge.updateMany({
        where: { id, organizationId, status: 'DRAFT' },
        data: { status: 'CONFIRMED' },
      })

      // count === 0 betyder tre olika saker, och ATT SKILJA DEM ÄT KRÄVER EN NY
      // LÄSNING — inte den vi gjorde i början av transaktionen.
      //
      //  1. Posten var redan CONFIRMED/ATTACHED när vi läste den → väntat
      //     (self-heal), ingenting att säga.
      //  2. Posten var DRAFT när vi läste den, men en SAMTIDIG bekräftelse hann
      //     commita före vår `updateMany`. Då är posten bokförd och CONFIRMED —
      //     av någon annan, med samma verifikat som vårt idempotensuppslag just
      //     returnerade. Det är ett lyckat utfall, inte ett fel.
      //  3. Posten var DRAFT och är det inte längre av något ANNAT skäl
      //     (annullering) → då ska ingenting bokföras, och transaktionen rullas.
      //
      // Utan omläsningen kollapsar 2 och 3 till samma gren, eftersom `charge`
      // bär det värde vi läste FÖRE racet. Följden vore ett 409 med texten
      // "ingenting har bokförts" till en användare vars post faktiskt ÄR
      // bokförd — alltså precis den sortens osanna besked den här ändringen
      // finns för att ta bort.
      if (count === 0 && charge.status === 'DRAFT') {
        const nu = await tx.consumptionCharge.findFirst({
          where: { id, organizationId },
          select: { status: true },
        })
        if (nu?.status !== 'CONFIRMED' && nu?.status !== 'ATTACHED') {
          throw new ConflictException(
            'Förbrukningsposten ändrades av någon annan under bekräftelsen. ' +
              'Ingenting har bokförts — läs om posten och försök igen.',
          )
        }
      }
    }, PRISMA_DEFAULT_TX_LIMITS)
  }

  // ══ Leveranssätt: CONFIRMED → ATTACHED (PR 4) ═══════════════════════════════
  //
  // Ren presentation + betalning. RÖR INTE bokföringen — verifikatet och
  // 1510-fordran är klara från PR 3. Här kopplas redan bokförda charges till ett
  // dokument (avi-rad eller separat faktura). Momsen läses oförändrad från
  // charge-snapshotet — beräknas aldrig om.

  // RENT_NOTICE_LINE: anropas av avi-genereringen efter att en RENT-avi skapats.
  // Plockar lease:ens CONFIRMED charges (leveranssätt RENT_NOTICE_LINE) med
  // 2-månaders förskjutning, skapar RentNoticeLine-rader, markerar charges
  // ATTACHED och returnerar summan (brutto) som avi-genereringen sätter som
  // RentNotice.consumptionAmount. Den summan ingår i den BETALBARA totalen/OCR —
  // men inte i hyresverifikatet (förbrukningen har sitt eget verifikat).
  //
  // 2-mån-lag via cutoff = sista dagen i månaden (aviMonth − 2). "<=" fångar även
  // ev. äldre obifogade charges (robust mot en månad där genereringen hoppades).
  async attachRentNoticeLineCharges(params: {
    organizationId: string
    leaseId: string
    rentNoticeId: string
    aviMonth: number
    aviYear: number
  }): Promise<number> {
    const lagCutoff = new Date(Date.UTC(params.aviYear, params.aviMonth - 2, 0))

    const charges = await this.prisma.consumptionCharge.findMany({
      where: {
        organizationId: params.organizationId,
        leaseId: params.leaseId,
        status: 'CONFIRMED',
        deliveryMode: 'RENT_NOTICE_LINE',
        periodEnd: { lte: lagCutoff },
      },
      orderBy: { periodEnd: 'asc' },
    })
    if (charges.length === 0) return 0

    let consumptionTotal = 0
    await this.prisma.$transaction(async (tx) => {
      for (const charge of charges) {
        // Atomiskt anspråk CONFIRMED → ATTACHED (race-säkert): bara den som
        // vinner får skapa raden. @unique(consumptionChargeId) är backstop.
        const claim = await tx.consumptionCharge.updateMany({
          where: { id: charge.id, organizationId: params.organizationId, status: 'CONFIRMED' },
          data: { status: 'ATTACHED' },
        })
        if (claim.count === 0) continue

        await tx.rentNoticeLine.create({
          data: {
            rentNoticeId: params.rentNoticeId,
            description: chargeLineDescription(charge.meterType, charge.periodEnd),
            quantity: charge.quantity,
            unitPrice: charge.pricePerUnit,
            vatRate: charge.vatRate,
            total: charge.totalAmount,
            consumptionChargeId: charge.id,
          },
        })
        consumptionTotal += Number(charge.totalAmount)
      }

      // Org-scopad write (defense-in-depth, samma mönster som MiscCharge-attach):
      // updateMany med organizationId i where så consumptionAmount aldrig kan skrivas
      // till en annan orgs avi. count===0 → avin tillhör inte org:en → kasta.
      const updated = await tx.rentNotice.updateMany({
        where: { id: params.rentNoticeId, organizationId: params.organizationId },
        data: { consumptionAmount: round2(consumptionTotal) },
      })
      if (updated.count === 0) {
        throw new NotFoundException('Hyresavin hittades inte för organisationen')
      }
    }, PRISMA_DEFAULT_TX_LIMITS)

    return round2(consumptionTotal)
  }

  // SEPARATE_INVOICE: bygger EN faktura (InvoiceType.UTILITY) av lease:ens
  // CONFIRMED charges med leveranssätt SEPARATE_INVOICE, en InvoiceLine per
  // charge, markerar dem ATTACHED + invoiceId. Speglar deposits-mönstret MEN
  // anropar ALDRIG bokföringen: intäkt + 1510-fordran är redan bokförda (PR 3).
  // Att även bokföra fakturan vore dubbelfordran. Fakturan är bara dokumentet
  // hyresgästen betalar mot; betalningen reglerar den befintliga 1510-fordran.
  async invoiceSeparateCharges(
    leaseId: string,
    organizationId: string,
    userId: string,
  ): Promise<Invoice | null> {
    const lease = await this.prisma.lease.findFirst({
      where: { id: leaseId, organizationId },
      select: { id: true, tenantId: true },
    })
    if (!lease) throw new NotFoundException('Hyresavtalet hittades inte')

    const charges = await this.prisma.consumptionCharge.findMany({
      where: {
        organizationId,
        leaseId,
        status: 'CONFIRMED',
        deliveryMode: 'SEPARATE_INVOICE',
      },
      orderBy: { periodEnd: 'asc' },
    })
    if (charges.length === 0) return null

    const subtotal = round2(charges.reduce((s, c) => s + Number(c.netAmount), 0))
    const vatTotal = round2(charges.reduce((s, c) => s + Number(c.vatAmount), 0))
    const total = round2(charges.reduce((s, c) => s + Number(c.totalAmount), 0))

    const today = new Date()
    const dueDate = new Date()
    dueDate.setDate(dueDate.getDate() + 30)

    return this.prisma.$transaction(async (tx) => {
      const year = today.getFullYear()
      const count = await tx.invoice.count({ where: { organizationId } })
      const invoiceNumber = `F-${year}-${String(count + 1).padStart(4, '0')}`

      const invoice = await tx.invoice.create({
        data: {
          organizationId,
          invoiceNumber,
          type: 'UTILITY',
          status: 'DRAFT',
          tenantId: lease.tenantId,
          leaseId: lease.id,
          subtotal,
          vatTotal,
          total,
          dueDate,
          issueDate: today,
          notes: 'Förbrukningsdebitering (el/vatten/värme)',
          lines: {
            create: charges.map((c) => ({
              description: chargeLineDescription(c.meterType, c.periodEnd),
              quantity: c.quantity,
              unitPrice: c.pricePerUnit,
              vatRate: c.vatRate,
              total: c.totalAmount,
            })),
          },
        },
      })

      // Atomiskt anspråk per charge (CONFIRMED → ATTACHED) + länk till fakturan.
      for (const charge of charges) {
        await tx.consumptionCharge.updateMany({
          where: { id: charge.id, organizationId, status: 'CONFIRMED' },
          data: { status: 'ATTACHED', invoiceId: invoice.id },
        })
      }

      // #340 (svepningen): via `record()`, inte en rå create. Den skrev bara
      // `actorId` — ett UUID — och `users.service.ts` gör en riktig delete, så
      // raderas användaren är namnet borta ur historiken för alltid.
      // `record()` denormaliserar etiketten vid skrivtillfället.
      await this.invoiceEvents.record(
        invoice.id,
        'CREATED',
        'USER',
        userId,
        { invoiceNumber, consumptionChargeIds: charges.map((c) => c.id) },
        { tx },
      )

      return invoice
    }, PRISMA_DEFAULT_TX_LIMITS)
  }

  // ══ Bokslut: upplupen förbrukningsintäkt (1790, PR 5) ═══════════════════════
  //
  // Vid räkenskapsårets slut estimeras förbrukning som är konsumerad men ännu
  // OMÄTT (mätaren läses först i januari) och periodiseras till rätt år via en
  // reverserande bokslutspost (1790 D / 3920|3970 K, återförs första dagen nästa
  // år). Detta är en BOKSLUTSPOST — den materialiseras aldrig som en charge och
  // hamnar aldrig på en avi/faktura.
  //
  // Estimatmetod (konsultfråga 3, ska vara konsekvent över år):
  //   dagstakt = senaste ACTUAL-chargens quantity / dess periodlängd (dagar)
  //   gap-dagar = dagar från sista mätpunkten (eller årsstart) t.o.m. årsslut
  //   estimerad kvantitet = dagstakt × gap-dagar
  //   estimerat netto = estimerad kvantitet × GÄLLANDE tariffpris (vid årsslut)
  // Moms tas från enhetens config (vatRateForRent), som för ACTUAL.
  async runYearEndAccrual(
    organizationId: string,
    fiscalYear: number,
    userId: string,
  ): Promise<{
    fiscalYear: number
    yearEndDate: string
    reversalDate: string
    accrued: number
    skipped: number
    totalNet: number
  }> {
    const DAY_MS = 86_400_000
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { fiscalYearStartMonth: true },
    })
    if (!org) throw new NotFoundException('Organisationen hittades inte')
    const startMonth = org.fiscalYearStartMonth ?? 1

    // Räkenskapsårets gränser. För kalenderår (startMonth=1): start 1/1, slut
    // 31/12, återföring 1/1 nästa år. Brutet år följer fiscalYearStartMonth.
    //
    // Uträkningen låg förut här; den är flyttad till accounting/fiscal-year.ts
    // (#704 PR 2), eftersom årsstängningen behöver EXAKT samma gränser. Två
    // kopior av "när slutar räkenskapsåret" svarar förr eller senare olika på
    // ett brutet år, och då bokförs bokslutsposten i fel år.
    const { fiscalStart, reversalDate, yearEndDate } = fiscalYearBounds(fiscalYear, startMonth)

    // Stängd period blockerar bokslutsposten (BFL) — tydligt fel uppåt innan
    // vi börjar skapa verifikat.
    await this.assertPeriodOpen(organizationId, yearEndDate, reversalDate)

    const meters = await this.prisma.meter.findMany({
      where: { organizationId, status: 'ACTIVE' },
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

    let accrued = 0
    let skipped = 0
    let totalNet = 0

    for (const meter of meters) {
      // Aktivt hyresförhållande som täcker årsskiftet — vakant enhet ger ingen
      // hyresgästintäkt att periodisera.
      const lease = await this.prisma.lease.findFirst({
        where: {
          unitId: meter.unitId,
          organizationId,
          status: 'ACTIVE',
          startDate: { lte: yearEndDate },
          OR: [{ endDate: null }, { endDate: { gte: fiscalStart } }],
        },
        select: { consumptionBillingMode: true },
      })
      if (!lease) {
        skipped++
        continue
      }
      const billingMode = lease.consumptionBillingMode ?? meter.unit.property.consumptionBillingMode
      if (billingMode === 'NONE') {
        skipped++
        continue
      }

      const lastReading = await this.prisma.meterReading.findFirst({
        where: { meterId: meter.id },
        orderBy: { periodEnd: 'desc' },
        select: { periodEnd: true },
      })
      // Senaste ACTUAL-charge ger dagstakten (basis). Ingen → ingen estimatbas.
      const lastCharge = await this.prisma.consumptionCharge.findFirst({
        where: {
          organizationId,
          meterType: meter.type,
          kind: 'ACTUAL',
          meterReading: { meterId: meter.id },
        },
        orderBy: { periodEnd: 'desc' },
        select: { quantity: true, periodStart: true, periodEnd: true },
      })
      if (!lastReading || !lastCharge) {
        skipped++
        continue
      }

      // Gap-dagar inom räkenskapsåret: från sista mätpunkten (eller årsstart om
      // mätaren inte lästs sedan föregående år) t.o.m. årsslut.
      const fiscalStartPrevDay = new Date(fiscalStart.getTime() - DAY_MS)
      const lower =
        lastReading.periodEnd > fiscalStartPrevDay ? lastReading.periodEnd : fiscalStartPrevDay
      const gapDays = Math.round((yearEndDate.getTime() - lower.getTime()) / DAY_MS)
      if (gapDays <= 0) {
        skipped++ // mätt t.o.m. årsslut — inget att periodisera
        continue
      }

      const lastChargeDays =
        Math.round((lastCharge.periodEnd.getTime() - lastCharge.periodStart.getTime()) / DAY_MS) + 1
      if (lastChargeDays <= 0) {
        skipped++
        continue
      }
      const dailyQty = Number(lastCharge.quantity) / lastChargeDays
      const estQty = dailyQty * gapDays

      const tariff = await this.resolveTariff(
        organizationId,
        meter.unitId,
        meter.unit.propertyId,
        meter.type,
        yearEndDate,
      )
      if (!tariff) {
        skipped++
        continue
      }

      const net = round2(estQty * Number(tariff.pricePerUnit))
      if (net <= 0) {
        skipped++
        continue
      }
      const vatRate = vatRateForRent(meter.unit.type, meter.unit.voluntaryTaxLiability)
      const vatStatus: ConsumptionVatStatus = vatRate === 25 ? 'TAXABLE_25' : 'EXEMPT'
      const vatAmount = round2((net * vatRate) / 100)
      const total = round2(net + vatAmount)

      const result = await this.accounting.createConsumptionAccrualEntry(
        {
          meterId: meter.id,
          meterType: meter.type,
          fiscalYear,
          yearEndDate,
          reversalDate,
          netAmount: net,
          vatStatus,
          vatAmount,
          totalAmount: total,
        },
        organizationId,
        userId,
      )
      if (result) {
        accrued++
        totalNet = round2(totalNet + net)
      } else {
        skipped++
      }
    }

    return {
      fiscalYear,
      yearEndDate: yearEndDate.toISOString().slice(0, 10),
      reversalDate: reversalDate.toISOString().slice(0, 10),
      accrued,
      skipped,
      totalNet,
    }
  }

  // Bokslutsposten OCH dess vändning måste båda ligga i öppna perioder — annars
  // skulle den ena halvan kunna bokföras och den andra fällas senare.
  // Uppslaget delas med allocate/backfill via closed-period.ts (en sanningskälla,
  // inklusive den subtila civil-tid-härledningen).
  private async assertPeriodOpen(
    organizationId: string,
    yearEndDate: Date,
    reversalDate: Date,
  ): Promise<void> {
    for (const date of [yearEndDate, reversalDate]) {
      await assertPeriodOpen(this.prisma, organizationId, date, 'bokslutspost kan inte skapas')
    }
  }

  async findReadings(
    organizationId: string,
    filters?: { meterId?: string; unitId?: string; periodStart?: Date; periodEnd?: Date },
  ): Promise<MeterReading[]> {
    return this.prisma.meterReading.findMany({
      where: {
        organizationId,
        ...(filters?.meterId ? { meterId: filters.meterId } : {}),
        ...(filters?.unitId ? { unitId: filters.unitId } : {}),
        // Periodfilter mot avläsningens slutdatum (periodEnd styr räkenskapsåret)
        ...(filters?.periodStart || filters?.periodEnd
          ? {
              periodEnd: {
                ...(filters.periodStart ? { gte: filters.periodStart } : {}),
                ...(filters.periodEnd ? { lte: filters.periodEnd } : {}),
              },
            }
          : {}),
      },
      orderBy: { periodEnd: 'desc' },
    })
  }
}
