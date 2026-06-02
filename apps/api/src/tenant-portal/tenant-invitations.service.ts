import { BadRequestException, Injectable, Logger } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../common/prisma/prisma.service'
import { MailService } from '../mail/mail.service'
import { TenantAuthService } from './tenant-auth.service'

// Härledd portal-inbjudningsstatus. Lagras INTE som kolumn — räknas fram ur
// portalActivated + email-giltighet + invitedAt. portalActivated förblir
// auktoritativ för aktivering. (PR 2 lägger till DELIVERED/BOUNCED via webhook.)
export type TenantInviteStatus = 'NOT_INVITED' | 'NO_EMAIL' | 'INVITED' | 'ACTIVATED'

// Inbjudan återanvänder aktiveringstokenets TTL (72 h) — samma mekanik som
// välkomstmejlet, så länken funkar identiskt i activate-flödet.
const INVITE_VALID_HOURS = 72

// Dubbelklicks-skydd: "Bjud in alla" hoppar över hyresgäster som redan bjudits
// in inom detta fönster. Medveten omsändning sker via resend (force = true).
const RECENT_INVITE_MS = 24 * 60 * 60 * 1000

// Batchstorlek + paus mellan batcher — speglar messages.service så vi inte
// dränker mejlkön/Resend i en spik. (Kön är inte HTTP-throttlad; detta är
// hänsyn till Resends egen kvot.)
const BATCH_SIZE = 10
const BATCH_PAUSE_MS = 500

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function isValidEmail(email: string | null | undefined): boolean {
  if (!email) return false
  const e = email.trim()
  return e.length > 0 && e.length <= 254 && EMAIL_RE.test(e)
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

const TENANT_INVITE_SELECT = {
  id: true,
  type: true,
  firstName: true,
  lastName: true,
  companyName: true,
  email: true,
  portalActivated: true,
  portalActivatedAt: true,
  invitedAt: true,
  inviteCount: true,
} satisfies Prisma.TenantSelect

type TenantRow = Prisma.TenantGetPayload<{ select: typeof TENANT_INVITE_SELECT }>

function displayName(
  t: Pick<TenantRow, 'type' | 'firstName' | 'lastName' | 'companyName' | 'email'>,
): string {
  if (t.type === 'COMPANY') return t.companyName ?? t.email
  const name = `${t.firstName ?? ''} ${t.lastName ?? ''}`.trim()
  return name.length > 0 ? name : t.email
}

function deriveStatus(
  t: Pick<TenantRow, 'portalActivated' | 'email' | 'invitedAt'>,
): TenantInviteStatus {
  if (t.portalActivated) return 'ACTIVATED'
  if (!isValidEmail(t.email)) return 'NO_EMAIL'
  if (t.invitedAt) return 'INVITED'
  return 'NOT_INVITED'
}

export interface TenantRef {
  tenantId: string
  name: string
  email: string
}

export interface InviteResult {
  invited: number
  alreadyActivated: number
  skippedRecent: number
  skippedNoEmail: number
  failed: number
  /** De som saknar giltig mejl — ytas så hyresvärden kan åtgärda (ej tyst skip). */
  noEmailTenants: TenantRef[]
  failedTenants: Array<TenantRef & { error: string }>
}

export interface InviteStatusRow {
  tenantId: string
  name: string
  email: string
  status: TenantInviteStatus
  invitedAt: string | null
  inviteCount: number
  portalActivatedAt: string | null
}

export interface InviteStatusList {
  counts: Record<TenantInviteStatus, number>
  total: number
  page: number
  pageSize: number
  items: InviteStatusRow[]
}

@Injectable()
export class TenantInvitationsService {
  private readonly logger = new Logger(TenantInvitationsService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly tenantAuth: TenantAuthService,
  ) {}

  // ── Bjud in ───────────────────────────────────────────────────────────────

  /**
   * Bjud in hyresgäster till portalen. Antingen `all: true` (alla med ≥1 ACTIVE-
   * lease) eller en explicit `tenantIds`-lista. Aktiverade hoppas över, saknad
   * mejl ytas (ej tyst skip), och utan `force` hoppas nyligen inbjudna (<24 h)
   * över. Mejlen köas batchvis på mejlkön (ett HTTP-anrop → N köjobb).
   */
  async invite(
    organizationId: string,
    opts: { tenantIds?: string[]; all?: boolean; force?: boolean },
  ): Promise<InviteResult> {
    const org = await this.prisma.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { id: true, name: true },
    })

    let tenants: TenantRow[]
    if (opts.tenantIds && opts.tenantIds.length > 0) {
      tenants = await this.prisma.tenant.findMany({
        where: { id: { in: opts.tenantIds }, organizationId },
        select: TENANT_INVITE_SELECT,
      })
    } else if (opts.all) {
      // "Aktiv hyresgäst" = har minst ett ACTIVE-kontrakt.
      tenants = await this.prisma.tenant.findMany({
        where: { organizationId, leases: { some: { status: 'ACTIVE' } } },
        select: TENANT_INVITE_SELECT,
      })
    } else {
      throw new BadRequestException('Ange antingen tenantIds eller all=true')
    }

    return this.runInvites(org, tenants, opts.force ?? false)
  }

  /**
   * Skicka om inbjudan. `force` så att 24 h-skyddet kringgås (medveten åtgärd).
   * `onlyNotActivated` riktar mot alla inbjudna men ej aktiverade.
   */
  async resend(
    organizationId: string,
    opts: { tenantIds?: string[]; onlyNotActivated?: boolean },
  ): Promise<InviteResult> {
    const org = await this.prisma.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { id: true, name: true },
    })

    let tenants: TenantRow[]
    if (opts.tenantIds && opts.tenantIds.length > 0) {
      tenants = await this.prisma.tenant.findMany({
        where: { id: { in: opts.tenantIds }, organizationId },
        select: TENANT_INVITE_SELECT,
      })
    } else if (opts.onlyNotActivated) {
      tenants = await this.prisma.tenant.findMany({
        where: { organizationId, portalActivated: false, invitedAt: { not: null } },
        select: TENANT_INVITE_SELECT,
      })
    } else {
      throw new BadRequestException('Ange tenantIds eller onlyNotActivated=true')
    }

    return this.runInvites(org, tenants, true)
  }

  private async runInvites(
    org: { id: string; name: string },
    tenants: TenantRow[],
    force: boolean,
  ): Promise<InviteResult> {
    const now = Date.now()
    const ref = (t: TenantRow): TenantRef => ({
      tenantId: t.id,
      name: displayName(t),
      email: t.email,
    })

    const noEmailTenants: TenantRef[] = []
    let alreadyActivated = 0
    let skippedRecent = 0
    const toSend: TenantRow[] = []

    for (const t of tenants) {
      if (t.portalActivated) {
        alreadyActivated++
        continue
      }
      if (!isValidEmail(t.email)) {
        // VIKTIGT: ytas, hoppas inte tyst över.
        noEmailTenants.push(ref(t))
        continue
      }
      if (!force && t.invitedAt && now - t.invitedAt.getTime() < RECENT_INVITE_MS) {
        skippedRecent++
        continue
      }
      toSend.push(t)
    }

    let invited = 0
    const failedTenants: Array<TenantRef & { error: string }> = []

    const batches = chunk(toSend, BATCH_SIZE)
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i] ?? []
      await Promise.allSettled(
        batch.map(async (t) => {
          try {
            await this.sendOne(org, t)
            invited++
          } catch (err) {
            failedTenants.push({
              ...ref(t),
              error: err instanceof Error ? err.message : String(err),
            })
          }
        }),
      )
      // Paus mellan batcher (ej sista) — håll Resend-kvoten lugn.
      if (i < batches.length - 1) {
        await new Promise((r) => setTimeout(r, BATCH_PAUSE_MS))
      }
    }

    this.logger.log(
      `[portal-invite] org=${org.id} invited=${invited} noEmail=${noEmailTenants.length} ` +
        `alreadyActivated=${alreadyActivated} skippedRecent=${skippedRecent} failed=${failedTenants.length}`,
    )

    return {
      invited,
      alreadyActivated,
      skippedRecent,
      skippedNoEmail: noEmailTenants.length,
      failed: failedTenants.length,
      noEmailTenants,
      failedTenants,
    }
  }

  private async sendOne(org: { id: string; name: string }, t: TenantRow): Promise<void> {
    const token = await this.tenantAuth.issueActivationToken(t.id)
    const activationUrl = this.tenantAuth.buildActivationUrl(token)

    const messageId = await this.mail.sendTenantPortalInvite({
      to: t.email,
      tenantName: displayName(t),
      organizationName: org.name,
      activationUrl,
      validForHours: INVITE_VALID_HOURS,
      // Stabil nyckel per (tenant, token-prefix): Bull dedupar dubbla enqueues,
      // Resend dedupar dubbla worker-körningar. Ny token → ny nyckel vid omskick.
      idempotencyKey: `tenant-invite-${t.id}-${token.substring(0, 8)}`,
    })

    await this.prisma.tenant.update({
      where: { id: t.id },
      data: {
        invitedAt: new Date(),
        inviteCount: { increment: 1 },
        // PR 1: Bull-jobId (samma mönster som PaymentReminder.emailMessageId).
        // PR 2 ersätter med Resend-message-id för bounce-korrelation.
        lastInviteMessageId: messageId,
      },
    })
  }

  // ── Status ─────────────────────────────────────────────────────────────────

  /**
   * Lista hyresgästers härledda inbjudningsstatus för hyresvärdens översikt.
   * Statusen härleds i minne (NO_EMAIL beror på regex, inte en kolumn), så vi
   * hämtar org:ens hyresgäster och filtrerar/paginerar därefter.
   */
  async listStatus(
    organizationId: string,
    opts: { status?: TenantInviteStatus; page?: number; pageSize?: number } = {},
  ): Promise<InviteStatusList> {
    const page = Math.max(1, opts.page ?? 1)
    const pageSize = Math.min(200, Math.max(1, opts.pageSize ?? 50))

    const tenants = await this.prisma.tenant.findMany({
      where: { organizationId },
      select: TENANT_INVITE_SELECT,
      orderBy: [{ createdAt: 'desc' }],
    })

    const rows: InviteStatusRow[] = tenants.map((t) => ({
      tenantId: t.id,
      name: displayName(t),
      email: t.email,
      status: deriveStatus(t),
      invitedAt: t.invitedAt?.toISOString() ?? null,
      inviteCount: t.inviteCount,
      portalActivatedAt: t.portalActivatedAt?.toISOString() ?? null,
    }))

    const counts: Record<TenantInviteStatus, number> = {
      NOT_INVITED: 0,
      NO_EMAIL: 0,
      INVITED: 0,
      ACTIVATED: 0,
    }
    for (const r of rows) counts[r.status]++

    const filtered = opts.status ? rows.filter((r) => r.status === opts.status) : rows
    const start = (page - 1) * pageSize

    return {
      counts,
      total: filtered.length,
      page,
      pageSize,
      items: filtered.slice(start, start + pageSize),
    }
  }
}
