/**
 * R2 steg 2 — BEVISET att bytet till exakt mängdmatchning är en no-op.
 *
 * ── Vad som byts, och varför ──────────────────────────────────────────────────
 *
 * `RolesGuard` var hierarkisk: `requiredRoles.some(r => userLevel >= H[r])`. Bara
 * den LÄGSTA rollen i listan hade effekt, resten var dekoration.
 * `@Roles('ACCOUNTANT','ADMIN','OWNER')` läste som "dessa tre" men BETYDDE
 * "ACCOUNTANT och uppåt" — MANAGER släpptes in utan att nämnas. Den missläsningen
 * gav nio inkasso-endpoints där en förvaltare kunde lämna över en hyresgästs
 * skuld till inkasso (R1).
 *
 * Steg 1 gjorde varje lista FULLSTÄNDIG: den räknar nu upp exakt de roller
 * guarden släpper in. Därmed ger `some(r => level >= H[r])` och `includes(role)`
 * per definition samma svar — och steg 2 kan byta semantik utan att något
 * beteende ändras.
 *
 * ── Varför det här testet ser ut som det gör ──────────────────────────────────
 *
 * "Per definition" är ett argument, inte ett bevis. Det här testet kör VARJE
 * rollista som faktiskt finns i kodbasen (159 grindade endpoints när steg 2
 * skrevs) genom BÅDA implementationerna, för VARJE roll — och kräver identiskt
 * svar i varje kombination.
 *
 * SUBJEKTET är den RIKTIGA `RolesGuard.canActivate`, inte en kopia av den nya
 * logiken. Ett test som jämförde två funktioner i testfilen hade bevisat att
 * testfilen är konsekvent med sig själv, inte att produktionskoden är det.
 *
 * ORAKLET är den gamla hierarkiska implementationen, bevarad här som referens.
 * Den är avsiktligt en ordagrann kopia av vad guarden gjorde före bytet — det är
 * hela poängen: den definierar "det tidigare beteendet" som bytet inte får ändra.
 *
 * Kör man testet FÖRE bytet jämför det hierarkisk mot hierarkisk och passerar
 * trivialt — vilket i sig bevisar att riggen faktiskt anropar den riktiga
 * guarden. Kör man det EFTER jämför det gammalt mot nytt, och då är det beviset.
 * Båda körningarna gjordes.
 *
 * Det här testet ERSÄTTER `role-lists-complete.spec.ts`, som blev tautologiskt
 * när semantiken byttes (dess `admittedBy()` degenererar till `listed` självt
 * under exakt matchning). Att behålla båda hade sett ut som två skydd men varit
 * ett.
 *
 * Källan parsas statiskt i stället för att importera fyrtio controllers — flera
 * drar in ESM-beroenden (aws-sdk, Anthropic) som ts-jest inte transformerar.
 * Parsern har därför ett rimlighetsgolv: hittar den för få listor är den trasig,
 * inte kodbasen bevisad.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { ForbiddenException } from '@nestjs/common'
import type { ExecutionContext } from '@nestjs/common'
import type { Reflector } from '@nestjs/core'
import { RolesGuard } from './roles.guard'

const ALL_ROLES = ['OWNER', 'ADMIN', 'MANAGER', 'ACCOUNTANT', 'VIEWER'] as const

/**
 * ORAKLET: rollhierarkin som `RolesGuard` använde FÖRE steg 2, ordagrant.
 * Ändras aldrig — den definierar det beteende bytet skulle bevara.
 */
const LEGACY_HIERARCHY: Record<string, number> = {
  OWNER: 5,
  ADMIN: 4,
  MANAGER: 3,
  ACCOUNTANT: 2,
  VIEWER: 1,
}

function legacyHierarchicalAllows(required: string[], role: string): boolean {
  const userLevel = LEGACY_HIERARCHY[role] ?? 0
  return required.some((r) => userLevel >= (LEGACY_HIERARCHY[r] as number))
}

/** SUBJEKTET: den riktiga guarden, med en Reflector-attrapp som matar in listan. */
function actualGuardAllows(required: string[], role: string): boolean {
  const reflector = { getAllAndOverride: () => required } as unknown as Reflector
  const guard = new RolesGuard(reflector)
  const context = {
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
  } as unknown as ExecutionContext
  try {
    return guard.canActivate(context) === true
  } catch (err) {
    if (err instanceof ForbiddenException) return false
    throw err
  }
}

interface RoleList {
  file: string
  endpoint: string
  listed: string[]
}

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(p))
    else if (entry.name.endsWith('.controller.ts')) out.push(p)
  }
  return out
}

function collectRoleLists(): RoleList[] {
  const found: RoleList[] = []
  for (const file of walk(join(__dirname, '..', '..'))) {
    const src = readFileSync(file, 'utf8')
    const base = /@Controller\(\s*['"`]([^'"`]*)['"`]/.exec(src)?.[1] ?? ''
    let classRoles = ''
    let seenClass = false
    let pending: string[] = []

    const rolesOf = (decorators: string[]): string => {
      const last = decorators.filter((d) => d.startsWith('@Roles')).pop()
      return last
        ? last
            .replace(/.*@Roles\(([^)]*)\).*/, '$1')
            .replace(/['"\s]/g, '')
            .replace(/UserRole\./g, '')
        : ''
    }

    for (const line of src.split('\n')) {
      const t = line.trim()
      if (/^export class /.test(t)) {
        classRoles = rolesOf(pending)
        pending = []
        seenClass = true
        continue
      }
      if (t.startsWith('@')) {
        pending.push(t)
        continue
      }
      const http = pending.find((d) => /^@(Get|Post|Patch|Put|Delete)\(/.test(d))
      if (seenClass && http && /^(async\s+)?[a-zA-Z_]\w*\s*\(/.test(t)) {
        const verb = /^@(\w+)/.exec(http)![1]!
        const path = /\(\s*['"`]([^'"`]*)['"`]/.exec(http)?.[1] ?? ''
        const roles = rolesOf(pending) || classRoles
        if (roles) {
          found.push({
            file: file.split('/').pop()!,
            endpoint: `${verb.toUpperCase()} /${base}${path ? `/${path}` : ''}`,
            listed: roles.split(',').filter(Boolean),
          })
        }
        pending = []
      } else if (t && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')) {
        if (!http) pending = []
      }
    }
  }
  return found
}

describe('R2 steg 2 · bytet till exakt matchning är en no-op', () => {
  const lists = collectRoleLists()

  it('parsern hittar faktiskt listorna (annars bevisar testet ingenting)', () => {
    // Utan golvet kan en trasig parser "bevisa" ekvivalens genom att inte hitta
    // något att jämföra. Kodbasen hade 159 grindade endpoints när steg 2 skrevs.
    expect(lists.length).toBeGreaterThan(150)
  })

  it('varje endpoint × varje roll ger IDENTISKT svar i båda implementationerna', () => {
    const mismatches: string[] = []
    let comparisons = 0

    for (const list of lists) {
      for (const role of ALL_ROLES) {
        comparisons++
        const before = legacyHierarchicalAllows(list.listed, role)
        const after = actualGuardAllows(list.listed, role)
        if (before !== after) {
          mismatches.push(
            `  ${list.endpoint}  [${list.listed.join(',')}]  roll=${role}  ` +
              `hierarkisk=${before ? 'SLÄPPS IN' : 'nekas'}  exakt=${after ? 'SLÄPPS IN' : 'nekas'}  (${list.file})`,
          )
        }
      }
    }

    expect(
      mismatches.length === 0
        ? ''
        : `\n${mismatches.length} av ${comparisons} jämförelser skiljer sig — bytet är INTE en no-op:\n` +
            `${mismatches.join('\n')}\n\n` +
            'Varje rad är en endpoint där en roll får ett annat svar än före bytet.\n' +
            'Är listan ofullständig? Kör R2 steg 1 igen: skriv ut alla roller\n' +
            'hierarkin släppte in, INNAN semantiken byts.\n',
    ).toBe('')

    // Skyddar mot en tom eller halv körning som annars passerat tyst.
    expect(comparisons).toBe(lists.length * ALL_ROLES.length)
    expect(comparisons).toBeGreaterThan(750)
  })

  it('lista utan roller släpper igenom alla (oförändrad kortslutning)', () => {
    // `if (!requiredRoles?.length) return true` — endpoints utan @Roles är
    // autentiserade men inte rollgrindade. Semantikbytet rör inte den vägen.
    for (const role of ALL_ROLES) {
      expect(actualGuardAllows([], role)).toBe(true)
    }
  })

  it('okänd roll nekas (fail-closed, oförändrat)', () => {
    // Hierarkin gav okänd roll nivå 0 → passerade ingenting. Exakt matchning
    // hittar den inte i någon lista → samma utfall, av en annan anledning.
    expect(actualGuardAllows(['VIEWER'], 'REVISOR_SOM_INTE_FINNS')).toBe(false)
    expect(actualGuardAllows(['OWNER', 'ADMIN'], '')).toBe(false)
  })
})
