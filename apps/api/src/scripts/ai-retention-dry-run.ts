/**
 * TORRKÖRNING AV AI-GALLRINGEN — mätning före verkställighet.
 *
 * Cronen kör i `dry-run` som default och rapporterar till loggen. Det här
 * skriptet gör samma mätning på begäran, så att man kan se talen NU i stället
 * för att vänta på nästa natt — och framför allt innan någon sätter
 * `AI_RETENTION_MODE=enforce`.
 *
 * Samma ordning som `rotate-pii-secrets`: kör alltid mätningen först, läs
 * talen, verkställ sedan.
 *
 *   pnpm --filter @eken/api ai:retention:dry-run
 *
 * Skriptet kan INTE radera. Det finns ingen flagga för det, och det är
 * avsiktligt: verkställighet sker genom cronen med miljövariabeln satt, så att
 * det finns ett spår i loggen av vad som togs och när.
 */

import { PrismaClient } from '@prisma/client'
import {
  CONVERSATION_RETENTION_DAYS,
  MEMORY_RETENTION_DAYS,
  USAGE_LOG_RETENTION_DAYS,
} from '../ai/retention/ai-retention.constants'
import {
  ACCOUNTING_TOOL_RETENTION_DAYS,
  ACTION_TOOL_RETENTION_DAYS,
  READ_TOOL_RETENTION_DAYS,
  allToolNames,
  bucketForTool,
  nonReadToolNames,
} from '../ai/retention/tool-execution-retention'

const prisma = new PrismaClient()
const DAY = 24 * 60 * 60 * 1000
const cutoff = (days: number) => new Date(Date.now() - days * DAY)

function line(label: string, total: number, doomed: number, days: number): string {
  const pct = total === 0 ? 0 : Math.round((doomed / total) * 100)
  return `${label.padEnd(34)} ${String(doomed).padStart(7)} av ${String(total).padStart(7)}  (${String(pct).padStart(3)} %)  frist ${days} d`
}

async function main(): Promise<void> {
  console.warn('AI-GALLRING — TORRKÖRNING. Ingenting raderas.\n')

  const [convTotal, convDoomed] = await Promise.all([
    prisma.aiConversation.count(),
    prisma.aiConversation.count({
      where: { updatedAt: { lt: cutoff(CONVERSATION_RETENTION_DAYS) } },
    }),
  ])
  // Meddelandena följer med via kaskad — de räknas separat eftersom de är den
  // stora volymen och den som bär mest fritext.
  const msgDoomed = await prisma.aiMessage.count({
    where: { conversation: { updatedAt: { lt: cutoff(CONVERSATION_RETENTION_DAYS) } } },
  })
  const msgTotal = await prisma.aiMessage.count()

  const [memTotal, memDoomed] = await Promise.all([
    prisma.aiMemory.count(),
    prisma.aiMemory.count({ where: { updatedAt: { lt: cutoff(MEMORY_RETENTION_DAYS) } } }),
  ])

  const [useTotal, useDoomed] = await Promise.all([
    prisma.aiUsageLog.count(),
    prisma.aiUsageLog.count({ where: { createdAt: { lt: cutoff(USAGE_LOG_RETENTION_DAYS) } } }),
  ])

  console.warn(line('AiConversation', convTotal, convDoomed, CONVERSATION_RETENTION_DAYS))
  console.warn(
    line('  └─ AiMessage (via kaskad)', msgTotal, msgDoomed, CONVERSATION_RETENTION_DAYS),
  )
  console.warn(line('AiMemory', memTotal, memDoomed, MEMORY_RETENTION_DAYS))
  console.warn(line('AiUsageLog', useTotal, useDoomed, USAGE_LOG_RETENTION_DAYS))

  console.warn('\nAiToolExecution — differentierad frist:')
  const toolTotal = await prisma.aiToolExecution.count()
  let toolDoomed = 0
  for (const [bucket, days] of [
    ['accounting', ACCOUNTING_TOOL_RETENTION_DAYS],
    ['action', ACTION_TOOL_RETENTION_DAYS],
    ['read', READ_TOOL_RETENTION_DAYS],
  ] as const) {
    const names = allToolNames().filter((n) => bucketForTool(n) === bucket)
    const where =
      bucket === 'read'
        ? { toolName: { notIn: nonReadToolNames() }, createdAt: { lt: cutoff(days) } }
        : { toolName: { in: names }, createdAt: { lt: cutoff(days) } }
    const [inBucket, doomed] = await Promise.all([
      prisma.aiToolExecution.count({
        where:
          bucket === 'read'
            ? { toolName: { notIn: nonReadToolNames() } }
            : { toolName: { in: names } },
      }),
      prisma.aiToolExecution.count({ where }),
    ])
    toolDoomed += doomed
    console.warn(line(`  ${bucket}`, inBucket, doomed, days))
  }
  console.warn(line('AiToolExecution TOTALT', toolTotal, toolDoomed, 0).replace(' frist 0 d', ''))

  // ── Per organisation ──────────────────────────────────────────────────────
  //
  // Totalsummor döljer fördelningen. En gallring som tar 400 rader kan vara 400
  // från en enda organisation eller 4 från hundra, och det är olika saker att
  // svara för i efterhand.
  const perOrg = new Map<string, Record<string, number>>()
  const bump = (orgId: string, table: string, n = 1): void => {
    const row = perOrg.get(orgId) ?? {}
    row[table] = (row[table] ?? 0) + n
    perOrg.set(orgId, row)
  }

  for (const c of await prisma.aiConversation.groupBy({
    by: ['organizationId'],
    where: { updatedAt: { lt: cutoff(CONVERSATION_RETENTION_DAYS) } },
    _count: { _all: true },
  })) {
    bump(c.organizationId, 'AiConversation', c._count._all)
  }
  for (const m of await prisma.aiMemory.groupBy({
    by: ['organizationId'],
    where: { updatedAt: { lt: cutoff(MEMORY_RETENTION_DAYS) } },
    _count: { _all: true },
  })) {
    bump(m.organizationId, 'AiMemory', m._count._all)
  }
  for (const u of await prisma.aiUsageLog.groupBy({
    by: ['organizationId'],
    where: { createdAt: { lt: cutoff(USAGE_LOG_RETENTION_DAYS) } },
    _count: { _all: true },
  })) {
    bump(u.organizationId, 'AiUsageLog', u._count._all)
  }
  for (const [bucket, days] of [
    ['accounting', ACCOUNTING_TOOL_RETENTION_DAYS],
    ['action', ACTION_TOOL_RETENTION_DAYS],
    ['read', READ_TOOL_RETENTION_DAYS],
  ] as const) {
    const names = allToolNames().filter((n) => bucketForTool(n) === bucket)
    for (const t of await prisma.aiToolExecution.groupBy({
      by: ['organizationId'],
      where: {
        toolName: bucket === 'read' ? { notIn: nonReadToolNames() } : { in: names },
        createdAt: { lt: cutoff(days) },
      },
      _count: { _all: true },
    })) {
      bump(t.organizationId, `AiToolExecution/${bucket}`, t._count._all)
    }
  }

  if (perOrg.size > 0) {
    console.warn('\nPer organisation:')
    for (const [orgId, tables] of [...perOrg.entries()].sort()) {
      const detalj = Object.entries(tables)
        .map(([t, n]) => `${t}=${n}`)
        .join('  ')
      console.warn(`  ${orgId}  ${detalj}`)
    }
  }

  const total = convDoomed + memDoomed + useDoomed + toolDoomed
  console.warn(`\nTOTALT ${total} rader skulle gallras (+ ${msgDoomed} meddelanden via kaskad).`)
  if (total === 0) {
    console.warn(
      'Noll betyder att ingenting ännu passerat sin frist — inte att gallringen inte fungerar.',
    )
  }
  console.warn('\nVerkställ genom att sätta AI_RETENTION_MODE=enforce i miljön. Cronen kör 05:00.')
}

main()
  .catch((err: unknown) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => void prisma.$disconnect())
