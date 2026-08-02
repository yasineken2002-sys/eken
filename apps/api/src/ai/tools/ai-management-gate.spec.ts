/**
 * #269 — FÖRVALTNINGSGRÄNSEN I AI-LAGRET.
 *
 * HTTP har alltid sagt `MANAGER, ADMIN, OWNER` för de nio förvaltnings-
 * handlingarna (POST /properties, /units, /leases, /maintenance, /inspections,
 * PATCH /tenants/:id, PATCH /leases/:id/status …). AI-lagret sa tvärtom:
 * MANAGER nekades av MANAGER_ALLOWED_ACTIONS, medan ACCOUNTANT slapp igenom
 * eftersom ingen lista uttryckte "det här är förvaltning, bokföraren ska inte
 * hit". En bokförare kunde alltså skapa ett hyresavtal genom att be
 * assistenten — en väg API:et nekar.
 *
 * Behörighetsytans golden-fil (#267) hittade oenigheten och bevakar den nu som
 * `must-agree`. DET HÄR TESTET BEVISAR BETEENDET, inte bara kartan: grinden
 * körs för varje roll och varje verktyg, precis som R1:s test gör för inkasso.
 * Kartan kan bara säga att lagren är överens; det här säger vad som händer.
 *
 * Verktygen anropas mot en executor med tomma beroenden. Det räcker, och det är
 * själva poängen: rollgrinden ligger FÖRE all exekvering, så ett nekande syns
 * som ForbiddenException medan ett insläpp faller på något helt annat (TypeError
 * från en attrapp som inte har metoden). Skillnaden mellan de två utfallen är
 * exakt behörighetsgränsen.
 */

// Tunga transitiva beroenden (S3/Puppeteer) — de laddas via invoices.service och
// har inget med rollgrinden att göra. Samma attrapper som authz-surface.spec.ts.
jest.mock('../../invoices/pdf.service', () => ({ PdfService: class {} }))
jest.mock('../../storage/storage.service', () => ({ StorageService: class {} }))

import { ForbiddenException } from '@nestjs/common'
import { ToolExecutorService } from './tool-executor.service'
import {
  ACTION_TOOLS,
  ACCOUNTING_ONLY_ACTIONS,
  MANAGEMENT_ONLY_ACTIONS,
} from './ai-tools.definition'

/** De nio operationerna beslutet gäller. Skriven här, inte importerad. */
const NIO_FORVALTNINGSVERKTYG = [
  'create_property',
  'create_unit',
  'create_lease',
  'create_tenant_and_lease',
  'update_tenant',
  'transition_lease_status',
  'create_maintenance_ticket',
  'update_maintenance_status',
  'create_inspection',
] as const

type Unsafe = (
  toolName: string,
  toolInput: Record<string, unknown>,
  organizationId: string,
  userId: string,
  userRole: string,
) => Promise<unknown>

function makeExecutor(): Unsafe {
  // 40 tomma beroenden ger marginal över dagens 24 — en tillagd konstruktor-
  // parameter ska inte tyst bli undefined på en position vi trodde vi fyllt.
  const Ctor = ToolExecutorService as unknown as new (...args: never[]) => ToolExecutorService
  const instans = new Ctor(...(Array.from({ length: 40 }, () => ({})) as never[]))
  return (instans as unknown as { executeToolUnsafe: Unsafe }).executeToolUnsafe.bind(instans)
}

/**
 * Nekade rollgrinden anropet?
 *
 * Bara ForbiddenException med grindens EGEN formulering räknas som nekande. Ett
 * annat fel betyder att grinden passerades och att exekveringen föll på något
 * annat — det är ett insläpp, inte ett nekande.
 */
async function nekas(run: Unsafe, tool: string, role: string): Promise<boolean> {
  try {
    await run(tool, {}, 'org-1', 'user-1', role)
    return false
  } catch (e) {
    return e instanceof ForbiddenException
  }
}

describe('#269 · förvaltningsgränsen i AI-lagret', () => {
  const run = makeExecutor()

  it('ACCOUNTANT nekas alla nio', async () => {
    const insläppta: string[] = []
    for (const tool of NIO_FORVALTNINGSVERKTYG) {
      if (!(await nekas(run, tool, 'ACCOUNTANT'))) insläppta.push(tool)
    }
    expect(insläppta).toEqual([])
  })

  it('MANAGER släpps in på alla nio', async () => {
    // Före #269 nekades MANAGER av MANAGER_ALLOWED_ACTIONS på samtliga nio.
    const nekade: string[] = []
    for (const tool of NIO_FORVALTNINGSVERKTYG) {
      if (await nekas(run, tool, 'MANAGER')) nekade.push(tool)
    }
    expect(nekade).toEqual([])
  })

  it('ADMIN och OWNER släpps in, VIEWER nekas', async () => {
    const utfall: Record<string, string[]> = { ADMIN: [], OWNER: [], VIEWER: [] }
    for (const tool of NIO_FORVALTNINGSVERKTYG) {
      for (const role of ['ADMIN', 'OWNER', 'VIEWER'] as const) {
        if (await nekas(run, tool, role)) utfall[role]!.push(tool)
      }
    }
    expect({ ADMIN: utfall['ADMIN'], OWNER: utfall['OWNER'] }).toEqual({ ADMIN: [], OWNER: [] })
    expect(utfall['VIEWER']).toEqual([...NIO_FORVALTNINGSVERKTYG])
  })

  it('AI-lagret ger nu SAMMA svar som HTTP för de nio', async () => {
    // HTTP:s @Roles-lista på samtliga nio endpoints är MANAGER, ADMIN, OWNER
    // (verifierat maskinellt av behörighetsytans golden-fil, #267). Här mäts
    // AI-sidan av samma påstående.
    const httpRoller = ['ADMIN', 'MANAGER', 'OWNER']
    const aiRoller: Record<string, string[]> = {}
    for (const tool of NIO_FORVALTNINGSVERKTYG) {
      const insläppta: string[] = []
      for (const role of ['VIEWER', 'ACCOUNTANT', 'MANAGER', 'ADMIN', 'OWNER']) {
        if (!(await nekas(run, tool, role))) insläppta.push(role)
      }
      aiRoller[tool] = insläppta.sort()
    }
    expect(aiRoller).toEqual(
      Object.fromEntries(NIO_FORVALTNINGSVERKTYG.map((t) => [t, httpRoller])),
    )
  })

  describe('listorna själva', () => {
    it('MANAGEMENT_ONLY_ACTIONS innehåller exakt de nio — inget verktyg fastnar av misstag', () => {
      expect([...MANAGEMENT_ONLY_ACTIONS].sort()).toEqual([...NIO_FORVALTNINGSVERKTYG].sort())
    })

    it('ingen operation är både förvaltning och bokföring', () => {
      // Vore ett verktyg med i båda listorna nekades ALLA utom ADMIN/OWNER —
      // en gräns ingen skrivit och ingen kan läsa sig till.
      const iBåda = [...MANAGEMENT_ONLY_ACTIONS].filter((t) => ACCOUNTING_ONLY_ACTIONS.has(t))
      expect(iBåda).toEqual([])
    })

    it('alla nio är handlingsverktyg — annars når grinden dem aldrig', () => {
      // Rollgrinden ligger inuti `if (ACTION_TOOLS.has(toolName))`. Ett verktyg
      // utanför den mängden passerar oavsett vad listorna säger, och då hade
      // testerna ovan mätt en grind som inte gäller.
      const utanför = NIO_FORVALTNINGSVERKTYG.filter((t) => !ACTION_TOOLS.has(t))
      expect(utanför).toEqual([])
    })
  })
})
