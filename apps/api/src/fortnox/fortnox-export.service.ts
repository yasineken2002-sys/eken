import { Inject, Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common'
import { Prisma, type FortnoxExportState } from '@prisma/client'
import type { FortnoxExportsPageQuery } from '@eken/shared'
import { PrismaService } from '../common/prisma/prisma.service'
import { PRISMA_DEFAULT_TX_LIMITS } from '../common/prisma/transaction-limits'
import { exportView } from './fortnox-export-view'

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
  | {
      ok: true
      draft: Record<string, unknown>
      draftHash: string
      /** Anslutningen som hashen räknades mot (T-N1). Sändning kräver likhet. */
      binding?: { generation: number; databaseNumber: number | null; accountingMethod?: string }
    }
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
  draft: true,
  id: true,
  journalEntryId: true,
  state: true,
  blockReason: true,
  draftHash: true,
  lastOutcome: true,
  externalYear: true,
  externalSeries: true,
  externalNumber: true,
  sendConfirmedAt: true,
  receiptAt: true,
  confirmedAt: true,
  reconciledAt: true,
  updatedAt: true,
} satisfies Prisma.FortnoxVoucherExportSelect

interface WorklistSelection {
  total: bigint
  ids: string[]
}

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
    return exportView(await this.dryRunRow(organizationId, journalEntryId))
  }

  private async dryRunRow(organizationId: string, journalEntryId: string) {
    const entry = await this.prisma.journalEntry.findFirst({
      where: { id: journalEntryId, organizationId },
      select: { id: true },
    })
    if (!entry) throw new NotFoundException('Verifikatet hittades inte')

    const existing = await this.prisma.fortnoxVoucherExport.findUnique({
      where: { organizationId_journalEntryId: { organizationId, journalEntryId } },
      select: EXPORT_VIEW,
    })
    // Endast BLOCKED/DRY_RUN_READY får omprövas. Pågående, okända, avvisade,
    // kvitterade och bekräftade försök byggs aldrig om genom dry-run (F17).
    if (existing && existing.state !== 'DRY_RUN_READY' && existing.state !== 'BLOCKED')
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
          // TESTKUND-006: intäktsgrindens skäl namnger varje berört konto; 500 tecken klippte
          // bort konto nummer två i exportvyn.
          blockReason: outcome.reasons.join(', ').slice(0, 2000),
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
    const rows = await this.prisma.fortnoxVoucherExport.findMany({
      where: { organizationId },
      orderBy: { updatedAt: 'desc' },
      take: 200,
      select: EXPORT_VIEW,
    })
    return rows.map(exportView)
  }

  /** Komplett arbetslista: status/datum filtreras före sidgränsen, även äldre problem. */
  async listPage(organizationId: string, input: FortnoxExportsPageQuery = {}) {
    const offset = input.offset ?? 0
    const limit = input.limit ?? 50
    const needsReview: FortnoxExportState[] = [
      'UNKNOWN',
      'REJECTED',
      'RECEIPT_MISMATCH',
      'RECEIPT_IDENTIFIED',
    ]
    const filters = [
      Prisma.sql`e."organizationId" = ${organizationId}`,
      Prisma.sql`j."organizationId" = ${organizationId}`,
    ]
    if (input.source) filters.push(Prisma.sql`j."source" = ${input.source}::"JournalEntrySource"`)
    if (input.from) filters.push(Prisma.sql`j."date" >= ${input.from}::date`)
    if (input.to) filters.push(Prisma.sql`j."date" <= ${input.to}::date`)
    const states = Prisma.join(
      needsReview.map((state) => Prisma.sql`${state}::"FortnoxExportState"`),
    )
    if (input.group === 'NEEDS_REVIEW') filters.push(Prisma.sql`e."state" IN (${states})`)
    if (input.group === 'OTHER') filters.push(Prisma.sql`e."state" NOT IN (${states})`)

    // En smal join ger både total och sidans identiteter. Att sortera EXPORT_VIEW
    // direkt drar med historiska JSON-utkast och skapade två journaljoins i Prisma.
    // Bara sidans detaljer hämtas nedan. RR håller urval/total/detaljer sammanhängande
    // när en annan transaktion ändrar status; nästa sidbyte får en ny läsbild.
    return this.prisma.$transaction(
      async (tx) => {
        const selections = await tx.$queryRaw<WorklistSelection[]>(Prisma.sql`
        WITH matched AS MATERIALIZED (
          SELECT e."id", j."date", e."createdAt"
          FROM "FortnoxVoucherExport" e
          INNER JOIN "JournalEntry" j ON j."id" = e."journalEntryId"
          WHERE ${Prisma.join(filters, ' AND ')}
        ), ordered_page AS (
          SELECT "id", "date", "createdAt" FROM matched
          ORDER BY "date" DESC, "createdAt" DESC, "id" DESC
          LIMIT ${limit} OFFSET ${offset}
        )
        SELECT (SELECT count(*) FROM matched) AS total,
          COALESCE(
            (SELECT array_agg("id" ORDER BY "date" DESC, "createdAt" DESC, "id" DESC)
             FROM ordered_page),
            ARRAY[]::text[]
          ) AS ids
      `)
        const selected = selections[0]
        if (
          selections.length !== 1 ||
          !selected ||
          typeof selected.total !== 'bigint' ||
          selected.total < 0n ||
          selected.total > BigInt(Number.MAX_SAFE_INTEGER) ||
          !Array.isArray(selected.ids) ||
          selected.ids.length > limit ||
          selected.ids.some((id) => typeof id !== 'string') ||
          new Set(selected.ids).size !== selected.ids.length
        )
          throw new InternalServerErrorException('Kunde inte läsa Fortnox-arbetslistan')
        const total = Number(selected.total)
        if (!selected.ids.length) return { items: [], total, offset, limit }
        const rows = await tx.fortnoxVoucherExport.findMany({
          // Filtren tillämpas en gång i matched. Identiteter och båda företagsvillkor
          // begränsar detaljläsningen inom samma oföränderliga transaktionsläsbild.
          where: {
            organizationId,
            journalEntry: { is: { organizationId } },
            id: { in: selected.ids },
          },
          select: EXPORT_VIEW,
        })
        const byId = new Map(rows.map((row) => [row.id, row]))
        const items = selected.ids.map((id) => {
          const row = byId.get(id)
          if (!row) throw new InternalServerErrorException('Kunde inte läsa Fortnox-arbetslistan')
          return exportView(row)
        })
        return { items, total, offset, limit }
      },
      {
        ...PRISMA_DEFAULT_TX_LIMITS,
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      },
    )
  }

  async counts(organizationId: string, sendingEnabled = FORTNOX_SENDING_ENABLED) {
    const grouped = await this.prisma.fortnoxVoucherExport.groupBy({
      by: ['state'],
      where: { organizationId },
      _count: { _all: true },
    })
    const counts = {
      DRY_RUN_READY: 0,
      BLOCKED: 0,
      SENDING: 0,
      UNKNOWN: 0,
      REJECTED: 0,
      RECEIPT_IDENTIFIED: 0,
      RECEIPT_MISMATCH: 0,
      CONFIRMED: 0,
    }
    for (const g of grouped) counts[g.state] = g._count._all
    return {
      counts,
      needsReconciliation: counts.UNKNOWN + counts.REJECTED + counts.RECEIPT_MISMATCH,
      sendingEnabled,
      sendingDisabledReason: sendingEnabled ? null : FORTNOX_SENDING_DISABLED_REASON,
    }
  }
}
