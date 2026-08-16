/**
 * Gallringscronen: vad den tar, vad den INTE tar, och att torrkörningen
 * verkligen inte skriver.
 *
 * Attrapperna RESPEKTERAR `where`. En attrapp som svarar likadant oavsett filter
 * kan inte skilja "gallrar på updatedAt" från "gallrar på createdAt" — och den
 * skillnaden är hela poängen med minnets frist.
 */

// Speglar konventionen i ai-attachments-specarna: bilagetjänsten drar in
// storage.service och därmed hela AWS-SDK:n, som inte går att ladda i jest.
jest.mock('../../storage/storage.service', () => ({ StorageService: class {} }))

import { AiRetentionService } from './ai-retention.service'
import {
  CONVERSATION_RETENTION_DAYS,
  MEMORY_RETENTION_DAYS,
  RETENTION_DECISION_DEADLINE,
  retentionDeadlinePassed,
} from './ai-retention.constants'
import {
  ACCOUNTING_TOOL_RETENTION_DAYS,
  READ_TOOL_RETENTION_DAYS,
} from './tool-execution-retention'

const DAY = 24 * 60 * 60 * 1000
const ago = (days: number) => new Date(Date.now() - days * DAY)

interface Row {
  id: string
  organizationId: string
  createdAt: Date
  updatedAt: Date
  toolName?: string
  messages?: number
}

/** Filtrerar som Postgres skulle: på det fält villkoret faktiskt nämner. */
function applyWhere(rows: Row[], where: Record<string, unknown>): Row[] {
  return rows.filter((r) => {
    for (const [field, cond] of Object.entries(where)) {
      const c = cond as Record<string, unknown>
      if (field === 'updatedAt' && !(r.updatedAt < (c['lt'] as Date))) return false
      if (field === 'createdAt' && !(r.createdAt < (c['lt'] as Date))) return false
      if (field === 'toolName') {
        if (Array.isArray(c['in']) && !(c['in'] as string[]).includes(r.toolName ?? ''))
          return false
        if (Array.isArray(c['notIn']) && (c['notIn'] as string[]).includes(r.toolName ?? ''))
          return false
      }
      if (field === 'id' && Array.isArray(c['in'])) {
        if (!(c['in'] as string[]).includes(r.id)) return false
      }
    }
    return true
  })
}

function setup(seed: {
  conversations?: Row[]
  memories?: Row[]
  usageLogs?: Row[]
  toolExecutions?: Row[]
}) {
  const state = {
    conversations: seed.conversations ?? [],
    memories: seed.memories ?? [],
    usageLogs: seed.usageLogs ?? [],
    toolExecutions: seed.toolExecutions ?? [],
  }
  const deletedFiles: string[] = []

  const table = (key: keyof typeof state) => ({
    findMany: jest.fn(async (args: { where: Record<string, unknown>; take?: number }) => {
      const hits = applyWhere(state[key], args.where)
      return hits.slice(0, args.take ?? hits.length).map((r) => ({
        id: r.id,
        organizationId: r.organizationId,
        _count: { messages: r.messages ?? 0 },
      }))
    }),
    deleteMany: jest.fn(async (args: { where: Record<string, unknown> }) => {
      const doomed = new Set(applyWhere(state[key], args.where).map((r) => r.id))
      state[key] = state[key].filter((r) => !doomed.has(r.id))
      return { count: doomed.size }
    }),
    delete: jest.fn(async (args: { where: { id: string } }) => {
      state[key] = state[key].filter((r) => r.id !== args.where.id)
      return {}
    }),
  })

  const prisma = {
    aiConversation: table('conversations'),
    aiMemory: table('memories'),
    aiUsageLog: table('usageLogs'),
    aiToolExecution: table('toolExecutions'),
  }
  const attachments = {
    deleteConversationFiles: jest.fn(async (id: string) => {
      deletedFiles.push(id)
    }),
  }
  const service = new AiRetentionService(prisma as never, attachments as never)
  return { service, prisma, state, attachments, deletedFiles }
}

describe('torrkörning', () => {
  it('rapporterar exakt samma tal som en skarp körning — men skriver ingenting', async () => {
    const seed = {
      conversations: [
        {
          id: 'c1',
          organizationId: 'org-1',
          createdAt: ago(500),
          updatedAt: ago(400),
          messages: 12,
        },
      ],
      memories: [{ id: 'm1', organizationId: 'org-1', createdAt: ago(500), updatedAt: ago(400) }],
      toolExecutions: [
        {
          id: 't1',
          organizationId: 'org-1',
          createdAt: ago(200),
          updatedAt: ago(200),
          toolName: 'get_available_units',
        },
      ],
    }

    const dry = setup(seed)
    const dryOutcome = await dry.service.runRetention('dry-run')

    const wet = setup(seed)
    const wetOutcome = await wet.service.runRetention('enforce')

    // Samma tal.
    expect(dryOutcome.total).toBe(wetOutcome.total)
    expect(dryOutcome.tables.map((t) => [t.table, t.rows])).toEqual(
      wetOutcome.tables.map((t) => [t.table, t.rows]),
    )

    // Men torrkörningen rörde ingenting.
    expect(dry.state.conversations).toHaveLength(1)
    expect(dry.state.memories).toHaveLength(1)
    expect(dry.state.toolExecutions).toHaveLength(1)
    expect(dry.prisma.aiConversation.delete).not.toHaveBeenCalled()
    expect(dry.prisma.aiMemory.deleteMany).not.toHaveBeenCalled()
    expect(dry.deletedFiles).toEqual([])

    // Och den skarpa körningen gjorde det.
    expect(wet.state.conversations).toHaveLength(0)
    expect(wet.state.memories).toHaveLength(0)
  })
})

describe('samtal', () => {
  it('gallras på updatedAt — ett gammalt men AKTIVT samtal överlever', async () => {
    const { service, state } = setup({
      conversations: [
        // Skapat för två år sedan men använt i går.
        { id: 'aktiv', organizationId: 'org-1', createdAt: ago(700), updatedAt: ago(1) },
        {
          id: 'vilande',
          organizationId: 'org-1',
          createdAt: ago(700),
          updatedAt: ago(CONVERSATION_RETENTION_DAYS + 1),
        },
      ],
    })

    await service.runRetention('enforce')

    expect(state.conversations.map((c) => c.id)).toEqual(['aktiv'])
  })

  it('tar R2-filerna FÖRE raden', async () => {
    const { service, deletedFiles, attachments } = setup({
      conversations: [
        {
          id: 'c1',
          organizationId: 'org-1',
          createdAt: ago(700),
          updatedAt: ago(700),
          messages: 3,
        },
      ],
    })

    await service.runRetention('enforce')

    // Cascade tar AiAttachment-RADEN, men databasen vet ingenting om R2. Utan
    // det här anropet blir objektet kvar utan att någon rad pekar på det.
    expect(attachments.deleteConversationFiles).toHaveBeenCalledWith('c1')
    expect(deletedFiles).toEqual(['c1'])
  })

  it('räknar meddelandena som följer med via kaskad', async () => {
    const { service } = setup({
      conversations: [
        {
          id: 'c1',
          organizationId: 'org-1',
          createdAt: ago(700),
          updatedAt: ago(700),
          messages: 42,
        },
      ],
    })

    const outcome = await service.runRetention('dry-run')
    const conv = outcome.tables.find((t) => t.table === 'AiConversation')

    // En rapport som bara säger "1 samtal" döljer att 42 meddelanden gick med.
    expect(conv?.cascaded).toEqual({ AiMessage: 42 })
  })
})

describe('minnet', () => {
  it('gallras på updatedAt — ett minne som bekräftas på nytt åldras aldrig ut', async () => {
    const { service, state } = setup({
      memories: [
        // Extraherat för länge sedan men bekräftat i förra veckan.
        { id: 'levande', organizationId: 'org-1', createdAt: ago(900), updatedAt: ago(7) },
        {
          id: 'glömt',
          organizationId: 'org-1',
          createdAt: ago(900),
          updatedAt: ago(MEMORY_RETENTION_DAYS + 1),
        },
      ],
    })

    await service.runRetention('enforce')

    // Det här är hela skälet till att fristen går på updatedAt: en frist på
    // createdAt hade tagit bort ett sant och använt faktum på dess årsdag.
    expect(state.memories.map((m) => m.id)).toEqual(['levande'])
  })
})

describe('verktygsloggen — differentierad frist', () => {
  it('ett bokföringsverktyg överlever länge efter att ett läsverktyg gallrats', async () => {
    const mid = Math.floor((READ_TOOL_RETENTION_DAYS + ACCOUNTING_TOOL_RETENTION_DAYS) / 2)
    const { service, state } = setup({
      toolExecutions: [
        {
          id: 'bokf',
          organizationId: 'org-1',
          createdAt: ago(mid),
          updatedAt: ago(mid),
          toolName: 'create_journal_entry',
        },
        {
          id: 'las',
          organizationId: 'org-1',
          createdAt: ago(mid),
          updatedAt: ago(mid),
          toolName: 'get_available_units',
        },
      ],
    })

    await service.runRetention('enforce')

    // Samma ålder, olika utfall — det är differentieringen.
    expect(state.toolExecutions.map((t) => t.id)).toEqual(['bokf'])
  })

  it('rapporterar per frist, inte bara en klumpsumma', async () => {
    const { service } = setup({
      toolExecutions: [
        {
          id: 'l1',
          organizationId: 'org-1',
          createdAt: ago(200),
          updatedAt: ago(200),
          toolName: 'get_available_units',
        },
        {
          id: 'b1',
          organizationId: 'org-2',
          createdAt: ago(800),
          updatedAt: ago(800),
          toolName: 'create_journal_entry',
        },
      ],
    })

    const outcome = await service.runRetention('dry-run')
    const tools = outcome.tables.find((t) => t.table === 'AiToolExecution')

    expect(tools?.perBucket).toMatchObject({ accounting: 1, read: 1 })
    expect(tools?.perOrganization).toEqual({ 'org-1': 1, 'org-2': 1 })
  })

  it('en rad från ett BORTTAGET verktyg gallras — den blir inte odödlig', async () => {
    const { service, state } = setup({
      toolExecutions: [
        {
          id: 'gammalt',
          organizationId: 'org-1',
          createdAt: ago(200),
          updatedAt: ago(200),
          toolName: 'ett_verktyg_som_togs_bort',
        },
      ],
    })

    await service.runRetention('enforce')

    // Läs-hinken är ett komplement (`notIn`), inte en lista. Vore den en lista
    // skulle raden aldrig matcha någon fråga och ligga kvar för alltid.
    expect(state.toolExecutions).toHaveLength(0)
  })
})

describe('rapportering per organisation', () => {
  it('delar upp raderna per organisation', async () => {
    const { service } = setup({
      memories: [
        { id: 'm1', organizationId: 'org-1', createdAt: ago(900), updatedAt: ago(900) },
        { id: 'm2', organizationId: 'org-1', createdAt: ago(900), updatedAt: ago(900) },
        { id: 'm3', organizationId: 'org-2', createdAt: ago(900), updatedAt: ago(900) },
      ],
    })

    const outcome = await service.runRetention('dry-run')
    const mem = outcome.tables.find((t) => t.table === 'AiMemory')

    // En gallring som inte kan svara "vems rader tog du" går inte att granska
    // i efterhand — raderna är ju borta.
    expect(mem?.perOrganization).toEqual({ 'org-1': 2, 'org-2': 1 })
  })
})

describe('beslutsdatumet', () => {
  it('varnar när datumet passerat och cronen fortfarande torrkör', () => {
    // Utan den här kontrollen är datumet en kommentar, och en gallring som
    // aldrig gallrar ser ut som en åtgärdad post i backloggen.
    expect(retentionDeadlinePassed('dry-run', new Date('2099-01-01'))).toBe(true)
  })

  it('varnar INTE när läget är enforce — då är beslutet fattat', () => {
    expect(retentionDeadlinePassed('enforce', new Date('2099-01-01'))).toBe(false)
  })

  it('varnar INTE före datumet', () => {
    expect(retentionDeadlinePassed('dry-run', new Date('2026-08-17'))).toBe(false)
  })

  it('datumet ligger efter den kortaste fristen, annars fattas beslutet på noll mätpunkter', () => {
    const infört = new Date('2026-08-16')
    const beslut = new Date(RETENTION_DECISION_DEADLINE)
    const dagar = Math.round((beslut.getTime() - infört.getTime()) / (24 * 60 * 60 * 1000))
    expect(dagar).toBeGreaterThanOrEqual(28)
  })
})
