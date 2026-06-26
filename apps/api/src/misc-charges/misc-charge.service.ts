import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common'
import type { MiscCharge } from '@prisma/client'
import { PrismaService } from '../common/prisma/prisma.service'
import { AccountingService } from '../accounting/accounting.service'
import { CreateMiscChargeDto } from './dto/create-misc-charge.dto'

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
    return this.findCharge(id, organizationId)
  }

  // ── CANCELLED: annullering/reversal ────────────────────────────────────────
  //
  // DRAFT (aldrig bokförd) → bara statusflipp, INGET motverifikat (det fanns aldrig
  // ett original). CONFIRMED (bokförd) → motverifikat FÖRST (3990 D / 1510 K),
  // sedan status, ATOMISKT i samma transaktion: faller reversalen flippas inte
  // status (ingen halv-annullering). Originalverifikatet raderas ALDRIG (BFL).
  // Idempotent: redan CANCELLED → no-op (inget andra motverifikat, inget fel).
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
      // ett samtidigt confirm (status:'DRAFT' i where).
      await this.prisma.miscCharge.updateMany({
        where: { id, organizationId, status: 'DRAFT' },
        data: { status: 'CANCELLED' },
      })
      return this.findCharge(id, organizationId)
    }

    // CONFIRMED → motverifikat + statusflipp atomiskt.
    await this.prisma.$transaction(async (tx) => {
      await this.accounting.reverseJournalEntryForMiscCharge(id, organizationId, userId, tx)
      await tx.miscCharge.updateMany({
        where: { id, organizationId, status: 'CONFIRMED' },
        data: { status: 'CANCELLED' },
      })
    })
    return this.findCharge(id, organizationId)
  }

  // Intern läs-helper (ingen exponerad GET i PR 3 — hyresgästvy är PR 5).
  private async findCharge(id: string, organizationId: string): Promise<MiscCharge> {
    const charge = await this.prisma.miscCharge.findFirst({ where: { id, organizationId } })
    if (!charge) throw new NotFoundException('Debiteringsposten hittades inte')
    return charge
  }
}
