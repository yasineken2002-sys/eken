import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common'
import type { Prisma, TerminationRequestStatus } from '@prisma/client'
import type { TenancyRegime, UnitType } from '@prisma/client'
import { endOfNoticePeriod } from '@eken/shared'
import { terminationNoticeMonths } from '../leases/leases.compliance'
import { PrismaService } from '../common/prisma/prisma.service'
import { MailService } from '../mail/mail.service'
import { NotificationsService } from '../notifications/notifications.service'
import { LeasesService } from '../leases/leases.service'
import { SAFE_TENANT_SELECT } from '../tenants/tenants.service'
import { ApproveTerminationDto } from './dto/approve-termination.dto'
import { RejectTerminationDto } from './dto/reject-termination.dto'

const INCLUDE = {
  organization: { select: { name: true } },
  tenant: { select: SAFE_TENANT_SELECT },
  lease: {
    include: {
      unit: { include: { property: true } },
    },
  },
} as const

type TerminationWithRelations = Prisma.TerminationRequestGetPayload<{ include: typeof INCLUDE }>

function startOfDay(d: Date): Date {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function tenantDisplayName(t: TerminationWithRelations['tenant']): string {
  if (t.type === 'COMPANY') return t.companyName ?? t.email
  const name = `${t.firstName ?? ''} ${t.lastName ?? ''}`.trim()
  return name.length > 0 ? name : t.email
}

@Injectable()
export class TerminationsService {
  private readonly logger = new Logger(TerminationsService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly notifications: NotificationsService,
    private readonly leases: LeasesService,
  ) {}

  // ── Läsning (hyresvärdens inbox) ───────────────────────────────────────────

  async findAll(
    organizationId: string,
    filters: { status?: TerminationRequestStatus } = {},
  ): Promise<TerminationWithRelations[]> {
    return this.prisma.terminationRequest.findMany({
      where: { organizationId, ...(filters.status ? { status: filters.status } : {}) },
      include: INCLUDE,
      // PENDING först (behöver handläggas), därefter senast inkomna överst.
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    })
  }

  async findOne(id: string, organizationId: string): Promise<TerminationWithRelations> {
    const req = await this.prisma.terminationRequest.findFirst({
      where: { id, organizationId },
      include: INCLUDE,
    })
    if (!req) throw new NotFoundException('Uppsägningsbegäran hittades inte')
    return req
  }

  // Förberäknat BINDANDE slutdatum: senare av hyresgästens önskade datum och
  // (idag + uppsägningstid). Hyresgästen har enligt JB 12 kap 5 § alltid minst
  // tre månaders uppsägningstid — önskat datum kan aldrig förkorta det. Detta
  // är ett FÖRSLAG som hyresvärden bekräftar/justerar i dialogen.
  private suggestEndDate(
    requestedEndDate: Date,
    lease: { tenancyRegime: TenancyRegime; noticePeriodMonths: number; unit: { type: UnitType } },
  ): Date {
    // HYRESGÄST-initierad uppsägning → hyresgästens uppsägningstid (#69):
    // privatuthyrning 1 mån, hyreslagen avtalets tid. Månadsskiftes-rundat golv
    // (#46); hyresgästens önskade datum kan aldrig FÖRKORTA golvet men får
    // förlänga. terminate(..., 'TENANT') tillämpar samma golv defensivt.
    const months = terminationNoticeMonths({
      regime: lease.tenancyRegime,
      initiator: 'TENANT',
      unitType: lease.unit.type,
      contractualNoticeMonths: lease.noticePeriodMonths > 0 ? lease.noticePeriodMonths : 3,
    })
    const floor = endOfNoticePeriod(new Date(), months)
    const requested = startOfDay(new Date(requestedEndDate))
    return requested.getTime() > floor.getTime() ? requested : floor
  }

  // ── Godkänn / avslå (hyresvärd) ────────────────────────────────────────────

  /**
   * Godkänner en uppsägningsbegäran. Kör den BEFINTLIGA lease-termineringen
   * (sätter terminatedAt/endDate, flyttar deposition → REFUND_PENDING, notifierar
   * personal; cron sätter TERMINATED när slutdatumet passeras) med det bekräftade
   * datumet, och markerar sedan begäran APPROVED + reviewedAt/ById. Hyresgästen
   * mejlas. Terminate() körs FÖRE statusbytet så att en icke-aktiv lease (redan
   * uppsagd) lämnar begäran kvar i PENDING i stället för ett inkonsekvent läge.
   */
  async approve(
    id: string,
    organizationId: string,
    reviewerUserId: string,
    dto: ApproveTerminationDto,
  ): Promise<TerminationWithRelations> {
    const req = await this.findOne(id, organizationId)
    if (req.status !== 'PENDING') {
      throw new BadRequestException('Endast väntande begäranden kan godkännas')
    }

    const effective = dto.effectiveDate
      ? startOfDay(new Date(dto.effectiveDate))
      : this.suggestEndDate(req.requestedEndDate, req.lease)

    const reason = dto.terminationReason ?? req.reason ?? undefined

    // Återanvänder den beprövade vägen — kastar om leasen inte är aktiv.
    // 'TENANT': detta är hyresgästens uppsägning (hyresvärden godkänner den) →
    // hyresgästens uppsägningstid gäller (privatuthyrning 1 mån), golvet får
    // aldrig tvinga hyresgästen till hyresvärdens längre tid (#69).
    await this.leases.terminate(
      req.leaseId,
      { effectiveDate: isoDate(effective), ...(reason ? { terminationReason: reason } : {}) },
      organizationId,
      'TENANT',
    )

    const updated = await this.prisma.terminationRequest.update({
      where: { id },
      data: { status: 'APPROVED', reviewedAt: new Date(), reviewedById: reviewerUserId },
      include: INCLUDE,
    })

    void this.emailDecision(updated, 'APPROVED', effective, null).catch((err) =>
      this.logger.error(`Termination decision mail failed: ${String(err)}`),
    )

    this.logger.log(
      `[termination] APPROVED id=${id} org=${organizationId} lease=${req.leaseId} endDate=${isoDate(effective)}`,
    )
    return updated
  }

  async reject(
    id: string,
    organizationId: string,
    reviewerUserId: string,
    dto: RejectTerminationDto,
  ): Promise<TerminationWithRelations> {
    const req = await this.findOne(id, organizationId)
    if (req.status !== 'PENDING') {
      throw new BadRequestException('Endast väntande begäranden kan avslås')
    }

    const updated = await this.prisma.terminationRequest.update({
      where: { id },
      data: { status: 'REJECTED', reviewedAt: new Date(), reviewedById: reviewerUserId },
      include: INCLUDE,
    })

    void this.emailDecision(updated, 'REJECTED', null, dto.reason ?? null).catch((err) =>
      this.logger.error(`Termination decision mail failed: ${String(err)}`),
    )

    this.logger.log(`[termination] REJECTED id=${id} org=${organizationId} lease=${req.leaseId}`)
    return updated
  }

  // ── Skapande (hyresgäst, idag via AI-verktyget) ────────────────────────────

  /**
   * Skapar en uppsägningsbegäran från en hyresgäst och notifierar personalen.
   * Centraliserad här så att alla skapande-vägar (AI-verktyg nu, ev. portal-knapp
   * senare) delar dubblettskydd + notis. Returnerar null vid pågående dubblett;
   * kastar BadRequestException om hyresgästen saknar aktivt avtal.
   */
  async createFromTenant(
    organizationId: string,
    tenantId: string,
    requestedEndDate: Date,
    reason?: string,
  ): Promise<{ id: string; requestedEndDate: Date } | null> {
    const lease = await this.prisma.lease.findFirst({
      where: { tenantId, organizationId, status: 'ACTIVE' },
      include: { tenant: { select: SAFE_TENANT_SELECT } },
    })
    if (!lease) {
      throw new BadRequestException('Du har inget aktivt hyresavtal som kan sägas upp.')
    }

    const existing = await this.prisma.terminationRequest.findFirst({
      where: { leaseId: lease.id, status: 'PENDING' },
    })
    if (existing) return null

    const request = await this.prisma.terminationRequest.create({
      data: {
        organizationId,
        tenantId,
        leaseId: lease.id,
        requestedEndDate,
        ...(reason ? { reason } : {}),
      },
    })

    const name = tenantDisplayName(lease.tenant)
    void this.notifications
      .createForAllOrgUsers(
        organizationId,
        'SYSTEM',
        '📤 Uppsägningsbegäran från hyresgäst',
        `${name} har begärt uppsägning per ${isoDate(requestedEndDate)}.`,
        { relatedEntityType: 'TERMINATION_REQUEST', relatedEntityId: request.id },
      )
      .catch(() => undefined)

    return { id: request.id, requestedEndDate }
  }

  // ── Hyresgäst-mejl vid beslut (branded 'custom'-mall) ──────────────────────

  private async emailDecision(
    req: TerminationWithRelations,
    decision: 'APPROVED' | 'REJECTED',
    effective: Date | null,
    rejectReason: string | null,
  ): Promise<void> {
    const tenantName = tenantDisplayName(req.tenant)
    const orgName = req.organization.name
    const unitName = req.lease.unit.name

    const bodyHtml =
      decision === 'APPROVED'
        ? `
        <p style="color:#374151;font-size:15px;line-height:1.6;margin:0 0 16px">
          Din uppsägning av hyresavtalet för <strong>${escapeHtml(unitName)}</strong> har
          bekräftats av hyresvärden.
        </p>
        <div style="background:#F9FAFB;border:1px solid #E5E7EB;border-radius:8px;padding:16px 20px;margin:20px 0">
          <p style="margin:0;color:#111827;font-size:14px">
            Avtalet upphör <strong>${effective ? isoDate(effective) : ''}</strong>.
          </p>
        </div>
        <p style="color:#374151;font-size:14px;line-height:1.6;margin:0">
          En avflyttningsbesiktning bokas inför avflyttningen. Eventuell deposition
          återbetalas efter godkänd slutbesiktning. Vid frågor — kontakta hyresvärden.
        </p>`
        : `
        <p style="color:#374151;font-size:15px;line-height:1.6;margin:0 0 16px">
          Din uppsägningsbegäran för <strong>${escapeHtml(unitName)}</strong> har
          tyvärr inte godkänts av hyresvärden.
        </p>
        ${
          rejectReason
            ? `<div style="background:#FEF2F2;border:1px solid #FECACA;border-radius:8px;padding:12px 16px;margin:16px 0;color:#991B1B;font-size:14px">
                 ${escapeHtml(rejectReason)}
               </div>`
            : ''
        }
        <p style="color:#374151;font-size:14px;line-height:1.6;margin:0">
          Kontakta hyresvärden direkt för att diskutera ärendet vidare.
        </p>`

    const subject =
      decision === 'APPROVED'
        ? `Din uppsägning är bekräftad — ${orgName}`
        : `Besked om din uppsägningsbegäran — ${orgName}`

    await this.mail.sendCustomEmail({
      to: req.tenant.email,
      subject,
      bodyHtml,
      tenantName,
      organizationName: orgName,
    })
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
