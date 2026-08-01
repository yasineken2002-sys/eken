/**
 * R2 steg 1 — VARJE @Roles-LISTA SKRIVER UT ALLA ROLLER DEN SLÄPPER IN.
 *
 * `RolesGuard` är hierarkisk: `requiredRoles.some(r => userLevel >= H[r])`. Bara
 * den LÄGSTA rollen i listan har effekt. `@Roles('ACCOUNTANT','ADMIN','OWNER')`
 * läses därför som "dessa tre" men BETYDER "ACCOUNTANT och uppåt" — MANAGER
 * ligger över ACCOUNTANT och släpps in utan att nämnas.
 *
 * Det är inte en teoretisk läsbarhetsfråga. Exakt den missläsningen gav nio
 * inkasso-endpoints där en förvaltare kunde lämna över en hyresgästs skuld till
 * inkasso (R1), och den fanns kvar i ytterligare fyra listor efteråt.
 *
 * DET HÄR TESTET KRÄVER ATT LISTAN OCH VERKLIGHETEN STÄMMER ÖVERENS. En lista
 * som släpper in en roll den inte nämner fäller testet. Två saker följer:
 *
 *   1. Nästa utvecklare kan LITA på listan. Står MANAGER inte där, kommer
 *      MANAGER inte in — och står den där är det ett medvetet val, inte en
 *      biverkning av var i hierarkin rollen råkade hamna.
 *
 *   2. R2 steg 2 (byt guarden till exakt mängdmatchning) blir en BEVISBAR
 *      no-op. När varje lista redan är fullständig ger `some(r => level >= H[r])`
 *      och `includes(role)` per definition samma svar på varje endpoint.
 *
 * När steg 2 landat blir "fullständig" och "exakt" samma sak, och det här testet
 * ersätts av ekvivalenstestet som jämför de två implementationerna direkt.
 *
 * Läser källan statiskt i stället för att importera fyrtio controllers — flera
 * av dem drar in ESM-beroenden (aws-sdk, Anthropic) som ts-jest inte
 * transformerar. Parsern har därför en egen rimlighetskontroll längst ned: hittar
 * den för få listor är den trasig, inte kodbasen ren.
 *
 * DYNAMISKA LISTOR: en statisk parser kan inte utvärdera `@Roles(...KONSTANT)`
 * eller en dekorator som slår in `Roles(...)`. Sådana finns inte i dag (verifierat),
 * och skulle någon skriva en blir tokenet oigenkännligt och faller på det TREDJE
 * testet ("bara kända roller") — alltså högljutt, inte tyst. Den utgången är
 * avsiktlig: får du ett tredje-test-fel på något som inte ser ut som en stavfel,
 * är det förmodligen en dynamisk lista som behöver skrivas ut.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** Måste spegla ROLE_HIERARCHY i roles.guard.ts. */
const HIERARCHY: Record<string, number> = {
  OWNER: 5,
  ADMIN: 4,
  MANAGER: 3,
  ACCOUNTANT: 2,
  VIEWER: 1,
}

interface RoleList {
  file: string
  endpoint: string
  listed: string[]
  admitted: string[]
  unlisted: string[]
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

/** Vilka roller släpper guarden in för en given lista? */
function admittedBy(listed: string[]): string[] {
  const min = Math.min(...listed.map((r) => HIERARCHY[r] ?? Number.POSITIVE_INFINITY))
  return Object.keys(HIERARCHY).filter((r) => HIERARCHY[r]! >= min)
}

function collectRoleLists(): RoleList[] {
  const found: RoleList[] = []
  for (const file of walk(join(__dirname, '..', '..'))) {
    const src = readFileSync(file, 'utf8')
    const base = /@Controller\(\s*['"`]([^'"`]*)['"`]/.exec(src)?.[1] ?? ''
    const lines = src.split('\n')
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

    for (const line of lines) {
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
          const listed = roles.split(',').filter(Boolean)
          const admitted = admittedBy(listed)
          found.push({
            file: file.split('/').pop()!,
            endpoint: `${verb.toUpperCase()} /${base}${path ? `/${path}` : ''}`,
            listed,
            admitted,
            unlisted: admitted.filter((r) => !listed.includes(r)),
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

describe('R2 steg 1 · @Roles-listorna är fullständiga', () => {
  const lists = collectRoleLists()

  it('parsern hittar faktiskt listor (rimlighetskontroll)', () => {
    // Utan den här kan en trasig parser rapportera "allt rent" genom att inte
    // hitta något alls. Golvet ligger nära det verkliga antalet (159 när R2
    // steg 1 landade) i stället för löst under: en parser som tyst slutar se en
    // handfull filer — t.ex. efter en import-omflyttning som stör
    // `export class`-matchningen, eller en controller i en katalog `walk()`
    // inte når — ska falla, inte glida igenom med marginal.
    expect(lists.length).toBeGreaterThan(150)
  })

  it('ingen lista släpper in en roll den inte nämner', () => {
    const dishonest = lists.filter((l) => l.unlisted.length > 0)
    const detail = dishonest
      .map(
        (l) =>
          `  ${l.endpoint}  [${l.listed.join(',')}]  släpper ÄVEN in: ${l.unlisted.join(',')}  (${l.file})`,
      )
      .join('\n')
    expect(
      dishonest.length === 0
        ? ''
        : `\n${dishonest.length} @Roles-lista(or) säger inte vad de gör:\n${detail}\n\n` +
            'Skriv ut alla roller guarden släpper in. Vill du utesluta en roll som ligger\n' +
            'ÖVER den lägsta listade går det inte via dekoratorn — hierarkin tillåter det\n' +
            'inte. Lägg spärren i tjänsten med exakt matchning (se CLOSE_ROLES,\n' +
            'REVERSAL_ROLES, COLLECTION_ACTION_ROLES).\n',
    ).toBe('')
  })

  it('varje lista innehåller bara kända roller', () => {
    const unknown = lists.filter((l) => l.listed.some((r) => HIERARCHY[r] === undefined))
    expect(unknown.map((l) => `${l.endpoint}: ${l.listed.join(',')}`)).toEqual([])
  })
})
