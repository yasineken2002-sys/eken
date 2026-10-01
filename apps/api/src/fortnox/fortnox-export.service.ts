import { Inject, Injectable, NotFoundException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../common/prisma/prisma.service'

/**
 * Export av Evenos verifikat mot Fortnox huvudbok — UTKORG och livscykel.
 *
 * Själva omvandlingen (konton, belopp, datum, balans, proveniens) är en separat
 * ren transformer (`export/fortnox-voucher-draft.ts`, egen leverans). Den här
 * tjänsten konsumerar den via `FORTNOX_VOUCHER_DRAFT_BUILDER` och äger:
 *
 *  - beständig exportidentitet: EN rad per (organisation, verifikat). Parallella
 *    begäranden kolliderar på det unika villkoret → samma rad, aldrig två.
 *  - förhandskontrollens utfall (DRY_RUN_READY med draft + hash, eller BLOCKED).
 *  - SÄNDNING ÄR AVSTÄNGD. Fortnox dokumenterar ingen klientsatt idempotensnyckel
 *    och ingen läs-efter-skriv-garanti (frågorna F1/F2 är obesvarade). Ett oklart
 *    POST-utfall kan därför inte avgöras säkert. Tills det är belagt levereras
 *    bara dry-run och en uttrycklig stopporsak — inget sändflöde, ingen retry.
 *  - UNKNOWN finns i modellen för framtida sändning: kräver manuell avstämning.
 */

export const FORTNOX_VOUCHER_DRAFT_BUILDER = Symbol('FORTNOX_VOUCHER_DRAFT_BUILDER')

export type FortnoxVoucherDraftOutcome =
  | { ok: true; draft: Record<string, unknown>; draftHash: string }
  | { ok: false; reasons: string[] }

/** Kontrakt mot transformer-leveransen. Läser verifikatet själv, org-bundet. */
export interface FortnoxVoucherDraftBuilder {
  build(organizationId: string, journalEntryId: string): Promise<FortnoxVoucherDraftOutcome>
}

/**
 * Standard tills transformer-leveransen är införd: blockerar uttryckligen. Det är
 * en avsiktlig spärr — ingen konkurrerande omvandling byggs här.
 */
export class PendingVoucherDraftBuilder implements FortnoxVoucherDraftBuilder {
  async build(): Promise<FortnoxVoucherDraftOutcome> {
    return { ok: false, reasons: ['TRANSFORMER_NOT_INTEGRATED'] }
  }
}

export const FORTNOX_SENDING_ENABLED = false
export const FORTNOX_SENDING_DISABLED_REASON = 'IDEMPOTENCY_UNRESOLVED' as const

const EXPORT_VIEW = {
  id: true,
  journalEntryId: true,
  state: true,
  blockReason: true,
  draftHash: true,
  updatedAt: true,
} satisfies Prisma.FortnoxVoucherExportSelect

@Injectable()
export class FortnoxExportService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(FORTNOX_VOUCHER_DRAFT_BUILDER) private readonly builder: FortnoxVoucherDraftBuilder,
  ) {}

  /**
   * Förhandskontroll + köplats. Idempotent per verifikat: en befintlig rad i
   * slutläge (UNKNOWN/CONFIRMED) rörs aldrig; en DRY_RUN_READY/BLOCKED-rad
   * omprövas mot dagens underlag.
   */
  async dryRun(organizationId: string, journalEntryId: string) {
    const entry = await this.prisma.journalEntry.findFirst({
      where: { id: journalEntryId, organizationId },
      select: { id: true },
    })
    if (!entry) throw new NotFoundException('Verifikatet hittades inte')

    const existing = await this.prisma.fortnoxVoucherExport.findUnique({
      where: { organizationId_journalEntryId: { organizationId, journalEntryId } },
      select: EXPORT_VIEW,
    })
    if (existing && (existing.state === 'UNKNOWN' || existing.state === 'CONFIRMED'))
      return existing

    const outcome = await this.builder.build(organizationId, journalEntryId)
    const data = outcome.ok
      ? {
          state: 'DRY_RUN_READY' as const,
          draft: outcome.draft as Prisma.InputJsonValue,
          draftHash: outcome.draftHash,
          blockReason: null,
        }
      : {
          state: 'BLOCKED' as const,
          draft: Prisma.DbNull,
          draftHash: null,
          blockReason: outcome.reasons.join(', ').slice(0, 500),
        }

    // E1: skrivningen är VILLKORAD på ett tillåtet tidigare tillstånd. Ett slutläge
    // (UNKNOWN/CONFIRMED) som satts under `await builder.build` skrivs aldrig över.
    if (existing) {
      await this.prisma.fortnoxVoucherExport.updateMany({
        where: { organizationId, journalEntryId, state: { in: ['DRY_RUN_READY', 'BLOCKED'] } },
        data,
      })
      return this.prisma.fortnoxVoucherExport.findUniqueOrThrow({
        where: { organizationId_journalEntryId: { organizationId, journalEntryId } },
        select: EXPORT_VIEW,
      })
    }
    try {
      return await this.prisma.fortnoxVoucherExport.create({
        data: { organizationId, journalEntryId, ...data },
        select: EXPORT_VIEW,
      })
    } catch (err) {
      // Två samtidiga första begäranden: den ena vinner skapandet, den andra får
      // P2002 och läser den vinnande raden. Fortfarande exakt en rad.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return this.prisma.fortnoxVoucherExport.findUniqueOrThrow({
          where: { organizationId_journalEntryId: { organizationId, journalEntryId } },
          select: EXPORT_VIEW,
        })
      }
      throw err
    }
  }

  /** Sändning är avstängd i denna version; svaret är en uttrycklig stopporsak. */
  send(): { sent: false; reason: typeof FORTNOX_SENDING_DISABLED_REASON } {
    return { sent: false, reason: FORTNOX_SENDING_DISABLED_REASON }
  }

  async list(organizationId: string) {
    return this.prisma.fortnoxVoucherExport.findMany({
      where: { organizationId },
      orderBy: { updatedAt: 'desc' },
      take: 200,
      select: EXPORT_VIEW,
    })
  }

  async counts(organizationId: string) {
    const grouped = await this.prisma.fortnoxVoucherExport.groupBy({
      by: ['state'],
      where: { organizationId },
      _count: { _all: true },
    })
    const counts = { DRY_RUN_READY: 0, BLOCKED: 0, UNKNOWN: 0, CONFIRMED: 0 }
    for (const g of grouped) counts[g.state] = g._count._all
    return {
      counts,
      needsReconciliation: counts.UNKNOWN,
      sendingEnabled: FORTNOX_SENDING_ENABLED,
      sendingDisabledReason: FORTNOX_SENDING_DISABLED_REASON,
    }
  }
}
