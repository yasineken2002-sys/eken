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
