/**
 * BEHÖRIGHETSYTAN — genererar den fullständiga bilden av vem som får göra vad.
 *
 * ── Varför den här filen finns ────────────────────────────────────────────────
 *
 * Under R2 steg 1–3 fanns en bred bevakning över samtliga `@Roles`-listor: ett
 * test som parsade varje controller vid VARJE körning och jämförde utfallet mot
 * ett orakel. Den bevakningen försvann när oraklet (den gamla rollhierarkin)
 * övergavs — men det var mekanismen som bar värdet, inte oraklet. Utan den syns
 * en ändrad rollista bara för den som råkar granska rätt rad. #267.
 *
 * Ersättningen är en GOLDEN-FIL: ytan skrivs ut som text, committas, och varje
 * ändring blir en diff en människa måste godkänna. Filen bevisar ingenting om
 * huruvida en gräns är RÄTT — den gör bara omöjligt att flytta en gräns utan att
 * någon ser det.
 *
 * ── De tre lagren, och varför de går att jämföra ─────────────────────────────
 *
 * Evenos behörighet bor på tre ställen med olika form:
 *
 *   HTTP      `@Roles(...)` per endpoint          → en lista
 *   Tjänst    CLOSE_ROLES m.fl. i chokepunkten    → en konstant
 *   AI        tool-executorns rollgrindar         → en algoritm över tre mängder
 *
 * Olika nyckelrymder (endpoint / metod / verktygsnamn) och olika notation. Men
 * alla tre svarar på samma fråga — VILKA ROLLER SLÄPPS IN — och den frågan är
 * den gemensamma normalformen. Därför är de jämförbara, och därför kan drift
 * mellan dem upptäckas.
 *
 * ── Vad som INTE är ett fel ──────────────────────────────────────────────────
 *
 * Lager får skilja sig åt. Inkasso-controllernas klassnivålista räknar upp
 * MANAGER medan `COLLECTION_ACTION_ROLES` inte gör det, och det är avsiktligt:
 * klasslistan täcker BÅDE läsning (som förvaltaren ska ha) och de bindande
 * handlingarna (som hen inte ska ha), och en klassnivålista kan inte skilja dem
 * åt. Ett test som krävde identiska mängder hade varit rött på main från dag ett.
 *
 * Det farliga är inte att lagren skiljer sig — det är att de skiljer sig utan att
 * någon skrivit ner varför. Precis så uppstod R1: HTTP-lagret och AI-lagret var
 * oense om vem som fick lämna en skuld till inkasso, ingen hade noterat det, och
 * det svagare lagret vann. Därför kräver `CROSS_LAYER_OPERATIONS` en DEKLARERAD
 * anledning för varje skillnad. Odeklarerad avvikelse failar.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { UserRole } from '@prisma/client'
import { CLOSE_ROLES } from '../../accounting/accounting-period.service'
import { REVERSAL_ROLES } from '../../accounting/accounting.service'
import { COLLECTION_ACTION_ROLES } from './collections-authz'

export const ALL_ROLES: readonly UserRole[] = [
  UserRole.OWNER,
  UserRole.ADMIN,
  UserRole.MANAGER,
  UserRole.ACCOUNTANT,
  UserRole.VIEWER,
]

/** Sorterar en rollmängd deterministiskt, så golden-filen inte brusar. */
export function normalizeRoles(roles: readonly string[]): string[] {
  return [...new Set(roles)].sort()
}

// ── Lager 1: HTTP-dekoratorerna ──────────────────────────────────────────────

export interface EndpointRoles {
  file: string
  endpoint: string
  roles: string[]
}

function walkControllers(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkControllers(p))
    else if (entry.name.endsWith('.controller.ts')) out.push(p)
  }
  return out
}

/**
 * Parsar `@Roles(...)` ur varje controller.
 *
 * Källan läses statiskt i stället för att importera fyrtio controllers — flera
 * drar in ESM-beroenden (aws-sdk, Anthropic) som ts-jest inte transformerar.
 * Parsern är ordagrant den som bar R2 steg 1 och 2; den är beprövad på exakt den
 * här kodbasen. Metodnivåns lista vinner över klassnivåns, precis som
 * `Reflector.getAllAndOverride` gör i runtime.
 */
export function collectEndpointRoles(srcDir: string): EndpointRoles[] {
  const found: EndpointRoles[] = []
  for (const file of walkControllers(srcDir)) {
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
            roles: normalizeRoles(roles.split(',').filter(Boolean)),
          })
        }
        pending = []
      } else if (t && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')) {
        if (!http) pending = []
      }
    }
  }
  // Ren kodpunkts-sortering, INTE localeCompare: filen committas och jämförs
  // mellan maskiner, och locale-ordning beror på ICU-bygget. Datan är ASCII
  // (URL:er och verktygsnamn), så det enda locale skulle tillföra är en
  // miljöberoende ordning som kan få golden-filen att brusa i CI.
  return found.sort((a, b) => {
    const ka = `${a.endpoint}|${a.file}`
    const kb = `${b.endpoint}|${b.file}`
    return ka < kb ? -1 : ka > kb ? 1 : 0
  })
}

// ── Lager 2: tjänstegrindarna ────────────────────────────────────────────────

export interface ServiceGate {
  name: string
  roles: string[]
  /** Vad grinden skyddar — läses av en människa i diffen, inte av testet. */
  guards: string
}

/**
 * Chokepunkterna: exakt matchning i tjänsten, som varje anropare passerar —
 * även de som aldrig ser en dekorator (AI-verktyg, köade jobb, interna
 * anropare). #194-mönstret.
 *
 * KÄND LUCKA: `reopenPeriod` har sin rollgrind som en inline-jämförelse
 * (`actorRole !== UserRole.OWNER`), inte en namngiven konstant, och kan därför
 * inte läsas härifrån. Den syns bara via sin dekorator nedan. Att bryta ut den
 * vore en ändring i behörighetslogik, vilket den här bevakningen medvetet
 * avstår från — se golden-filens huvud.
 */
export const SERVICE_GATES: readonly ServiceGate[] = [
  {
    name: 'CLOSE_ROLES',
    roles: normalizeRoles(CLOSE_ROLES),
    guards: 'stänga en bokföringsperiod',
  },
  {
    name: 'REVERSAL_ROLES',
    roles: normalizeRoles(REVERSAL_ROLES),
    guards: 'rätta ett verifikat',
  },
  {
    name: 'COLLECTION_ACTION_ROLES',
    roles: normalizeRoles(COLLECTION_ACTION_ROLES),
    guards: 'exportera/markera skickad till inkasso',
  },
]

// ── Lager 3 + korslager: operationer som lever på flera ställen ──────────────

export interface CrossLayerOperation {
  /** Läsbart namn på handlingen, inte på koden. */
  operation: string
  /** Endpoints (exakt som `collectEndpointRoles` namnger dem). */
  endpoints: string[]
  /** Tjänstegrindens namn, eller null om operationen saknar chokepunkt. */
  serviceGate: string | null
  /** AI-verktygsnamn, eller null om ingen AI-väg finns. */
  aiTool: string | null
  /**
   * Hur den här operationens lager förhåller sig till varandra.
   *
   * Tre olika saker som lätt blandas ihop — och som gjorde det i första utkastet,
   * tills testet sa ifrån:
   *
   *   `must-agree`     lagren ska säga exakt samma sak; varje skillnad är ett fel.
   *   `declared`       de skiljer sig, avsiktligt, av det skäl som anges. Skillnaden
   *                    måste FINNAS — försvinner den ska deklarationen bort, annars
   *                    ligger en inaktuell motivering kvar och döljer nästa riktiga.
   *   `not-comparable` operationen HAR flera lager i verkligheten, men de går inte
   *                    att läsa maskinellt (t.ex. en inline-jämförelse i stället för
   *                    en namngiven konstant). Ingen driftkontroll är möjlig — luckan
   *                    står här för att den ska vara synlig, inte för att den är okej.
   */
  comparison:
    | { kind: 'must-agree' }
    | { kind: 'declared'; reason: string }
    | { kind: 'not-comparable'; reason: string }
}

/**
 * Operationerna som finns i mer än ett lager. Handskriven — kopplingen mellan
 * en endpoint, en tjänstemetod och ett verktygsnamn finns ingenstans i koden att
 * härleda ur, och att gissa den vore värre än att skriva ner den.
 *
 * Listan är avsiktligt kort: bara BINDANDE handlingar har chokepunkt i tjänsten.
 */
export const CROSS_LAYER_OPERATIONS: readonly CrossLayerOperation[] = [
  {
    operation: 'Stänga en bokföringsperiod',
    endpoints: ['POST /accounting/periods/:year/:month/close'],
    serviceGate: 'CLOSE_ROLES',
    aiTool: 'close_period',
    comparison: { kind: 'must-agree' },
  },
  {
    operation: 'Rätta ett verifikat',
    endpoints: ['POST /accounting/journal/:id/reverse'],
    serviceGate: 'REVERSAL_ROLES',
    aiTool: null,
    comparison: { kind: 'must-agree' },
  },
  {
    operation: 'Exportera underlag till inkasso',
    endpoints: [
      'POST /collections/export/:invoiceId',
      'POST /collections/bulk-export',
      'POST /rent-collections/export/:noticeId',
      'POST /rent-collections/bulk-export',
    ],
    serviceGate: 'COLLECTION_ACTION_ROLES',
    aiTool: 'export_for_collection',
    comparison: {
      kind: 'declared',
      reason:
        'Dekoratorn är BREDARE än tjänstegrinden. Klassnivålistan på inkasso-' +
        'controllerna täcker både läsning (förfallostatus, som förvaltaren ska ha) ' +
        'och de bindande handlingarna (som hen inte ska ha) — en klassnivålista kan ' +
        'inte skilja dem åt. MANAGER passerar därför dekoratorn och nekas av ' +
        'tjänsten. Att smalna av klasslistan hade tagit läsningen med sig.',
    },
  },
  {
    operation: 'Markera som skickad till inkasso',
    endpoints: ['POST /collections/mark-sent/:invoiceId'],
    serviceGate: 'COLLECTION_ACTION_ROLES',
    aiTool: 'mark_sent_to_collection',
    comparison: {
      kind: 'declared',
      reason:
        'Samma sak som exporten ovan: klassnivålistan bär även läsvägarna, så ' +
        'MANAGER passerar dekoratorn och stoppas i tjänsten.',
    },
  },
  {
    operation: 'Öppna en stängd period igen',
    endpoints: ['POST /accounting/periods/:year/:month/reopen'],
    serviceGate: null,
    aiTool: null,
    comparison: {
      kind: 'not-comparable',
      reason:
        'Tjänstegrinden FINNS (actorRole !== OWNER i reopenPeriod) men är en ' +
        'inline-jämförelse, inte en namngiven konstant, och kan därför inte läsas ' +
        'härifrån. Ingen driftkontroll är möjlig för operationen. Luckan står här ' +
        'för att vara synlig — att bryta ut konstanten vore en ändring i ' +
        'behörighetslogik, vilket den här bevakningen avstår från.',
    },
  },
]

// ── Rendering av golden-filen ────────────────────────────────────────────────

export interface AiToolRoles {
  tool: string
  roles: string[]
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length)
}

function rolesCell(roles: string[]): string {
  return roles.length ? roles.join(', ') : '(ingen släpps in)'
}

/**
 * Skriver ut hela ytan som text.
 *
 * TEXT, inte JSON: en granskare ska kunna läsa diffen och se "aha, MANAGER fick
 * tillgång till X". En rad per endpoint, fast kolumnbredd, deterministisk
 * sortering — så att en ändrad rollista blir en ändrad rad och ingenting annat.
 */
export function renderSurface(input: {
  endpoints: EndpointRoles[]
  serviceGates: readonly ServiceGate[]
  aiTools: AiToolRoles[]
}): string {
  const { endpoints, serviceGates, aiTools } = input
  const out: string[] = []

  out.push('# Behörighetsytan i Eveno')
  out.push('')
  out.push('GENERERAD FIL — redigera den aldrig för hand.')
  out.push('')
  out.push('Varje rad är ett svar på frågan "vilka roller släpps in här?". Ändras en rad har')
  out.push('någon flyttat en behörighetsgräns. Uppdatera filen med')
  out.push('')
  out.push('    pnpm --filter @eken/api authz:golden')
  out.push('')
  out.push('och förklara ändringen i PR-beskrivningen. Att filen ändras är inte ett fel —')
  out.push('att den ändras UTAN att någon nämner det är det.')
  out.push('')
  out.push('Filen säger inget om huruvida en gräns är RÄTT. Den gör bara omöjligt att')
  out.push('flytta en gräns utan att någon ser det. Se authz-surface.ts.')
  out.push('')

  out.push('')
  out.push(`## 1. HTTP-endpoints med rollgrind (${endpoints.length} st)`)
  out.push('')
  out.push('Endpoints utan @Roles saknas här med flit: de är autentiserade men inte')
  out.push('rollgrindade, och de flesta är självscopade (byt mitt lösenord, läs mina')
  out.push('notiser). Vill du veta vilka de är: sök efter controllers utan @Roles.')
  out.push('')
  const epWidth = Math.max(...endpoints.map((e) => e.endpoint.length), 10)
  for (const e of endpoints) {
    out.push(`${pad(e.endpoint, epWidth)}  ${rolesCell(e.roles)}`)
  }

  out.push('')
  out.push('')
  out.push(`## 2. Tjänstegrindar (${serviceGates.length} st)`)
  out.push('')
  out.push('Chokepunkter med exakt matchning i tjänsten. Varje anropare passerar dem —')
  out.push('även de som aldrig ser en dekorator (AI-verktyg, köade jobb, interna')
  out.push('anropare). Det är här den bärande spärren ligger för bindande handlingar.')
  out.push('')
  const sgWidth = Math.max(...serviceGates.map((g) => g.name.length), 10)
  for (const g of serviceGates) {
    out.push(`${pad(g.name, sgWidth)}  ${rolesCell(g.roles)}`)
    out.push(`${pad('', sgWidth)}  └─ ${g.guards}`)
  }

  out.push('')
  out.push('')
  out.push(`## 3. AI-verktyg som utför handlingar (${aiTools.length} st)`)
  out.push('')
  out.push('Utfallet är MÄTT, inte härlett: varje verktyg körs mot tool-executorns')
  out.push('riktiga rollgrindar för varje roll, och raden visar vilka som tog sig förbi.')
  out.push('Läsande verktyg saknas här — de grindas inte på roll.')
  out.push('')
  out.push('⚠ LÄS DEN HÄR SEKTIONEN BREDVID SEKTION 1. För förvaltningshandlingar säger')
  out.push('  lagren nästan motsatta saker: HTTP ger "ADMIN, MANAGER, OWNER" (POST')
  out.push('  /properties, /units, /leases, /maintenance, /tenants …) medan AI ger')
  out.push('  "ACCOUNTANT, ADMIN, OWNER" för motsvarande verktyg. En förvaltare kan')
  out.push('  alltså skapa en felanmälan i webben men inte genom att be assistenten,')
  out.push('  och en bokförare kan skapa en fastighet via assistenten men inte via API:et.')
  out.push('  Det är samma sorts odokumenterade oenighet mellan lager som var R1 — hittad')
  out.push('  av den här filen, spårad separat, INTE åtgärdad här (#267 bygger bevakning,')
  out.push('  inte ändrad behörighet). Sektion 4 nedan täcker än så länge bara de')
  out.push('  bindande bokförings- och inkassohandlingarna.')
  out.push('')
  const toolWidth = Math.max(...aiTools.map((t) => t.tool.length), 10)
  for (const t of aiTools) {
    out.push(`${pad(t.tool, toolWidth)}  ${rolesCell(t.roles)}`)
  }

  out.push('')
  out.push('')
  out.push(`## 4. Operationer som finns i flera lager (${CROSS_LAYER_OPERATIONS.length} st)`)
  out.push('')
  out.push('Här upptäcks DRIFT. R1 var en oenighet mellan HTTP-lagret och AI-lagret som')
  out.push('ingen hade skrivit ner — och det svagare lagret vann. Skillnader är tillåtna,')
  out.push('men de måste vara deklarerade. En odeklarerad skillnad failar testet.')
  out.push('')

  const gateByName = new Map(serviceGates.map((g) => [g.name, g]))
  const toolByName = new Map(aiTools.map((t) => [t.tool, t]))
  const epByName = new Map(endpoints.map((e) => [e.endpoint, e]))

  for (const op of CROSS_LAYER_OPERATIONS) {
    out.push(`### ${op.operation}`)
    out.push('')
    for (const ep of op.endpoints) {
      const found = epByName.get(ep)
      out.push(`  HTTP    ${pad(ep, 52)}  ${found ? rolesCell(found.roles) : '(SAKNAS I KODEN)'}`)
    }
    if (op.serviceGate) {
      const g = gateByName.get(op.serviceGate)
      out.push(
        `  Tjänst  ${pad(op.serviceGate, 52)}  ${g ? rolesCell(g.roles) : '(SAKNAS I KODEN)'}`,
      )
    } else {
      out.push(`  Tjänst  ${pad('—', 52)}  (ingen chokepunkt)`)
    }
    if (op.aiTool) {
      const t = toolByName.get(op.aiTool)
      out.push(`  AI      ${pad(op.aiTool, 52)}  ${t ? rolesCell(t.roles) : '(SAKNAS I KODEN)'}`)
    } else {
      out.push(`  AI      ${pad('—', 52)}  (ingen AI-väg)`)
    }
    out.push('')
    if (op.comparison.kind === 'declared') {
      out.push('  → LAGREN SKILJER SIG, DEKLARERAT:')
      for (const line of wrap(op.comparison.reason, 72)) out.push(`    ${line}`)
    } else if (op.comparison.kind === 'not-comparable') {
      out.push('  → GÅR INTE ATT JÄMFÖRA MASKINELLT:')
      for (const line of wrap(op.comparison.reason, 72)) out.push(`    ${line}`)
    } else {
      out.push('  → lagren ska vara ÖVERENS')
    }
    out.push('')
  }

  return out.join('\n').trimEnd() + '\n'
}

function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/)
  const lines: string[] = []
  let line = ''
  for (const w of words) {
    if (line && line.length + 1 + w.length > width) {
      lines.push(line)
      line = w
    } else {
      line = line ? `${line} ${w}` : w
    }
  }
  if (line) lines.push(line)
  return lines
}
