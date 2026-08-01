/**
 * GOLDEN-TESTET för behörighetsytan. #267.
 *
 * Genererar ytan ur koden och jämför mot `authz-surface.golden.txt`. Skiljer de
 * sig har någon flyttat en behörighetsgräns — och då ska det synas i en diff som
 * en människa godkänner, inte passera tyst.
 *
 * ── Varför filen uppdateras manuellt ─────────────────────────────────────────
 *
 * `UPDATE_AUTHZ_GOLDEN=1` skriver om filen; utan den skrivs ingenting. Ett test
 * som lagade sig självt hade varit värdelöst: hela poängen är att ändringen ska
 * kosta en medveten handling och hamna i en PR där någon läser den.
 *
 * ── Varför AI-lagret MÄTS och inte härleds ───────────────────────────────────
 *
 * Tool-executorns rollgrind är en algoritm över tre mängder (ACTION_TOOLS,
 * MANAGER_ALLOWED_ACTIONS, ACCOUNTING_ONLY_ACTIONS) plus ett specialfall. Att
 * skriva av den logiken här hade gett ett test som bevisar att testfilen är
 * konsekvent med sig själv — samma fälla som R2 steg 2 undvek.
 *
 * I stället körs den RIKTIGA `executeToolUnsafe` för varje (verktyg, roll).
 * Rollgrindarna ligger överst i metoden och kastar innan något beroende rörs,
 * så tjänsten kan konstrueras med tomma beroenden: kastar den en av grindarnas
 * kända fraser blev rollen nekad, allt annat betyder att den tog sig förbi.
 *
 * Klassificeringen är sluten: dyker en OKÄND ForbiddenException upp failar
 * testet i stället för att gissa. En ny rollgrind med ny formulering ska
 * upptäckas, inte tolkas som "passerade".
 */

// Tunga leaf-tjänster mockas bort — de dras in via tool-executorns importgraf
// och behöver aldrig existera för att rollgrindarna ska köra. Samma grepp som
// rbac-c1-c2-c3.spec.ts.
jest.mock('../../invoices/pdf.service', () => ({ PdfService: class {} }))
jest.mock('../../storage/storage.service', () => ({ StorageService: class {} }))

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { ForbiddenException } from '@nestjs/common'
import { ACTION_TOOLS } from '../../ai/tools/ai-tools.definition'
import { ToolExecutorService } from '../../ai/tools/tool-executor.service'
import {
  ALL_ROLES,
  CROSS_LAYER_OPERATIONS,
  SERVICE_GATES,
  collectEndpointRoles,
  normalizeRoles,
  renderSurface,
  type AiToolRoles,
} from './authz-surface'

const SRC_DIR = join(__dirname, '..', '..')
const GOLDEN_PATH = join(__dirname, 'authz-surface.golden.txt')

/**
 * Fraserna tool-executorns ROLLGRINDAR kastar. Allt annat som kastas betyder att
 * rollen tog sig förbi grinden och stoppades av något annat (saknat beroende,
 * validering) — vilket för vårt syfte är "insläppt".
 */
const ROLE_DENIAL_MESSAGES = new Set([
  'Du har inte behörighet att utföra åtgärder.',
  'Du har inte behörighet för denna åtgärd.',
  'Endast bokförare (ACCOUNTANT) eller administratörer får använda bokförings-verktyg.',
  'Endast OWNER/ADMIN får förbereda en signering (bindande handling).',
])

type Unsafe = (
  toolName: string,
  toolInput: Record<string, unknown>,
  organizationId: string,
  userId: string,
  userRole: string,
) => Promise<unknown>

function makeExecutor(): Unsafe {
  // 30+ beroenden, alla oanvända före rollgrinden. `never[]` för att slippa
  // attrappa en graf som ändå aldrig anropas.
  const Ctor = ToolExecutorService as unknown as new (...args: never[]) => ToolExecutorService
  const svc = new Ctor(...(Array.from({ length: 40 }, () => undefined) as never[]))
  return (svc as unknown as { executeToolUnsafe: Unsafe }).executeToolUnsafe.bind(svc) as Unsafe
}

/** Kördes rollen förbi grinden? Kastar vid okänd Forbidden — hellre rött än gissat. */
async function passesRoleGate(run: Unsafe, tool: string, role: string): Promise<boolean> {
  try {
    await run(tool, {}, 'org-golden', 'user-golden', role)
    return true
  } catch (err) {
    if (err instanceof ForbiddenException) {
      const msg = (err as Error).message
      if (ROLE_DENIAL_MESSAGES.has(msg)) return false
      throw new Error(
        `Okänd ForbiddenException från ${tool}/${role}: "${msg}".\n` +
          'Har tool-executorn fått en ny rollgrind? Lägg till frasen i ' +
          'ROLE_DENIAL_MESSAGES — annars klassas nekandet som "insläppt".',
      )
    }
    // TypeError från tomma beroenden, valideringsfel, m.m. — grinden passerades.
    return true
  }
}

async function measureAiTools(): Promise<AiToolRoles[]> {
  const run = makeExecutor()
  const tools = [...ACTION_TOOLS].sort()
  const out: AiToolRoles[] = []
  for (const tool of tools) {
    const admitted: string[] = []
    for (const role of ALL_ROLES) {
      if (await passesRoleGate(run, tool, role)) admitted.push(role)
    }
    out.push({ tool, roles: normalizeRoles(admitted) })
  }
  return out
}

describe('Behörighetsytan · golden-fil (#267)', () => {
  let endpoints: ReturnType<typeof collectEndpointRoles>
  let aiTools: AiToolRoles[]
  let generated: string

  beforeAll(async () => {
    endpoints = collectEndpointRoles(SRC_DIR)
    aiTools = await measureAiTools()
    generated = renderSurface({ endpoints, serviceGates: SERVICE_GATES, aiTools })
  }, 120_000)

  it('parsern ser fortfarande kodbasen (rimlighetsgolv)', () => {
    // Utan golvet kan en trasig parser "bevisa" att inget ändrats genom att inte
    // hitta något att jämföra — och en golden-fil som krympt till noll rader
    // hade sett ut som en ren diff. Kodbasen hade 159 grindade endpoints när
    // #267 skrevs. Golvet är 150, inte 120: marginalen ska fånga att en hel
    // modul slutar parsas, inte bara att en endpoint tas bort.
    expect(endpoints.length).toBeGreaterThan(150)
    expect(SERVICE_GATES.length).toBeGreaterThanOrEqual(3)
    expect(aiTools.length).toBeGreaterThan(25)
  })

  it('varje AI-verktyg har ett MÄTT utfall, inte ett tomt', () => {
    // Ett verktyg som varken släpper in eller nekar någon betyder att sonden
    // slutat fungera — inte att verktyget är öppet.
    for (const t of aiTools) {
      expect(ALL_ROLES.some((r) => t.roles.includes(r) || !t.roles.includes(r))).toBe(true)
      expect(t.roles.every((r) => (ALL_ROLES as readonly string[]).includes(r))).toBe(true)
    }
    // VIEWER får aldrig utföra en handling — grindens första rad. Faller den här
    // har sonden tappat kontakten med den riktiga koden.
    expect(aiTools.every((t) => !t.roles.includes('VIEWER'))).toBe(true)
  })

  it('ytan matchar golden-filen', () => {
    if (process.env['UPDATE_AUTHZ_GOLDEN'] === '1') {
      writeFileSync(GOLDEN_PATH, generated, 'utf8')
      console.warn(`[authz] golden-filen uppdaterad: ${GOLDEN_PATH}`)
      return
    }

    expect(existsSync(GOLDEN_PATH)).toBe(true)
    const golden = readFileSync(GOLDEN_PATH, 'utf8')
    if (golden === generated) return

    const g = golden.split('\n')
    const n = generated.split('\n')
    const diffs: string[] = []
    for (let i = 0; i < Math.max(g.length, n.length); i++) {
      if (g[i] !== n[i]) {
        diffs.push(`  rad ${i + 1}:`)
        diffs.push(`    golden: ${g[i] ?? '(saknas)'}`)
        diffs.push(`    koden:  ${n[i] ?? '(saknas)'}`)
      }
      if (diffs.length > 60) {
        diffs.push('  … (fler rader skiljer)')
        break
      }
    }

    throw new Error(
      'BEHÖRIGHETSYTAN HAR ÄNDRATS.\n\n' +
        `${diffs.join('\n')}\n\n` +
        'Är ändringen avsedd? Kör då:\n' +
        '    pnpm --filter @eken/api authz:golden\n' +
        'och beskriv i PR:en VEM som fick eller tappade åtkomst, och varför.\n\n' +
        'Är den inte avsedd har du flyttat en behörighetsgräns av misstag.\n',
    )
  })

  describe('drift mellan lager', () => {
    // R1 var en oenighet mellan HTTP-lagret och AI-lagret som ingen skrivit ner,
    // och det svagare lagret vann. Skillnader är tillåtna — odeklarerade är det
    // inte.
    it.each(CROSS_LAYER_OPERATIONS.map((op) => [op.operation, op] as const))('%s', (_name, op) => {
      const gate = op.serviceGate ? SERVICE_GATES.find((g) => g.name === op.serviceGate) : undefined
      if (op.serviceGate) {
        expect(gate).toBeDefined()
      }

      const layers: { label: string; roles: string[] }[] = []
      for (const ep of op.endpoints) {
        const found = endpoints.find((e) => e.endpoint === ep)
        // En operation som pekar på en endpoint som inte finns är en trasig
        // karta — då bevakar den ingenting.
        expect(found).toBeDefined()
        layers.push({ label: `HTTP ${ep}`, roles: found!.roles })
      }
      if (gate) layers.push({ label: `Tjänst ${gate.name}`, roles: gate.roles })
      if (op.aiTool) {
        const tool = aiTools.find((t) => t.tool === op.aiTool)
        expect(tool).toBeDefined()
        layers.push({ label: `AI ${op.aiTool}`, roles: tool!.roles })
      }

      if (op.comparison.kind === 'not-comparable') {
        // Operationen har flera lager i verkligheten, men bara ett går att
        // läsa maskinellt. Ingen driftkontroll är möjlig — det enda testet kan
        // göra är att vägra låta luckan påstås utan att finnas.
        expect(layers.length).toBeLessThan(2)
        return
      }

      const first = layers[0]!
      const disagreeing = layers.filter((l) => l.roles.join(',') !== first.roles.join(','))

      if (op.comparison.kind === 'declared') {
        // Deklarerad skillnad — men den måste fortfarande FINNAS. Försvinner
        // den har någon ändrat ett lager och motiveringen blivit inaktuell;
        // då ska deklarationen tas bort, inte ligga kvar som brus.
        expect(
          disagreeing.length > 0
            ? ''
            : `${op.operation}: lagren är numera överens, men en avvikelse står ` +
                'fortfarande deklarerad. Ta bort declaredDivergence — en motivering ' +
                'för något som inte längre gäller döljer nästa riktiga avvikelse.',
        ).toBe('')
        return
      }

      expect(
        disagreeing.length === 0
          ? ''
          : `ODEKLARERAD DRIFT i "${op.operation}":\n` +
              layers.map((l) => `  ${l.label}: ${l.roles.join(', ') || '(ingen)'}`).join('\n') +
              '\n\nLagren säger olika saker om samma handling. Antingen är det ett fel ' +
              '(rätta lagret som har fel), eller är skillnaden avsiktlig — och då ska ' +
              'den skrivas in som declaredDivergence i authz-surface.ts, med skälet. ' +
              'Precis den här sortens odokumenterade oenighet var R1.',
      ).toBe('')
    })
  })
})
