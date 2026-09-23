import { api, del, get, patch, post } from '@/lib/api'
import type {
  BankTransaction,
  ConfirmImportInput,
  CreateBankAccountInput,
  ImportAttemptInfo,
  ImportResult,
  ManualMatchInput,
  ReconciliationStats,
} from '@eken/shared'

export type BankFormat = 'GENERIC' | 'HANDELSBANKEN' | 'SEB' | 'SWEDBANK'

export interface AutoMatchResult {
  matched: number
  /** Kördes utan fel men matchade inte — väntar på manuell matchning. */
  unmatched: number
  /** Matchningen KASTADE (bokföringsfel, timeout, DB-fel). Inte samma sak som att
   *  ingen match hittades — se kommentaren i reconciliation.service.ts. */
  failed: number
  /** Bar en OCR som inte löste ut, och beloppsgissades därför inte. Ingår i
   *  `unmatched` — "en ledtråd som inte stämde" är något annat än "ingen ledtråd". */
  skippedUnresolvedOcr: number
}

// ─── PDF-import (AI-tolkat kontoutdrag) ──────────────────────────────────────

export interface ParsedTransaction {
  date: string // YYYY-MM-DD
  description: string
  ocr: string | null
  amount: number
  isIncoming: boolean
}

export interface ParsedBankStatement {
  bank: string | null
  accountNumber: string | null
  periodStart: string | null
  periodEnd: string | null
  transactions: ParsedTransaction[]
}

export interface PdfImportDraft {
  id: string
  /**
   * #F034c — kontot som valdes vid UPPLADDNINGEN, buret vidare till
   * bekräftelsen. PDF-flödet är två steg och det är BEKRÄFTELSEN som skriver
   * bankrader; att låta operatören välja konto två gånger hade inbjudit till
   * att de blir olika. Sätts av klienten, inte av servern — därför valfritt i
   * typen (serverns uppladdningssvar bär det inte).
   */
  bankAccountId?: string
  // CONFIRMING (#F034b) = commiten har TAGIT draften och skriver bankrader.
  // Eget läge och inte återanvänt PARSING — se enumet i schema.prisma.
  status: 'PARSING' | 'PARSED' | 'CONFIRMING' | 'CONFIRMED' | 'FAILED' | 'CANCELLED'
  parsed: ParsedBankStatement
}

export interface ImportCommitResult {
  importId: string
  created: number
  duplicates: number
  autoMatched: number
  unmatched: number
  forsok?: ImportAttemptInfo
}

// ─── #F034b: importförsökets utfall, tolkat för UI ──────────────────────────

/**
 * Backends 409-kropp när samma fil redan importeras. Skickas som ett OBJEKT
 * (inte bara en sträng) därför att UI:t ska kunna visa NÄR den pågående
 * körningen startade — ett "importen pågår" utan klockslag går inte att skilja
 * från en hängning.
 */
export interface ImportPagarSvar {
  code: 'IMPORT_PAGAR'
  message: string
  startadAt: string
  forsokNr: number
}

/**
 * Tolkar ett fångat fel som "samma fil importeras redan".
 *
 * REN FUNKTION MED FLIT: webs vitest kör med `environment: 'node'` och
 * renderar ingenting (apps/web/vitest.config.ts). Ett prov på att rätt
 * meddelande visas måste därför ställas mot en ren funktion, inte mot DOM.
 *
 * OKÄNT FEL BLIR `null`, INTE ett påstående. Ett nätverksavbrott och ett
 * pågående importförsök är olika saker, och att tolka allt 409-liknande som
 * det senare hade gjort ett driftfel till en lugnande text.
 */
export function tolkaImportPagar(fel: unknown): ImportPagarSvar | null {
  const kropp = (fel as { response?: { status?: number; data?: unknown } })?.response
  if (kropp?.status !== 409) return null
  const rå = kropp.data as { code?: unknown; startadAt?: unknown; message?: unknown } | undefined
  const inre = (rå as { data?: Record<string, unknown> })?.data ?? rå
  const d = inre as {
    code?: unknown
    startadAt?: unknown
    message?: unknown
    forsokNr?: unknown
  }
  if (d?.code !== 'IMPORT_PAGAR') return null
  return {
    code: 'IMPORT_PAGAR',
    message: typeof d.message === 'string' ? d.message : 'Samma fil importeras redan just nu.',
    startadAt: typeof d.startadAt === 'string' ? d.startadAt : '',
    forsokNr: typeof d.forsokNr === 'number' ? d.forsokNr : 0,
  }
}

/** Vad UI:t ska säga om ett importförsök. En källa för alla tre filvägarna. */
export interface Importbesked {
  ton: 'klar' | 'uppspelad' | 'delvis'
  rubrik: string
  text: string | null
}

export function importbesked(forsok: ImportAttemptInfo | undefined): Importbesked {
  // SAKNAT FÄLT ÄR INTE "KLAR". Ett svar utan försöksinfo kommer från en väg
  // som inte går genom filnivåskyddet, och då ska UI:t inte påstå något om
  // uppspelning eller partiellt utfall — bara att importen är genomförd.
  if (!forsok) return { ton: 'klar', rubrik: 'Import klar!', text: null }
  const tid = forsok.kordesAt ? new Date(forsok.kordesAt) : null
  const klockslag =
    tid && !Number.isNaN(tid.getTime())
      ? `${tid.toLocaleDateString('sv-SE')} ${tid.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' })}`
      : null
  if (forsok.status === 'DELVIS') {
    return {
      ton: 'delvis',
      rubrik: 'Importen blev delvis klar',
      text:
        'Några rader kunde inte läsas eller lagras. Betalningsunderlagets datum flyttades inte fram. ' +
        'Rätta filen och importera igen — rader som redan lagrats räknas som dubbletter.',
    }
  }
  if (forsok.replayed) {
    return {
      ton: 'uppspelad',
      rubrik: 'Filen är redan importerad',
      text: klockslag
        ? `Resultatet nedan är från körningen ${klockslag}. Inga nya rader har skapats.`
        : 'Resultatet nedan är från en tidigare körning. Inga nya rader har skapats.',
    }
  }
  return { ton: 'klar', rubrik: 'Import klar!', text: null }
}

/**
 * #F034c — MÅLKONTOT ÄR OBLIGATORISKT.
 *
 * Servern avvisar en import utan konto med ett svenskt besked. Parametern är
 * därför inte valfri här heller: en anropare som kunde utelämna den hade fått
 * felet i runtime i stället för i kompilatorn.
 */
export async function importBankStatement(
  file: File,
  bankAccountId: string,
  bank?: BankFormat,
): Promise<ImportResult> {
  const formData = new FormData()
  formData.append('statement', file)
  // URLSearchParams kodar värdena; BgMax-raden nedan kodar för hand eftersom
  // den bara har en parameter.
  const fråga = new URLSearchParams({ bankAccountId })
  if (bank) fråga.set('bank', bank)
  const url = `/reconciliation/import?${fråga.toString()}`
  const { data } = await api.post<{ data: ImportResult }>(url, formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  })
  return data.data
}

export async function importBgMaxFile(
  file: File,
  bankAccountId: string,
): Promise<ImportResult & { fileName: string }> {
  const formData = new FormData()
  formData.append('statement', file)
  const { data } = await api.post<{ data: ImportResult & { fileName: string } }>(
    `/reconciliation/import-bgmax?bankAccountId=${encodeURIComponent(bankAccountId)}`,
    formData,
    { headers: { 'Content-Type': 'multipart/form-data' } },
  )
  return data.data
}

export async function autoMatchAll(): Promise<AutoMatchResult> {
  // Ingen kropp: rutten tar inget @Body().
  return post<AutoMatchResult>('/reconciliation/auto-match')
}

export async function getTransactions(filters?: {
  status?: string
  from?: string
  to?: string
}): Promise<BankTransaction[]> {
  return get<BankTransaction[]>('/reconciliation/transactions', filters as Record<string, unknown>)
}

export async function getReconciliationStats(): Promise<ReconciliationStats> {
  return get<ReconciliationStats>('/reconciliation/stats')
}

export async function manualMatch(transactionId: string, target: ManualMatchInput): Promise<void> {
  await patch(`/reconciliation/transactions/${transactionId}/match`, target)
}

export async function ignoreTransaction(transactionId: string): Promise<void> {
  // Ingen kropp: rutten tar inget @Body().
  await patch(`/reconciliation/transactions/${transactionId}/ignore`)
}

export async function unmatchTransaction(transactionId: string): Promise<void> {
  // Ingen kropp: rutten tar inget @Body().
  await patch(`/reconciliation/transactions/${transactionId}/unmatch`)
}

// ─── PDF-import ─────────────────────────────────────────────────────────────

export async function importPdfStatement(file: File): Promise<PdfImportDraft> {
  const formData = new FormData()
  formData.append('statement', file)
  const { data } = await api.post<{ data: PdfImportDraft }>(
    '/reconciliation/import-pdf',
    formData,
    { headers: { 'Content-Type': 'multipart/form-data' } },
  )
  return data.data
}

export async function confirmPdfImport(
  importId: string,
  bankAccountId: string,
  transactions?: ParsedTransaction[],
): Promise<ImportCommitResult> {
  const kropp: ConfirmImportInput = {
    bankAccountId,
    ...(transactions ? { transactions } : {}),
  }
  return post<ImportCommitResult>(`/reconciliation/imports/${importId}/confirm`, kropp)
}

// ─── #F034c: målkontona ─────────────────────────────────────────────────────

export interface Bankkonto {
  id: string
  name: string
  accountNumber: string | null
  isActive: boolean
}

export function getBankAccounts(): Promise<Bankkonto[]> {
  return get<Bankkonto[]>('/reconciliation/bank-accounts')
}

/**
 * G2 — varför de automatiska kraven är pausade, och vilka rader som måste
 * avgöras för att de ska släppas.
 *
 * `orsak` är serverns text och renderas som den är. Att formulera om den i
 * klienten hade gett två versioner av samma besked — en i 409-svaret från
 * knappen "skicka krav nu", en här — och den som är fel är den ingen jämför.
 */
export interface Granskningsläge {
  pausad: boolean
  antal: number
  orsak: string | null
  rader: BankTransaction[]
}

export function getIdentityReview(): Promise<Granskningsläge> {
  return get<Granskningsläge>('/reconciliation/identity-review')
}

/**
 * Nyttolastens typ kommer från `@eken/shared` (`CreateBankAccountSchema`), inte
 * från ett objektlitteral här — `check-request-contract.mjs` kräver det, och
 * skälet är att webben och API:t annars kan drifta isär i tysthet.
 */
export function createBankAccount(input: CreateBankAccountInput): Promise<Bankkonto> {
  return post<Bankkonto>('/reconciliation/bank-accounts', input)
}

/**
 * Vad kontoväljaren ska säga när den är tom eller ofullständig.
 *
 * REN FUNKTION, samma skäl som `importbesked`: webs vitest renderar i jsdom men
 * provet ska kunna ställa frågan utan DOM. Och OKÄNT ÄR INTE "VÄLJ" — en
 * organisation som saknar konton behöver en annan uppmaning än en som har konton
 * men inget valt, och att ge samma text åt båda hade skickat operatören till fel
 * åtgärd.
 */
export type Kontoläge = 'inga-konton' | 'valj' | 'valt'

export function kontoläge(konton: Bankkonto[] | undefined, valt: string | null): Kontoläge {
  const valbara = (konton ?? []).filter((k) => k.isActive)
  if (valbara.length === 0) return 'inga-konton'
  if (!valt || !valbara.some((k) => k.id === valt)) return 'valj'
  return 'valt'
}

export function kontobesked(läge: Kontoläge): string | null {
  switch (läge) {
    case 'inga-konton':
      return (
        'Organisationen har inget bankkonto upplagt. Lägg upp kontot importen gäller ' +
        'innan du importerar — ett kontoutdrag måste höra till ett namngivet konto.'
      )
    case 'valj':
      return 'Välj vilket bankkonto importen gäller. Filen bär ingen säker kontoidentitet.'
    case 'valt':
      return null
  }
}

export async function cancelPdfImport(importId: string): Promise<void> {
  await del(`/reconciliation/imports/${importId}`)
}

// ─── K1: lägga upp importkontot FRÅN WEBBEN ─────────────────────────────────
//
// `createBankAccount` ovan och `useCreateBankAccount` fanns sedan #F034c men
// hade NOLL anropare i `apps/web/src` — mätt över hook-filens tretton exporter,
// där de övriga tolv hade exakt en var. En ny organisation kunde alltså inte
// importera alls utan ett API-anrop vid sidan av webben, vilket är precis vad
// kundprovet fick göra (UI 0079–0081).
//
// Funktionerna nedan är RENA av samma skäl som `importbesked` och `kontoläge`:
// frågan "vad ska formuläret säga" ska gå att ställa utan att rendera.

/** Fältvisa fel i formuläret. Tomt objekt förekommer inte — `null` = inga fel. */
export interface BankkontoFältfel {
  name?: string
  accountNumber?: string
}

/** Gränserna är schemats (`CreateBankAccountSchema`), inte egna. */
export const BANKKONTO_NAMN_MAX = 120
export const BANKKONTO_NUMMER_MAX = 64

/**
 * Formulärets EGNA regler, som körs FÖRE kontraktsgrinden och säger vilket fält
 * man ska tillbaka till. Grinden (`kontraktsfel`) är ett sista nej mot samma
 * schema och ska normalt aldrig tala — se `lib/contract-gate.ts`.
 *
 * DUBBLETTKONTROLLEN ÄR EN ARTIGHET, INTE SPÄRREN. Det unika villkoret är
 * `@@unique([organizationId, name])` i Prisma, alltså en EXAKT jämförelse på det
 * trimmade namnet — samma jämförelse görs här. Att göra den skiftlägesokänslig
 * här hade blockerat ett namn servern tillåter, och att hoppa över den hade
 * gjort 409:an till enda beskedet. Servern är fortfarande skiljedomaren: svarar
 * den 409 visas dess text.
 */
export function bankkontoFältfel(
  input: { name: string; accountNumber: string },
  befintliga: Bankkonto[] | undefined,
): BankkontoFältfel | null {
  const namn = input.name.trim()
  const nummer = input.accountNumber.trim()
  const fel: BankkontoFältfel = {}
  if (!namn) {
    fel.name = 'Kontot måste ha ett namn.'
  } else if (namn.length > BANKKONTO_NAMN_MAX) {
    fel.name = `Namnet får vara högst ${BANKKONTO_NAMN_MAX} tecken (är ${namn.length}).`
  } else if ((befintliga ?? []).some((k) => k.name === namn)) {
    fel.name = `Det finns redan ett konto som heter "${namn}".`
  }
  if (nummer.length > BANKKONTO_NUMMER_MAX) {
    fel.accountNumber = `Kontonumret får vara högst ${BANKKONTO_NUMMER_MAX} tecken (är ${nummer.length}).`
  }
  return fel.name || fel.accountNumber ? fel : null
}

/**
 * Nyttolasten som skickas. ANNOTERAD med den delade typen med flit: utan
 * annotering är literalen en inferrerad `const` och TypeScript kör ingen
 * överskottskontroll, så ett fält som finns i webben men inte i kontraktet
 * passerar tyst (CLAUDE.md, "Kontraktet webb↔API").
 *
 * Tomt kontonummer UTELÄMNAS i stället för att skickas som `''`. Schemat
 * tillåter tomma strängar (`max(64)` utan `min`), så ett `''` hade lagrats som
 * ett kontonummer — och `jamforKontonummer` hade då fortsatt behandla kontot
 * som "saknar nummer", eftersom den läser falsy. Ett fält som lagras men aldrig
 * kan betyda något är skräp i tabellen.
 */
export function bankkontoNyttolast(input: {
  name: string
  accountNumber: string
}): CreateBankAccountInput {
  const nummer = input.accountNumber.trim()
  const kropp: CreateBankAccountInput = {
    name: input.name.trim(),
    ...(nummer ? { accountNumber: nummer } : {}),
  }
  return kropp
}

// ─── RÄTTNING-1: IMPORTENS MÅL ÄR ETT BESLUT, INTE EN HÄRLEDNING ────────────
//
// ── VAD SOM VAR FEL, OCH VARFÖR DET INTE SYNTES ─────────────────────────────
//
// Målet räknades om vid VARJE rendering:
//
//     effektivtKonto = bankAccountId ?? (aktiva.length === 1 ? aktiva[0].id : null)
//
// Så länge operatören inte rört väljaren var `bankAccountId` fortfarande `null`,
// och uttrycket svarade "det enda aktiva kontot" — vilket konto det än råkade
// vara just då. Blev A avvecklat och B aktivt mellan filvalet och klicket pekade
// uttrycket om sig till B: väljaren visade B, ingen uppmaning syntes, knappen
// var aktiv, och klicket skickade B. Mätt av granskaren: `submittedAccount:
// "account-b"` med `userSelectionEvents: 0`.
//
// Det är inte ett formuleringsfel utan ett MODELLFEL. En härledning kan inte
// skilja "systemet band A åt dig" från "A är det enda som finns just nu", och
// bara den första får överleva att listan ändras. Därför är målet nedan ett
// TILLSTÅND som binds en gång, och giltigheten prövas mot den AKTUELLA listan
// vid varje rendering.
//
// ── OCH VARFÖR GRINDEN MÅSTE VARA EN HÄRLEDNING, INTE EN EFFEKT ─────────────
//
// Tvärtom för spärren. Hade ogiltigheten hanterats i en `useEffect` som
// nollställer state finns ett renderingsvarv där knappen står aktiv med ett
// ogiltigt id — och ett klick i det varvet skickar. `importmål` nedan är därför
// ren och körs under renderingen: knappen kan aldrig vara aktiv med ett id som
// inte finns bland de aktiva kontona i det svar som just visas.

/**
 * Kan vi lita på kontolistan just nu?
 *
 * TRE lägen och inte två, därför att "ingen data" och "data som kan vara
 * inaktuell" kräver olika svar. Ett bakgrundsanrop som pågår medan vi har ett
 * tidigare svar är NORMAL uppdatering — att spärra importen för den hade gjort
 * en osynlig cache-refresh till ett stopp mitt i operatörens arbete. Ett FEL är
 * något annat: då vet vi inte om listan speglar verkligheten, och ett konto kan
 * ha avvecklats utan att vi sett det.
 */
export type Kontolistläge =
  | { typ: 'okänt'; orsak: 'laddar' | 'fel' }
  | { typ: 'användbar'; konton: Bankkonto[] }

export function kontolistläge(fråga: {
  data: Bankkonto[] | undefined
  isPending: boolean
  isError: boolean
}): Kontolistläge {
  // FELET FÖRST, före `data`. React Query behåller det senaste lyckade svaret
  // när en omhämtning misslyckas, så `data` kan finnas OCH vara opålitlig. Att
  // läsa `data` först hade gjort ett nätfel osynligt.
  if (fråga.isError) return { typ: 'okänt', orsak: 'fel' }
  if (fråga.isPending || !fråga.data) return { typ: 'okänt', orsak: 'laddar' }
  return { typ: 'användbar', konton: fråga.data }
}

/**
 * Importomgångens mål.
 *
 * `bundet` och `valt` bär samma id men är INTE samma sak, och skillnaden styr
 * vad som händer vid en ny importomgång: en automatisk bindning hörde till den
 * omgång den gjordes i, ett uttryckligt val är operatörens svar och följer med.
 * Se `nyImportomgång`.
 */
export type Importmål =
  | { typ: 'obestämt' }
  | { typ: 'bundet'; id: string }
  | { typ: 'valt'; id: string }

export interface Målbesked {
  /** Id som får skickas. `null` = importen är spärrad. */
  id: string | null
  /** Vad operatören ska få veta. `null` = inget att säga. */
  besked: string | null
  /** Spärren beror på att listan inte gick att hämta — visa "Försök igen". */
  kanHämtasOm: boolean
  /** Målet blev ogiltigt; ett NYTT uttryckligt val krävs. */
  kräverNyttVal: boolean
}

const SPÄRRAD = { id: null, kanHämtasOm: false, kräverNyttVal: false } as const

/**
 * ETT villkor för knapp och handler, på alla tre filvägarna.
 *
 * Tidigare bar knappen `!file || !effektivtKonto` medan `kontoläge` räknade
 * fram "välj" alldeles bredvid utan att någon läste det. Texten sa alltså rätt
 * sak samtidigt som knappen var aktiv och handlern skickade ett avvecklat
 * konto. Nu kommer båda ur det här svaret.
 */
export function importmål(läge: Kontolistläge, mål: Importmål): Målbesked {
  if (läge.typ === 'okänt') {
    return läge.orsak === 'laddar'
      ? { ...SPÄRRAD, besked: 'Hämtar konton…' }
      : {
          ...SPÄRRAD,
          kanHämtasOm: true,
          besked:
            'Kontona kunde inte hämtas, så vi vet inte vilka som är aktiva just nu. ' +
            'Försök igen — importen görs inte mot ett okontrollerat konto.',
        }
  }
  const aktiva = läge.konton.filter((k) => k.isActive)

  if (mål.typ === 'obestämt') {
    if (aktiva.length === 0) return { ...SPÄRRAD, besked: kontobesked('inga-konton') }
    // ETT konto är ingen valsituation. Bindningen persisteras av `bindEnkonto`;
    // att svara redan här gör att knappen inte blinkar förbi ett "välj" som
    // aldrig gällde.
    if (aktiva.length === 1) return { ...SPÄRRAD, id: aktiva[0]!.id, besked: null }
    return { ...SPÄRRAD, besked: kontobesked('valj') }
  }

  if (aktiva.some((k) => k.id === mål.id)) return { ...SPÄRRAD, id: mål.id, besked: null }

  // Ogiltigt mål. NAMNET om vi har det — ett avvecklat konto ligger kvar i
  // listan med `isActive: false`, och "Företagskonto SEB är avvecklat" är ett
  // annat besked än "kontot finns inte längre".
  const känt = läge.konton.find((k) => k.id === mål.id)
  return {
    ...SPÄRRAD,
    kräverNyttVal: true,
    besked: känt
      ? `Kontot "${känt.name}" är avvecklat och kan inte ta emot importen. ` +
        'Välj vilket konto importen gäller.'
      : 'Kontot importen var inställd på finns inte längre. Välj vilket konto importen gäller.',
  }
}

/**
 * Binder enkontovalet EN gång. Returnerar `null` när ingenting ska ändras.
 *
 * Bindningen är hela poängen med rättningen: efter den ligger id:t i state, och
 * en senare liständring kan inte räkna om det till ett annat konto — den kan
 * bara göra det ogiltigt, vilket `importmål` besvarar med ett krav på nytt val.
 */
export function bindEnkonto(läge: Kontolistläge, mål: Importmål): Importmål | null {
  if (mål.typ !== 'obestämt' || läge.typ !== 'användbar') return null
  const aktiva = läge.konton.filter((k) => k.isActive)
  return aktiva.length === 1 ? { typ: 'bundet', id: aktiva[0]!.id } : null
}

/**
 * Vad som gäller när importmodalen stängs och en ny omgång börjar.
 *
 * BESLUTET, och skälet: ett UTTRYCKLIGT val följer med — det är ett svar
 * operatören redan gett, och att glömma det hade tvingat fram samma val igen.
 * En AUTOMATISK bindning gör det inte: den var systemets bekvämlighet i den
 * omgången, och nästa omgång ska binda mot den lista som gäller då.
 *
 * Skillnaden syns bara när det enda aktiva kontot har bytts mellan omgångarna,
 * och då är den rätt åt båda hållen: ett uttryckligt A blir OGILTIGT och kräver
 * nytt val (aldrig ett tyst byte), medan ett automatiskt bundet A ersätts av
 * den nya omgångens enda möjlighet.
 *
 * En redan uppladdad PDF-draft berörs inte av det här: draften bär sitt eget
 * `bankAccountId` och lever i bekräftelsemodalen, inte i importomgångens state.
 */
export function nyImportomgång(mål: Importmål): Importmål {
  return mål.typ === 'valt' ? mål : { typ: 'obestämt' }
}
