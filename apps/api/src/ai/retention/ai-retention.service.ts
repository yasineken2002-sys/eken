import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { PrismaService } from '../../common/prisma/prisma.service'
import { AiAttachmentsService } from '../attachments/ai-attachments.service'
import {
  allToolNames,
  bucketForTool,
  nonReadToolNames,
  retentionDaysForBucket,
} from './tool-execution-retention'
import {
  CONVERSATION_RETENTION_DAYS,
  MEMORY_RETENTION_DAYS,
  RETENTION_BATCH_SIZE,
  USAGE_LOG_RETENTION_DAYS,
  RETENTION_DECISION_DEADLINE,
  retentionDeadlinePassed,
  retentionModeFromEnv,
  type RetentionMode,
} from './ai-retention.constants'

export interface TableOutcome {
  table: string
  /** Antal rader som togs (eller skulle tas i torrkörning). */
  rows: number
  /** Antal rader per organisation, för granskning i efterhand. */
  perOrganization: Record<string, number>
  /** Rader som försvann via kaskad snarare än en egen DELETE. */
  cascaded?: Record<string, number>
  /** Uppdelning per gallringshink, för tabeller med differentierad frist. */
  perBucket?: Record<string, number>
}

export interface RetentionOutcome {
  mode: RetentionMode
  tables: TableOutcome[]
  total: number
}

function cutoff(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000)
}

/**
 * GALLRING AV AI-LAGRET.
 *
 * Formen är speglad på `cleanupExpiredAttachments`: nattlig `@Cron`, batchad,
 * idempotent genom att den arbetar på ett tidsfönster — en körning som avbryts
 * halvvägs gör bara mindre, och nästa natt tar resten. Ingen ny mekanism
 * uppfunnen.
 *
 * ── ORDNINGEN ÄR INTE GODTYCKLIG ────────────────────────────────────────────
 *
 * Cronen ligger 05:00, EFTER bilagestädningens 04:00. Ett samtal som gallras
 * har då redan passerat bilagornas egen 90-dagarsfrist, så dess R2-objekt är i
 * normalfallet redan borta. Vi litar ändå inte på det: `deleteConversationFiles`
 * anropas explicit före varje samtalsradering, av exakt det skäl som står i den
 * metodens docblock — `onDelete: Cascade` tar bort `AiAttachment`-RADEN, men
 * databasen vet ingenting om R2, och ett objekt utan rad kan ingen städning
 * någonsin hitta igen.
 *
 * ── VAD KASKADEN GÖR ÅT OSS ─────────────────────────────────────────────────
 *
 * Mätt i schemat, inte antaget:
 *
 *   AiMessage.conversation       -> AiConversation   Cascade
 *   AiPendingAction.conversation -> AiConversation   Cascade
 *   AiAttachment.conversation    -> AiConversation   Cascade
 *
 * Meddelanden gallras alltså genom att SAMTALET gallras. En egen DELETE mot
 * `AiMessage` vore både överflödig och farlig — den skulle kunna lämna ett
 * samtal utan innehåll men med rad kvar, vilket ser ut som ett tomt samtal i
 * sidopanelen i stället för inget samtal alls.
 *
 * `AiToolExecution.conversationId` har DÄREMOT ingen relation i schemat — det är
 * ett löst id. Att gallra samtal lämnar alltså verktygsloggen orörd, och den får
 * sin egen frist.
 */
@Injectable()
export class AiRetentionService {
  private readonly logger = new Logger(AiRetentionService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly attachments: AiAttachmentsService,
  ) {}

  // ── KLASSIFICERING: B — SKYDDAT AV INVARIANT ─────────────────────────
  // deleteMany på AiToolExecution, AiConversation, AiMemory och AiUsageLog,
  // var och en filtrerad på createdAt äldre än sin frist — raderade rader
  // kan inte raderas igen, så en andra körning träffar noll rader i samtliga
  // fyra tabeller.
  //
  // Bevakas av check-cron-classification.mjs: ett @Cron utan klassificering
  // fäller CI, och ett B utan namngiven invariant likaså.
  @Cron('0 5 * * *')
  async scheduledRetention(): Promise<void> {
    const outcome = await this.runRetention(retentionModeFromEnv())
    this.report(outcome)
  }

  /**
   * Kör (eller simulerar) gallringen.
   *
   * `dry-run` läser exakt samma rader med exakt samma villkor men skriver
   * ingenting. Talen i rapporten är därför de tal en skarp körning hade gett —
   * inte en uppskattning.
   */
  async runRetention(mode: RetentionMode): Promise<RetentionOutcome> {
    const tables: TableOutcome[] = [
      await this.collectConversations(mode),
      await this.collectMemories(mode),
      await this.collectUsageLogs(mode),
      await this.collectToolExecutions(mode),
    ]
    return { mode, tables, total: tables.reduce((sum, t) => sum + t.rows, 0) }
  }

  // ── Verktygsloggen — tre frister, en per hink ─────────────────────────────

  /**
   * `AiToolExecution` gallras med DIFFERENTIERAD frist: bokföringsverktyg 730
   * dagar, övriga handlingsverktyg 365, läsande 90. Skälen står i
   * `tool-execution-retention.ts`.
   *
   * En not om orphanade rader: `userId` och `tenantId` är `SetNull`, så en rad
   * kan bli kvar med `userId: null` efter att användaren raderats. Fristen här
   * går på `createdAt` och bryr sig inte om vem raden pekar på — annars hade
   * just de raderna, som fortfarande bär fritext i `toolInput`, överlevt längre
   * än någon frist avsett.
   */
  private async collectToolExecutions(mode: RetentionMode): Promise<TableOutcome> {
    const perOrganization: Record<string, number> = {}
    const perBucket: Record<string, number> = {}
    let rows = 0

    for (const bucket of ['accounting', 'action', 'read'] as const) {
      const names = allToolNames().filter((name) => bucketForTool(name) === bucket)
      if (names.length === 0) continue

      const stale = await this.prisma.aiToolExecution.findMany({
        where: {
          toolName: bucket === 'read' ? { notIn: nonReadToolNames() } : { in: names },
          createdAt: { lt: cutoff(retentionDaysForBucket(bucket)) },
        },
        select: { id: true, organizationId: true },
        take: RETENTION_BATCH_SIZE,
      })

      for (const row of stale) {
        perOrganization[row.organizationId] = (perOrganization[row.organizationId] ?? 0) + 1
      }
      if (mode === 'enforce' && stale.length > 0) {
        await this.prisma.aiToolExecution.deleteMany({
          where: { id: { in: stale.map((r) => r.id) } },
        })
      }
      perBucket[bucket] = stale.length
      rows += stale.length
    }

    return { table: 'AiToolExecution', rows, perOrganization, perBucket }
  }

  // ── Samtal (+ kaskad: meddelanden, väntande åtgärder, bilagor) ────────────

  private async collectConversations(mode: RetentionMode): Promise<TableOutcome> {
    const stale = await this.prisma.aiConversation.findMany({
      where: { updatedAt: { lt: cutoff(CONVERSATION_RETENTION_DAYS) } },
      select: { id: true, organizationId: true, _count: { select: { messages: true } } },
      take: RETENTION_BATCH_SIZE,
    })

    const perOrganization: Record<string, number> = {}
    const cascaded: Record<string, number> = { AiMessage: 0 }
    let rows = 0

    for (const conversation of stale) {
      if (mode === 'enforce') {
        // R2 FÖRE raden — se docblocken ovan.
        await this.attachments.deleteConversationFiles(conversation.id)
        await this.prisma.aiConversation.delete({ where: { id: conversation.id } })
      }
      rows++
      cascaded['AiMessage'] = (cascaded['AiMessage'] ?? 0) + conversation._count.messages
      perOrganization[conversation.organizationId] =
        (perOrganization[conversation.organizationId] ?? 0) + 1
    }

    return { table: 'AiConversation', rows, perOrganization, cascaded }
  }

  // ── Minnet ────────────────────────────────────────────────────────────────

  private async collectMemories(mode: RetentionMode): Promise<TableOutcome> {
    // `updatedAt`, inte `createdAt`: ett minne som fortsätter bekräftas förnyas
    // av `upsert` och åldras aldrig ut. Se konstantens docblock.
    const where = { updatedAt: { lt: cutoff(MEMORY_RETENTION_DAYS) } }

    const stale = await this.prisma.aiMemory.findMany({
      where,
      select: { id: true, organizationId: true },
      take: RETENTION_BATCH_SIZE,
    })

    const perOrganization: Record<string, number> = {}
    for (const memory of stale) {
      perOrganization[memory.organizationId] = (perOrganization[memory.organizationId] ?? 0) + 1
    }

    if (mode === 'enforce' && stale.length > 0) {
      await this.prisma.aiMemory.deleteMany({ where: { id: { in: stale.map((m) => m.id) } } })
    }

    return { table: 'AiMemory', rows: stale.length, perOrganization }
  }

  // ── Förbrukningsloggen ────────────────────────────────────────────────────

  private async collectUsageLogs(mode: RetentionMode): Promise<TableOutcome> {
    const stale = await this.prisma.aiUsageLog.findMany({
      where: { createdAt: { lt: cutoff(USAGE_LOG_RETENTION_DAYS) } },
      select: { id: true, organizationId: true },
      take: RETENTION_BATCH_SIZE,
    })

    const perOrganization: Record<string, number> = {}
    for (const log of stale) {
      perOrganization[log.organizationId] = (perOrganization[log.organizationId] ?? 0) + 1
    }

    if (mode === 'enforce' && stale.length > 0) {
      await this.prisma.aiUsageLog.deleteMany({ where: { id: { in: stale.map((l) => l.id) } } })
    }

    return { table: 'AiUsageLog', rows: stale.length, perOrganization }
  }

  // ── Rapporten ─────────────────────────────────────────────────────────────

  /**
   * En gallring som inte rapporterar vad den tog går inte att granska i
   * efterhand — raderna är ju borta. Därför per tabell OCH per organisation,
   * och därför alltid en rad även när den inte tog något: tystnad är inte
   * urskiljbar från "cronen kördes aldrig".
   */
  private report(outcome: RetentionOutcome): void {
    const label = outcome.mode === 'enforce' ? 'VERKSTÄLLT' : 'TORRKÖRNING (raderade inget)'

    // Datumet i konstanterna är annars bara en kommentar. Har det passerat medan
    // cronen fortfarande torrkör är gallringen en åtgärdad post som inte gallrar
    // — och det ska synas i varje körning, inte upptäckas av en slump.
    if (retentionDeadlinePassed(outcome.mode)) {
      this.logger.warn(
        `[ai-retention] BESLUTSDATUMET ${RETENTION_DECISION_DEADLINE} HAR PASSERAT och cronen ` +
          'torrkör fortfarande. Sätt AI_RETENTION_MODE=enforce eller ta bort cronen — ' +
          'ingen tredje väg. Se GDPR-ärendet.',
      )
    }

    if (outcome.total === 0) {
      this.logger.log(`[ai-retention] ${label}: inget att gallra.`)
      return
    }

    for (const table of outcome.tables) {
      if (table.rows === 0) continue
      const orgs = Object.entries(table.perOrganization)
        .map(([orgId, n]) => `${orgId}=${n}`)
        .join(' ')
      const cascade = table.cascaded
        ? ' | via kaskad: ' +
          Object.entries(table.cascaded)
            .map(([t, n]) => `${t}=${n}`)
            .join(' ')
        : ''
      const buckets = table.perBucket
        ? ' | per frist: ' +
          Object.entries(table.perBucket)
            .map(([b, n]) => `${b}=${n}`)
            .join(' ')
        : ''
      this.logger.log(
        `[ai-retention] ${label} ${table.table}: ${table.rows} rader${cascade}${buckets}`,
      )
      this.logger.log(`[ai-retention]   per organisation: ${orgs}`)
    }

    if (outcome.tables.some((t) => t.rows === RETENTION_BATCH_SIZE)) {
      // Ett tak som nås tyst ser ut som "klart" i loggen. Säg det i stället.
      this.logger.log(
        `[ai-retention] ${label}: minst en tabell nådde batchtaket ${RETENTION_BATCH_SIZE} — ` +
          'resten tas nästa körning.',
      )
    }
  }
}
