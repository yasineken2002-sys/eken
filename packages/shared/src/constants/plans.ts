// SaaS-plan-konfiguration. SINGLE SOURCE OF TRUTH för månadsavgift,
// objektgräns och AI-anropstak. Backend (AiPlanLimitsService) läser samma
// data, frontend (Plan-sida + admin) visar samma data, säljsida via
// publik /v1/public/plans-endpoint får också detta.
//
// Priser visas alltid EXKL MOMS i UI (B2B-standard). Fakturering lägger
// på 25% moms.
//
// VIKTIGT: monthlyAiCalls räknas BARA mot manuella anrop från admin via
// AiPage / chat. Automatiska anrop (morning insights, hyresgäst-chats,
// OCR, kontraktsskanning, bankavstämning) räknas EJ — de ingår i
// baspriset oavsett plan.

export type SubscriptionPlan = 'TRIAL' | 'STARTER' | 'MINI' | 'STANDARD' | 'PLUS' | 'PRO'

export type OrgStatus = 'TRIAL' | 'ACTIVE' | 'PAST_DUE' | 'SUSPENDED' | 'CANCELLED'

export interface PlanLimit {
  /** Månadsavgift i SEK exkl moms. */
  monthlyFee: number
  /** Maxantal hyresobjekt (lägenheter/lokaler) i organisationen. */
  maxObjects: number
  /** Tak för MANUELLA AI-anrop per kalendermånad. Återställs första
   *  dagen varje månad kl 00:00 lokal tid. */
  monthlyAiCalls: number
  /** Visningsnamn i UI ("Standard", "Pro" osv). */
  name: string
  /** Kort beskrivning för plan-väljaren. */
  description: string
}

export const PLAN_LIMITS: Record<SubscriptionPlan, PlanLimit> = {
  TRIAL: {
    monthlyFee: 0,
    maxObjects: 999,
    monthlyAiCalls: 100,
    name: 'Trial',
    description: '30 dagar gratis – alla funktioner inkluderade',
  },
  STARTER: {
    monthlyFee: 390,
    maxObjects: 5,
    monthlyAiCalls: 200,
    name: 'Starter',
    description: 'För dig som har 1–5 hyresobjekt',
  },
  MINI: {
    monthlyFee: 990,
    maxObjects: 15,
    monthlyAiCalls: 500,
    name: 'Mini',
    description: 'För dig som har 6–15 hyresobjekt',
  },
  STANDARD: {
    monthlyFee: 2490,
    maxObjects: 50,
    monthlyAiCalls: 2000,
    name: 'Standard',
    description: 'För dig som har 16–50 hyresobjekt',
  },
  PLUS: {
    monthlyFee: 4990,
    maxObjects: 150,
    monthlyAiCalls: 5000,
    name: 'Plus',
    description: 'För dig som har 51–150 hyresobjekt',
  },
  PRO: {
    monthlyFee: 9990,
    maxObjects: 300,
    monthlyAiCalls: 20000,
    name: 'Pro',
    description: 'För dig som har 151–300 hyresobjekt',
  },
}

/** Ordning på planer från lägst till högst (för UI-uppgraderingsstegar). */
export const PLAN_ORDER: SubscriptionPlan[] = [
  'TRIAL',
  'STARTER',
  'MINI',
  'STANDARD',
  'PLUS',
  'PRO',
]

/** Pris per extra AI-anrop som credit, exkl moms. */
export const CREDIT_PRICE_SEK = 1

/** Köppaket för extra credits (visas i frontend-modalen). */
export const CREDIT_PACKAGES = [
  { amount: 100, priceSek: 99, label: '100 credits', recommended: true },
  { amount: 500, priceSek: 499, label: '500 credits', recommended: false },
  { amount: 1000, priceSek: 999, label: '1 000 credits', recommended: false },
] as const

/** Antalet dagar i trial vid signup. */
export const TRIAL_DAYS = 30

/** Trösklar (% av tak) som triggar varningsmejl. */
export const USAGE_WARNING_THRESHOLDS = [80, 95, 100] as const

/** Hjälpfunktion: returnera plan-limit för en given plan (typed lookup). */
export function getPlanLimit(plan: SubscriptionPlan): PlanLimit {
  return PLAN_LIMITS[plan]
}

/** Returnerar tidsstämpel för första millisekunden i nästa kalendermånad
 *  (när taket nollställs). */
export function getNextResetAt(from: Date = new Date()): Date {
  return new Date(from.getFullYear(), from.getMonth() + 1, 1, 0, 0, 0, 0)
}

/** Returnerar tidsstämpel för första dagen i innevarande månad kl 00:00. */
export function getMonthStart(from: Date = new Date()): Date {
  return new Date(from.getFullYear(), from.getMonth(), 1, 0, 0, 0, 0)
}
