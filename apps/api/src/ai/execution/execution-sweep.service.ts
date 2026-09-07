import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'

import { PrismaService } from '../../common/prisma/prisma.service'
import { CronErrorSink } from '../../common/cron/cron-error-sink'
import { runCronSafely } from '../../common/cron/cron-safety'
import { LockService } from '../../common/redis/lock.service'
import { AiAgentExecutionQueue } from './execution.queue'

const LAS_TTL_SEC = 120

/** Hur många uppdrag ett pass köar. Ett tak som SYNS. */
export const SVEP_BATCH = 100

/**
 * Statusar som betyder att uppdraget är färdigbehandlat.
 *
 * Spridd med `[...TERMINALA]` i frågan: Prismas `notIn` kräver en MUTABEL array,
 * och en `as const` här hade gett ett typfel som ser ut att handla om enumen.
 */
const TERMINALA = ['EXECUTED', 'FAILED', 'LAPSED'] as const

// ── KLASSIFICERING: A — LÅST (cron:ai-agent-execution) ──────────────────────
/**
 * PASSET SOM DRIVER SKARPT LÄGE.
 *
 * ── VARFÖR DET ÄR ETT EGET PASS OCH INTE TORRLÄGETS ─────────────────────────
 *
 * Beställningen sa "samma sveparjobb som torrläget". Det gick inte att göra
 * bokstavligt, och skälet är den spärr torrläget vilar på: `AiExecutionDryRunModule`
 * importerar med flit INTE `ToolExecutorService`, och dess docblock säger att så
 * länge beroendet saknas kan ingen kodväg där nå en effekt — oavsett vad någon
 * skriver i en tjänst. Att lägga utförandet i det passet hade krävt just den
 * importen, och därmed rivit garantin för torrläget i samma andetag som skarpt
 * läge byggdes.
 *
 * Passet är därför en KOPIA AV FORMEN, inte av koden: samma kadens, samma lås,
 * samma felsänka, samma hjärtslag. Vad som skiljer står nedan.
 *
 * ── DET LÄSER DOMAR, INTE FÖRSLAG ───────────────────────────────────────────
 *
 * Torrläget svepar `executionVerdict: null` — förslag utan dom. Det här passet
 * svepar `executionVerdict: 'WOULD_EXECUTE'` utan terminalstatus och utan
 * anspråk. De två mängderna är disjunkta, så passen kan inte kapa åt sig
 * varandras rader.
 *
 * ── OCH DET FRÅGAR ORGANISATIONEN FÖRST ─────────────────────────────────────
 *
 * Frågan är avgränsad till organisationer där BÅDA flaggorna är på. En
 * organisation som inte slagit på skarpt läge ska inte ens producera jobb —
 * tjänsten skulle avvisa dem, men ett pass som köar hundra jobb för att kasta
 * dem är en kö full av brus som döljer det som betyder något.
 */
@Injectable()
export class AiAgentExecutionSweepService {
  private readonly logger = new Logger(AiAgentExecutionSweepService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: AiAgentExecutionQueue,
    private readonly locks: LockService,
    private readonly cronErrors: CronErrorSink,
  ) {}

  @Cron('*/15 * * * *')
  async svepPass(): Promise<void> {
    const utfall = await this.locks.runIfUnlocked(
      'cron:ai-agent-execution',
      () => this.svepPassUnsafe(),
      { ttlSec: LAS_TTL_SEC },
    )
    if (!utfall.ran) {
      this.logger.log(
        `[cron:ai-agent-execution] Kördes redan av en annan replik — hoppar över. ` +
          `Låset hållet i ${utfall.heldForSec ?? '?'} s av ${LAS_TTL_SEC} s.`,
      )
    }
  }

  /** Namnet är INTE fritt: `check-cron-error-sink.mjs` följer exakt `${metod}Unsafe`. */
  private async svepPassUnsafe(): Promise<void> {
    await runCronSafely('ai-agent-execution', () => this.svep(), {
      logger: this.logger,
      sink: this.cronErrors,
    })
  }

  async svep(): Promise<{ koade: number; takNatt: boolean; organisationer: number }> {
    const orgar = await this.prisma.organization.findMany({
      where: { agentExecutionEnabled: true, shadowAgentEnabled: true },
      select: { id: true },
    })
    if (orgar.length === 0) {
      // NOLL ÄR ETT SVAR. Skarpt läge är avstängt överallt tills någon slår på
      // det, och passet ska säga det i stället för att tiga.
      this.logger.log('[cron:ai-agent-execution] Ingen organisation har skarpt läge på.')
      return { koade: 0, takNatt: false, organisationer: 0 }
    }

    const where = {
      organizationId: { in: orgar.map((o) => o.id) },
      executionVerdict: 'WOULD_EXECUTE' as const,
      executionStartedAt: null,
      status: { notIn: [...TERMINALA] },
    }
    // TAKET SYNS: kandidaterna räknas separat, så en rapporterad radlängd inte
    // blir en mätning av taket.
    const kandidater = await this.prisma.aiAssignment.count({ where })
    const rader = await this.prisma.aiAssignment.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      take: SVEP_BATCH,
      select: { id: true, organizationId: true },
    })
    const takNatt = kandidater > rader.length

    let koade = 0
    for (const r of rader) {
      await this.queue.enqueue({ organizationId: r.organizationId, assignmentId: r.id })
      koade++
    }

    if (takNatt)
      this.logger.warn(
        `[cron:ai-agent-execution] Taket ${SVEP_BATCH} slog i — ${kandidater} uppdrag ` +
          'väntar, resten tas nästa pass.',
      )
    if (koade > 0) this.logger.log(`[cron:ai-agent-execution] Köade ${koade} utföranden.`)
    return { koade, takNatt, organisationer: orgar.length }
  }
}
