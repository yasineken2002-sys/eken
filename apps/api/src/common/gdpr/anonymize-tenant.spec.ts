/**
 * Avidentifieringens kärna — vad som FAKTISKT skrubbas, vad som FAKTISKT bevaras,
 * och att en andra körning inte gör något dumt.
 *
 * Testerna kör mot en tillståndsbärande fejk-transaktion i stället för
 * `jest.fn()`-attrapper som glömmer vad de skrivit. Det är avsiktligt:
 * idempotens går inte att bevisa mot en mock som inte minns det första anropet —
 * den skulle vara grön oavsett.
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import {
  anonymizeTenantWithin,
  maskedTenantEmail,
  AI_TENANT_LINK_STEPS,
  aiClientKey,
} from './anonymize-tenant'
import type { Prisma } from '@prisma/client'

const SCHEMA = join(__dirname, '..', '..', '..', 'prisma', 'schema.prisma')

const TENANT = 'aaaaaaaa-1111-2222-3333-444444444444'
const ORG = 'org-1'

interface FakeState {
  tenant: Record<string, unknown>
  sessions: { tenantId: string }[]
  keyHandovers: { tenantId: string; issuedToName: string | null }[]
  sentMessages: { tenantId: string; subject: string; content: string }[]
  logs: Record<string, unknown>[]
  /** Varje `data`-objekt som skickats till tenant.update, i ordning. */
  updates: Record<string, unknown>[]
  aiTenantConversations: { id: string; tenantId: string }[]
  aiTenantMessages: { conversationId: string }[]
  aiToolExecutions: { tenantId: string | null }[]
  aiUsageLogs: { tenantId: string | null }[]
  aiAssignments: { tenantId: string | null }[]
  /**
   * #612: varje `$executeRaw`-anrop, med de bundna värdena.
   *
   * Attrappen kan inte köra SQL — att FRÅGAN matchar rätt rader prövas mot
   * riktig Postgres i `anonymize-errorlog.db.spec.ts`. Det som mäts här är att
   * steget är PÅKOPPLAT och får rätt nål, vilket är den halvan som historiskt
   * går sönder tyst.
   */
  rawCalls: { sql: string; values: unknown[] }[]
}

function freshState(): FakeState {
  return {
    tenant: {
      id: TENANT,
      firstName: 'Anna',
      lastName: 'Andersson',
      companyName: null,
      email: 'anna@example.se',
      phone: '070-1234567',
      personalNumberEnc: 'CIPHERTEXT',
      personalNumberHash: 'BLINDINDEX',
      orgNumber: null,
      street: 'Storgatan 1',
      city: 'Göteborg',
      postalCode: '41100',
      contactPerson: 'Anna',
      passwordHash: '$2a$12$hash',
      portalActivated: true,
      activationTokenHash: 'tok',
      activationTokenExpiresAt: new Date('2026-01-01'),
      activationReminderSentAt: new Date('2026-01-01'),
      passwordResetTokenHash: 'rst',
      passwordResetTokenExpiresAt: new Date('2026-01-01'),
      anonymizedAt: null,
      ocrNumber: '00000000019',
    },
    sessions: [{ tenantId: TENANT }, { tenantId: TENANT }],
    keyHandovers: [
      { tenantId: TENANT, issuedToName: 'Sambo Svensson' },
      { tenantId: TENANT, issuedToName: null },
    ],
    sentMessages: [
      {
        tenantId: TENANT,
        subject: 'Anmaning om rättelse',
        content: 'Anna Andersson, 850101-1234, ombeds omedelbart upphöra med störningarna.',
      },
    ],
    logs: [],
    updates: [],
    aiTenantConversations: [
      { id: 'conv-1', tenantId: TENANT },
      { id: 'conv-2', tenantId: TENANT },
      { id: 'conv-annan', tenantId: 'annan-hyresgast' },
    ],
    aiTenantMessages: [
      { conversationId: 'conv-1' },
      { conversationId: 'conv-1' },
      { conversationId: 'conv-2' },
      { conversationId: 'conv-annan' },
    ],
    aiToolExecutions: [{ tenantId: TENANT }, { tenantId: 'annan-hyresgast' }, { tenantId: null }],
    aiUsageLogs: [{ tenantId: TENANT }, { tenantId: TENANT }, { tenantId: 'annan-hyresgast' }],
    aiAssignments: [{ tenantId: TENANT }, { tenantId: 'annan-hyresgast' }, { tenantId: null }],
    rawCalls: [],
  }
}

/** Minimal men TILLSTÅNDSBÄRANDE Prisma-transaktion. */
function fakeTx(state: FakeState) {
  return {
    tenant: {
      findUniqueOrThrow: async () => ({ anonymizedAt: state.tenant.anonymizedAt }),
      update: async ({ data }: { data: Record<string, unknown> }) => {
        state.updates.push(data)
        Object.assign(state.tenant, data)
        return state.tenant
      },
    },
    tenantSession: {
      deleteMany: async ({ where }: { where: { tenantId: string } }) => {
        const before = state.sessions.length
        state.sessions = state.sessions.filter((s) => s.tenantId !== where.tenantId)
        return { count: before - state.sessions.length }
      },
    },
    keyHandover: {
      updateMany: async ({ where }: { where: { tenantId: string } }) => {
        let n = 0
        for (const k of state.keyHandovers) {
          if (k.tenantId === where.tenantId && k.issuedToName !== null) {
            k.issuedToName = null
            n++
          }
        }
        return { count: n }
      },
    },
    sentMessage: {
      updateMany: async () => {
        throw new Error(
          'sentMessage.updateMany anropades — SentMessage är ett uttryckligt undantag ' +
            'som väntar på juridisk bedömning.',
        )
      },
    },
    aiTenantConversation: {
      deleteMany: async ({ where }: { where: { tenantId: string } }) => {
        const doomed = state.aiTenantConversations.filter((c) => c.tenantId === where.tenantId)
        state.aiTenantConversations = state.aiTenantConversations.filter(
          (c) => c.tenantId !== where.tenantId,
        )
        // Emulerar databasens kaskad AiTenantMessage → AiTenantConversation.
        // OBS: att den här fejken kaskaderar bevisar inte att Postgres gör det —
        // det bevisas av att FK:n är onDelete: Cascade (vakten nedan kollar det
        // mekaniskt ur schemat) och av körningen mot riktig dev-DB.
        const ids = new Set(doomed.map((c) => c.id))
        state.aiTenantMessages = state.aiTenantMessages.filter((m) => !ids.has(m.conversationId))
        return { count: doomed.length }
      },
    },
    aiToolExecution: {
      updateMany: async ({ where }: { where: { tenantId: string } }) => {
        let n = 0
        for (const r of state.aiToolExecutions) {
          if (r.tenantId === where.tenantId) {
            r.tenantId = null
            n++
          }
        }
        return { count: n }
      },
    },
    aiUsageLog: {
      updateMany: async ({ where }: { where: { tenantId: string } }) => {
        let n = 0
        for (const r of state.aiUsageLogs) {
          if (r.tenantId === where.tenantId) {
            r.tenantId = null
            n++
          }
        }
        return { count: n }
      },
    },
    aiAssignment: {
      updateMany: async ({ where }: { where: { tenantId: string } }) => {
        let n = 0
        for (const r of state.aiAssignments) {
          if (r.tenantId === where.tenantId) {
            r.tenantId = null
            n++
          }
        }
        return { count: n }
      },
    },
    // #612: `purgeTenantErrorLogRows` går via rå SQL. Attrappen spelar in
    // anropet i stället för att köra det — se `rawCalls` ovan.
    $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      state.rawCalls.push({ sql: strings.join('?'), values })
      return 0
    },
    tenantAnonymizationLog: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        state.logs.push(data)
        return data
      },
    },
  } as unknown as Prisma.TransactionClient
}

const ACTOR = { performedById: 'user-1', ipAddress: '1.2.3.4', userAgent: 'jest' }

describe('avidentifiering — identifierande fält nollas', () => {
  it('nollar namn, kontaktuppgifter och maskerar e-posten', async () => {
    const state = freshState()
    await anonymizeTenantWithin(fakeTx(state), TENANT, ORG, ACTOR)

    expect(state.tenant.firstName).toBeNull()
    expect(state.tenant.lastName).toBeNull()
    expect(state.tenant.phone).toBeNull()
    expect(state.tenant.street).toBeNull()
    expect(state.tenant.city).toBeNull()
    expect(state.tenant.postalCode).toBeNull()
    expect(state.tenant.contactPerson).toBeNull()
    expect(state.tenant.companyName).toBe('Raderad hyresgäst')
    expect(state.tenant.email).toBe(maskedTenantEmail(TENANT))
    expect(state.tenant.email).not.toContain('anna')
  })

  it('nollar personnumret i BÅDA kolumnerna — chiffertext och blind-index', async () => {
    const state = freshState()
    await anonymizeTenantWithin(fakeTx(state), TENANT, ORG, ACTOR)

    expect(state.tenant.personalNumberEnc).toBeNull()
    // Blind-indexet är deterministiskt och jämförbart mellan rader. Lämnas det
    // kvar går personen att korrelera trots att chiffertexten är borta.
    expect(state.tenant.personalNumberHash).toBeNull()
  })

  it('river portal-inloggningen: credentials nollade och sessioner raderade', async () => {
    const state = freshState()
    await anonymizeTenantWithin(fakeTx(state), TENANT, ORG, ACTOR)

    expect(state.tenant.passwordHash).toBeNull()
    expect(state.tenant.activationTokenHash).toBeNull()
    expect(state.tenant.passwordResetTokenHash).toBeNull()
    expect(state.tenant.portalActivated).toBe(false)
    expect(state.sessions).toHaveLength(0)
  })

  it('skrubbar KeyHandover.issuedToName — fritextnamnet i angränsande tabell', async () => {
    const state = freshState()
    await anonymizeTenantWithin(fakeTx(state), TENANT, ORG, ACTOR)

    expect(state.keyHandovers.map((k) => k.issuedToName)).toEqual([null, null])
  })

  it('sätter anonymizedAt så att tillståndet blir läsbart', async () => {
    const state = freshState()
    const res = await anonymizeTenantWithin(fakeTx(state), TENANT, ORG, ACTOR)

    expect(state.tenant.anonymizedAt).toBeInstanceOf(Date)
    expect(res.performed).toBe(true)
    expect(res.anonymizedAt).toEqual(state.tenant.anonymizedAt)
  })
})

describe('avidentifiering — vad som med flit INTE rörs', () => {
  it('lämnar SentMessage orört (uttryckligt undantag, öppen juridisk fråga)', async () => {
    const state = freshState()
    // Fejken kastar om `sentMessage.updateMany` anropas. Skulle någon lägga till
    // en skrubb utan att först ha den juridiska bedömningen faller detta test.
    await expect(anonymizeTenantWithin(fakeTx(state), TENANT, ORG, ACTOR)).resolves.toBeDefined()

    expect(state.sentMessages[0]!.content).toContain('Anna Andersson')
    expect(state.sentMessages[0]!.subject).toBe('Anmaning om rättelse')
  })

  it('lämnar ocrNumber orört — mätt beslut, se GDPR-ärendet', async () => {
    const state = freshState()
    await anonymizeTenantWithin(fakeTx(state), TENANT, ORG, ACTOR)

    // Nollningen skulle ta bort en kopia av N+1: RentNotice.ocrNumber är NOT NULL
    // och bär samma värde på varje avi. Kopplingen person→avier går dessutom via
    // tenantId, inte via OCR.
    expect(state.tenant.ocrNumber).toBe('00000000019')
  })
})

describe('KANARIEFÅGEL — avidentifieringen är idempotent', () => {
  it('två körningar ger samma sluttillstånd, inget fel och EN loggpost', async () => {
    const state = freshState()

    const first = await anonymizeTenantWithin(fakeTx(state), TENANT, ORG, ACTOR)
    const afterFirst = JSON.parse(JSON.stringify(state.tenant)) as Record<string, unknown>

    // Andra körningen får inte kasta.
    const second = await anonymizeTenantWithin(fakeTx(state), TENANT, ORG, ACTOR)

    // Samma sluttillstånd, fält för fält.
    expect(JSON.parse(JSON.stringify(state.tenant))).toEqual(afterFirst)

    // Exakt EN loggpost. En idempotent operation ska inte se ut som två
    // raderingsbegäranden i revisionsspåret.
    expect(state.logs).toHaveLength(1)

    // anonymizedAt behåller sin FÖRSTA tidpunkt.
    //
    // Att jämföra värdena räcker INTE. Båda körningarna ligger inom samma
    // millisekund, så `new Date()` ger samma tal och jämförelsen är grön även om
    // fältet skrivs om varje gång — uppmätt: negativkontrollen som alltid satte
    // `anonymizedAt` gav 11/11 gröna innan den här raden fanns.
    //
    // Vi mäter i stället att den andra skrivningen inte ens NÄMNER fältet.
    expect(state.updates).toHaveLength(2)
    expect(state.updates[0]).toHaveProperty('anonymizedAt')
    expect(Object.keys(state.updates[1]!)).not.toContain('anonymizedAt')
    expect(second.anonymizedAt).toEqual(first.anonymizedAt)

    // Och returvärdet skiljer fallen åt, så anroparen slipper gissa.
    expect(first.performed).toBe(true)
    expect(second.performed).toBe(false)
  })

  it('skrubbar ändå data som tillkommit EFTER den första körningen', async () => {
    const state = freshState()
    await anonymizeTenantWithin(fakeTx(state), TENANT, ORG, ACTOR)

    // En ny nyckelkvittens med ett namn dyker upp efteråt.
    state.keyHandovers.push({ tenantId: TENANT, issuedToName: 'Ny Person' })

    await anonymizeTenantWithin(fakeTx(state), TENANT, ORG, ACTOR)

    // Idempotens betyder samma SLUTTILLSTÅND, inte "gör ingenting". En tidig
    // retur på anonymizedAt hade lämnat namnet kvar.
    expect(state.keyHandovers.every((k) => k.issuedToName === null)).toBe(true)
    expect(state.logs).toHaveLength(1)
  })
})

describe('AI-lagret — riktad skrubbning där tenantId finns', () => {
  it('raderar hyresgästens EGNA konversationer, och bara dennes', async () => {
    const state = freshState()
    await anonymizeTenantWithin(fakeTx(state), TENANT, ORG, ACTOR)
    expect(state.aiTenantConversations.map((c) => c.id)).toEqual(['conv-annan'])
  })

  it('meddelandena följer med konversationen — och en annan hyresgästs blir kvar', async () => {
    const state = freshState()
    expect(state.aiTenantMessages).toHaveLength(4)
    await anonymizeTenantWithin(fakeTx(state), TENANT, ORG, ACTOR)
    expect(state.aiTenantMessages).toEqual([{ conversationId: 'conv-annan' }])
  })

  it('nollar kopplingen i AiToolExecution utan att radera revisionsraden', async () => {
    const state = freshState()
    await anonymizeTenantWithin(fakeTx(state), TENANT, ORG, ACTOR)
    // Radantalet är OFÖRÄNDRAT — #505 väntar på revisor, underlaget rörs inte.
    expect(state.aiToolExecutions).toHaveLength(3)
    expect(state.aiToolExecutions.filter((r) => r.tenantId === TENANT)).toEqual([])
    expect(state.aiToolExecutions.filter((r) => r.tenantId === 'annan-hyresgast')).toHaveLength(1)
  })

  it('nollar kopplingen i AiAssignment — uppdraget försvinner ur hyresgästens historik', async () => {
    const state = freshState()
    await anonymizeTenantWithin(fakeTx(state), TENANT, ORG, ACTOR)
    // Radantalet är OFÖRÄNDRAT: uppdraget bär en människas beslut och är
    // revisionsspår över hyresvärdens handlingar, samma skäl som AiToolExecution.
    expect(state.aiAssignments).toHaveLength(3)
    // Men KOPPLINGEN är borta — och därmed raden ur historiken, som
    // sammanställs vid läsning och inte har någon andra kopia att glömma.
    expect(state.aiAssignments.filter((r) => r.tenantId === TENANT)).toEqual([])
    // Grannens uppdrag rörs inte. Avgränsningen är inte för grov.
    expect(state.aiAssignments.filter((r) => r.tenantId === 'annan-hyresgast')).toHaveLength(1)
  })

  it('nollar kopplingen i AiUsageLog utan att radera kvot-/faktureringsunderlaget', async () => {
    const state = freshState()
    await anonymizeTenantWithin(fakeTx(state), TENANT, ORG, ACTOR)
    expect(state.aiUsageLogs).toHaveLength(3)
    expect(state.aiUsageLogs.filter((r) => r.tenantId === TENANT)).toEqual([])
    expect(state.aiUsageLogs.filter((r) => r.tenantId === 'annan-hyresgast')).toHaveLength(1)
  })

  it('ämneskopplingen (#510) rörs INTE — keep är ett beslut, inte en glömska', async () => {
    // Att radera kopplingen hade gjort läget sämre: innehållet ligger kvar
    // oavsett, medan förmågan att HITTA raderna hade försvunnit. Fejken saknar
    // delegater för de två tabellerna — försöker koden röra dem kastar
    // aiDelegate "Okänd modell" och det här faller.
    const state = freshState()
    await expect(anonymizeTenantWithin(fakeTx(state), TENANT, ORG, ACTOR)).resolves.toBeDefined()
    const keeps = AI_TENANT_LINK_STEPS.filter((s) => s.action === 'keep').map((s) => s.model)
    expect(keeps.sort()).toEqual(['AiMemoryTenant', 'AiMessageTenant'])
  })

  it('KANARIEFÅGEL: skrubbningen körs även vid en ANDRA körning', async () => {
    // Idempotensen får inte bli "hoppa över AI-lagret när alreadyDone är true" —
    // då hade data som tillkommit efter första körningen blivit kvar för alltid.
    const state = freshState()
    await anonymizeTenantWithin(fakeTx(state), TENANT, ORG, ACTOR)
    state.aiTenantConversations.push({ id: 'conv-ny', tenantId: TENANT })
    state.aiUsageLogs.push({ tenantId: TENANT })
    await anonymizeTenantWithin(fakeTx(state), TENANT, ORG, ACTOR)
    expect(state.aiTenantConversations.map((c) => c.id)).toEqual(['conv-annan'])
    expect(state.aiUsageLogs.filter((r) => r.tenantId === TENANT)).toEqual([])
  })

  it('rör INTE AiMessage/AiMemory/AiConversation — de saknar tenantId (beslut D)', async () => {
    // Fejken saknar de delegaterna helt. Skulle någon lägga till ett steg för
    // dem kastar aiDelegate "Okänd modell" och det här faller.
    const state = freshState()
    await expect(anonymizeTenantWithin(fakeTx(state), TENANT, ORG, ACTOR)).resolves.toBeDefined()
  })
})

describe('felloggen (#612)', () => {
  /**
   * PÅKOPPLINGEN, PÅ ENHETSNIVÅ.
   *
   * Att FRÅGAN matchar rätt rader prövas mot riktig Postgres i
   * `anonymize-errorlog.db.spec.ts` — en attrapp kan inte köra `::text` och
   * `position()`. Det som mäts här är att steget körs alls och får hyresgästens
   * id som bundet värde, så att en bortkopplad rad fäller ETT test till även när
   * db-riggarna hoppas över (t.ex. i en miljö utan DATABASE_URL).
   */
  it('kör ErrorLog-raderingen med hyresgästens id som bundet värde', async () => {
    const state = freshState()
    await anonymizeTenantWithin(fakeTx(state), TENANT, ORG, ACTOR)

    const errorLogAnrop = state.rawCalls.filter((c) => c.sql.includes('"ErrorLog"'))
    expect(errorLogAnrop).toHaveLength(1)
    expect(errorLogAnrop[0]?.values).toEqual([TENANT, TENANT, TENANT])
  })

  it('id:t BINDS, det interpoleras inte in i SQL-texten', () => {
    const state = freshState()
    return anonymizeTenantWithin(fakeTx(state), TENANT, ORG, ACTOR).then(() => {
      const sql = state.rawCalls.find((c) => c.sql.includes('"ErrorLog"'))?.sql ?? ''
      // Nålen är en UUID från en raderingsbegäran; hamnar den i SQL-TEXTEN i
      // stället för bland parametrarna är det både en injektionsyta och ett
      // tecken på att någon bytt `$executeRaw` mot `$executeRawUnsafe`.
      expect(sql).not.toContain(TENANT)
    })
  })

  it('körs ÄVEN på en redan avidentifierad hyresgäst — nya felrader ska också falla', async () => {
    const state = freshState()
    await anonymizeTenantWithin(fakeTx(state), TENANT, ORG, ACTOR)

    const efterFörsta = freshState()
    efterFörsta.tenant['anonymizedAt'] = new Date('2026-01-01')
    await anonymizeTenantWithin(fakeTx(efterFörsta), TENANT, ORG, ACTOR)

    expect(efterFörsta.rawCalls.filter((c) => c.sql.includes('"ErrorLog"'))).toHaveLength(1)
  })
})

describe('revisionsspåret', () => {
  it('skriver aktör, org, mål och härkomst', async () => {
    const state = freshState()
    await anonymizeTenantWithin(fakeTx(state), TENANT, ORG, ACTOR)

    expect(state.logs[0]).toMatchObject({
      organizationId: ORG,
      tenantId: TENANT,
      performedById: 'user-1',
      ipAddress: '1.2.3.4',
      userAgent: 'jest',
    })
  })

  it('portalvägen loggas med performedById = null (hyresgästen själv)', async () => {
    const state = freshState()
    await anonymizeTenantWithin(fakeTx(state), TENANT, ORG, { performedById: null })

    // Null är ett VÄRDE här, inte ett saknat fält: en logg som bara känner till
    // operatörsvägen ger fel svar på "har den här personen begärt radering?".
    expect(state.logs).toHaveLength(1)
    expect(state.logs[0]!.performedById).toBeNull()
  })
})

/**
 * ── VAKT: VARJE AI-TABELL MED `tenantId` MÅSTE HANTERAS EXPLICIT ────────────
 *
 * Härleder mängden ur `schema.prisma` i stället för att lita på en handskriven
 * lista. Lägger någon till en ny `Ai*`-modell med `tenantId` i morgon faller
 * vakten tills modellen fått ett steg i `AI_TENANT_LINK_STEPS`.
 *
 * SKILLNADEN MOT `delete-organization.spec.ts` ÄR AVSIKTLIG OCH ÄR HELA POÄNGEN:
 * där räknas en `onDelete: Cascade` som täckning, eftersom org-raden FAKTISKT
 * raderas och kaskaden därmed fyrar. Här raderas hyresgästraden ALDRIG — det är
 * en avidentifiering, `tenant.update()` — så en kaskad fyrar aldrig och täcker
 * ingenting. `coversNothing` nedan är den regeln uttryckt mekaniskt, och den
 * andra kanariefågeln bevisar att den faktiskt gäller.
 */
interface AiModel {
  name: string
  hasTenantId: boolean
  /** Vad FK:n mot Tenant säger. Registreras för att kunna BORTSE från den. */
  onDeleteFromTenant: string | null
}

export function parseAiModels(schema: string): AiModel[] {
  return [...schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)]
    .map((m) => {
      const name = m[1] ?? ''
      const body = m[2] ?? ''
      const rel = body.split('\n').find((l) => /\s(Tenant)(\?|\[\])?\s/.test(l))
      return {
        name,
        hasTenantId: /^\s*tenantId\s+\S/m.test(body),
        onDeleteFromTenant: rel ? (/onDelete:\s*(\w+)/.exec(rel)?.[1] ?? null) : null,
      }
    })
    .filter((m) => m.name.startsWith('Ai'))
}

/**
 * AI-modeller som bär `tenantId` men inte hanteras av ett steg.
 *
 * `onDeleteFromTenant` läses ALDRIG här. Det är inte ett förbiseende — det är
 * kravet: en kaskad eller SetNull som aldrig fyrar får inte kunna räknas som
 * täckning. Se kanariefågel 2.
 */
export function uncoveredAiModels(models: AiModel[], handled: ReadonlySet<string>): string[] {
  return models
    .filter((m) => m.hasTenantId && !handled.has(m.name))
    .map((m) => m.name)
    .sort()
}

describe('VAKT: AI-tabeller med tenantId hanteras explicit vid avidentifiering', () => {
  const schema = readFileSync(SCHEMA, 'utf8')
  const models = parseAiModels(schema)
  const handled = new Set(AI_TENANT_LINK_STEPS.map((s) => s.model))

  it('parsern ser faktiskt schemat — utan detta kan allt nedan vara tomt och grönt', () => {
    expect(models.length).toBeGreaterThanOrEqual(8)
    expect(models.some((m) => m.name === 'AiMessage')).toBe(true)
    expect(models.filter((m) => m.hasTenantId).length).toBeGreaterThanOrEqual(3)
    // Minst en av dem deklarerar Cascade — annars mäter kanariefågel 2 ingenting.
    expect(models.some((m) => m.hasTenantId && m.onDeleteFromTenant === 'Cascade')).toBe(true)
  })

  it('varje AI-tabell med tenantId står i AI_TENANT_LINK_STEPS', () => {
    expect(uncoveredAiModels(models, handled)).toEqual([])
  })

  it('urvalet är exakt det förväntade — en tabell som TAPPAR tenantId ska märkas', () => {
    expect(
      models
        .filter((m) => m.hasTenantId)
        .map((m) => m.name)
        .sort(),
    ).toEqual([
      'AiAssignment',
      'AiMemoryTenant',
      'AiMessageTenant',
      'AiTenantConversation',
      'AiToolExecution',
      'AiUsageLog',
    ])
  })

  it('varje steg motsvarar en modell som finns i schemat', () => {
    const names = new Set(models.map((m) => m.name))
    expect(AI_TENANT_LINK_STEPS.map((s) => s.model).filter((m) => !names.has(m))).toEqual([])
  })

  it('inget steg står två gånger', () => {
    expect(AI_TENANT_LINK_STEPS.length).toBe(handled.size)
  })

  it('varje steg har en motivering — beslutet radera/nolla ska vara skrivet', () => {
    for (const step of AI_TENANT_LINK_STEPS) {
      expect(step.reason.length).toBeGreaterThan(80)
    }
  })

  it('AiMessage/AiMemory/AiConversation kräver INGET steg — de saknar tenantId', () => {
    // Motsatt riktning: vakten får inte börja kräva textsökningstabeller (D).
    for (const n of ['AiMessage', 'AiMemory', 'AiConversation']) {
      expect(models.find((m) => m.name === n)?.hasTenantId).toBe(false)
    }
    expect(AI_TENANT_LINK_STEPS.some((s) => ['AiMessage', 'AiMemory'].includes(s.model))).toBe(
      false,
    )
  })

  it('AiTenantMessage faller via sin kaskad mot konversationen — den kaskaden FYRAR', () => {
    // Den saknar tenantId och kräver därför inget eget steg, men den är i sin
    // helhet hyresgästens data. Att den försvinner beror på att vi RADERAR
    // konversationsraden. Byter någon den FK:n till SetNull/Restrict blir
    // meddelandena kvar föräldralösa — då ska det här falla.
    const m = /^model\s+AiTenantMessage\s*\{([\s\S]*?)^\}/m.exec(schema)?.[1] ?? ''
    const rel = m.split('\n').find((l) => /\sAiTenantConversation(\?|\[\])?\s/.test(l)) ?? ''
    expect(/onDelete:\s*Cascade/.test(rel)).toBe(true)
    expect(AI_TENANT_LINK_STEPS.some((s) => s.model === 'AiTenantConversation')).toBe(true)
  })

  it('clientKey mappar modellnamn till Prisma-klientens egenskap', () => {
    expect(aiClientKey('AiUsageLog')).toBe('aiUsageLog')
    expect(aiClientKey('AiTenantConversation')).toBe('aiTenantConversation')
  })

  // ── KANARIEFÅGLARNA ────────────────────────────────────────────────────────
  // Mäter SKILLNADEN injektionen gör, så en annans otäckta tabell inte dränker
  // signalen. Sonderna heter Kanariefagel* — verifierat att de namnen inte
  // finns i schemat (en sond som råkar heta något befintligt gör mätningen
  // tvetydig).
  const baseline = uncoveredAiModels(models, handled)
  const injected = (fejk: string): string[] =>
    uncoveredAiModels(parseAiModels(schema + '\n' + fejk), handled).filter(
      (n) => !baseline.includes(n),
    )

  it('sondnamnen finns inte redan i schemat', () => {
    expect(schema).not.toContain('AiKanariefagel')
  })

  it('KANARIEFÅGEL 1: en ny AI-tabell med tenantId rapporteras som otäckt', () => {
    const fejk = `model AiKanariefagelNy {\n  id String @id\n  tenantId String\n}\n`
    expect(parseAiModels(schema + '\n' + fejk).some((m) => m.name === 'AiKanariefagelNy')).toBe(
      true,
    )
    expect(injected(fejk)).toEqual(['AiKanariefagelNy'])
  })

  it('KANARIEFÅGEL 2: en Cascade mot Tenant räknas INTE som täckning', () => {
    // Exakt defekten vi hittade, uttryckt mekaniskt. AiTenantConversation SÅG
    // täckt ut i månader eftersom den kaskaderar — men avidentifiering raderar
    // aldrig hyresgästraden, så kaskaden fyrade aldrig. En vakt som accepterade
    // Cascade som täckning hade varit grön hela tiden.
    const fejk =
      `model AiKanariefagelKaskad {\n  id String @id\n  tenantId String\n` +
      `  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)\n}\n`
    const parsed = parseAiModels(schema + '\n' + fejk).find(
      (m) => m.name === 'AiKanariefagelKaskad',
    )
    // Parsern SER kaskaden...
    expect(parsed?.onDeleteFromTenant).toBe('Cascade')
    // ...och rapporterar modellen som otäckt ändå.
    expect(injected(fejk)).toEqual(['AiKanariefagelKaskad'])
  })

  it('KANARIEFÅGEL 3: en AI-tabell UTAN tenantId rapporteras INTE', () => {
    // Andra halvan: vakten får inte vara röd för allt nytt.
    const fejk = `model AiKanariefagelUtan {\n  id String @id\n  organizationId String\n}\n`
    expect(injected(fejk)).toEqual([])
  })
})
