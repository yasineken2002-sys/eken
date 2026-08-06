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
 * A–D letar dessutom efter mönstret NÅGONSTANS i funktionen, utan att binda det
 * till vilket id som faktiskt skrivs. Att den kopplingen inte byggs är ett
 * avgjort beslut med skäl och omprövningsvillkor — det står i `detectProtection`
 * och dupliceras inte här.
 *
 * För NÄSTLADE skrivningar (se nedan) finns en femte form som DÄREMOT är
 * avgörbar på plats:
 *
 *   P  förälder org-bunden   invoice.update({ where: { id, organizationId }, … })
 *
 * Den nästlade skrivningen kan inte scopas för egen del — den träffar de rader
 * föräldern pekar ut. Frågan är därför alltid "är föräldern bunden till en org?",
 * och svaret står i förälderns eget `where` eller `data`. A–D används fortfarande
 * som reserv när P inte syns.
 *
 * ── Två skrivformer: direkt och nästlad ─────────────────────────────────────
 *
 * DIREKT skrivning nämner barnets egen accessor: `invoiceLine` + `create`. Den
 * är trivial att hitta.
 *
 * NÄSTLAD skrivning gör det inte:
 *
 *     tx.invoice.create({ data: { …, lines: { createMany: … } } })
 *
 * Här skrivs InvoiceLine, men i källan står bara `.invoice.`. Ett mönster byggt
 * på accessorer ser ingenting — och Invoice bär eget organizationId, så modellen
 * är inte ens med i accessor-listan. Det var #273:s HIGH-fynd: sju sådana
 * skrivningar fanns i kodbasen och stod i ingen rad i inventariet, samtidigt som
 * InvoiceLine och JournalEntryLine stod klassificerade som förälder-scopade och
 * därmed fick ytan att se inventerad ut.
 *
 * Båda formerna inventeras nu. Den nästlade kräver tre saker som är värda att
 * känna till, för de är också dess gränser:
 *
 *   MODELLEN HÄRLEDS UR SCHEMAT. `lines` är InvoiceLine under Invoice och
 *   JournalEntryLine under JournalEntry — samma fältnamn, olika modell. Att
 *   gissa ur namnet hade gett både falsklarm och missar. Kartan byggs ur
 *   schema.prisma, samma sanning som Prisma-klienten genereras ur.
 *
 *   BARA RELATIONSFÄLT FÖLJS. Det är spärren mot falsklarm: `where: { lines:
 *   { some: … } }` är ett filter, `data: { name: { set: … } }` är en skalär.
 *   Ingen av dem är en relationsskrivning, och ingen av dem kan bli en rad.
 *
 *   NYTTOLASTEN KAN LIGGA I EN VARIABEL. `updateData.lines = { createMany: … }`
 *   följt av `data: updateData` är samma skrivning, och den enda av de sju som
 *   sitter under en `update`. En parser som bara läste anropets objektlitteral
 *   hade missat just det farligaste fallet och ändå sett komplett ut.
 *
 * Kvar utanför: nyttolast som byggs i en ANNAN funktion eller modul än anropet,
 * relationsfält som slås upp dynamiskt (`data: { [fält]: … }`), och rå SQL.
 * Ingen av dem förekommer i kodbasen i dag — men de är inte bevakade, och det är
 * skillnad på "finns inte" och "fångas".
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

export type ProtectionForm = 'A' | 'B' | 'C' | 'D' | 'P' | 'INGEN'

export interface WriteSite {
  file: string
  model: string
  op: string
  line: number
  form: 1 | 2
  protection: ProtectionForm
  /**
   * Satt bara för NÄSTLADE skrivningar: `Invoice.lines`, alltså förälder-modellen
   * och relationsfältet skrivningen gick igenom. Direkta anrop saknar den.
   */
  via?: string
}

/**
 * Blankar ut strängar och kommentarer, men behåller längden.
 *
 * Mönstren nedan letar efter KOD. En sträng eller kommentar som råkar innehålla
 * rätt ord är inte ett skydd — den är text. Utan saneringen räcker
 * `notes: 'admin, organizationId-migrering pågår'` för att form C ska matcha och
 * skrivningen se scopad ut. Samma rotorsak som P-formen hade; se
 * `bindsOrganization`.
 */
function stripLiterals(src: string): string {
  let ut = ''
  let i = 0
  while (i < src.length) {
    const c = src[i]!
    if (c === "'" || c === '"' || c === '`') {
      const slut = skipString(src, i)
      ut += ' '.repeat(slut - i)
      i = slut
      continue
    }
    if (c === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i)
      const slut = nl === -1 ? src.length : nl
      ut += ' '.repeat(slut - i)
      i = slut
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      const e = src.indexOf('*/', i)
      const slut = e === -1 ? src.length : e + 2
      ut += ' '.repeat(slut - i)
      i = slut
      continue
    }
    ut += c
    i++
  }
  return ut
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
 *
 * ── BESLUT 2026-08-02: ingen dataflödeskoppling byggs ───────────────────────
 *
 * Den här funktionen letar efter skyddsmönster NÅGONSTANS i den omslutande
 * funktionen, utan att koppla dem till VILKET id som skrivs. En funktion som
 * org-scopar id A och sedan skriver på id B märks alltså som skyddad. Det är en
 * verklig strukturell svaghet, den är känd, och den lämnas MEDVETET öppen.
 * Frågan kartlades och avgjordes — det här är inte ett förbiseende.
 *
 * SKÄLEN, i fallande tyngd:
 *
 *   1. Kodbasens dominerande scopnings-idiom går inte att följa lokalt. Det ser
 *      ut så här: `const invoice = await this.service.findOne(id, orgId)` och
 *      sedan `invoice.id` i skrivningen. Medlemsåtkomst på ett objekt ur ett
 *      scopat METODANROP — över 20 av 67 skrivställen. En koppling som bara ser
 *      den egna funktionen landar på "okänt" för samtliga.
 *
 *   2. Det enda form 1-fall en namnkoppling inte klarar är KORREKT kod:
 *      inspections.controller.ts:183 hämtar besiktningen via ett scopat anrop,
 *      plockar ut posten ur en relationsarray med `.find()` och skriver på
 *      `existing.id` — metodgräns, array, medlemsåtkomst. Larmet därifrån kan
 *      bara tystas med ett CALLER_SCOPED-undantag för något som inte är ett
 *      undantag, och att lägga in undantag för korrekt kod är exakt hur en vakt
 *      ruttnar.
 *
 *   3. Buggen har aldrig inträffat här. Två säkerhetsgranskningar (#273, #274)
 *      har stickprovat samtliga form 1-rader utan att hitta ett enda fall där
 *      det verifierade id:t skiljer sig från det skrivna.
 *
 *   4. Priset vore 12 nedgraderade rader och ett falsklarm — alltså att byta en
 *      TYST strukturell svaghet mot SYNLIGT brus. Fel riktning: en grind man lär
 *      sig ignorera är värre än ingen.
 *
 *   5. Att göra det ordentligt kräver interprocedurell analys — ett eget
 *      statiskt analysverktyg med symbolupplösning. Det vore en mekanism ingen
 *      kan resonera om genom att läsa den här filen, tvärtemot hela designidén:
 *      säg bara det som är avgörbart, och var ärlig om resten.
 *
 * MÄTNING SOM STÄNGER EN NÄRLIGGANDE UTVÄG. Att i stället "göra A–D mer som P"
 * — alltså läsa skrivningens egen bindning — ger två rader: bara 2 av 60 direkta
 * skrivningar bär scopningen i sitt eget `where`. P är precis av konstruktion,
 * men har nästan ingen yta bland direkta anrop.
 *
 * RIKTNINGEN SOM FAKTISKT GER EN GARANTI (eget projekt, inte nu). Den statiska
 * vägen har nått avtagande avkastning. Buggklassen försvinner inte av bättre
 * läsning utan av att göras omöjlig att skriva: org-scopning framtvingad i
 * frågelagret (en Prisma client extension som kräver org-bindning på skrivningar
 * mot förälder-scopade modeller) eller row-level security i Postgres. Då blir
 * #114:s form ett RUNTIME-fel i stället för något en granskare ska upptäcka —
 * en garanti i stället för en heuristik.
 *
 * OMPRÖVAS OM något av detta inträffar:
 *
 *   • en granskning hittar ett verkligt fall av "verifierar A, skriver B", eller
 *   • kodbasen börjar skriva id:n som kommer direkt ur request-body medan ett
 *     ANNAT id verifieras.
 *
 * Då är antagandet bakom beslutet brutet och frågan ska ställas om — inte
 * besvaras med samma nej.
 */
function detectProtection(rawBody: string): ProtectionForm {
  const fnBody = stripLiterals(rawBody)
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
function enclosingFunctionSpan(lines: string[], index: number): [number, number] {
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
  return [start, end]
}

function enclosingFunction(lines: string[], index: number): string {
  const [start, end] = enclosingFunctionSpan(lines, index)
  return lines.slice(start, end).join('\n')
}

/**
 * Verktygets egna filer. Uteslutna, och det är INTE en bekvämlighet.
 *
 * Filen måste kunna visa hur ett skrivanrop ser ut för att förklara vad den
 * letar efter. Utan uteslutningen inventerar dokumentationen sig själv: i #273
 * gick form 2 från 29 till 30 rader av ett exempel i en kommentar, och raden såg
 * ut som en riktig skrivning i `common/authz/object-scope.ts`.
 *
 * Uteslutningen är säker just här och ingen annanstans: de här filerna innehåller
 * per konstruktion ingen Prisma-klient och kan därför inte dölja en verklig
 * skrivning. Listan får aldrig växa till kataloger eller mönster — då blir den
 * ett gömställe i stället för en avgränsning.
 */
const EGNA_FILER = ['object-scope.ts', 'object-scope.spec.ts', 'object-scope.golden.txt']

function ärEgenFil(path: string): boolean {
  return EGNA_FILER.some((f) => path.endsWith(`/common/authz/${f}`))
}

function walkTs(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkTs(p))
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts') && !ärEgenFil(p)) {
      out.push(p)
    }
  }
  return out
}

/** Direkta anrop: `prisma.invoiceLine.create(…)`. Barnets egen accessor står i koden. */
function collectDirectWriteSites(srcDir: string): WriteSite[] {
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

// ── Nästlade skrivningar ─────────────────────────────────────────────────────

/**
 * NÄSTLAD SKRIVNING: barnet skrivs via förälderns `data`-objekt.
 *
 *     tx.invoice.create({ data: { …, lines: { createMany: { data: rader } } } })
 *
 * Skrivningen träffar InvoiceLine, men barnets accessor står ingenstans i koden.
 * Ett mönster byggt på accessorer kan därför inte se den — det var #273:s HIGH.
 *
 * MODELLEN HÄRLEDS UR SCHEMAT, ALDRIG UR FÄLTNAMNET. `lines` betyder InvoiceLine
 * under Invoice och JournalEntryLine under JournalEntry, och `items` betyder
 * olika saker på fyra ställen. Att gissa ur namnet hade gett både falsklarm (fel
 * modell → rad mot en modell som inte skrivs) och missar (fält vars namn inte
 * liknar sin modell). Kartan nedan kommer från schema.prisma, som är samma
 * sanning Prisma-klienten själv genereras ur.
 */
export interface RelationField {
  /** Modellen fältet pekar på. */
  model: string
  /** Listrelation (`lines InvoiceLine[]`) eller enkelrelation (`lease Lease`). */
  isList: boolean
}

/** modell → relationsfält → vad fältet pekar på. Grunden för nästlad detektion. */
export function relationFields(schemaPath: string): Map<string, Map<string, RelationField>> {
  const src = readFileSync(schemaPath, 'utf8')
  const blocks = [...src.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)]
  const modelNames = new Set(blocks.map((b) => b[1]!))
  const out = new Map<string, Map<string, RelationField>>()
  for (const b of blocks) {
    const fields = new Map<string, RelationField>()
    for (const rad of b[2]!.split('\n')) {
      const trimmad = rad.trim()
      if (!trimmad || trimmad.startsWith('//') || trimmad.startsWith('@@')) continue
      const m = /^(\w+)\s+(\w+)(\[\])?/.exec(trimmad)
      if (!m) continue
      // Bara fält vars TYP är en modell är relationer. Skalärer och enum:ar
      // faller bort här — det är därför `data: { name: { set: … } }` aldrig kan
      // förväxlas med en relationsskrivning.
      if (!modelNames.has(m[2]!)) continue
      fields.set(m[1]!, { model: m[2]!, isList: m[3] === '[]' })
    }
    out.set(b[1]!, fields)
  }
  return out
}

/**
 * Nästlade operationer som SKRIVER barnraden.
 *
 * `connect`/`set`/`disconnect` skriver också — men bara mot LISTRELATIONER, där
 * de flyttar barnets främmande nyckel. Mot en enkelrelation sätter de i stället
 * FK:n på raden man redan skriver, alltså föräldern, och då vore en rad mot
 * barnet direkt felaktig. Skillnaden avgörs av `isList` ur schemat.
 */
const NESTED_OPS = [
  'create',
  'createMany',
  'update',
  'updateMany',
  'upsert',
  'delete',
  'deleteMany',
  'connectOrCreate',
] as const
const NESTED_LIST_ONLY_OPS = ['set', 'disconnect', 'connect'] as const

/** Föräldraoperationer som kan bära ett nästlat skrivblock. */
const PARENT_OPS = ['create', 'update', 'upsert', 'updateMany'] as const

function skipString(src: string, start: number): number {
  const quote = src[start]!
  let i = start + 1
  while (i < src.length) {
    const c = src[i]!
    if (c === '\\') {
      i += 2
      continue
    }
    if (c === quote) return i + 1
    if (quote === '`' && c === '$' && src[i + 1] === '{') {
      const slut = matchingBracket(src, i + 1)
      i = slut === -1 ? src.length : slut
      continue
    }
    i++
  }
  return src.length
}

/**
 * Index EFTER klammern som stänger den som står på `open`. -1 vid obalans.
 *
 * Strängar och kommentarer hoppas över — en `{` i en textsträng får inte räknas,
 * annars glider fönstret och parsern läser fel objekt.
 */
function matchingBracket(src: string, open: number): number {
  const par: Record<string, string> = { '{': '}', '[': ']', '(': ')' }
  const stack: string[] = [par[src[open]!]!]
  let i = open + 1
  while (i < src.length && stack.length > 0) {
    const c = src[i]!
    if (c === "'" || c === '"' || c === '`') {
      i = skipString(src, i)
      continue
    }
    if (c === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i)
      i = nl === -1 ? src.length : nl
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      const slut = src.indexOf('*/', i)
      i = slut === -1 ? src.length : slut + 2
      continue
    }
    if (c === '{' || c === '[' || c === '(') stack.push(par[c]!)
    else if (c === '}' || c === ']' || c === ')') {
      if (stack[stack.length - 1] !== c) return -1
      stack.pop()
    }
    i++
  }
  return stack.length === 0 ? i : -1
}

interface ObjectKey {
  key: string
  /** Index för nyckelns första tecken — radnumret rapporteras härifrån. */
  at: number
  /** Index för värdets första icke-blanka tecken. */
  value: number
  /** `{ data }` i stället för `{ data: … }` — värdet ÄR nyckelns namn. */
  shorthand: boolean
}

/** Slutet på ett värde: index efter kommat, eller objektets slut. */
function endOfValue(src: string, start: number, end: number): number {
  let i = start
  while (i < end) {
    const c = src[i]!
    if (c === "'" || c === '"' || c === '`') {
      i = skipString(src, i)
      continue
    }
    if (c === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i)
      i = nl === -1 ? end : nl
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      const slut = src.indexOf('*/', i)
      i = slut === -1 ? end : slut + 2
      continue
    }
    // Klamrar hoppas över i sin helhet — ett komma inuti dem avslutar inte
    // värdet, och en pilfunktion i en map() får inte klippa objektet mitt itu.
    if (c === '{' || c === '[' || c === '(') {
      const slut = matchingBracket(src, i)
      i = slut === -1 ? end : slut
      continue
    }
    if (c === ',') return i + 1
    if (c === '}' || c === ']' || c === ')') return i
    i++
  }
  return end
}

/**
 * Nycklarna på ÖVERSTA nivån i objektet vars `{` står på `open`.
 *
 * Värdet hoppas över i sin helhet efter varje nyckel. Utan det läser skannern
 * `data: updateData` som TVÅ nycklar — `data`, och sedan identifieraren
 * `updateData` som om den vore en kortformsnyckel.
 */
function topLevelKeys(src: string, open: number): ObjectKey[] {
  const end = matchingBracket(src, open)
  if (end === -1) return []
  const out: ObjectKey[] = []
  let i = open + 1
  while (i < end - 1) {
    const c = src[i]!
    if (/\s/.test(c) || c === ',' || c === ';') {
      i++
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      i = skipString(src, i)
      continue
    }
    if (c === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i)
      i = nl === -1 ? end : nl
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      const slut = src.indexOf('*/', i)
      i = slut === -1 ? end : slut + 2
      continue
    }
    const rest = src.slice(i, i + 160)
    const medVärde = /^(\w+)\s*:/.exec(rest)
    if (medVärde) {
      let v = i + medVärde[0]!.length
      while (v < end && /\s/.test(src[v]!)) v++
      out.push({ key: medVärde[1]!, at: i, value: v, shorthand: false })
      i = endOfValue(src, v, end)
      continue
    }
    // Kortform: `{ where, data }`. Värdet är variabeln med samma namn.
    const kortform = /^(\w+)\s*(?=[,}])/.exec(rest)
    if (kortform) {
      out.push({ key: kortform[1]!, at: i, value: i, shorthand: true })
      i += kortform[1]!.length
      continue
    }
    i = endOfValue(src, i, end)
  }
  return out
}

/** Radnummer (1-baserat) för ett index. */
function lineAt(src: string, index: number): number {
  let rad = 1
  for (let i = 0; i < index && i < src.length; i++) if (src[i] === '\n') rad++
  return rad
}

interface NestedHit {
  model: string
  op: string
  index: number
  via: string
}

/**
 * Går igenom ett `data`-objekt för `model` och plockar ut nästlade skrivningar.
 *
 * Bara relationsfält följs. Det är den avgörande spärren mot falsklarm: ett
 * `where: { lines: { some: … } }` är ett FILTER, inte en skrivning, och når hit
 * bara om `some` råkar heta som en skrivoperation — vilket den inte gör. Och
 * eftersom vi aldrig stiger ned i något annat än relationsfält och deras
 * operationsblock, kan select/include/orderBy aldrig producera en rad.
 */
function scanPayload(
  src: string,
  objOpen: number,
  model: string,
  rel: Map<string, Map<string, RelationField>>,
  hits: NestedHit[],
  depth: number,
): void {
  if (depth > 8) return
  const fält = rel.get(model)
  if (!fält) return
  for (const nyckel of topLevelKeys(src, objOpen)) {
    const relation = fält.get(nyckel.key)
    if (!relation) continue
    if (src[nyckel.value] !== '{') continue
    scanRelationBlock(src, nyckel.value, model, nyckel.key, relation, rel, hits, depth, nyckel.at)
  }
}

/**
 * Blocket som står EFTER ett relationsfält: `{ create: … }`, `{ deleteMany: … }`.
 *
 * Radnumret ankras på RELATIONSFÄLTET, inte på operationen. De ligger ofta på
 * skilda rader (`lines: {` … `createMany: {`), och fältet är det en granskare
 * letar efter — det är där man ser vilken förälder skrivningen går igenom.
 */
function scanRelationBlock(
  src: string,
  blockOpen: number,
  parentModel: string,
  field: string,
  relation: RelationField,
  rel: Map<string, Map<string, RelationField>>,
  hits: NestedHit[],
  depth: number,
  anchor: number,
): void {
  for (const op of topLevelKeys(src, blockOpen)) {
    const ärSkrivning =
      (NESTED_OPS as readonly string[]).includes(op.key) ||
      (relation.isList && (NESTED_LIST_ONLY_OPS as readonly string[]).includes(op.key))
    if (!ärSkrivning) continue
    hits.push({
      model: relation.model,
      op: op.key,
      index: anchor,
      via: `${parentModel}.${field}`,
    })
    recurseOpPayload(src, op.value, relation.model, rel, hits, depth + 1)
  }
}

/** Nyttolasten för en nästlad operation kan i sin tur bära nästlade skrivningar. */
function recurseOpPayload(
  src: string,
  value: number,
  model: string,
  rel: Map<string, Map<string, RelationField>>,
  hits: NestedHit[],
  depth: number,
): void {
  if (depth > 8) return
  if (src[value] === '[') {
    // `create: [ { … }, { … } ]`
    const end = matchingBracket(src, value)
    if (end === -1) return
    let i = value + 1
    while (i < end - 1) {
      const c = src[i]!
      if (c === '{') {
        scanPayload(src, i, model, rel, hits, depth)
        const slut = matchingBracket(src, i)
        i = slut === -1 ? end : slut
        continue
      }
      i++
    }
    return
  }
  if (src[value] !== '{') return
  // `update: { where: …, data: { … } }` — nyttolasten ligger under data/create/
  // update. Saknas de är objektet självt nyttolasten (`create: { … }`).
  const nycklar = topLevelKeys(src, value)
  const inre = nycklar.filter((k) => k.key === 'data' || k.key === 'create' || k.key === 'update')
  if (inre.length === 0) {
    scanPayload(src, value, model, rel, hits, depth)
    return
  }
  for (const k of inre) {
    if (src[k.value] === '{') scanPayload(src, k.value, model, rel, hits, depth)
    else if (src[k.value] === '[') recurseOpPayload(src, k.value, model, rel, hits, depth)
  }
}

/**
 * Nyttolast byggd i en VARIABEL, inte i anropet:
 *
 *     updateData.lines = { createMany: { data: rader } }
 *     await tx.invoice.update({ where: { id }, data: updateData })
 *
 * Utan den här vägen missas invoices.service.ts helt — och det är just den av de
 * sju kända skrivningarna som sitter under en `update` (alltså den enda med
 * form 1-karaktär i föräldern). En parser som bara läser anropets objektlitteral
 * hade alltså missat det farligaste fallet och sett komplett ut.
 *
 * Sökningen begränsas till den omslutande funktionen. Ett variabelnamn som
 * `updateData` återanvänds i flera metoder i samma fil, och utan begränsningen
 * hade en tilldelning i en annan metod tillskrivits det här anropet.
 */
function scanIdentifierPayload(
  src: string,
  radStart: number[],
  lines: string[],
  callIndex: number,
  ident: string,
  model: string,
  rel: Map<string, Map<string, RelationField>>,
  hits: NestedHit[],
): void {
  const fält = rel.get(model)
  if (!fält) return
  const [startLine, endLine] = enclosingFunctionSpan(lines, lineAt(src, callIndex) - 1)
  const från = radStart[startLine] ?? 0
  const till = radStart[endLine] ?? src.length
  const fönster = src.slice(från, till)

  const tilldelning = new RegExp(`\\b${ident}\\.(\\w+)\\s*=\\s*\\{`, 'g')
  let m: RegExpExecArray | null
  while ((m = tilldelning.exec(fönster)) !== null) {
    const relation = fält.get(m[1]!)
    if (!relation) continue
    const blockOpen = från + m.index + m[0]!.length - 1
    scanRelationBlock(src, blockOpen, model, m[1]!, relation, rel, hits, 0, från + m.index)
  }

  const deklaration = new RegExp(`\\b(?:const|let|var)\\s+${ident}\\b[^=\\n]*=\\s*\\{`, 'g')
  while ((m = deklaration.exec(fönster)) !== null) {
    scanPayload(src, från + m.index + m[0]!.length - 1, model, rel, hits, 0)
  }
}

/** Radernas startindex — för att kunna klippa ut en funktion ur källtexten. */
function lineOffsets(lines: string[]): number[] {
  const out: number[] = [0]
  let pos = 0
  for (const rad of lines) {
    pos += rad.length + 1
    out.push(pos)
  }
  return out
}

/**
 * Bär FÖRÄLDERNS anrop scopningen? Formen som bara finns för nästlade rader.
 *
 * En nästlad skrivning kan inte scopas för egen del — den träffar de rader
 * föräldern pekar ut. Frågan är därför alltid "är FÖRÄLDERN scopad?", och den
 * har två synliga svar: `where` som binder organizationId (uppdatering av en rad
 * i anroparens org) eller `data` som sätter organizationId (raden skapas i
 * anroparens org). Båda är avgörbara på plats, till skillnad från A–D som måste
 * letas i hela funktionen.
 */
function parentScoping(src: string, argOpen: number): boolean {
  for (const k of topLevelKeys(src, argOpen)) {
    if (k.key !== 'where' && k.key !== 'data' && k.key !== 'create' && k.key !== 'update') continue
    if (k.shorthand || src[k.value] !== '{') continue
    if (bindsOrganization(src, k.value, 0)) return true
  }
  return false
}

/**
 * Finns `organizationId` som NYCKEL i objektet — inte bara som text?
 *
 * Skillnaden är hela poängen. En första version testade regexet
 * `/\borganizationId\b/` mot spannets råtext, och då räckte en kommentar
 * ("// TODO: verifiera organizationId när multi-tenant landar") eller ett
 * strängvärde för att en helt oskyddad skrivning skulle märkas P. Det är inte ett
 * falsklarm utan dess motsats: raden såg granskad ut, och den strukturella
 * kontrollen slutade fälla den — precis den #114-klass verktyget finns för.
 * Säkerhetsgranskningen av den här PR:en hittade det och det är bevisat körbart.
 *
 * Nyckelläsaren hoppar över strängar och kommentarer, så den kan inte luras av
 * text. Både `{ id, organizationId }` (kortform) och `{ organizationId: orgId }`
 * räknas, liksom kedjan `{ id, invoice: { organizationId } }` — alla tre binder
 * raden till en organisation.
 */
function bindsOrganization(src: string, objOpen: number, depth: number): boolean {
  if (depth > 6) return false
  for (const k of topLevelKeys(src, objOpen)) {
    if (k.key === 'organizationId') return true
    if (k.shorthand || src[k.value] !== '{') continue
    if (bindsOrganization(src, k.value, depth + 1)) return true
  }
  return false
}

/**
 * Nästlade skrivningar i EN källtext.
 *
 * Exporterad för att kunna bevisas mot fixturer i stället för mot kodbasen. Ett
 * mönster som bara testas mot verklig kod kan bara visa att den koden passerar —
 * inte att en oskyddad skrivning FAKTISKT hade fällts, och inte att ett filter
 * (`where: { lines: { some } }`) INTE fälls. Båda riktningarna behöver bevisas.
 */
export function nestedWritesInSource(
  src: string,
  rel: Map<string, Map<string, RelationField>>,
): Array<Omit<WriteSite, 'file'>> {
  const parentScoped = new Set(
    Object.entries(MODEL_SCOPES)
      .filter(([, v]) => v.scope === 'parent-scoped')
      .map(([model]) => model),
  )
  const accessorTillModell = new Map([...rel.keys()].map((m) => [accessorOf(m), m]))
  const anropsMönster = new RegExp(`\\.(\\w+)\\.(${PARENT_OPS.join('|')})\\(`, 'g')
  const sites: Array<Omit<WriteSite, 'file'>> = []
  {
    const lines = src.split('\n')
    const radStart = lineOffsets(lines)
    // Samma nästlade skrivning kan nås från två föräldraanrop i samma funktion
    // (två update-anrop som delar nyttolastvariabel). Den ska räknas EN gång.
    const sedda = new Set<string>()
    anropsMönster.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = anropsMönster.exec(src)) !== null) {
      const modell = accessorTillModell.get(m[1]!)
      if (!modell) continue
      const parenOpen = m.index + m[0]!.length - 1
      let argOpen = parenOpen + 1
      while (argOpen < src.length && /\s/.test(src[argOpen]!)) argOpen++
      if (src[argOpen] !== '{') continue

      const hits: NestedHit[] = []
      for (const k of topLevelKeys(src, argOpen)) {
        if (k.key !== 'data' && k.key !== 'create' && k.key !== 'update') continue
        if (!k.shorthand && src[k.value] === '{') scanPayload(src, k.value, modell, rel, hits, 0)
        else if (!k.shorthand && src[k.value] === '[') {
          recurseOpPayload(src, k.value, modell, rel, hits, 0)
        } else {
          // `data: updateData` eller kortformen `{ where, data }` — nyttolasten
          // byggs i en variabel, som måste följas i den omslutande funktionen.
          const ident = /^([A-Za-z_]\w*)/.exec(src.slice(k.value, k.value + 60))
          if (ident) {
            scanIdentifierPayload(src, radStart, lines, m.index, ident[1]!, modell, rel, hits)
          }
        }
      }
      if (hits.length === 0) continue

      const föräldernScopad = parentScoping(src, argOpen)
      for (const hit of hits) {
        const nyckel = `${hit.model}|${hit.op}|${hit.index}|${hit.via}`
        if (sedda.has(nyckel)) continue
        sedda.add(nyckel)
        // Bara barn som saknar eget organizationId kan bära en objektnivå-IDOR.
        // Ett nästlat barn med egen org-kolumn står redan i sin egen dimension.
        if (!parentScoped.has(hit.model)) continue
        const rad = lineAt(src, hit.index)
        sites.push({
          model: hit.model,
          op: hit.op,
          line: rad,
          form: riskFormOf(hit.op),
          protection: föräldernScopad ? 'P' : detectProtection(enclosingFunction(lines, rad - 1)),
          via: hit.via,
        })
      }
    }
  }
  return sites
}

/** Alla nästlade skrivningar mot förälder-scopade modeller i kodbasen. */
function collectNestedWriteSites(srcDir: string, schemaPath: string): WriteSite[] {
  const rel = relationFields(schemaPath)
  const sites: WriteSite[] = []
  for (const file of walkTs(srcDir)) {
    const src = readFileSync(file, 'utf8')
    for (const s of nestedWritesInSource(src, rel)) {
      sites.push({ ...s, file: file.split('/src/')[1] ?? file })
    }
  }
  return sites
}

/**
 * Hela skrivytan: direkta anrop OCH nästlade skrivningar.
 *
 * Två insamlare, ett inventarium. Skillnaden syns i `via`-fältet och i
 * golden-filen, för en granskare behöver veta vilken fråga som gäller: för ett
 * direkt anrop "är det här id:t scopat?", för en nästlad "är FÖRÄLDERN scopad?".
 */
export function collectWriteSites(srcDir: string, schemaPath: string): WriteSite[] {
  return [...collectDirectWriteSites(srcDir), ...collectNestedWriteSites(srcDir, schemaPath)]
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
  /** `Invoice.lines` för nästlade rader, tomt för direkta anrop. */
  via?: string
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
    // `via` ingår i nyckeln: en nästlad skrivning och ett direkt anrop mot samma
    // modell i samma fil är TVÅ skrivvägar med olika scopningsfråga, och att slå
    // ihop dem hade dolt den ena bakom den andras skyddsform.
    const key = `${s.file}|${s.model}|${s.op}|${s.via ?? ''}`
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
        ...(s.via === undefined ? {} : { via: s.via }),
      })
    }
  }
  for (const row of byKey.values()) row.protections.sort()
  // Kodpunkts-sortering, INTE localeCompare: filen committas och jämförs mellan
  // maskiner, och locale-ordning beror på ICU-bygget (samma läxa som #267).
  //
  // FÄLTVIS jämförelse, inte en sammanslagen nyckel. En avgränsare hamnar i
  // kodpunktsordning bland bokstäverna (`|` ligger efter versaler), så `update`
  // och `updateMany` byter plats så fort ett fält läggs till i nyckeln — orörda
  // rader flyttar sig i diffen och ser ut som ändringar.
  const jämför = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
  return [...byKey.values()].sort(
    (a, b) =>
      jämför(a.model, b.model) ||
      jämför(a.file, b.file) ||
      jämför(a.op, b.op) ||
      jämför(a.via ?? '', b.via ?? ''),
  )
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
  {
    file: 'notifications/payment-reminder.service.ts',
    model: 'PaymentReminder',
    op: 'updateMany',
    sites: 1,
    reason:
      'sendFormalReminder skriver emailMessageId på markören efter commit (#357). ' +
      'Skrivningen ÄR org-bunden — `where` innehåller `invoice: { organizationId: ' +
      'invoice.organizationId }` — men heuristikens form A känner bara igen bindningen ' +
      'på find*, inte i en skrivnings where, så den syns inte. Invoice-objektet kommer ' +
      'från processOverdueReminders eget findMany; cronen äger alla organisationer och ' +
      'har ingen aktör att scopa mot. Skrivningen rör ett enda noteringsfält och kan ' +
      'inte sätta belopp, status eller kravsteg.',
  },
]

function exceptionKey(x: { file: string; model: string; op: string; via?: string }): string {
  // Nästlade rader får aldrig konsumera ett undantag skrivet för ett direkt
  // anrop: `via` är tomt för direkta och ifyllt för nästlade, så nycklarna kan
  // inte kollidera. Undantagen i CALLER_SCOPED gäller alltså bara direkta anrop.
  return `${x.file}|${x.model}|${x.op}|${x.via ?? ''}`
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
  P: 'P förälder org-bunden',
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
  out.push('kontrollerat". Det enda filen garanterar är att ingen skrivväg tillkommer')
  out.push('obemärkt. Se object-scope.ts för varför mer inte går att göra statiskt.')
  out.push('')
  out.push('TVÅ SKRIVFORMER INGÅR:')
  out.push('  DIREKT   invoiceLine + create — barnets egen accessor står i koden.')
  out.push('  NÄSTLAD  invoice.create({ data: { lines: { createMany: … } } }) — barnet')
  out.push('           skrivs via förälderns data-objekt och nämner aldrig sin accessor.')
  out.push('           Märks med "← nästlad via <Förälder>.<fält>". Modellen härleds ur')
  out.push('           schema.prisma: lines betyder InvoiceLine under Invoice och')
  out.push('           JournalEntryLine under JournalEntry.')
  out.push('')
  out.push('Utanför: nyttolast som byggs i en annan funktion än anropet, dynamiska')
  out.push('fältnamn och rå SQL. Inget av det finns i kodbasen i dag — men skillnaden')
  out.push('mellan "finns inte" och "fångas" ska stå skriven.')
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
  out.push('  P  förälderns anrop binder org: invoice.update({ where: { id, organizationId } })')
  out.push('     Bara nästlade rader. Den nästlade skrivningen träffar de rader föräldern')
  out.push('     pekar ut, så frågan är alltid om FÖRÄLDERN är bunden till anroparens org.')
  out.push('')
  out.push('En form till går inte att detektera: en intern hjälpare utan aktörskontext,')
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
      const via = r.via ? `  ← nästlad via ${r.via}` : ''
      out.push(
        `${pad(r.model, MODEL_COL)}${pad(r.op, OP_COL)}${pad(r.file, FILE_COL)}${n}  ` +
          r.protections.map((p) => FORM_LABELS[p]).join(' + ') +
          via,
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
