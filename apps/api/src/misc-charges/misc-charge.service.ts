import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common'
import type { MiscCharge, MiscChargeStatus, Prisma } from '@prisma/client'
import { PrismaService } from '../common/prisma/prisma.service'
import { AccountingService } from '../accounting/accounting.service'
import { CreateMiscChargeDto } from './dto/create-misc-charge.dto'
import { assertRentNoticeLineChargeXor } from './misc-charge.xor'

// Öresavrundning — speglar consumption (ingen float-aritmetik på snapshots).
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

/**
 * Teknisk förvaltning · Spår A PR 3 — orchestrering av övriga debiterbara poster.
 *
 * Statemaskin: DRAFT → CONFIRMED → CANCELLED. ATTACHED rörs ALDRIG här (PR 4,
 * med invoiceId/RentNoticeLine). CANCELLED är terminal. All kontering ligger i
 * AccountingService — denna service flippar bara status och anropar.
 */
@Injectable()
export class MiscChargeService {
  private readonly logger = new Logger(MiscChargeService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly accounting: AccountingService,
  ) {}

  // ── DRAFT: skapa + prissätt (momssnapshot fryses här) ──────────────────────
  //
  // netAmount/vatStatus/vatRate/vatAmount/totalAmount sätts EN gång; momsen läses
  // aldrig om senare (PR 2 äger regeln, EXEMPT v1 = bostad, ML 3 kap 2 §). När
  // källan är ett felanmälningsärende claim:as MaintenanceTicket.chargeId atomiskt
  // — en debitering per ärende (@unique är backstop, service-claimet är auktoritet).
  async createMiscCharge(dto: CreateMiscChargeDto, organizationId: string): Promise<MiscCharge> {
    // Org-scope, aldrig via JOIN: lease + tenant valideras var för sig.
    const lease = await this.prisma.lease.findFirst({
      where: { id: dto.leaseId, organizationId },
      select: { id: true },
    })
    if (!lease) throw new NotFoundException('Hyresavtalet hittades inte')

    const tenant = await this.prisma.tenant.findFirst({
      where: { id: dto.tenantId, organizationId },
      select: { id: true },
    })
    if (!tenant) throw new NotFoundException('Hyresgästen hittades inte')

    // Momssnapshot — fryst vid create. EXEMPT v1: ingen moms (vatRate 0/vatAmount 0,
    // total = netto). TAXABLE_25 ägs av framtida momsbeslut (PR 2, docs/legal/45).
    const netAmount = round2(dto.netAmount)
    const vatStatus = 'EXEMPT' as const
    const vatRate = 0
    const vatAmount = 0
    const totalAmount = round2(netAmount + vatAmount)

    return this.prisma.$transaction(async (tx) => {
      if (dto.sourceType === 'MAINTENANCE_TICKET') {
        const ticket = await tx.maintenanceTicket.findFirst({
          where: { id: dto.sourceRefId, organizationId },
          select: { id: true, chargeId: true },
        })
        if (!ticket) throw new NotFoundException('Felanmälningsärendet hittades inte')
        if (ticket.chargeId) throw new ConflictException('Ärendet är redan debiterat')
      }

      const charge = await tx.miscCharge.create({
        data: {
          organizationId,
          leaseId: dto.leaseId,
          tenantId: dto.tenantId,
          sourceType: dto.sourceType,
          sourceRefId: dto.sourceRefId,
          description: dto.description,
          incidentDate: new Date(dto.incidentDate),
          netAmount,
          vatStatus,
          vatRate,
          vatAmount,
          totalAmount,
          status: 'DRAFT',
        },
      })

      if (dto.sourceType === 'MAINTENANCE_TICKET') {
        // Race-säkert claim: bara den som ser chargeId=null vinner. Backstop:
        // MaintenanceTicket.chargeId @unique. count===0 → någon hann före → rulla
        // tillbaka hela transaktionen (ingen föräldralös charge).
        const claim = await tx.maintenanceTicket.updateMany({
          where: { id: dto.sourceRefId, organizationId, chargeId: null },
          data: { chargeId: charge.id },
        })
        if (claim.count === 0) throw new ConflictException('Ärendet är redan debiterat')
      }

      return charge
    })
  }

  // ── CONFIRMED: bokför (delegerar helt till PR 2) ───────────────────────────
  //
  // createJournalEntryForMiscCharge gör BÅDE statusflippen (DRAFT→CONFIRMED) och
  // NotFound/BadRequest-kasten internt. confirm flippar därför ALDRIG status själv
  // (skulle dubbla PR 2:s flipp) — den delegerar och översätter de fyra utfallen:
  //   • entry  → bokförd (ny ELLER idempotent träff) → ok
  //   • throws NotFoundException   → okänd post (bubblar som 404)
  //   • throws BadRequestException → CANCELLED, går ej att boka (bubblar som 400)
  //   • null   → kontoplan saknar 1510/3990/2611 ELLER total ≤ 0 → 422 (inte tyst)
  // Idempotent: andra anropet får idempotent träff → samma resultat, ingen dubbel.
  async confirmMiscCharge(id: string, organizationId: string, userId: string): Promise<MiscCharge> {
    const entry = await this.accounting.createJournalEntryForMiscCharge(id, organizationId, userId)
    if (entry === null) {
      this.logger.error(
        `[MiscCharge] Bokföring av post ${id} gav ingen verifikation (saknat konto/total≤0)`,
      )
      throw new UnprocessableEntityException(
        'Kunde inte bokföra posten: kontoplanen saknar konto (1510/3990) eller beloppet är noll.',
      )
    }
    return this.findMiscCharge(id, organizationId)
  }

  // ── CANCELLED: annullering/reversal ────────────────────────────────────────
  //
  // DRAFT (aldrig bokförd) → bara statusflipp, INGET motverifikat (det fanns aldrig
  // ett original). CONFIRMED (bokförd) → motverifikat FÖRST (3990 D / 1510 K),
  // sedan status, ATOMISKT i samma transaktion: faller reversalen flippas inte
  // status (ingen halv-annullering). Originalverifikatet raderas ALDRIG (BFL).
  // Idempotent: redan CANCELLED → no-op (inget andra motverifikat, inget fel).
  //
  // clearCharge (PR 4c): en annullering frigör ärendet för om-debitering —
  // MaintenanceTicket.chargeId rensas tillbaka till null i SAMMA transaktion som
  // statusflippen (charge→CANCELLED och ticket→fri sker atomiskt, aldrig det ena
  // utan det andra). Bara MAINTENANCE_TICKET har en ticket.chargeId att rensa;
  // andra källor (INSPECTION_ITEM/KEY_LOSS) hoppas säkert över. Se clearTicketClaim.
  async cancelMiscCharge(id: string, organizationId: string, userId: string): Promise<MiscCharge> {
    const charge = await this.prisma.miscCharge.findFirst({ where: { id, organizationId } })
    if (!charge) throw new NotFoundException('Debiteringsposten hittades inte')

    if (charge.status === 'CANCELLED') return charge // idempotent no-op

    if (charge.status === 'ATTACHED') {
      // ATTACHED hör till PR 4 (kopplad till avi/faktura) — annulleras inte här.
      throw new BadRequestException(
        'Posten är kopplad till en avi/faktura och kan inte annulleras här',
      )
    }

    if (charge.status === 'DRAFT') {
      // Aldrig bokförd → inget att backa. Villkorad updateMany stänger TOCTOU mot
      // ett samtidigt confirm (status:'DRAFT' i where). count===0 betyder att ett
      // parallellt confirm hann flippa DRAFT→CONFIRMED mellan findFirst och nu —
      // då får anroparen ett tydligt fel, inte ett tyst 200 med CONFIRMED-status
      // (speglar ticket-claim-mönstret i createMiscCharge). Statusflipp + clear av
      // ticket.chargeId görs atomiskt i en transaktion (count===0 → rulla tillbaka).
      const cancelled = await this.prisma.$transaction(async (tx) => {
        const result = await tx.miscCharge.updateMany({
          where: { id, organizationId, status: 'DRAFT' },
          data: { status: 'CANCELLED' },
        })
        if (result.count === 0) return false
        await this.clearTicketClaim(tx, charge, organizationId)
        return true
      })
      if (!cancelled) {
        const current = await this.findMiscCharge(id, organizationId)
        throw new ConflictException(
          `Posten kan inte annulleras i nuläget (nuvarande status: ${current.status})`,
        )
      }
      return this.findMiscCharge(id, organizationId)
    }

    // CONFIRMED → motverifikat + statusflipp + frigör ärendet, allt atomiskt.
    await this.prisma.$transaction(async (tx) => {
      await this.accounting.reverseJournalEntryForMiscCharge(id, organizationId, userId, tx)
      await tx.miscCharge.updateMany({
        where: { id, organizationId, status: 'CONFIRMED' },
        data: { status: 'CANCELLED' },
      })
      await this.clearTicketClaim(tx, charge, organizationId)
    })
    return this.findMiscCharge(id, organizationId)
  }

  // ── clearCharge (PR 4c): frigör ärendet vid annullering ────────────────────
  //
  // Speglar claim:et i createMiscCharge omvänt: där sätts MaintenanceTicket.chargeId
  // = charge.id när en debitering skapas; här nollas den när debiteringen annulleras,
  // så ärendet kan om-debiteras (t.ex. fel belopp annulleras → ny korrekt charge).
  // Villkorat på chargeId: charge.id → bara DEN ticket som faktiskt pekar på denna
  // charge rensas. Idempotent: redan null (eller pekar på annan charge) → count 0,
  // no-op, inget fel. Endast MAINTENANCE_TICKET har en ticket.chargeId att rensa —
  // INSPECTION_ITEM/KEY_LOSS (framtida källor) saknar koppling och hoppas säkert över.
  // Körs i SAMMA tx som statusflippen så charge→CANCELLED och ticket→fri är atomiskt.
  private async clearTicketClaim(
    tx: Prisma.TransactionClient,
    charge: Pick<MiscCharge, 'id' | 'sourceType' | 'sourceRefId'>,
    organizationId: string,
  ): Promise<void> {
    if (charge.sourceType !== 'MAINTENANCE_TICKET') return
    await tx.maintenanceTicket.updateMany({
      where: { id: charge.sourceRefId, organizationId, chargeId: charge.id },
      data: { chargeId: null },
    })
  }

  // ── Läsning (hyresvärds-sidan, PR 4) ───────────────────────────────────────
  //
  // Lista debiteringsposter, org-scopat. Filter: status (t.ex. CONFIRMED för
  // poster som kan attach:as till avi i PR 4b), leaseId, sourceRefId (ärendets id
  // → hämta postens status för en MaintenanceTicket utan att läcka övriga fält).
  // Hyresgästvy/portal är PR 5 — detta är endast hyresvärds-API.
  async findMiscCharges(
    organizationId: string,
    filters?: { status?: MiscChargeStatus; leaseId?: string; sourceRefId?: string },
  ): Promise<MiscCharge[]> {
    return this.prisma.miscCharge.findMany({
      where: {
        organizationId,
        ...(filters?.status ? { status: filters.status } : {}),
        ...(filters?.leaseId ? { leaseId: filters.leaseId } : {}),
        ...(filters?.sourceRefId ? { sourceRefId: filters.sourceRefId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      // Säkerhetsgräns på en publik (MANAGER+) list-endpoint — tabellen växer per
      // org. Full paginering (cursor) läggs vid en ev. "Alla debiteringar"-listvy.
      take: 500,
    })
  }

  // Enskild post (query-nyckel ['misc-charge', id] i frontend). Org-scopat.
  async findMiscCharge(id: string, organizationId: string): Promise<MiscCharge> {
    const charge = await this.prisma.miscCharge.findFirst({ where: { id, organizationId } })
    if (!charge) throw new NotFoundException('Debiteringsposten hittades inte')
    return charge
  }

  // ── ATTACHED: koppla CONFIRMED-poster som rader på en hyresavi (PR 4b) ──────
  //
  // Speglar consumption.attachRentNoticeLineCharges. Anropas av avi-genereringen
  // bredvid consumption-attach. RÖR INTE bokföringen — verifikatet + 1510-fordran
  // är klara (PR 2/3). Här kopplas redan bokförda CONFIRMED-poster som RentNoticeLine
  // och summeras till RentNotice.miscChargeAmount, som ingår i den BETALBARA totalen/
  // OCR/skuld (rentNoticePayableTotal/computeRentDebt) — men har sitt egna verifikat.
  //
  // FÖRSTA gången ATTACHED sätts för MiscCharge. invoiceId existerar inte på modellen
  // (rent-notice-line-vägen länkar via RentNoticeLine.miscChargeId; en separat-faktura-
  // väg byggs inte här). Claim-mönstret (updateMany status CONFIRMED→ATTACHED,
  // count===0 → continue) är race-säkert; @unique(miscChargeId) på raden är backstop.
  // Beloppen läses oförändrat från postens snapshot — beräknas aldrig om.
  async attachMiscChargesToRentNotice(params: {
    organizationId: string
    leaseId: string
    rentNoticeId: string
  }): Promise<number> {
    const charges = await this.prisma.miscCharge.findMany({
      where: {
        organizationId: params.organizationId,
        leaseId: params.leaseId,
        status: 'CONFIRMED',
      },
      orderBy: { createdAt: 'asc' },
    })
    if (charges.length === 0) return 0

    let miscTotal = 0
    await this.prisma.$transaction(async (tx) => {
      for (const charge of charges) {
        // Atomiskt anspråk CONFIRMED → ATTACHED (race-säkert): bara vinnaren skapar
        // raden. @unique(miscChargeId) på RentNoticeLine är backstop.
        const claim = await tx.miscCharge.updateMany({
          where: { id: charge.id, organizationId: params.organizationId, status: 'CONFIRMED' },
          data: { status: 'ATTACHED' },
        })
        if (claim.count === 0) continue

        // XOR-invariant (PR 3): exakt EN av consumptionChargeId/miscChargeId satt.
        // En misc-rad har bara miscChargeId.
        assertRentNoticeLineChargeXor(undefined, charge.id)

        await tx.rentNoticeLine.create({
          data: {
            rentNoticeId: params.rentNoticeId,
            // Avi-raden visas för hyresgästen (deras egen faktura) — postens
            // beskrivning hör hemma här, till skillnad från det PII-fria verifikatet.
            description: charge.description,
            quantity: 1,
            unitPrice: charge.netAmount,
            vatRate: charge.vatRate,
            total: charge.totalAmount,
            miscChargeId: charge.id,
          },
        })
        miscTotal += Number(charge.totalAmount)
      }

      // Org-scopad write (defense-in-depth): updateMany med organizationId i where
      // så miscChargeAmount aldrig kan skrivas till en annan orgs avi även om en
      // framtida anropare skickar ett godtyckligt rentNoticeId. count===0 → avin
      // tillhör inte org:en → kasta (rulla tillbaka attach-transaktionen).
      const updated = await tx.rentNotice.updateMany({
        where: { id: params.rentNoticeId, organizationId: params.organizationId },
        data: { miscChargeAmount: round2(miscTotal) },
      })
      if (updated.count === 0) {
        throw new NotFoundException('Hyresavin hittades inte för organisationen')
      }
    })

    return round2(miscTotal)
  }
}
