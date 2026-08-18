/**
 * ÄMNESKOPPLINGENS VAKTER (#510).
 *
 * A. FORMVAKT — ingen skapar `AiMessage`/`AiMemory` utanför skrivaren.
 * B. SCHEMAVAKT — kopplingstabellerna finns och har den form som gör dem
 *    användbara (främmande nyckel till Tenant, unik per par).
 * C. BETEENDEVAKT — kollektorn samlar rätt, org-scopar, och ljuger inte om en
 *    rad som handlar om flera hyresgäster.
 *
 * Den här filen innehåller INGEN radering. PR:en bygger bara kopplingen.
 */

import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import {
  runWithSubjectCollector,
  noteSubjectCandidates,
  currentSubjectCollector,
} from './ai-subjects.context'
import { createAiMessageWithSubjects, upsertAiMemoryWithSubjects } from './ai-subject-writer'

const SRC = join(__dirname, '..', '..')
const SCHEMA = join(__dirname, '..', '..', '..', 'prisma', 'schema.prisma')
const WRITER = join('common', 'ai-subjects', 'ai-subject-writer.ts')

/** Alla .ts under src/, utom tester. Ingen filändelselista, inget urval. */
function allSourceFiles(dir: string = SRC): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) return allSourceFiles(full)
    if (!full.endsWith('.ts') || full.endsWith('.spec.ts')) return []
    return [full]
  })
}

/**
 * En rå skrivning av en AI-rad. `aiMessageTenant`/`aiMemoryTenant` är
 * KOPPLINGStabellerna och ska inte matchas — därför kräver mönstret att
 * modellnamnet slutar direkt efter `aiMessage`/`aiMemory`.
 */
export const RAW_WRITE = /\.(aiMessage|aiMemory)\.(create|createMany|upsert)\s*\(/

/** Ren funktion: träffar i EN fils innehåll. Kanariefågeln matar den direkt. */
export function offendersInContent(file: string, content: string): string[] {
  if (file.endsWith(WRITER)) return []
  return content
    .split('\n')
    .map((line, i) => ({ line: line.trim(), nr: i + 1 }))
    .filter(({ line }) => RAW_WRITE.test(line))
    .map(({ line, nr }) => `${file.replace(SRC, 'src')}:${nr}  ${line}`)
}

export function rawWriteOffenders(files: string[]): string[] {
  return files.flatMap((file) => offendersInContent(file, readFileSync(file, 'utf8')))
}

describe('A. formvakten: AiMessage/AiMemory skapas bara av skrivaren', () => {
  const files = allSourceFiles()

  it('svepet hittar faktiskt källfiler', () => {
    // Utan den här raden är allt nedan grönt även om svepet returnerar tomt.
    expect(files.length).toBeGreaterThan(200)
    expect(files.some((f) => f.endsWith('memory.service.ts'))).toBe(true)
    expect(files.some((f) => f.endsWith(WRITER))).toBe(true)
  })

  it('KANARIEFÅGEL: mönstret träffar faktiskt en skrivning', () => {
    // Träffar regexen ingenting alls är vakten blind och evigt grön.
    const writer = readFileSync(join(SRC, WRITER), 'utf8')
    expect(writer.split('\n').some((l) => RAW_WRITE.test(l))).toBe(true)
  })

  it('KANARIEFÅGEL: en injicerad skrivning utanför skrivaren FÄLLS', () => {
    // Matas in i funktionen, inte i repot — kravet är att mekanismen ger utslag.
    // Sondnamnet är kontrollerat: `__sond` finns inte som fil i src/.
    expect(
      offendersInContent(join(SRC, 'ai', '__sond.ts'), 'await this.prisma.aiMessage.create({})'),
    ).toEqual(['src/ai/__sond.ts:1  await this.prisma.aiMessage.create({})'])
    expect(
      offendersInContent(join(SRC, 'ai', '__sond.ts'), 'await this.prisma.aiMemory.upsert({})'),
    ).toEqual(['src/ai/__sond.ts:1  await this.prisma.aiMemory.upsert({})'])
  })

  it('KANARIEFÅGEL: samma injicerade skrivning INNE i skrivaren fälls inte', () => {
    // Andra halvan: vakten pekar ut vägen, inte mönstret i sig.
    expect(offendersInContent(join(SRC, WRITER), 'await db.aiMessage.create({})')).toEqual([])
  })

  it('KANARIEFÅGEL: kopplingstabellerna räknas INTE som råskrivningar', () => {
    // Vakten får inte vara röd för skrivaren själv när den skriver kopplingar.
    expect(RAW_WRITE.test('await db.aiMessageTenant.createMany({ data })')).toBe(false)
    expect(RAW_WRITE.test('await db.aiMemoryTenant.createMany({ data })')).toBe(false)
  })

  it('ingen väg skapar AiMessage eller AiMemory utanför skrivaren', () => {
    expect(rawWriteOffenders(files)).toEqual([])
  })
})

describe('B. schemavakten: kopplingstabellerna har rätt form', () => {
  const schema = readFileSync(SCHEMA, 'utf8')
  const modelBody = (name: string): string =>
    new RegExp(`^model\\s+${name}\\s*\\{([\\s\\S]*?)^\\}`, 'm').exec(schema)?.[1] ?? ''

  it.each(['AiMessageTenant', 'AiMemoryTenant'])('%s finns och pekar på Tenant', (name) => {
    const body = modelBody(name)
    expect(body).not.toBe('')
    // Främmande nyckel — inte en lös id-sträng. En koppling som tyst kan ruttna
    // är värre än ingen, eftersom den ser ut att fungera.
    expect(/tenant\s+Tenant\s+@relation/.test(body)).toBe(true)
    expect(/onDelete:\s*Cascade/.test(body)).toBe(true)
    // Unik per par: samma hyresgäst kopplas en gång per rad, inte fem.
    expect(/@@unique\(\[\w+, tenantId\]\)/.test(body)).toBe(true)
    // Sökbar från hyresgästhållet — det är hela syftet med tabellen.
    expect(/@@index\(\[tenantId\]\)/.test(body)).toBe(true)
  })

  it('tabellerna bär INGET innehåll — de är ren metadata', () => {
    for (const name of ['AiMessageTenant', 'AiMemoryTenant']) {
      const body = modelBody(name)
      expect(/\b(content|value|text|body)\s+String/.test(body)).toBe(false)
    }
  })
})

// ── Tillståndsbärande fejk-DB ────────────────────────────────────────────────

const ORG = 'org-1'
const ANNAN_ORG = 'org-2'
const T = (n: number) => `aaaaaaaa-0000-0000-0000-00000000000${n}`
const EJ_HYRESGAST = 'bbbbbbbb-0000-0000-0000-000000000001'

function fakeDb() {
  const state = {
    messages: [] as { id: string }[],
    memories: [] as { id: string; key: string; value: string }[],
    messageLinks: [] as { messageId: string; tenantId: string }[],
    memoryLinks: [] as { memoryId: string; tenantId: string }[],
    tenantQueries: 0,
  }
  const tenants = [
    { id: T(1), organizationId: ORG },
    { id: T(2), organizationId: ORG },
    { id: T(3), organizationId: ORG },
    { id: T(4), organizationId: ORG },
    { id: T(5), organizationId: ORG },
    { id: T(9), organizationId: ANNAN_ORG },
  ]
  let seq = 0
  const db = {
    aiMessage: {
      create: async () => {
        const row = { id: `m${++seq}` }
        state.messages.push(row)
        return row
      },
    },
    aiMemory: {
      upsert: async ({ create }: { create: { key: string; value: string } }) => {
        const found = state.memories.find((m) => m.key === create.key)
        if (found) {
          found.value = create.value
          return { id: found.id }
        }
        const row = { id: `mem${++seq}`, key: create.key, value: create.value }
        state.memories.push(row)
        return row
      },
    },
    tenant: {
      findMany: async ({ where }: { where: { organizationId: string; id: { in: string[] } } }) => {
        state.tenantQueries++
        return tenants
          .filter((t) => t.organizationId === where.organizationId && where.id.in.includes(t.id))
          .map((t) => ({ id: t.id }))
      },
    },
    aiMessageTenant: {
      createMany: async ({ data }: { data: { messageId: string; tenantId: string }[] }) => {
        for (const d of data) {
          if (
            !state.messageLinks.some(
              (l) => l.messageId === d.messageId && l.tenantId === d.tenantId,
            )
          )
            state.messageLinks.push(d)
        }
        return { count: data.length }
      },
    },
    aiMemoryTenant: {
      createMany: async ({ data }: { data: { memoryId: string; tenantId: string }[] }) => {
        for (const d of data) {
          if (
            !state.memoryLinks.some((l) => l.memoryId === d.memoryId && l.tenantId === d.tenantId)
          )
            state.memoryLinks.push(d)
        }
        return { count: data.length }
      },
    },
  }
  return { db: db as unknown as Parameters<typeof createAiMessageWithSubjects>[0], state }
}

const MSG = { conversationId: 'c1', role: 'assistant', content: 'x' } as never

describe('C. beteendevakten: kopplingen blir rätt', () => {
  it('FEM-PERSONERS-RADEN: ett svar om fem hyresgäster ger FEM kopplingar', async () => {
    // Formen måste tåla det utan att ljuga. Ett tenantId-fält hade tvingat fram
    // ett val mellan fem korrekta svar; kopplingstabellen behöver inte välja.
    const { db, state } = fakeDb()
    await runWithSubjectCollector(ORG, async () => {
      noteSubjectCandidates({ tenants: [T(1), T(2), T(3), T(4), T(5)].map((id) => ({ id })) })
      await createAiMessageWithSubjects(db, MSG)
    })
    expect(state.messageLinks).toHaveLength(5)
    expect(state.messageLinks.map((l) => l.tenantId).sort()).toEqual([T(1), T(2), T(3), T(4), T(5)])
  })

  it('ORG-SCOPAR: ett hyresgäst-id från en annan organisation kopplas ALDRIG', async () => {
    const { db, state } = fakeDb()
    await runWithSubjectCollector(ORG, async () => {
      noteSubjectCandidates({ a: T(1), b: T(9) })
      await createAiMessageWithSubjects(db, MSG)
    })
    expect(state.messageLinks.map((l) => l.tenantId)).toEqual([T(1)])
  })

  it('VALIDERAR: ett UUID som inte är en hyresgäst kopplas inte', async () => {
    // Insamlingen är typblind och drar in fastighets-/avtals-id också.
    // Valideringen mot Tenant är det som gör överskottet gratis.
    const { db, state } = fakeDb()
    await runWithSubjectCollector(ORG, async () => {
      noteSubjectCandidates({ propertyId: EJ_HYRESGAST, tenantId: T(2) })
      await createAiMessageWithSubjects(db, MSG)
    })
    expect(state.messageLinks.map((l) => l.tenantId)).toEqual([T(2)])
  })

  it('samma hyresgäst i flera verktyg ger EN koppling', async () => {
    const { db, state } = fakeDb()
    await runWithSubjectCollector(ORG, async () => {
      noteSubjectCandidates({ id: T(1) })
      noteSubjectCandidates([{ id: T(1) }, { tenant: { id: T(1) } }])
      await createAiMessageWithSubjects(db, MSG)
    })
    expect(state.messageLinks).toHaveLength(1)
  })

  it('LUCKAN, UTTALAD: nämns någon som inget verktyg rörde blir raden OKOPPLAD', async () => {
    // Modellen kan namnge en hyresgäst den läst ur historiken eller ur
    // portföljdatan. Den kopplas inte — kopplingen är högprecis men OFULLSTÄNDIG,
    // och får aldrig användas för att påstå att alla rader är hittade.
    const { db, state } = fakeDb()
    await runWithSubjectCollector(ORG, async () => {
      await createAiMessageWithSubjects(db, MSG)
    })
    expect(state.messages).toHaveLength(1)
    expect(state.messageLinks).toEqual([])
  })

  it('utan tur skrivs raden ändå — ingen krasch, inga kopplingar', async () => {
    const { db, state } = fakeDb()
    await createAiMessageWithSubjects(db, MSG)
    expect(state.messages).toHaveLength(1)
    expect(state.messageLinks).toEqual([])
    // Ingen kandidat → ingen validerings-fråga. Kostar inget utanför AI-vägen.
    expect(state.tenantQueries).toBe(0)
  })

  it('AiMemory: ett minne om EN hyresgäst blir riktat raderbart', async () => {
    // Den stora vinsten. Till skillnad från ett chattsvar handlar minnet om en
    // person, och raden ÄR om den personen.
    const { db, state } = fakeDb()
    await runWithSubjectCollector(ORG, async () => {
      noteSubjectCandidates({ tenantId: T(3) })
      await upsertAiMemoryWithSubjects(db, {
        organizationId: ORG,
        userId: 'u1',
        key: 'aviformat',
        value: 'papper',
        type: 'preference',
      })
    })
    expect(state.memoryLinks).toEqual([{ memoryId: 'mem1', tenantId: T(3) }])
  })

  it('AiMemory: ett förnyat minne som rör en NY hyresgäst får kopplingen tillagd', async () => {
    const { db, state } = fakeDb()
    await runWithSubjectCollector(ORG, async () => {
      noteSubjectCandidates({ tenantId: T(3) })
      await upsertAiMemoryWithSubjects(db, {
        organizationId: ORG,
        userId: 'u1',
        key: 'k',
        value: 'v1',
        type: 'fact',
      })
    })
    await runWithSubjectCollector(ORG, async () => {
      noteSubjectCandidates({ tenantId: T(4) })
      await upsertAiMemoryWithSubjects(db, {
        organizationId: ORG,
        userId: 'u1',
        key: 'k',
        value: 'v2',
        type: 'fact',
      })
    })
    expect(state.memories).toHaveLength(1)
    expect(state.memoryLinks.map((l) => l.tenantId).sort()).toEqual([T(3), T(4)])
  })

  it('kontexten överlever await-gränser', async () => {
    await runWithSubjectCollector(ORG, async () => {
      noteSubjectCandidates({ id: T(1) })
      await new Promise((r) => setTimeout(r, 1))
      expect(currentSubjectCollector()?.candidates.has(T(1))).toBe(true)
    })
  })

  it('kontexten följer med i en fire-and-forget-promise (minnesextraktionen)', async () => {
    // `extractMemoriesInBackground` gör `void this.memory.extract...()`. Promisen
    // STARTAS inne i turen, och AsyncLocalStorage följer med i kedjan — annars
    // hade minnesvägen tyst tappat sin koppling.
    const { db, state } = fakeDb()
    let bakgrund!: Promise<unknown>
    runWithSubjectCollector(ORG, () => {
      noteSubjectCandidates({ tenantId: T(5) })
      bakgrund = (async () => {
        await new Promise((r) => setTimeout(r, 1))
        return upsertAiMemoryWithSubjects(db, {
          organizationId: ORG,
          userId: 'u1',
          key: 'k',
          value: 'v',
          type: 'fact',
        })
      })()
    })
    await bakgrund
    expect(state.memoryLinks.map((l) => l.tenantId)).toEqual([T(5)])
  })

  it('kollektorn läcker inte ut ur turen', () => {
    runWithSubjectCollector(ORG, () => noteSubjectCandidates({ id: T(1) }))
    expect(currentSubjectCollector()).toBeUndefined()
  })

  it('två turer delar inte kandidater', async () => {
    const { db, state } = fakeDb()
    await runWithSubjectCollector(ORG, async () => {
      noteSubjectCandidates({ id: T(1) })
      await createAiMessageWithSubjects(db, MSG)
    })
    await runWithSubjectCollector(ORG, async () => {
      await createAiMessageWithSubjects(db, MSG)
    })
    expect(state.messageLinks.filter((l) => l.messageId === 'm2')).toEqual([])
  })
})
