import type { Prisma } from '@prisma/client'

/**
 * SVARSFORMERNA FÖR BankTransaction — BÅDA, INTILL VARANDRA.
 *
 * Modellen når klienten via två skilda vyer, och de bär olika fält. Att de
 * skiljer sig är AVSIKTLIGT och motiverat nedan. Att de ligger i samma modul är
 * lika avsiktligt: `TENANT_CREDENTIAL_KEYS` fanns i två kopior i två filer och
 * divergerade tyst i månader (#453). Två former för en modell på två ställen är
 * samma konstruktion, och den upptäcks bara om någon råkar läsa båda.
 *
 * ── Form 1: FAKTURAKONTEXTEN (#444) ─────────────────────────────────────────
 *
 * `GET /invoices` och `GET /invoices/:id` visar "Kopplad banktransaktion" under
 * en betald faktura: datum, betalare, belopp. Den som redan ser fakturan vet
 * vem som betalade, så `description` tillför inget nytt — men kontosaldot
 * (`balance`) och aktörsfältet (`matchedBy`) hör till BANKKONTOT, inte till
 * fakturan, och den vyn är dessutom öppen för fler roller.
 *
 * ── Form 2: AVSTÄMNINGSTABELLEN ─────────────────────────────────────────────
 *
 * `GET /reconciliation/transactions` (ACCOUNTANT+ sedan #440) är arbetsytan där
 * en människa matchar inbetalningar mot avier. Den behöver därför MER än
 * fakturavyn: `reference` och `rawOcr` är det operatören matchar på när
 * automatiken inte hittade rätt, och `status` styr filterflikarna.
 *
 * Den behöver däremot inte `balance`, `matchedBy`, `externalId` eller
 * `dedupKey`. Mätt i gränssnittet: avstämningstabellen läser `id`,
 * `status`, `description`, `reference`, `rawOcr`, `invoice`, `date`, `amount` —
 * inget annat. Enda träffen på "balance" i hela featuren är en CSV-kolumnetikett
 * i importmappningen, inte en läsning.
 *
 * ── Skillnaden mellan dem, sammanfattad ─────────────────────────────────────
 *
 *   bara i form 2:  reference, rawOcr, status, matchedRentNoticeId, matchedAt
 *   i ingen av dem: balance, matchedBy, externalId, dedupKey, organizationId
 *
 * `matchedAt` står i form 2 för att AI-verktyget `get_bank_transactions` läser
 * det. Det upptäcktes INTE av min mätning av gränssnittet — jag sökte i web,
 * admin och portal men inte i verktygslagret — utan av att den deklarerade
 * returtypen fällde `tool-executor.service.ts:2985` i typecheck. Det är precis
 * skillnaden mellan en projicerad typ och en påstådd: den här hade varit tyst
 * fel i runtime.
 *
 * EN TREDJE FORM SKA MOTIVERAS MOT BÅDA. Behöver en ny vy fält som ingen av
 * formerna har, är frågan först om någon av dem borde utökas — inte om en tredje
 * ska läggas till. `bank-transaction-views.spec.ts` partitionerar hela modellen
 * mot BÅDA formerna samtidigt, så en ny kolumn tvingar fram ett beslut för dem
 * båda på en gång.
 */

/** Form 1 — fakturakontexten. Prisma-select; fälten lämnar aldrig databasen. */
export const SAFE_INVOICE_BANK_TRANSACTION_SELECT = {
  id: true,
  date: true,
  amount: true,
  description: true,
  rawOcr: true,
} as const

/**
 * Form 2 — avstämningstabellen. HANDPROJICERAD, inte en select.
 *
 * Skälet till skillnaden i mekanism: `getTransactions` behöver `where`-filtrera
 * på `status` och inkludera två relationer, och en select som bär allt det blir
 * svårare att läsa än en projicering vid returen. Viktigare: en deklarerad
 * returtyp som kompilatorn upprätthåller är starkare än en select som körtiden
 * upprätthåller (se mall-rangordningen i #445), och projiceringen är det som gör
 * returtypen SANN — en typ utan projicering hade bara påstått att fälten inte
 * går över tråden.
 */
export const RECONCILIATION_TRANSACTION_FIELDS = [
  'id',
  'date',
  'description',
  'amount',
  'reference',
  'rawOcr',
  'status',
  'invoiceId',
  'matchedRentNoticeId',
  'matchedAt',
  'createdAt',
] as const

export type ReconciliationTransactionField = (typeof RECONCILIATION_TRANSACTION_FIELDS)[number]

/** Relationerna avstämningsvyn bär, redan projicerade i queryn. */
export interface ReconciliationTransactionRelations {
  invoice: { id: string; invoiceNumber: string; status: string } | null
  matchedRentNotice: {
    id: string
    noticeNumber: string
    status: string
    totalAmount: Prisma.Decimal
  } | null
}

/**
 * Avstämningsvyns rad. Kompilatorn upprätthåller att inget annat följer med —
 * och `projectReconciliationTransaction` nedan är det som gör påståendet sant.
 */
export type ReconciliationTransactionView = Pick<
  Prisma.BankTransactionGetPayload<Record<string, never>>,
  ReconciliationTransactionField
> &
  ReconciliationTransactionRelations

/** Handprojicering. Enda vägen från en rå rad till avstämningsvyns form. */
export function projectReconciliationTransaction(
  rad: Prisma.BankTransactionGetPayload<Record<string, never>> &
    Partial<ReconciliationTransactionRelations>,
): ReconciliationTransactionView {
  return {
    id: rad.id,
    date: rad.date,
    description: rad.description,
    amount: rad.amount,
    reference: rad.reference,
    rawOcr: rad.rawOcr,
    status: rad.status,
    invoiceId: rad.invoiceId,
    matchedRentNoticeId: rad.matchedRentNoticeId,
    matchedAt: rad.matchedAt,
    createdAt: rad.createdAt,
    invoice: rad.invoice ?? null,
    matchedRentNotice: rad.matchedRentNotice ?? null,
  }
}
