/**
 * OBJEKTNIVÅ-SCOPNING — inventarium över skrivningar mot förälder-scopade modeller.
 *
 * ── Varför den här filen finns ────────────────────────────────────────────────
 *
 * Behörighetsytans golden-fil (#267) svarar på "får den här ROLLEN anropa den här
 * endpointen?". Den säger ingenting om "får den här anroparen röra just den HÄR
 * raden?". Det är två olika frågor, och den andra är den som gav #114 sitt
 * HIGH-fynd: `updateItem` verifierade att besiktningen tillhörde anroparens org,
 * men uppdaterade sedan posten enbart på `itemId` — så ett `itemId` från en annan
 * org gick igenom. Rollgrinden var korrekt hela tiden.
 *
 * ── Vad som INTE går att göra ────────────────────────────────────────────────
 *
 * Man kan inte statiskt BEVISA att en skrivning är scopad. Det kräver att man
 * följer var id:t kommer ifrån, och skydden i kodbasen har minst fyra former —
 * varav två är osynliga på raden:
 *
 *   A  kedje-query      findFirst({ where: { id, inspection: { organizationId } } })
 *   B  hjälpare         assertRelationsInOrg(orgId, { propertyId, … })
 *   C  scopat anrop     await this.findOne(ticketId, organizationId)
 *   D  annan nyckel     findFirst({ where: { id, tenantId } })   ← portalen
 *
 * En grind som kräver form A hade larmat falskt på B, C och D — alltså på
 * majoriteten av korrekt kod. En grind man lär sig ignorera är värre än ingen.
 *
 * ── Vad grinden inte SER — en annan sorts lucka ──────────────────────────────
 *
 * Formerna A–D ovan handlar om att inte kunna BEVISA skydd på ett skrivställe
 * grinden ser. Det som följer är något annat, och värre: skrivställen den inte
 * ser alls.
 *
 * Sökmönstret byggs av Prisma-accessorerna för de förälder-scopade modellerna —
 * punkt, accessor, punkt, operation: `invoiceLine` + `create`. (Exemplen här
 * skrivs medvetet utan den inledande punkten: med den hade parsern inventerat
 * sin egen dokumentation.) En NÄSTLAD skrivning går aldrig via barnets accessor:
 *
 *     tx.invoice.create({ data: { …, lines: { createMany: … } } })
 *
 * Här skrivs InvoiceLine, men i källan står bara `.invoice.` — och Invoice bär
 * eget organizationId, så modellen är inte ens med i accessor-listan. Hela
 * klassen nästlade skrivningar (`create`/`createMany`/`update`/`updateMany`/
 * `upsert`/`delete`/`deleteMany`/`connectOrCreate` inuti ett `data`-objekt) är
 * därmed osynlig för BÅDA mekanismerna: inventariet får ingen rad, och den
 * strukturella kontrollen itererar bara över det inventariet samlat in.
 *
 * Konsekvensen ska sägas rakt: för den skrivformen gäller INTE löftet att ingen
 * skrivväg kan tillkomma obemärkt. Ett framtida
 * `invoice.update({ where: { id: klientId }, data: { lines: { deleteMany, create } } })`
 * utan organizationId i `where` hade passerat båda mekanismerna tyst.
 *
 * KÄNDA NÄSTLADE SKRIVSTÄLLEN — manuellt granskade 2026-08-02, ej bevakade:
 *
 *     accounting/accounting.service.ts:378       JournalEntryLine
 *     ai/tools/tool-executor.service.ts:3155     JournalEntryLine
 *     ai/tools/tool-executor.service.ts:3263     JournalEntryLine
 *     invoices/invoices.service.ts:331           InvoiceLine
 *     invoices/invoices.service.ts:421           InvoiceLine
 *     consumption/consumption.service.ts:655     InvoiceLine
 *     deposits/deposits.service.ts:150           InvoiceLine
 *
 * Alla sju är verifierat org-scopade vid granskningstillfället: de sex create-
 * fallen sätter organizationId från en JWT-härledd parameter, och invoices:421
 * skriver på ett id som org-verifierats tidigare i samma funktion. Listan är en
 * ögonblicksbild, inte en grind — den ruttnar, och radnumren först. Den står här
 * för att en läsare annars drar slutsatsen att InvoiceLine och JournalEntryLine
 * är inventerade (de står klassificerade som förälder-scopade), när fyra av sex
 * InvoiceLine-vägar och samtliga JournalEntryLine-vägar saknas. Att flytta in
 * formen i inventariet är egen uppföljning.
 *
 * ── Vad som DÄREMOT går ──────────────────────────────────────────────────────
 *
 * Att upptäcka att en NY skrivväg tillkommit är trivialt avgörbart. Och det är
 * det man faktiskt vill: ingen skrivning mot en förälder-scopad modell ska dyka
 * upp utan att en människa tittat på den en gång.
 *
 * Därför två mekanismer med olika ambition:
 *
 *   1. INVENTARIET (golden-fil). Varje fil × modell × operation, med antal och
 *      DETEKTERAD skyddsform. Formen härleds — den underhålls inte för hand, så
 *      den kan inte ruttna. Nytt skrivställe ändrar en rad, och den raden måste
 *      någon godkänna.
 *
 *   2. DEN SMALA STRUKTURELLA KONTROLLEN. Bara där svaret är avgörbart:
 *      `update`/`delete` på id mot en förälder-scopad modell, i en funktion utan
 *      NÅGOT scopnings-uttryck alls. Det är #114:s exakta form. Om ingen av de
 *      fyra formerna syns någonstans i funktionen är det inte en tolkningsfråga.
 *
 * Inventariet bevisar alltså ingen säkerhet. Det gör bara omöjligt att lägga till
 * en skrivväg obemärkt — och det är den enda garantin som går att ge statiskt.
 *
 * ── Två riskformer, inte en ──────────────────────────────────────────────────
 *
 * FORM 1 — `update`/`delete` med `where: { id }`. Den klassiska IDOR:en (#114).
 * FORM 2 — `create` med förälder-FK från klienten. Minst lika farlig men ser inte
 *          ut som ett behörighetsproblem: den som skriver
 *          `create({ data: { ticketId } })` tänker "spara en kommentar", inte
 *          "behörighetskontroll". Det är därför form 2 behöver ett par ögon en
 *          gång, och varför inventariet omfattar den trots att den strukturella
 *          kontrollen inte kan uttala sig om den.
 *
 * Form 2 har en asymmetri värd att känna till: bara form 1 tvingar fram ett
 * nedskrivet undantag (CALLER_SCOPED). En `create`-hjälpare utan aktörskontext
 * slipper alltså motivera sig. MaintenanceService.addImages(ticketId, files) är
 * ett sådant fall — publik, utan organizationId-parameter, skriver
 * MaintenanceImage på ett ticketId den inte själv verifierar. Dess enda anropare
 * scopar korrekt idag (portalen, på tenantId), men en NY anropare som glömmer
 * kontrollen ändrar ingenting i inventariet: raden sitter inne i addImages och
 * förblir densamma. Känd avgränsning per 2026-08-02, inte åtgärdad här.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// ── Modellklassificering ─────────────────────────────────────────────────────

export interface ParentScoped {
  scope: 'parent-scoped'
  /** Föräldern som bär organizationId. Visas i felmeddelandet. */
  parent: string
}
export interface OutOfScope {
  scope: 'out'
  /** Varför modellen inte kan bära en objektnivå-IDOR. */
  reason: string
}
export type ModelScope = ParentScoped | OutOfScope

/**
 * Varje modell i schemat som saknar eget `organizationId` måste stå här.
 *
 * Listan är HANDSKRIVEN med flit. Att en modell saknar `organizationId` betyder
 * inte automatiskt att den är känslig — en refresh-token scopas av sitt eget
 * hemliga värde, en räntesats är global. Den bedömningen kan inte härledas ur
 * schemat, och att gissa den vore värre än att skriva ner den.
 *
 * Tillkommer en ny modell utan `organizationId` failar testet tills någon
 * klassificerat den. Det är avsikten: en ny förälder-scopad modell ska inte
 * kunna glida in i kodbasen utan att någon svarat på frågan.
 */
export const MODEL_SCOPES: Readonly<Record<string, ModelScope>> = {
  // ── Förälder-scopade: org-ägd data, adresserbar med ett id från klienten ──
  Unit: { scope: 'parent-scoped', parent: 'Property' },
  InvoiceEvent: { scope: 'parent-scoped', parent: 'Invoice' },
  InvoiceLine: { scope: 'parent-scoped', parent: 'Invoice' },
  InvoicePayment: { scope: 'parent-scoped', parent: 'Invoice' },
  PaymentReminder: { scope: 'parent-scoped', parent: 'Invoice' },
  JournalEntryLine: { scope: 'parent-scoped', parent: 'JournalEntry' },
  AiMessage: { scope: 'parent-scoped', parent: 'AiConversation' },
  MaintenanceImage: { scope: 'parent-scoped', parent: 'MaintenanceTicket' },
  MaintenanceComment: { scope: 'parent-scoped', parent: 'MaintenanceTicket' },
  RentNoticeLine: { scope: 'parent-scoped', parent: 'RentNotice' },
  RentNoticeEvent: { scope: 'parent-scoped', parent: 'RentNotice' },
  RentNoticePayment: { scope: 'parent-scoped', parent: 'RentNotice' },
  InspectionItem: { scope: 'parent-scoped', parent: 'Inspection' },
  InspectionImage: { scope: 'parent-scoped', parent: 'Inspection' },
  AiTenantConversation: { scope: 'parent-scoped', parent: 'Tenant' },

  // ── Utanför: kan inte bära en objektnivå-IDOR ────────────────────────────
  Organization: { scope: 'out', reason: 'toppnivån själv — inget att scopa mot' },
  RefreshToken: { scope: 'out', reason: 'auth-realm: scopas av tokenvärdet, inte av ett id' },
  PasswordResetToken: { scope: 'out', reason: 'auth-realm: scopas av tokenvärdet' },
  UserInvitation: { scope: 'out', reason: 'auth-realm: scopas av tokenvärdet' },
  TenantMagicLink: { scope: 'out', reason: 'auth-realm: scopas av tokenvärdet' },
  TenantSession: { scope: 'out', reason: 'auth-realm: scopas av sessionstoken' },
  PlatformUser: { scope: 'out', reason: 'egen realm (PlatformGuard), ingen org-koppling' },
  PlatformRefreshToken: { scope: 'out', reason: 'egen realm, scopas av tokenvärdet' },
  AiTenantMessage: {
    scope: 'out',
    reason: 'når bara via AiTenantConversation, som är klassificerad ovan',
  },
  CustomerNumberSequence: { scope: 'out', reason: 'global singleton-sekvens' },
  PlatformInvoiceNumberSequence: { scope: 'out', reason: 'global singleton-sekvens' },
  ReferenceInterestRate: { scope: 'out', reason: 'global referensdata (Riksbanken)' },
  FailedEmail: { scope: 'out', reason: 'systemdata, ingen kundadresserbar väg' },
  LegalChunkEmbedding: { scope: 'out', reason: 'global juridisk referensdata (RAG)' },
}

/** Modeller i schemat som saknar `organizationId`. Grunden för klassificeringen. */
export function modelsWithoutOrgId(schemaPath: string): string[] {
  const src = readFileSync(schemaPath, 'utf8')
  const models = [...src.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)]
  return models.filter((m) => !/\borganizationId\b/.test(m[2]!)).map((m) => m[1]!)
}

/** Prisma-klientens accessor för en modell: `InspectionItem` → `inspectionItem`. */
function accessorOf(model: string): string {
  return model.charAt(0).toLowerCase() + model.slice(1)
}

// ── Skrivställen ─────────────────────────────────────────────────────────────

/** Operationer som SKRIVER. `upsert` räknas — den kan skapa och ändra. */
const WRITE_OPS = [
  'create',
  'createMany',
  'update',
  'updateMany',
  'upsert',
  'delete',
  'deleteMany',
] as const

/** Form 1 = ändrar/tar bort en befintlig rad. Form 2 = skapar en ny. */
function riskFormOf(op: string): 1 | 2 {
  return op.startsWith('create') ? 2 : 1
}

export type ProtectionForm = 'A' | 'B' | 'C' | 'D' | 'INGEN'

export interface WriteSite {
  file: string
  model: string
  op: string
  line: number
  form: 1 | 2
  protection: ProtectionForm
}

/**
 * Vilken skyddsform syns i den omslutande funktionen?
 *
 * Detekteras, underhålls inte för hand — en handskriven klassificering hade
 * ruttnat i takt med att koden ändrades, och en ruttnad annotering är värre än
 * ingen: den ser ut som en granskning som gjorts.
 *
 * Ordningen är avsiktlig. A är starkast (scopningen syns på raden), D svagast av
 * de giltiga (rätt princip, annan nyckel). `INGEN` betyder att inget av de fyra
 * mönstren syns någonstans i funktionen — vilket för form 1 är den strukturella
 * kontrollens larm, och för form 2 en rad någon bör titta på.
 */
function detectProtection(fnBody: string): ProtectionForm {
  // A — scopningen står i själva queryn, via en relation som bär organizationId.
  if (/\bfind(First|Unique|Many)\b[\s\S]*?\{[^}]*\b\w+:\s*\{[^}]*organizationId/.test(fnBody)) {
    return 'A'
  }
  // B — en namngiven hjälpare som gör kontrollen.
  if (/\bassert\w*InOrg\b|\bassertMayActOnCollections\b/.test(fnBody)) return 'B'
  // C — ett anrop som tar org-id som argument. Scopningen sker inuti, inte här.
  // Måste tillåta kedjor (`this.inspectionsService.findOne(id, orgId)`), inte bara
  // `this.findOne(...)`: controllers delegerar till en tjänst, och den varianten
  // är minst lika vanlig som den korta.
  if (/\bthis(?:\.\w+)+\((?:[^)]*?,\s*)?(?:organizationId|orgId)\b/.test(fnBody)) return 'C'
  // D — samma princip, annan nyckel. Hyresgästportalen scopar på tenantId.
  if (/\bfind(First|Unique|Many)\b[\s\S]*?\btenantId\b/.test(fnBody)) return 'D'
  return 'INGEN'
}

/**
 * Den omslutande klassmetodens kropp.
 *
 * Hittas genom att gå BAKÅT till närmaste metodsignatur på klassnivå (två stegs
 * indrag — kodbasens Prettier-stil) och framåt till nästa. Grovt, men rätt
 * granularitet: skyddet ligger nästan alltid några rader ovanför skrivningen i
 * samma metod, och ett för STORT fönster ger falska godkännanden snarare än
 * falska larm — vilket är fel riktning att fela åt.
 *
 * Därför taket nedan: hittas ingen signatur används ett begränsat fönster i
 * stället för hela filen.
 */
function enclosingFunction(lines: string[], index: number): string {
  const SIGNATURE =
    /^ {2}(?:(?:private|public|protected|static|readonly)\s+)*(?:async\s+)?[a-zA-Z_]\w*\s*[(<]/
  let start = -1
  for (let i = index; i >= 0 && index - i < 400; i--) {
    if (SIGNATURE.test(lines[i]!)) {
      start = i
      break
    }
  }
  if (start === -1) start = Math.max(0, index - 60)

  let end = lines.length
  for (let i = index + 1; i < lines.length; i++) {
    if (SIGNATURE.test(lines[i]!)) {
      end = i
      break
    }
  }
  return lines.slice(start, end).join('\n')
}

function walkTs(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkTs(p))
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) out.push(p)
  }
  return out
}

/** Alla skrivningar mot förälder-scopade modeller, med detekterad skyddsform. */
export function collectWriteSites(srcDir: string): WriteSite[] {
  const parentScoped = Object.entries(MODEL_SCOPES)
    .filter(([, v]) => v.scope === 'parent-scoped')
    .map(([model]) => model)
  const byAccessor = new Map(parentScoped.map((m) => [accessorOf(m), m]))

  const pattern = new RegExp(
    `\\.(${[...byAccessor.keys()].join('|')})\\.(${WRITE_OPS.join('|')})\\(`,
  )

  const sites: WriteSite[] = []
  for (const file of walkTs(srcDir)) {
    const src = readFileSync(file, 'utf8')
    if (!pattern.test(src)) continue
    const lines = src.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const m = pattern.exec(lines[i]!)
      if (!m) continue
      const model = byAccessor.get(m[1]!)!
      const op = m[2]!
      sites.push({
        file: file.split('/src/')[1] ?? file,
        model,
        op,
        line: i + 1,
        form: riskFormOf(op),
        protection: detectProtection(enclosingFunction(lines, i)),
      })
    }
  }
  return sites
}

// ── Inventariets rader ───────────────────────────────────────────────────────

export interface InventoryRow {
  file: string
  model: string
  op: string
  count: number
  form: 1 | 2
  /** Alla former som förekommer på stället — sorterade, så raden är stabil. */
  protections: ProtectionForm[]
}

/**
 * Slår ihop skrivställen till en rad per fil × modell × operation.
 *
 * RADNUMMER INGÅR MEDVETET INTE. En nyckel med radnummer hade ändrats varje gång
 * någon la till en rad ovanför, och ett inventarium som brusar vid varje orörd
 * ändring slutar man läsa. Antalet fångar ändå en ny skrivning: `×7` blir `×8`.
 */
export function toInventory(sites: WriteSite[]): InventoryRow[] {
  const byKey = new Map<string, InventoryRow>()
  for (const s of sites) {
    const key = `${s.file}|${s.model}|${s.op}`
    const row = byKey.get(key)
    if (row) {
      row.count++
      if (!row.protections.includes(s.protection)) row.protections.push(s.protection)
    } else {
      byKey.set(key, {
        file: s.file,
        model: s.model,
        op: s.op,
        count: 1,
        form: s.form,
        protections: [s.protection],
      })
    }
  }
  for (const row of byKey.values()) row.protections.sort()
  // Kodpunkts-sortering, INTE localeCompare: filen committas och jämförs mellan
  // maskiner, och locale-ordning beror på ICU-bygget (samma läxa som #267).
  return [...byKey.values()].sort((a, b) => {
    const ka = `${a.model}|${a.file}|${a.op}`
    const kb = `${b.model}|${b.file}|${b.op}`
    return ka < kb ? -1 : ka > kb ? 1 : 0
  })
}

/**
 * Form 1-skrivningar där scopningen ligger hos ANROPAREN, inte i funktionen.
 *
 * Den femte legitima formen, och den enda som inte går att detektera: en intern
 * hjälpare som tar ett id som parameter och saknar aktörskontext helt. Den kan
 * inte scopa — det är per konstruktion anroparens ansvar.
 *
 * Formen är inte automatiskt ofarlig. "Privat metod som tar ett id" är exakt den
 * skepnad en verklig IDOR gömmer sig i, så den får ALDRIG detekteras bort. Den
 * måste skrivas ner, med ett påstående om vem som scopar i stället — och det
 * påståendet är vad en granskare läser.
 *
 * Nyckeln saknar radnummer med flit, av samma skäl som inventariet.
 */
export interface CallerScopedException {
  file: string
  model: string
  op: string
  /**
   * Hur många skrivställen undantaget FAKTISKT gäller.
   *
   * Utan siffran undantar nyckeln (fil × modell × operation) hela gruppen, och
   * ett nytt oskyddat anrop i samma fil hade tystats av ett undantag skrivet för
   * ett annat. Antalet gör undantaget till ett precist påstående i stället för
   * ett blankofullmakt: tillkommer ett till failar den strukturella kontrollen,
   * oberoende av att inventariet också visar det.
   */
  sites: number
  /** Vem scopar i stället, och varför det håller. Verifierat, inte antaget. */
  reason: string
}

export const CALLER_SCOPED: readonly CallerScopedException[] = [
  {
    file: 'units/unit-status.sync.ts',
    model: 'Unit',
    op: 'updateMany',
    sites: 2,
    reason:
      'syncUnitStatusFromLeases(db, unitId) är den enda platsen som håller Unit.status ' +
      'i synk med kontrakten (I1/#62). Den tar en prisma- ELLER transaktionsklient och ' +
      'har ingen aktörskontext alls — den kan inte scopa. Alla tre anropare skickar ett ' +
      'unitId de redan laddat: import.service (unit.id), leases.service (unitId i en ' +
      'redan org-verifierad lease-operation, samt lease.unitId). Skrivningen är dessutom ' +
      'en idempotent statussynk, inte en väg att sätta godtyckliga värden.',
  },
  {
    file: 'ai/tenant-ai.service.ts',
    model: 'AiTenantConversation',
    op: 'update',
    sites: 1,
    reason:
      'handleTextResponse(response, conversationId, message) är privat och rör bara ' +
      'updatedAt. Dess enda anropare skickar conversation.id från ' +
      'getOrCreateConversation(tenantId, …), som scopar på tenantId (form D). Id:t har ' +
      'alltså redan passerat portalens scopning innan det når hit.',
  },
]

function exceptionKey(x: { file: string; model: string; op: string }): string {
  return `${x.file}|${x.model}|${x.op}`
}

/**
 * Form 1-skrivningar utan synlig scopning OCH utan nedskrivet undantag — den
 * strukturella kontrollens larm.
 */
export function unscopedForm1(sites: WriteSite[]): WriteSite[] {
  // Budget per undantag, inte en blankofullmakt: de N första oskyddade ställena
  // i gruppen är täckta, resten larmar.
  const budget = new Map(CALLER_SCOPED.map((x) => [exceptionKey(x), x.sites]))
  const öppna: WriteSite[] = []
  for (const s of sites) {
    if (s.form !== 1 || s.protection !== 'INGEN') continue
    const kvar = budget.get(exceptionKey(s))
    if (kvar != null && kvar > 0) {
      budget.set(exceptionKey(s), kvar - 1)
      continue
    }
    öppna.push(s)
  }
  return öppna
}

/** Undantag som inte längre motsvarar något skrivställe — städas bort. */
export function staleExceptions(sites: WriteSite[]): CallerScopedException[] {
  const nycklar = new Set(sites.filter((s) => s.form === 1).map(exceptionKey))
  return CALLER_SCOPED.filter((x) => !nycklar.has(exceptionKey(x)))
}

// ── Rendering ────────────────────────────────────────────────────────────────

const FILE_COL = 52
const MODEL_COL = 24
const OP_COL = 12

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length)
}

const FORM_LABELS: Record<ProtectionForm, string> = {
  A: 'A kedje-query',
  B: 'B hjälpare',
  C: 'C scopat anrop',
  D: 'D annan nyckel',
  INGEN: 'INGEN UPPTÄCKT',
}

export function renderInventory(rows: InventoryRow[]): string {
  const out: string[] = []
  out.push('# Objektnivå-scopning — skrivningar mot förälder-scopade modeller')
  out.push('')
  out.push('GENERERAD FIL — redigera den aldrig för hand.')
  out.push('')
  out.push('En rad per fil × modell × operation. Ändras en rad har någon lagt till, tagit')
  out.push('bort eller flyttat en skrivning mot data som bara kan scopas via sin förälder.')
  out.push('Uppdatera med')
  out.push('')
  out.push('    pnpm --filter @eken/api authz:objects')
  out.push('')
  out.push('och säg i PR:en hur den nya skrivningen är scopad.')
  out.push('')
  out.push('FILEN BEVISAR INGEN SÄKERHET. Skyddsformen är DETEKTERAD, inte verifierad —')
  out.push('en heuristik som säger "det här mönstret syns i funktionen", inte "id:t är')
  out.push('kontrollerat". Filen garanterar att ingen skrivväg via en modells EGEN')
  out.push('Prisma-accessor (invoiceLine + create) tillkommer obemärkt — inte mer än så.')
  out.push('Se object-scope.ts för varför mer inte går att göra statiskt.')
  out.push('')
  out.push('INTE BEVAKAT: NÄSTLADE SKRIVNINGAR. En skrivning som går via förälderns')
  out.push('data-objekt — invoice.create({ data: { lines: { createMany: … } } }) — nämner')
  out.push('aldrig barnets accessor och syns därför inte här. Sju sådana ställen finns i')
  out.push('kodbasen (JournalEntryLine ×3, InvoiceLine ×4); de är manuellt granskade')
  out.push('2026-08-02 och listade med fil:rad i object-scope.ts. Att InvoiceLine och')
  out.push('JournalEntryLine står klassificerade längst ned betyder alltså INTE att deras')
  out.push('skrivyta är komplett här. En ny nästlad skrivning larmar inte.')
  out.push('')
  out.push('FORM 1 = update/delete på ett id (den klassiska IDOR:en, #114).')
  out.push('FORM 2 = create med förälder-FK (ser inte ut som ett behörighetsproblem,')
  out.push('         men skriver in i förälderns objekt — därför bevakad).')
  out.push('')
  out.push('SKYDDSFORMER:')
  out.push(
    '  A  scopningen står i queryn:  findFirst({ where: { id, parent: { organizationId } } })',
  )
  out.push('  B  namngiven hjälpare:        assertRelationsInOrg(orgId, { … })')
  out.push('  C  scopat metodanrop:         await this.findOne(id, organizationId)')
  out.push('  D  annan scopningsnyckel:     findFirst({ where: { id, tenantId } })  ← portalen')
  out.push('')
  out.push('En femte form går inte att detektera: en intern hjälpare utan aktörskontext,')
  out.push('där scopningen är anroparens ansvar. Den måste skrivas ner i CALLER_SCOPED med')
  out.push('ett påstående om vem som scopar i stället — se sista sektionen.')
  out.push('')

  const form1 = rows.filter((r) => r.form === 1)
  const form2 = rows.filter((r) => r.form === 2)

  for (const [title, group] of [
    [`## Form 1 — update/delete (${form1.length} rader)`, form1],
    [`## Form 2 — create (${form2.length} rader)`, form2],
  ] as const) {
    out.push('')
    out.push(title)
    out.push('')
    for (const r of group) {
      const n = r.count > 1 ? `×${r.count}` : '  '
      out.push(
        `${pad(r.model, MODEL_COL)}${pad(r.op, OP_COL)}${pad(r.file, FILE_COL)}${n}  ` +
          r.protections.map((p) => FORM_LABELS[p]).join(' + '),
      )
    }
  }

  out.push('')
  out.push('')
  out.push(`## Undantag: scopningen ligger hos anroparen (${CALLER_SCOPED.length} st)`)
  out.push('')
  out.push('Interna hjälpare utan aktörskontext. Formen är INTE automatiskt ofarlig — en')
  out.push('privat metod som tar ett id är exakt den skepnad en verklig IDOR gömmer sig i.')
  out.push('Därför står de här med ett verifierat påstående om vem som scopar i stället,')
  out.push('i stället för att detekteras bort.')
  out.push('')
  for (const x of [...CALLER_SCOPED].sort((a, b) => (a.file < b.file ? -1 : 1))) {
    out.push(`${x.model}.${x.op}  —  ${x.file}  (${x.sites} st)`)
    for (const line of wrapText(x.reason, 76)) out.push(`    ${line}`)
    out.push('')
  }

  out.push('')
  out.push('## Modeller utan eget organizationId')
  out.push('')
  out.push('Varje sådan modell måste vara klassificerad. Tillkommer en oklassificerad')
  out.push('failar testet — en ny förälder-scopad modell ska inte glida in obemärkt.')
  out.push('')
  const models = Object.entries(MODEL_SCOPES).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  for (const [model, scope] of models) {
    const desc =
      scope.scope === 'parent-scoped'
        ? `förälder-scopad via ${scope.parent}`
        : `utanför: ${scope.reason}`
    out.push(`${pad(model, 32)}${desc}`)
  }

  return out.join('\n').trimEnd() + '\n'
}

function wrapText(text: string, width: number): string[] {
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
