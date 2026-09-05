import { get, post, patch, del, api } from '@/lib/api'
import type {
  CreateRentNoticeCreditInput,
  GenerateNoticesInput,
  MarkNoticePaidInput,
  SendNoticesInput,
} from '@eken/shared'

export type RentNoticeStatus = 'PENDING' | 'SENT' | 'PAID' | 'OVERDUE' | 'CANCELLED' | 'FAILED'

export type PaymentMethod = 'BANK' | 'CASH' | 'SWISH' | 'MANUAL'

export interface RentNotice {
  id: string
  organizationId: string
  tenantId: string
  leaseId: string
  noticeNumber: string
  ocrNumber: string
  month: number
  year: number
  amount: number
  vatAmount: number
  totalAmount: number
  dueDate: string
  paidAt: string | null
  paidAmount: number | null
  paymentMethod: PaymentMethod | null
  status: RentNoticeStatus
  sentAt: string | null
  sentTo: string | null
  // Felorsak när ett utskick misslyckats (status FAILED) — visas i UI:t så
  // hyresvärden ser VARFÖR avin fastnat. Backenden returnerar hela modellen.
  sendError: string | null
  createdAt: string
  updatedAt: string
  tenant: {
    id: string
    type: 'INDIVIDUAL' | 'COMPANY'
    firstName?: string | null
    lastName?: string | null
    companyName?: string | null
    email: string
    phone?: string | null
  }
  lease: {
    id: string
    unit: {
      id: string
      name: string
      property: {
        id: string
        name: string
      }
    }
  }
}

export interface GenerateResult {
  created: number
  skipped: number
  notices: RentNotice[]
}

export interface SendResult {
  sent: number
  failed: number
}

export interface AviseringStats {
  total: number
  pending: number
  sent: number
  paid: number
  overdue: number
  cancelled: number
  totalAmount: number
  paidAmount: number
  outstandingAmount: number
}

export type NoticeFilter = {
  month?: number
  year?: number
  status?: RentNoticeStatus | ''
  search?: string
  tenantId?: string
}

export function fetchNotices(filters?: NoticeFilter) {
  const params = new URLSearchParams()
  if (filters?.month) params.set('month', String(filters.month))
  if (filters?.year) params.set('year', String(filters.year))
  if (filters?.status) params.set('status', filters.status)
  if (filters?.search) params.set('search', filters.search)
  if (filters?.tenantId) params.set('tenantId', filters.tenantId)
  const q = params.toString()
  return get<RentNotice[]>(`/avisering${q ? `?${q}` : ''}`)
}

export function fetchStats(month: number, year: number) {
  return get<AviseringStats>(`/avisering/stats/${month}/${year}`)
}

export function fetchNotice(id: string) {
  return get<RentNotice>(`/avisering/${id}`)
}

// NYTTOLASTERNA ÄR ANNOTERADE med de delade typerna — utan annotering körs ingen
// överskottskontroll på literalen.
export function generateNotices(month: number, year: number) {
  const kropp: GenerateNoticesInput = { month, year }
  return post<GenerateResult>('/avisering/generate', kropp)
}

export function sendNotices(noticeIds: string[]) {
  const kropp: SendNoticesInput = { noticeIds }
  return post<SendResult>('/avisering/send', kropp)
}

export function sendAllNotices(month: number, year: number) {
  // Ingen kropp: månad och år står i sökvägen, rutten har inget @Body().
  return post<SendResult>(`/avisering/send-all/${month}/${year}`)
}

export function markAsPaid(
  id: string,
  paidAmount: number,
  paymentMethod: PaymentMethod,
  paidAt?: string,
) {
  const kropp: MarkNoticePaidInput = {
    paidAmount,
    paymentMethod,
    ...(paidAt ? { paidAt } : {}),
  }
  return patch<RentNotice>(`/avisering/${id}/paid`, kropp)
}

export function cancelNotice(id: string) {
  return del(`/avisering/${id}`)
}

export async function downloadNoticePdf(id: string, noticeNumber: string) {
  const res = await api.get(`/avisering/${id}/pdf`, { responseType: 'blob' })
  const url = window.URL.createObjectURL(res.data as Blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `hyresavi-${noticeNumber}.pdf`
  a.click()
  window.URL.revokeObjectURL(url)
}

// ─── #518 — kreditering (nedsättning) av hyresavi ────────────────────────────

export type RentCollectionStage = 'NONE' | 'REMINDED' | 'INKASSO_READY' | 'WRITTEN_OFF'

/**
 * En post på avin som går att kreditera, med sitt KUMULATIVA tak.
 *
 * `remaining` räknas av servern över ALLA tidigare krediteringar. Klienten får
 * aldrig gissa fram det ur `invoiced` — taket ligger i databasen, och en gissning
 * hade föreslagit belopp som API:et sedan avvisar.
 */
export interface RentNoticeCreditBucket {
  /** null = hyreskapitalet (avins totalAmount), annars avi-radens id. */
  rentNoticeLineId: string | null
  description: string
  invoiced: number
  credited: number
  remaining: number
  vatBearing: boolean
}

export interface RentNoticeCreditRecord {
  id: string
  amount: number
  reason: string
  creditedAt: string
  lines: Array<{
    id: string
    rentNoticeLineId: string | null
    description: string
    amount: number
  }>
}

/** Skuldläget ur API:ets `computeRentDebt` — aldrig omräknat i klienten. */
export interface RentNoticeDebt {
  capital: number
  consumption: number
  miscCharge: number
  reminderFee: number
  interest: number
  paid: number
  credited: number
  outstanding: number
  ocrOutstanding: number
  interestOnlyAfterCredit: boolean
}

/**
 * Utfallet av en TÄNKT kreditering, räknat av servern.
 *
 * `interestOnlyAfterCredit` är en REGEL, inte en subtraktion: den avgör om avin
 * stannar för människobeslut i stället för att gå vidare i kravtrappan. Därför
 * frågar vi servern i stället för att räkna ut den här.
 */
export interface RentNoticeCreditProjection {
  requested: number
  /** Det klampade beloppet — det som projektionen faktiskt gäller. */
  applied: number
  outstandingBefore: number
  ocrOutstandingBefore: number
  outstanding: number
  ocrOutstanding: number
  interest: number
  credited: number
  interestOnlyAfterCredit: boolean
}

export interface RentNoticeCreditPreview {
  rentNoticeId: string
  noticeNumber: string
  payableTotal: number
  outstanding: number
  credited: number
  /** Servern avgör OM det går. UI:t härleder aldrig villkoret själv. */
  allowed: boolean
  /** Skrivet för en människa. Visas ordagrant när `allowed` är falskt. */
  blockedReason: string | null
  buckets: RentNoticeCreditBucket[]
  creditableNow: number
  debt: RentNoticeDebt
  collectionStage: RentCollectionStage
  credits: RentNoticeCreditRecord[]
  projection: RentNoticeCreditProjection | null
}

export interface CreateRentNoticeCreditResult {
  credit: { id: string; amount: number; reason: string; creditedAt: string }
  rentNotice: {
    id: string
    noticeNumber: string
    outstanding: number
    interestOnlyAfterCredit: boolean
  }
}

/**
 * `amount` skickas med när gränssnittet vill veta vad krediteringen LEDER TILL.
 * Utan den utelämnas projektionen — en tom sträng eller ett NaN avvisas av
 * API:et i stället för att tolkas som noll.
 */
export function getRentNoticeCreditPreview(id: string, amount?: number) {
  const q = amount !== undefined ? `?amount=${encodeURIComponent(amount)}` : ''
  return get<RentNoticeCreditPreview>(`/avisering/${id}/credit/preview${q}`)
}

export function createRentNoticeCredit(id: string, dto: CreateRentNoticeCreditInput) {
  return post<CreateRentNoticeCreditResult>(`/avisering/${id}/credit`, dto)
}

// ── #648: AVINS HÄNDELSELOGG OCH VARFÖR DEN STÅR STILL ─────────────────────
//
// Typerna nedan är API:ets `RentNoticeEvent` och `RentCollectionStatus`
// uttryckta över nätet: `Date` blir ISO-sträng, resten är oförändrat. Samma
// form och samma skäl som `features/history/api/history.api.ts` — historiken
// har ännu ingen delad kontraktsyta, och en spegling här är ärligare än en
// halvdelad typ i `@eken/shared`.

/** Alla 17 typerna. `string` och inte en union — se resonemanget i historiken. */
export type RentNoticeEventType = string

export interface RentNoticeEvent {
  id: string
  rentNoticeId: string
  type: RentNoticeEventType
  actorType: 'USER' | 'SYSTEM' | 'WEBHOOK' | 'AI'
  actorId: string | null
  actorLabel: string | null
  payload: Record<string, unknown>
  /** ISO-8601. */
  createdAt: string
}

/**
 * Varför avin står still. `state` säger vad kravtrappans cron kommer att göra;
 * `missing` säger vad som är fel — och fylls ALLTID, oavsett `state`.
 */
export type RentCollectionState =
  | 'NOT_APPLICABLE'
  | 'REMINDERS_OFF'
  | 'PAUSED_STALE'
  | 'WAITING'
  | 'BLOCKED'
  | 'READY'

export interface RentCollectionStatus {
  state: RentCollectionState
  collectionStage: RentCollectionStage
  missing: string[]
  daysOverdue: number
  thresholdDays: number
  daysUntilEvaluation: number
  freshness: {
    stale: boolean
    through: string | null
    ageDays: number | null
    thresholdDays: number
  }
  /** AVINS och PÅMINNELSENS leverans är SKILDA fält. Se #651. */
  delivery: {
    noticeSentAt: string | null
    noticeDeliveredAt: string | null
    noticeBouncedAt: string | null
    reminderSentAt: string | null
    reminderDeliveredAt: string | null
    reminderBouncedAt: string | null
    sendFailedAt: string | null
  }
  lastBlockedAt: string | null
  blockedDays: number | null
  /**
   * Omsändningen av påminnelsen (#656). Beräknad i API:et — grindarna bär
   * pengar och får inte finnas i två uppsättningar.
   */
  resend: {
    allowed: boolean
    blockedReason: string | null
    senasteUtskickId: string | null
    /** `null` = VET EJ. Ett eget svar, inte ett ja. */
    addressChangedSinceBounce: boolean | null
  }
}

export function getRentNoticeEvents(id: string) {
  return get<RentNoticeEvent[]>(`/avisering/${id}/events`)
}

export function getRentNoticeCollectionStatus(id: string) {
  return get<RentCollectionStatus>(`/avisering/${id}/collection-status`)
}

export function resendRentNoticeReminder(id: string) {
  // Ingen kropp: rutten tar inget @Body().
  return post<{ enqueued: true }>(`/avisering/${id}/reminder/resend`)
}

// ── FÖRFALLOPÅMINNELSER: människans väg till `send_overdue_reminders` ────────
//
// Endpointerna ligger under /notifications (där tjänsten bor) men ytan är
// aviseringssidans — det är där hyresvärden står när frågan uppstår.

export interface PaminnelseForhandsbeskedSvar {
  invoices: Array<{
    id: string
    invoiceNumber: string
    recipient: string
    outstanding: number
    dueDate: string
  }>
  count: number
  totalOutstanding: number
  freshness: {
    stale: boolean
    through: string | null
    ageDays: number | null
    thresholdDays: number
  }
}

export const fetchReminderPreview = (): Promise<PaminnelseForhandsbeskedSvar> =>
  get<PaminnelseForhandsbeskedSvar>('/notifications/overdue-reminders/preview')

export const sendOverdueReminders = (): Promise<{
  sent: number
  failed: number
  skipped: number
  message: string
}> => post('/notifications/send-overdue-reminders')
