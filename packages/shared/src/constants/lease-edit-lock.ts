// ── Edit-lås på ACTIVE-hyresavtal (T1.1) ────────────────────────────────────
// Kanonisk källa för VILKA fält som är låsta när ett hyresavtal är ACTIVE, delad
// mellan backend-guarden (LeasesService.update) och frontend-formuläret så de
// ALDRIG kan divergera. Diverngens = antingen 400-vägg (fält låst i backend men
// redigerbart i UI) eller ett fält som ser låst ut men inte är det.
//
// SYNK-KONTRAKT: `LEASE_ACTIVE_LOCKED_FIELDS` MÅSTE matcha backendens
// `TIER1_LOCKED_ON_ACTIVE`-array (apps/api/src/leases/leases.service.ts) exakt —
// en backend-test (leases-edit-lock-t11a.spec.ts) asserterar likheten och bryter
// CI om listorna glider isär.

export type LeaseLockRoute = 'RENT' | 'DATE_START' | 'END_DATE' | 'IDENTITY' | 'DEPOSIT' | 'TERMS'

// De 29 Tier-1-fält som backend låser på ACTIVE (guard-only i update()).
// endDate ingår INTE här — den låses av sin egen guard (F2/#65) och är därför inte
// med i backendens TIER1-array; UI-låset nedan lägger till den separat.
export const LEASE_ACTIVE_LOCKED_FIELDS = [
  // Hyra + avgifter (del av total hyra, JB 12:19) → hyreshöjningsflödet
  'monthlyRent',
  'parkingFee',
  'storageFee',
  'garageFee',
  // Tillträdesdag
  'startDate',
  // Identitet → succession
  'unitId',
  'tenantId',
  // Deposition
  'depositAmount',
  // Bindande villkor
  'leaseType',
  'noticePeriodMonths',
  'renewalPeriodMonths',
  'includesHeating',
  'includesWater',
  'includesHotWater',
  'includesElectricity',
  'includesInternet',
  'includesCleaning',
  'includesParking',
  'includesStorage',
  'includesLaundry',
  'usagePurpose',
  'sublettingAllowed',
  'requiresHomeInsurance',
  'petsAllowed',
  'indexClauseType',
  'indexBaseYear',
  'indexAdjustmentDate',
  'indexMaxIncrease',
  'indexMinIncrease',
  'specialTerms',
] as const

export type LeaseLockedField = (typeof LEASE_ACTIVE_LOCKED_FIELDS)[number]

// UI-låset inkluderar dessutom endDate (backend F2/#65-guard nekar den redan).
// Frontend disablar denna fulla lista på ACTIVE; annotationer (indexNotes,
// petsApprovalNotes) är MEDVETET inte med och förblir redigerbara.
export const LEASE_ACTIVE_LOCKED_UI_FIELDS = [...LEASE_ACTIVE_LOCKED_FIELDS, 'endDate'] as const

// Vilken domänväg varje låst fält hör till (styr hint-texten i UI + speglar
// backendens per-fält-route i TIER1_LOCKED_ON_ACTIVE).
export const LEASE_LOCK_FIELD_ROUTE: Record<string, LeaseLockRoute> = {
  monthlyRent: 'RENT',
  parkingFee: 'RENT',
  storageFee: 'RENT',
  garageFee: 'RENT',
  startDate: 'DATE_START',
  endDate: 'END_DATE',
  unitId: 'IDENTITY',
  tenantId: 'IDENTITY',
  depositAmount: 'DEPOSIT',
  leaseType: 'TERMS',
  noticePeriodMonths: 'TERMS',
  renewalPeriodMonths: 'TERMS',
  includesHeating: 'TERMS',
  includesWater: 'TERMS',
  includesHotWater: 'TERMS',
  includesElectricity: 'TERMS',
  includesInternet: 'TERMS',
  includesCleaning: 'TERMS',
  includesParking: 'TERMS',
  includesStorage: 'TERMS',
  includesLaundry: 'TERMS',
  usagePurpose: 'TERMS',
  sublettingAllowed: 'TERMS',
  requiresHomeInsurance: 'TERMS',
  petsAllowed: 'TERMS',
  indexClauseType: 'TERMS',
  indexBaseYear: 'TERMS',
  indexAdjustmentDate: 'TERMS',
  indexMaxIncrease: 'TERMS',
  indexMinIncrease: 'TERMS',
  specialTerms: 'TERMS',
}

// Kort UI-hint per väg — talar om VART ändringen ska göras (aktiv röst, den
// enskilda ytan). Speglar backendens felmeddelande-hänvisningar.
export const LEASE_LOCK_ROUTE_HINT: Record<LeaseLockRoute, string> = {
  RENT: 'Ändras via hyreshöjning.',
  DATE_START: 'Tillträdesdagen är låst på ett aktivt kontrakt.',
  END_DATE: 'Ändras via uppsägning eller förnyelse.',
  IDENTITY: 'Byte kräver ett nytt kontrakt (förnyelse).',
  DEPOSIT: 'Hanteras via depositionsflödet.',
  TERMS: 'Bindande villkor — ändras via nytt kontrakt eller tillägg.',
}
