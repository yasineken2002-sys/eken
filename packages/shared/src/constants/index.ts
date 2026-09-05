// Svenska momssatser. 0% och 25% är de två som faktiskt används för
// fastigheter (bostadshyra är momsbefriad, lokalhyra med frivillig
// skattskyldighet är 25%). 6% och 12% finns i listan eftersom de kan
// förekomma vid extern fakturering (t.ex. tidskrifter, livsmedel) men
// får ALDRIG användas för bostadshyra.
export const VAT_RATES = [0, 6, 12, 25] as const
export type VatRate = (typeof VAT_RATES)[number]

// Per Mervärdesskattelagen (2023:200): bostadshyra är momsbefriad. Lokalhyra
// kan vara momsbefriad eller 25% beroende på frivillig skattskyldighet.
export const VAT_RATE_RESIDENTIAL_RENT = 0
export const VAT_RATE_COMMERCIAL_RENT_TAXED = 25

// MOMSSATSEN PER UPPLÅTELSETYP BOR I `vatRateForRent`
// (apps/api/src/accounting/accounting.service.ts) — den enda momskällan, och
// den som faktiskt grindar fakturering, avisering och IMD-debitering.
//
// Här fanns tidigare en andra funktion, `getVatRateForUnitType`, som gav ett
// ANNAT svar för PARKING (0 % mot 25 %) och hade noll anropare. Den togs bort i
// #393: en död funktion som bär en regel ingen kör ser ut som täckning och är
// därför sämre än ingen funktion alls.
//
// Regeln den bar — att parkering underordnad en momsfri bostads- eller
// lokaluthyrning följer huvudupplåtelsen — är BEVARAD I #393, tillsammans med
// Skatteverkets ställningstagande (tillämpas 2026-10-01) och konstaterandet att
// datamodellen ännu inte kan uttrycka villkoret. Sök "parkeringsmoms" → #393.

// ─── Påminnelseavgiftens lagstadgade tak (G3) ────────────────────────────────
//
// 4 § lagen (1981:739) om ersättning för inkassokostnader anger 60 kr för
// skriftlig betalningspåminnelse (beloppet står där sedan SFS 2013:56 — den
// tidigare förordningen 1981:1057 är upphävd och angav 50 kr).
//
// TAKET ÄR TVINGANDE ÄVEN MOT NÄRINGSIDKARE. 6 § första stycket gör ett
// avtalsvillkor som utvidgar gäldenärens ersättningsskyldigheter ogiltigt, och
// ordalydelsen har ingen konsumentavgränsning. Ett avtalat belopp över taket är
// därför ogiltigt i den överskjutande delen även mellan företag — det finns
// ingen INDIVIDUAL/COMPANY-förgrening att göra här, och den som funderar på att
// införa en ska läsa 6 § först.
//
// EN KONSTANT, ALLA FÖREKOMSTER. Talet stod tidigare på flera ställen: DTO:ns
// validering, inställningssidans "Max enligt lag"-text, villkorssidorna i web
// och portal, inkassounderlagets disclaimer och AI-assistentens systemprompt.
// Två literaler som ska föreställa samma tak glider isär — och glider de isär
// är det en av dem som kräver hyresgästen på fel belopp.
//
// KAN INTE LÄSA KONSTANTEN, med flit dokumenterat:
//   • `schema.prisma` (`reminderFeeSek Decimal @default(60)`) — Prisma-schemat
//     är inte TypeScript och kan inte importera. Literalen står kvar med en
//     kommentar som pekar hit.
//   • markdown i `docs/` och `.claude/knowledge/` — statisk text.
// Båda är dokumenterade snarare än tyst duplicerade.
export const REMINDER_FEE_MAX_SEK = 60

export const DEFAULT_NOTICE_PERIOD_MONTHS = 3
export const DEFAULT_PAGE_SIZE = 20
export const MAX_PAGE_SIZE = 100

export const CURRENCY = 'SEK'
export const LOCALE = 'sv-SE'

// BAS 2024 — kontoklass-intervall (H5, verifierat av Auktoriserad
// Redovisningskonsult mot accounting.service.ts + bas-chart.ts).
// OBS: eget kapital är INTE ett eget intervall — det ligger inom klass 2
// (2000–2999) men vilken delmängd beror på företagsform (AB 2080–2099,
// enskild firma 2010–2019 osv). Se bas-chart.ts. Därför ingen EQUITY-nyckel:
// en konstant `EQUITY: 3000–3999` (intäkter) var ett BAS-fundamentalt fel.
export const ACCOUNT_CLASS_RANGES = {
  ASSET: { min: 1000, max: 1999 },
  LIABILITY: { min: 2000, max: 2999 }, // inkl. eget kapital
  REVENUE: { min: 3000, max: 3999 },
  EXPENSE: { min: 4000, max: 8999 },
} as const

// Hyresintäktskonton per upplåtelsetyp (ML 10 kap. 35 §, BAS 2024). Det finns
// INGEN enskild "RENT_REVENUE" — bostad får aldrig moms, lokal/p-plats kan.
// Den auktoritativa mappningen är accounting.service.ts:revenueAccountForUnitType();
// dessa konstanter är referensvärden, bokför aldrig direkt mot ett enda konto.
export const RENT_REVENUE_ACCOUNTS = {
  APARTMENT: 3911, // Hyresintäkter, bostäder (0 % moms)
  PARKING: 3912, // Hyresintäkter, parkering (25 % moms)
  OFFICE: 3913, // Hyresintäkter, lokaler (0 % eller 25 % vid frivillig skattskyldighet)
  RETAIL: 3913, // Hyresintäkter, lokaler (samma konto som OFFICE)
  STORAGE: 3914, // Hyresintäkter, övrigt/förråd
  OTHER: 3914, // Hyresintäkter, övrigt (fallback)
} as const

// Övriga standardkonton för fastighetsförvaltning (BAS 2024). Speglar exakt
// de accountByNumber.get()-anrop som finns i accounting.service.ts efter FIX 9.
export const CORE_ACCOUNTS = {
  ACCOUNTS_RECEIVABLE: 1510, // Kundfordringar
  CASH: 1910, // Kassa (kontant)
  BANK: 1930, // Företagskonto / bank
  DEPOSIT_LIABILITY: 2890, // Mottagna depositioner (kortfristig skuld)
  VAT_OUTPUT_25: 2611, // Utgående moms 25 %
  VAT_OUTPUT_12: 2621, // Utgående moms 12 %
  VAT_OUTPUT_6: 2631, // Utgående moms 6 %
  DAMAGE_REVENUE: 3040, // Skadeersättningar (depositionsavdrag)
} as const

export const USER_ROLES = ['OWNER', 'ADMIN', 'MANAGER', 'ACCOUNTANT', 'VIEWER'] as const

/**
 * Rollerna en organisation kan ge någon — vid inbjudan OCH vid rollbyte.
 *
 * EN lista, med flit. Tidigare fanns två: `INVITABLE_ROLES` (ADMIN, MANAGER) och
 * `ASSIGNABLE_ROLES` (ADMIN, MANAGER, ACCOUNTANT, VIEWER). Skillnaden var aldrig
 * ett säkerhetsbeslut — kommentaren sa "för att hålla UI:t enkelt" — men den gav
 * en ekonomiansvarig en omväg i två steg: bjud in som förvaltare, låt sedan
 * ägaren byta rollen till ekonomi. Samma slutresultat, fler steg, och två listor
 * som motsade varandra utan att någon skrivit ner varför (R3).
 *
 * OWNER står inte här. Ägaren är organisationens skapare och rollen är skyddad
 * på flera ställen — den kan varken tilldelas, ändras eller inaktiveras — så ett
 * ägarbyte är en egen handling med egna spärrar, inte ett rollval i en lista.
 *
 * Ordningen är fallande behörighet, samma som USER_ROLES, för att listan ska gå
 * att läsa som en rangordning i ett UI.
 *
 * ── BESLUT 2026-08-02: ADMIN får skapa ekonomi- och läskonton direkt ─────────
 *
 * Sammanslagningen ändrar VEM som kan skapa ett ACCOUNTANT- eller VIEWER-konto,
 * och det ska sägas rakt ut i stället för att upptäckas av nästa granskare.
 *
 * Före: inbjudan tillät bara ADMIN och MANAGER, och `PATCH /users/:id/role` är
 * OWNER-only. Varje väg till ett ACCOUNTANT-konto krävde alltså att ägaren var
 * inblandad — inte för att någon bestämt det, utan som en bieffekt av att den
 * ena listan var snävare än den andra.
 *
 * Efter: `POST /users/invite` är fortfarande `@Roles('ADMIN', 'OWNER')`, men en
 * ADMIN kan nu skapa kontot i ett steg utan ägaren.
 *
 * Det är avsiktligt, av två skäl. En ADMIN kunde redan bjuda in en ANNAN ADMIN —
 * en strikt mäktigare roll än ACCOUNTANT — så taket för vad ADMIN kan skapa
 * höjs inte; det är omvägen som försvinner. Och beslutet 2026-08-01 (#271) gav
 * ADMIN fullt bokföringsmandat i det här kundsegmentet: att neka samma person
 * att skapa en bokförare, men tillåta hen att skapa en administratör, vore
 * inkonsekvent.
 *
 * OMPRÖVAS TILLSAMMANS MED #271. Skiljs ADMIN någon gång från bokförings-
 * mandatet — vilket #271:s eget omprövningsvillkor pekar ut: större kunder med
 * flera administratörer, där rätt lösning sannolikt är en egen ekonomiroll —
 * ska den här listan omprövas i samma veva. De två besluten vilar på samma
 * antagande om vem ADMIN är, och får inte glida isär.
 */
export const ASSIGNABLE_ROLES = ['ADMIN', 'MANAGER', 'ACCOUNTANT', 'VIEWER'] as const

// ─── Invoice Event Types ──────────────────────────────────────────────────────

export const INVOICE_EVENT_TYPES = [
  'invoice.created',
  'invoice.updated',
  'invoice.sent',
  'invoice.send_failed',
  'invoice.email_queued',
  'invoice.email_delivered',
  'invoice.email_bounced',
  'invoice.email_spam',
  'invoice.email_opened',
  'invoice.pdf_viewed',
  'invoice.payment_received',
  'invoice.payment_partial',
  'invoice.payment_reversed',
  'invoice.overdue',
  'invoice.reminder_sent',
  'invoice.debt_collection',
  'invoice.voided',
  'invoice.credit_note_created',
  'invoice.note_added',
  'invoice.viewed_by_user',
] as const

// ─── Invoice State Machine ─────────────────────────────────────────────────
// Giltiga statusövergångar. Terminala statusar (PAID, VOID) har tomma arrayer.
// Samma approach som Stripe använder internt.

import type { InvoiceStatus, InvoiceEventType, LeaseStatus } from '../types'

export const INVOICE_TRANSITIONS: Record<InvoiceStatus, InvoiceStatus[]> = {
  DRAFT: ['SENT', 'VOID'],
  SENT: ['PARTIAL', 'PAID', 'OVERDUE', 'VOID'],
  // #307 PR 2b: PARTIAL → SENT_TO_COLLECTION. En DELBETALD fordran är en
  // verklig fordran, och inkassovägen har alltid kunnat lämna över den —
  // `claimForExport` grindade på `notIn ['PAID','VOID','SENT_TO_COLLECTION']`
  // och konsulterade aldrig den här tabellen. Kanten fanns alltså i koden men
  // inte i modellen.
  //
  // Att i stället flippa PARTIAL → OVERDUE före överlämningen (det uppenbara
  // alternativet) VALDES BORT: OverdueDebtService — dashboardens och
  // månadsrapportens delade sanningskälla för "Försenat belopp" — räknar
  // Invoice-sidan som `inv.total` på det dokumenterade antagandet att en
  // OVERDUE-faktura är fullt obetald. En delbetald faktura som flippas till
  // OVERDUE hade därför lagt in HELA ursprungsbeloppet i den siffran, inte
  // restskulden. Fixen hade gjort en rapporterad siffra fel för att blidka
  // statusmaskinen.
  //
  // HISTORIK — HÅLET ÄR STÄNGT (#325). OverdueDebtService räknar sedan dess
  // Invoice-sidan som `invoiceOutstanding(inv)`, alltså restskulden, symmetriskt
  // med RentNotice-grenen. Argumentet ovan gäller alltså inte längre som skäl att
  // undvika kanten — men bortvalet STÅR KVAR på egna meriter: PARTIAL →
  // SENT_TO_COLLECTION är den ärliga modelleringen av "en delbetald fordran är en
  // fordran", och att gå omvägen via OVERDUE hade dolt att fakturan är delbetald.
  PARTIAL: ['PAID', 'OVERDUE', 'VOID', 'SENT_TO_COLLECTION'],
  OVERDUE: ['PARTIAL', 'PAID', 'VOID', 'SENT_TO_COLLECTION'],
  SENT_TO_COLLECTION: ['PAID', 'VOID'],
  PAID: [],
  VOID: [],
}

export function isValidTransition(from: InvoiceStatus, to: InvoiceStatus): boolean {
  return INVOICE_TRANSITIONS[from]?.includes(to) ?? false
}

// Hyresavtalets statusmaskin (#60). Enda källan till giltiga övergångar, delad
// mellan alla status-skrivare i LeasesService (transitionStatus, renew/autoRenew
// gamla→EXPIRED, terminateExpired ACTIVE→TERMINATED). Gäller BARA övergångar på en
// BEFINTLIG rad — ett nytt avtal som skapas direkt ACTIVE (succession) har ingen
// from-status och gate:as därför inte. EXPIRED/TERMINATED är terminala.
export const LEASE_STATUS_TRANSITIONS: Record<LeaseStatus, LeaseStatus[]> = {
  DRAFT: ['ACTIVE', 'TERMINATED'],
  ACTIVE: ['EXPIRED', 'TERMINATED'],
  EXPIRED: [],
  TERMINATED: [],
}

export function isValidLeaseTransition(from: LeaseStatus, to: LeaseStatus): boolean {
  return LEASE_STATUS_TRANSITIONS[from]?.includes(to) ?? false
}

// Mappar statusövergång → händelsetyp som loggas
export const STATUS_TO_EVENT: Partial<Record<InvoiceStatus, InvoiceEventType>> = {
  SENT: 'invoice.sent',
  PARTIAL: 'invoice.payment_partial',
  PAID: 'invoice.payment_received',
  OVERDUE: 'invoice.overdue',
  VOID: 'invoice.voided',
}

// PDF-/dokumentvarumärke (default-färg, typsnittsval + font-stackar). Steg 3 PR 1.
export * from './branding'

// SaaS-plans & AI-anropstak. Definitionen ligger i plans.ts för läsbarhet.
export * from './plans'

// Plattformens juridiska identitet + versionsmärkta dokument
export * from './platform'

// Edit-lås på ACTIVE-hyresavtal (T1.1) — delad fält-lista backend↔frontend
export * from './lease-edit-lock'

// Succession-carry: villkor som en förnyelse bär vidare (T1.3) — fail-closed via DMMF-test
export * from './lease-succession-carry'

// Bankkopplingens säkra fältmängd — EN lista, härledd av både api och web.
export * from './psd2'
