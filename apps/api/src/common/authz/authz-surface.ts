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

/**
 * Alla roller som finns i schemat — HÄRLEDDA, inte handskrivna (R4.0).
 *
 * Listan stod tidigare uppräknad här. Den blir aldrig fel i sig, men den kan bli
 * OFULLSTÄNDIG: läggs en roll till i Prisma-enumet utan att någon minns den här
 * filen mäter sonden aldrig den nya rollen, och golden-filen ser komplett ut
 * medan den tiger om en hel roll. Samma tysta lucka som objektinventariet
 * hanterar med sitt rimlighetsgolv (#273) — en bevakning som inte vet vad den
 * inte mäter.
 *
 * `Object.values` på Prisma-enumet gör listan självuppdaterande: en ny roll
 * dyker upp i mätningen, hamnar i golden-filen som en diff, och någon måste
 * godkänna den.
 */
export const ALL_ROLES: readonly UserRole[] = Object.values(UserRole)

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

/**
 * En endpoint UTAN rollgrind. `public` = `@Public()`, alltså helt utanför
 * JwtAuthGuard; annars är den autentiserad men öppen för varje roll (#434).
 */
export interface UngatedEndpoint {
  file: string
  endpoint: string
  public: boolean
  /** `@UseGuards(...)` som gäller (klass- eller metodnivå), tom om ingen. */
  guards: string
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
/**
 * #434 — endpoints UTAN rollgrind. Samma parsning som `collectEndpointRoles`;
 * det är komplementmängden, inte en andra läsning av källan.
 */
export function collectUngatedEndpoints(srcDir: string): UngatedEndpoint[] {
  return parseControllers(srcDir).ungated
}

export function collectEndpointRoles(srcDir: string): EndpointRoles[] {
  return parseControllers(srcDir).gated
}

function parseControllers(srcDir: string): {
  gated: EndpointRoles[]
  ungated: UngatedEndpoint[]
} {
  const found: EndpointRoles[] = []
  const ungated: UngatedEndpoint[] = []
  for (const file of walkControllers(srcDir)) {
    const src = readFileSync(file, 'utf8')
    const base = /@Controller\(\s*['"`]([^'"`]*)['"`]/.exec(src)?.[1] ?? ''
    let classRoles = ''
    let classGuards = ''
    let classIsPublic = false
    let seenClass = false
    let pending: string[] = []

    // #434: `@UseGuards(...)` är den ANDRA mekanismen. Frånvaro av @Roles
    // betyder inte att endpointen är ostyrd — plattformsadmin går via
    // PlatformGuard och hyresgästportalen via sin egen session. Utan den här
    // kolumnen hade avsnitt 1b lästs som en lista över hål, vilket vore falskt.
    const guardsOf = (decorators: string[]): string =>
      decorators
        .filter((d) => d.startsWith('@UseGuards'))
        .map((d) => d.replace(/.*@UseGuards\(([^)]*)\).*/, '$1').replace(/\s/g, ''))
        .join(' ')

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
        classGuards = guardsOf(pending)
        classIsPublic = pending.some((d) => /^@Public\(/.test(d))
        pending = []
        seenClass = true
        continue
      }
      if (t.startsWith('@')) {
        // Vakt VID KÄLLAN: parsern läser en rad i taget. En `@Roles(` utan
        // avslutande parentes på samma rad betyder att dekoratorn brutits, och
        // då kan ingenting nedanför lita på tolkningen — vare sig metodens egen
        // lista eller klassens. Att fånga det här, före all annan logik, täcker
        // båda: en metodlista som annars gett skräp, och en KLASSlista som
        // annars tyst hade smittat varje endpoint i filen.
        if (/^@Roles\(/.test(t) && !t.includes(')')) {
          throw new Error(
            `authz-surface: flerradig @Roles(...) i ${file}. Parsern läser en rad i taget ` +
              'och kan inte tolka den. Slå ihop dekoratorn till en rad, eller utöka parsern ' +
              'till att ackumulera fram till matchande parentes.',
          )
        }
        pending.push(t)
        continue
      }
      const http = pending.find((d) => /^@(Get|Post|Patch|Put|Delete)\(/.test(d))
      if (seenClass && http && /^(async\s+)?[a-zA-Z_]\w*\s*\(/.test(t)) {
        const verb = /^@(\w+)/.exec(http)![1]!
        const path = /\(\s*['"`]([^'"`]*)['"`]/.exec(http)?.[1] ?? ''
        const roles = rolesOf(pending) || classRoles
        if (roles) {
          const endpoint = `${verb.toUpperCase()} /${base}${path ? `/${path}` : ''}`
          const parsed = normalizeRoles(roles.split(',').filter(Boolean))
          // Parsern läser en rad i taget och antar att `@Roles(...)` ryms på en
          // rad — sant i hela kodbasen i dag, och Prettier bryter inte
          // dekoratorargument. Bryts den ändå matchar regexen inte, och strängen
          // "@Roles(" skulle överleva som ett "rollnamn": endpointen hamnar i
          // filen med SKRÄP i rollkolumnen i stället för att försvinna. Det är
          // subtilare än ett bortfall och lättare att godkänna av misstag.
          const okanda = parsed.filter((r) => !(ALL_ROLES as readonly string[]).includes(r))
          if (okanda.length) {
            throw new Error(
              `authz-surface: kunde inte tolka rollerna för ${endpoint} i ${file}: ` +
                `${okanda.join(', ')}. Sträcker sig @Roles(...) över flera rader? ` +
                'Parsern läser en rad i taget.',
            )
          }
          found.push({ file: file.split('/').pop()!, endpoint, roles: parsed })
        } else {
          // #434: ingen rollgrind. Raden hamnade tidigare INGENSTANS — golden-
          // filen registrerade bara det som HADE en gräns, så en SAKNAD gräns
          // var per konstruktion osynlig för driftbevakningen. Det var ett
          // medvetet val ("de flesta är självscopade"), men #81 visade att
          // "de flesta" inte räcker: GET /import/jobs var varken självscopad
          // eller avsedd att vara öppen, och ingenting fångade det.
          ungated.push({
            file: file.split('/').pop()!,
            endpoint: `${verb.toUpperCase()} /${base}${path ? `/${path}` : ''}`,
            public: pending.some((d) => /^@Public\(/.test(d)) || classIsPublic,
            guards: guardsOf(pending) || classGuards,
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
  const bySort = <T extends { endpoint: string; file: string }>(a: T, b: T): number => {
    const ka = `${a.endpoint}|${a.file}`
    const kb = `${b.endpoint}|${b.file}`
    return ka < kb ? -1 : ka > kb ? 1 : 0
  }
  return { gated: found.sort(bySort), ungated: ungated.sort(bySort) }
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
  // ── Förvaltningshandlingar: lagren är överens sedan #269 ──────────────────
  //
  // Hittat AV den här filen, första gången ytan ställdes bredvid sig själv.
  // Mönstret var systematiskt över nio operationer: HTTP släppte in MANAGER men
  // inte ACCOUNTANT, AI-lagret tvärtom. En förvaltare kunde skapa en felanmälan
  // i webben men inte genom att be assistenten, och en bokförare tvärtom.
  //
  // BESLUTAT 2026-08-01: AI-lagret rättar sig efter HTTP. MANAGER ja,
  // ACCOUNTANT nej. Att skapa fastigheter och avtal och att byta avtalsstatus
  // är förvaltning, inte ekonomi — samma linje som R1 drog för inkasso (agera
  // bindande i ekonomin = ACCOUNTANT och uppåt, förvalta = MANAGER och uppåt).
  //
  // GENOMFÖRT i #269: de nio ligger i MANAGER_ALLOWED_ACTIONS, och
  // MANAGEMENT_ONLY_ACTIONS stänger dem för ACCOUNTANT — spegelbilden av
  // ACCOUNTING_ONLY_ACTIONS, som saknades och var hela skälet till att
  // ACCOUNTANT-sidan inte gick att uttrycka.
  //
  // Därför står de som `must-agree` numera, inte `declared`: bevakningen har
  // gått från att VETA OM skillnaden till att FÖRHINDRA den. Glider något lager
  // isär igen failar testet i stället för att beskriva läget.
  {
    operation: 'Skapa en fastighet',
    endpoints: ['POST /properties'],
    serviceGate: null,
    aiTool: 'create_property',
    comparison: { kind: 'must-agree' },
  },
  {
    operation: 'Skapa en lägenhet eller lokal',
    endpoints: ['POST /units'],
    serviceGate: null,
    aiTool: 'create_unit',
    comparison: { kind: 'must-agree' },
  },
  {
    operation: 'Skapa ett hyresavtal',
    endpoints: ['POST /leases'],
    serviceGate: null,
    aiTool: 'create_lease',
    comparison: { kind: 'must-agree' },
  },
  {
    operation: 'Skapa hyresgäst och avtal i ett steg',
    endpoints: ['POST /leases/with-tenant'],
    serviceGate: null,
    aiTool: 'create_tenant_and_lease',
    comparison: { kind: 'must-agree' },
  },
  {
    operation: 'Uppdatera en hyresgäst',
    endpoints: ['PATCH /tenants/:id'],
    serviceGate: null,
    aiTool: 'update_tenant',
    comparison: { kind: 'must-agree' },
  },
  {
    operation: 'Byta status på ett hyresavtal',
    endpoints: ['PATCH /leases/:id/status'],
    serviceGate: null,
    aiTool: 'transition_lease_status',
    comparison: { kind: 'must-agree' },
  },
  {
    operation: 'Skapa en felanmälan',
    endpoints: ['POST /maintenance'],
    serviceGate: null,
    aiTool: 'create_maintenance_ticket',
    comparison: { kind: 'must-agree' },
  },
  {
    operation: 'Uppdatera en felanmälans status',
    endpoints: ['PATCH /maintenance/:id'],
    serviceGate: null,
    aiTool: 'update_maintenance_status',
    comparison: { kind: 'must-agree' },
  },
  {
    operation: 'Skapa en besiktning',
    endpoints: ['POST /inspections'],
    serviceGate: null,
    aiTool: 'create_inspection',
    comparison: { kind: 'must-agree' },
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

/**
 * FASTA kolumnbredder, inte `Math.max(...)` över innehållet.
 *
 * En innehållsberoende bredd låter den LÄNGSTA raden bestämma indraget för alla
 * andra: lägger någon till en endpoint som är ett tecken längre än dagens
 * längsta, flyttar sig 159 rader och en ändring av EN roll drunknar i
 * whitespace-brus. Det är precis det filen finns för att förhindra.
 *
 * Bredderna har marginal mot dagens längsta (53, 23 resp. 25 tecken). Spränger
 * något ändå taket degraderar `pad` tyst till en oformaterad rad — en skev rad
 * är billigt, en omflödad sektion är det inte.
 */
const ENDPOINT_COL = 62
const GATE_COL = 26
const TOOL_COL = 32

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
  ungated: UngatedEndpoint[]
}): string {
  const { endpoints, serviceGates, aiTools, ungated } = input
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
  out.push('Endpoints utan @Roles står i avsnitt 1b — de saknades helt fram till #434.')
  out.push('')
  for (const e of endpoints) {
    out.push(`${pad(e.endpoint, ENDPOINT_COL)}  ${rolesCell(e.roles)}`)
  }

  // #434 — TRE hinkar, inte två. `@Public()` betyder "inte den globala
  // JwtAuthGuard", INTE "oautentiserad": hyresgästportalen och plattformsadmin
  // opt:ar ur org-JWT:n och in i sin EGEN guard. En tvådelning hade påstått att
  // varje @Public-endpoint ligger öppen, vilket är falskt för de flesta av dem.
  const annanMekanism = ungated.filter((e) => e.guards !== '')
  const publika = ungated.filter((e) => e.public && e.guards === '')
  const öppna = ungated.filter((e) => !e.public && e.guards === '')

  out.push('')
  out.push('')
  out.push(`## 1b. HTTP-endpoints UTAN rollgrind (${ungated.length} st)`)
  out.push('')
  out.push('DE HÄR RADERNA ÄR INTE GRANSKADE. De står här för att en NY ogrindad')
  out.push('endpoint ska bli en diff någon måste godkänna — inte för att någon har')
  out.push('intygat att var och en av dem ska vara öppen.')
  out.push('')
  out.push('Fram till #434 saknades de helt. Motiveringen som stod här var att de')
  out.push('"flesta är självscopade", och just därför var luckan farlig: filen')
  out.push('registrerade bara det som HADE en gräns, så en SAKNAD gräns var per')
  out.push('konstruktion osynlig för driftbevakningen. #81 visade vad det kostade —')
  out.push('GET /import/jobs var varken självscopad eller avsedd att vara öppen, låg')
  out.push('öppen för VIEWER, och fanns inte i den här filen medan hålet var öppet.')
  out.push('')
  out.push(`### a) Org-inloggad, öppen för VARJE roll (${öppna.length} st)`)
  out.push('')
  out.push('Enbart den globala JwtAuthGuard. Många är självscopade (byt mitt lösenord,')
  out.push('läs mina notiser) — men "många" är inte "alla", och raden säger inte')
  out.push('vilket. Det är den här hinken #81 kom ur.')
  out.push('')
  for (const e of öppna) {
    out.push(`${pad(e.endpoint, ENDPOINT_COL)}  ${e.file}`)
  }

  out.push('')
  out.push(`### b) Styrda av en ANNAN mekanism (${annanMekanism.length} st)`)
  out.push('')
  out.push('@UseGuards(...) med egen guard. Frånvaro av @Roles betyder inte ostyrd:')
  out.push('plattformsadmin går via PlatformGuard, hyresgästportalen via sin egen')
  out.push('session. Raderna står här för fullständighetens skull — deras gräns bor')
  out.push('i guarden, inte i en rollista, och bevakas därför inte av kolumnen.')
  out.push('')
  for (const e of annanMekanism) {
    out.push(`${pad(e.endpoint, ENDPOINT_COL)}  ${pad(e.guards, 28)}  ${e.file}`)
  }

  out.push('')
  out.push(`### c) VERKLIGT ÖPPNA — ingen autentisering alls (${publika.length} st)`)
  out.push('')
  out.push('@Public() utan någon egen guard. Ingen inloggning krävs. En NY rad här är')
  out.push('den mest säkerhetskänsliga ändring den här filen kan visa.')
  out.push('')
  for (const e of publika) {
    out.push(`${pad(e.endpoint, ENDPOINT_COL)}  ${e.file}`)
  }

  out.push('')
  out.push('')
  out.push(`## 2. Tjänstegrindar (${serviceGates.length} st)`)
  out.push('')
  out.push('Chokepunkter med exakt matchning i tjänsten. Varje anropare passerar dem —')
  out.push('även de som aldrig ser en dekorator (AI-verktyg, köade jobb, interna')
  out.push('anropare). Det är här den bärande spärren ligger för bindande handlingar.')
  out.push('')
  for (const g of serviceGates) {
    out.push(`${pad(g.name, GATE_COL)}  ${rolesCell(g.roles)}`)
    out.push(`${pad('', GATE_COL)}  └─ ${g.guards}`)
  }

  out.push('')
  out.push('')
  out.push(`## 3. AI-verktyg som utför handlingar (${aiTools.length} st)`)
  out.push('')
  out.push('Utfallet är MÄTT, inte härlett: varje verktyg körs mot tool-executorns')
  out.push('riktiga rollgrindar för varje roll, och raden visar vilka som tog sig förbi.')
  out.push('Läsande verktyg saknas här — de grindas inte på roll.')
  out.push('')
  out.push('"Insläppt" betyder att rollen passerade den INLEDANDE rollgrinden — inte att')
  out.push('handlingen lyckas. Ett verktyg kan fortfarande neka längre ner av skäl som inte')
  out.push('rör roll (saknad resurs, ogiltigt läge). Raden mäter behörighetsgränsen, inte')
  out.push('utfallet.')
  out.push('')
  out.push('LÄS DEN HÄR SEKTIONEN BREDVID SEKTION 1. För förvaltningshandlingar sa lagren')
  out.push('  tidigare nästan motsatta saker: HTTP gav "ADMIN, MANAGER, OWNER" (POST')
  out.push('  /properties, /units, /leases, /maintenance, PATCH /tenants/:id …) medan AI')
  out.push('  gav "ACCOUNTANT, ADMIN, OWNER" för motsvarande verktyg. En förvaltare kunde')
  out.push('  skapa en felanmälan i webben men inte genom att be assistenten, och en')
  out.push('  bokförare tvärtom. Samma sorts odokumenterade oenighet som var R1, hittad')
  out.push('  av den här filen (#267).')
  out.push('')
  out.push('  ÅTGÄRDAT i #269: AI-lagret rättade sig efter HTTP — de nio verktygen ligger')
  out.push('  i MANAGER_ALLOWED_ACTIONS, och MANAGEMENT_ONLY_ACTIONS stänger dem för')
  out.push('  ACCOUNTANT. De står som must-agree i sektion 4, så drift failar testet.')
  out.push('')
  for (const t of aiTools) {
    out.push(`${pad(t.tool, TOOL_COL)}  ${rolesCell(t.roles)}`)
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
