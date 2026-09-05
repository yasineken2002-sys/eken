import { get, post } from '@/lib/api'
import type { Account, JournalEntry } from '@eken/shared'

export const fetchAccounts = (): Promise<Account[]> => get<Account[]>('/accounting/accounts')

export const seedAccounts = (): Promise<{ message: string }> =>
  post<{ message: string }>('/accounting/accounts/seed')

export const fetchJournalEntries = (filters?: {
  from?: string
  to?: string
  source?: string
}): Promise<JournalEntry[]> =>
  get<JournalEntry[]>('/accounting/journal', filters as Record<string, unknown> | undefined)

export const fetchJournalEntry = (id: string): Promise<JournalEntry> =>
  get<JournalEntry>(`/accounting/journal/${id}`)

/**
 * Rättar ett verifikat: bokför dess motsats, daterad idag. Originalet rörs inte.
 * Svaret är det NYA rättelseverifikatet.
 */
export const reverseJournalEntry = (id: string, reason: string): Promise<JournalEntry> =>
  post<JournalEntry>(`/accounting/journal/${id}/reverse`, { reason })

// ── Bokföringsperioder (T5 PR1a) ─────────────────────────────────────────────
// Stängningen fanns tidigare bara som AI-verktyg. Spärren mot att bokföra i en
// stängd period är oförändrad och ligger kvar i backend (allocate).

export interface PeriodCheck {
  code: string
  severity: 'blocking' | 'warning'
  message: string
  count: number
}

export interface PeriodOverviewItem {
  year: number
  month: number
  closed: boolean
  closedAt: string | null
  /** > 0 → perioden har en historia värd att visa. */
  reopenedCount: number
}

export type PeriodReasonCategory = 'MISSING_ENTRY' | 'EXISTING_ENTRY_INCORRECT'

/** En händelse i periodens kedja. `seq` är intern ordning och visas ALDRIG. */
export interface PeriodHistoryEvent {
  seq: number
  type: 'CLOSED' | 'REOPENED'
  createdAt: string
  actorLabel: string | null
  reason: string | null
  reasonCategory: PeriodReasonCategory | null
}

export interface PeriodDetail {
  year: number
  month: number
  closed: boolean
  events: PeriodHistoryEvent[]
  vatPeriods: string[]
  fiscalYear: number
  fiscalYearEnd: string
  /** Falskt → räkenskapsårsspärren stänger dörren, oavsett orsak och roll. */
  withinReopenWindow: boolean
  /**
   * Är RÄKENSKAPSÅRET stängt (#704)? Då är återöppning meningslös — årsspärren
   * fäller varje verifikat oavsett månadens tillstånd, och året går inte att
   * öppna. Dialogen förklarar i stället för att erbjuda.
   */
  fiscalYearClosed: boolean
  /** `2026` eller `2026/2027` — för texten i dialogen. */
  fiscalYearLabel: string
}

export interface PeriodOverview {
  items: PeriodOverviewItem[]
  lastClosed: { year: number; month: number } | null
  open: Array<{ year: number; month: number }>
}

export interface PeriodSummary {
  month: number
  year: number
  revenue: number
  expenses: number
  result: number
  entriesCount: number
  generatedAt: string
}

export interface PeriodPrecheck {
  year: number
  month: number
  alreadyClosed: boolean
  canClose: boolean
  checks: PeriodCheck[]
  vatPeriods: string[]
}

export const fetchPeriods = (months?: number): Promise<PeriodOverview> =>
  get<PeriodOverview>('/accounting/periods', months ? { months } : undefined)

export const fetchPeriodPrecheck = (year: number, month: number): Promise<PeriodPrecheck> =>
  get<PeriodPrecheck>(`/accounting/periods/${year}/${month}/precheck`)

export const closePeriod = (
  year: number,
  month: number,
): Promise<{ year: number; month: number; summary: PeriodSummary; checks: PeriodCheck[] }> =>
  post(`/accounting/periods/${year}/${month}/close`)

export const fetchPeriodHistory = (year: number, month: number): Promise<PeriodDetail> =>
  get<PeriodDetail>(`/accounting/periods/${year}/${month}/history`)

export const reopenPeriod = (args: {
  year: number
  month: number
  reason: string
  reasonCategory: PeriodReasonCategory
}): Promise<{
  year: number
  month: number
  reopenedAt: string
  reason: string
  reasonCategory: PeriodReasonCategory
  previousSummary: PeriodSummary | null
}> =>
  post(`/accounting/periods/${args.year}/${args.month}/reopen`, {
    reason: args.reason,
    reasonCategory: args.reasonCategory,
  })

// ── Årsstängning (#704 PR 3) ─────────────────────────────────────────────────
// Ett räkenskapsår stängs genom att årets SISTA MÅNAD stängs: förutsättningen är
// att månad 1–11 är stängda och månad 12 öppen. Årsstängningen bokför då
// resultatavräkningen mot Årets resultat, stänger månad tolv och låser året.
//
// ETT STÄNGT ÅR KAN INTE ÖPPNAS IGEN. Det är därför bekräftelsen kräver att
// användaren skriver årtalet — se CloseFiscalYearModal.

export type FiscalYearStatus = 'CLOSED' | 'READY' | 'MONTHS_PENDING'

export interface FiscalYearOverviewItem {
  fiscalYear: number
  /** `2026` vid kalenderår, `2026/2027` vid brutet räkenskapsår. */
  label: string
  fiscalStart: string
  yearEndDate: string
  status: FiscalYearStatus
  closedAt: string | null
  /** Årsavslutsverifikatet. `null` när inget skrevs (inget resultatkonto hade saldo). */
  entry: { id: string; series: string; verNumber: number } | null
  monthsRemaining: string[]
  finalMonth: string
  finalMonthClosed: boolean
}

export interface FiscalYearCheck {
  code: string
  severity: 'blocking' | 'warning'
  message: string
}

export interface FiscalYearEntryLine {
  accountId: string
  accountNumber: number
  accountName: string
  debit?: number
  credit?: number
  description: string
}

export interface FiscalYearEntryDraft {
  lines: FiscalYearEntryLine[]
  /** Positivt = vinst, negativt = förlust. */
  result: number
  resultAccountNumber: number
  resultAccountMissing: boolean
  date: string
}

export interface FiscalYearClosePreview {
  fiscalYear: number
  label: string
  startMonth: number
  fiscalStart: string
  yearEndDate: string
  months: Array<{ year: number; month: number }>
  canClose: boolean
  checks: FiscalYearCheck[]
  entry: FiscalYearEntryDraft
}

export interface FiscalYearCloseResult {
  fiscalYear: number
  label: string
  journalEntryId: string | null
  summary: {
    result: number
    accountsZeroed: number
    resultAccountNumber: number
    noEntryReason: string | null
    yearEndDate: string
  }
  monthClosed: { year: number; month: number }
}

export const fetchFiscalYears = (years?: number): Promise<FiscalYearOverviewItem[]> =>
  get<FiscalYearOverviewItem[]>('/accounting/fiscal-years', years ? { years } : undefined)

export const fetchFiscalYearClosePreview = (year: number): Promise<FiscalYearClosePreview> =>
  get<FiscalYearClosePreview>(`/accounting/fiscal-years/${year}/close-preview`)

export const closeFiscalYear = (year: number): Promise<FiscalYearCloseResult> =>
  post<FiscalYearCloseResult>(`/accounting/fiscal-years/${year}/close`)

// ── MANUELL BOKFÖRING (människans väg till create_journal_entry/record_expense) ─
//
// De två anropen nedan är motsvarigheten till AI-verktygen. Backend delar
// kontering och skrivning med verktyget (`accounting/manual-entry.ts` +
// `createNumberedEntry`), så gränssnittet behöver inte veta något om konton
// utöver numret hyresvärden väljer.

export interface ManuellVerifikatrad {
  accountNumber: number
  debit?: number
  credit?: number
  description?: string
}

export interface SkapaVerifikatInput {
  date: string
  description: string
  lines: ManuellVerifikatrad[]
  /**
   * En nyckel per öppnad modal. Två skickningar med samma nyckel ger EN
   * journalpost — ett omtag efter en tappad uppkoppling får inte bli två
   * verifikat i huvudboken.
   */
  idempotencyKey: string
  attachmentUrl?: string
}

export const createJournalEntry = (input: SkapaVerifikatInput): Promise<JournalEntry> =>
  post<JournalEntry>('/accounting/journal-entries', input)

export interface SkapaUtgiftInput {
  date: string
  description: string
  supplier?: string
  /** BRUTTO — det som lämnar bankkontot. Momsen bryts UT ur det, inte till. */
  amount: number
  vatRate?: number
  vatAmount?: number
  accountNumber: number
  idempotencyKey: string
  attachmentUrl?: string
}

export const createExpense = (input: SkapaUtgiftInput): Promise<JournalEntry> =>
  post<JournalEntry>('/accounting/expenses', input)

// ─── LEVERANTÖRSSKULDER (2440) ────────────────────────────────────────────────

/**
 * En leverantörsfaktura som den ser ut UTÅT.
 *
 * `status` och `overdue` finns INTE som kolumner — servern räknar fram dem ur
 * `paidAt`/`cancelledAt` och dagens datum (`supplier-invoice-status.ts`). Att
 * typen ändå bär dem är avsiktligt: det är svarets form, och alternativet vore
 * att varje yta räknade om samma sak ur råfälten och kunde räkna olika.
 */
export interface SupplierInvoice {
  id: string
  supplierName: string
  invoiceNumber?: string | null
  description: string
  invoiceDate: string
  dueDate: string
  expenseAccount: number
  netAmount: number
  vatRate: number
  vatAmount: number
  totalAmount: number
  paidAt?: string | null
  cancelledAt?: string | null
  status: 'OPEN' | 'PAID' | 'CANCELLED'
  overdue: boolean
  createdAt: string
}

export interface SkapaLeverantorsfakturaInput {
  supplierName: string
  invoiceNumber?: string
  description: string
  invoiceDate: string
  dueDate: string
  expenseAccount: number
  /** BRUTTO — det som står på fakturan. Momsen bryts UT ur det, inte till. */
  amount: number
  vatRate?: number
  attachmentUrl?: string
}

export const getSupplierInvoices = (status?: 'OPEN' | 'PAID' | 'CANCELLED') =>
  get<SupplierInvoice[]>(`/accounting/supplier-invoices${status ? `?status=${status}` : ''}`)

export const createSupplierInvoice = (input: SkapaLeverantorsfakturaInput) =>
  post<SupplierInvoice>('/accounting/supplier-invoices', input)

export const paySupplierInvoice = (input: { id: string; paidDate: string }) =>
  post<SupplierInvoice>(`/accounting/supplier-invoices/${input.id}/pay`, {
    paidDate: input.paidDate,
  })

export const cancelSupplierInvoice = (input: { id: string }) =>
  post<SupplierInvoice>(`/accounting/supplier-invoices/${input.id}/cancel`, {})
