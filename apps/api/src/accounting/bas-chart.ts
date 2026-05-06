// BAS-kontoplan 2026 anpassad per svensk företagsform.
//
// Bygger på Bokföringsnämndens normgivning samt Fastighetsägarnas
// branschanpassning för fastighetsförvaltning. Det enda som faktiskt
// skiljer sig per företagsform är eget kapital-serien — tillgångar,
// skulder, intäkter och kostnader är desamma.
//
// Eget kapital-mappning:
//   • AB             → 2080-serien (aktiekapital, reservfond, balanserat resultat)
//   • Enskild firma  → 2010-serien (eget kapital, egna uttag, egna insättningar)
//   • HB / KB        → 2010-serien (delägarkapital — varje delägare har egen 20XX)
//   • Förening       → 2065-serien (förändring av kapital + årets resultat)
//   • Stiftelse      → 2070-serien (bundet/fritt eget kapital)
//
// Tar man bort eller döper om en post i en av listorna måste man hålla
// koll på var kontonumren refereras i AccountingService (auto-postering
// vid fakturering, momsredovisning m.m.) — se `VAT_TO_ACCOUNT` och
// `POSTING_RULES` i accounting.service.ts.

import type { CompanyForm } from '@prisma/client'

export interface BasAccountSeed {
  number: number
  name: string
  type: 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE'
}

// ── Gemensamma konton (samma för alla företagsformer) ─────────────────────
//
// Identiskt med tidigare DEFAULT_ACCOUNTS i AccountingService — vi har
// flyttat hit det enbart för att kunna kombinera med form-specifik
// eget kapital-serie utan att duplicera 60+ rader.
const COMMON_ACCOUNTS: BasAccountSeed[] = [
  // Tillgångar
  { number: 1510, name: 'Kundfordringar', type: 'ASSET' },
  { number: 1515, name: 'Osäkra kundfordringar', type: 'ASSET' },
  { number: 1930, name: 'Företagskonto / Bank', type: 'ASSET' },
  { number: 1940, name: 'Plusgiro', type: 'ASSET' },
  // Skulder (exkl. eget kapital)
  { number: 2350, name: 'Andra långfristiga skulder', type: 'LIABILITY' },
  { number: 2440, name: 'Leverantörsskulder', type: 'LIABILITY' },
  { number: 2490, name: 'Övriga kortfristiga skulder', type: 'LIABILITY' },
  { number: 2611, name: 'Utgående moms 25% (försäljning Sverige)', type: 'LIABILITY' },
  { number: 2621, name: 'Utgående moms 12%', type: 'LIABILITY' },
  { number: 2631, name: 'Utgående moms 6%', type: 'LIABILITY' },
  { number: 2640, name: 'Ingående moms', type: 'LIABILITY' },
  { number: 2641, name: 'Debiterad ingående moms', type: 'LIABILITY' },
  { number: 2645, name: 'Beräknad ingående moms på förvärv från utlandet', type: 'LIABILITY' },
  { number: 2650, name: 'Redovisningskonto för moms', type: 'LIABILITY' },
  { number: 2710, name: 'Personalskatt', type: 'LIABILITY' },
  { number: 2820, name: 'Mottagna depositioner', type: 'LIABILITY' },
  // Intäkter
  { number: 3001, name: 'Hyresintäkter bostäder (momsfri)', type: 'REVENUE' },
  { number: 3010, name: 'Hyresintäkter lokaler (momspliktiga)', type: 'REVENUE' },
  { number: 3011, name: 'Hyresintäkter lokaler (momsfria)', type: 'REVENUE' },
  { number: 3012, name: 'Hyresintäkter parkering / garage', type: 'REVENUE' },
  { number: 3013, name: 'Hyresintäkter förråd', type: 'REVENUE' },
  { number: 3030, name: 'Övriga ersättningar (varmvatten, el)', type: 'REVENUE' },
  { number: 3040, name: 'Skadeersättningar', type: 'REVENUE' },
  { number: 3593, name: 'Påminnelseavgifter', type: 'REVENUE' },
  { number: 3960, name: 'Valutakursvinster på rörelsefordringar', type: 'REVENUE' },
  // Driftkostnader
  { number: 5010, name: 'Lokalhyra (egen)', type: 'EXPENSE' },
  { number: 5020, name: 'El för fastighet', type: 'EXPENSE' },
  { number: 5030, name: 'Värme (fjärrvärme)', type: 'EXPENSE' },
  { number: 5040, name: 'Vatten och avlopp', type: 'EXPENSE' },
  { number: 5050, name: 'Sophämtning och städning', type: 'EXPENSE' },
  { number: 5060, name: 'Fastighetsskötsel', type: 'EXPENSE' },
  { number: 5070, name: 'Reparation och underhåll', type: 'EXPENSE' },
  { number: 5080, name: 'Försäkring fastighet', type: 'EXPENSE' },
  { number: 5090, name: 'Övriga fastighetskostnader', type: 'EXPENSE' },
  { number: 6110, name: 'Kontorsmaterial', type: 'EXPENSE' },
  { number: 6230, name: 'Internet och datakommunikation', type: 'EXPENSE' },
  { number: 6310, name: 'Företagsförsäkring', type: 'EXPENSE' },
  { number: 6420, name: 'Revisionsarvoden', type: 'EXPENSE' },
  { number: 6530, name: 'Redovisningstjänster', type: 'EXPENSE' },
  { number: 7010, name: 'Löner till tjänstemän', type: 'EXPENSE' },
  { number: 7510, name: 'Lagstadgade sociala avgifter', type: 'EXPENSE' },
  { number: 8410, name: 'Räntekostnader (lån)', type: 'EXPENSE' },
]

// ── Eget kapital per företagsform ─────────────────────────────────────────

// Aktiebolag — bundet (2080-2089) och fritt (2090-2099) eget kapital
// enligt ABL 17 kap. och BAS-kontoplanen 2026.
const AB_EQUITY: BasAccountSeed[] = [
  { number: 2080, name: 'Bundet eget kapital', type: 'EQUITY' },
  { number: 2081, name: 'Aktiekapital', type: 'EQUITY' },
  { number: 2086, name: 'Reservfond', type: 'EQUITY' },
  { number: 2087, name: 'Bunden överkursfond', type: 'EQUITY' },
  { number: 2090, name: 'Fritt eget kapital', type: 'EQUITY' },
  { number: 2091, name: 'Balanserat resultat', type: 'EQUITY' },
  { number: 2098, name: 'Vinst eller förlust föregående år', type: 'EQUITY' },
  { number: 2099, name: 'Årets resultat', type: 'EQUITY' },
]

// Enskild firma — eget kapital med egna uttag/insättningar (BAS 2010-2019).
// Aktivt använda av enskild näringsidkare i K1/K2-bokslut.
const ENSKILD_FIRMA_EQUITY: BasAccountSeed[] = [
  { number: 2010, name: 'Eget kapital', type: 'EQUITY' },
  { number: 2011, name: 'Egna varuuttag', type: 'EQUITY' },
  { number: 2013, name: 'Övriga egna uttag', type: 'EQUITY' },
  { number: 2017, name: 'Årets kapitaltillskott', type: 'EQUITY' },
  { number: 2018, name: 'Övriga egna insättningar', type: 'EQUITY' },
  { number: 2019, name: 'Årets resultat', type: 'EQUITY' },
]

// Handelsbolag / Kommanditbolag — delägarbaserat eget kapital. BAS
// rekommenderar 2010-2019 per delägare; vi seedar konton för en första
// delägare och låter användaren själv lägga till fler vid behov.
const HB_KB_EQUITY: BasAccountSeed[] = [
  { number: 2010, name: 'Eget kapital, delägare 1', type: 'EQUITY' },
  { number: 2013, name: 'Egna uttag, delägare 1', type: 'EQUITY' },
  { number: 2018, name: 'Egna insättningar, delägare 1', type: 'EQUITY' },
  { number: 2019, name: 'Årets resultat, delägare 1', type: 'EQUITY' },
]

// Ideell/ekonomisk förening — förändring av eget kapital över året.
const FORENING_EQUITY: BasAccountSeed[] = [
  { number: 2065, name: 'Förändring i fond för verkligt värde', type: 'EQUITY' },
  { number: 2067, name: 'Balanserad vinst eller förlust', type: 'EQUITY' },
  { number: 2068, name: 'Vinst eller förlust föregående år', type: 'EQUITY' },
  { number: 2069, name: 'Årets resultat', type: 'EQUITY' },
]

// Stiftelse — bundet/fritt eget kapital enligt SFL.
const STIFTELSE_EQUITY: BasAccountSeed[] = [
  { number: 2070, name: 'Stiftelsens kapital (bundet)', type: 'EQUITY' },
  { number: 2071, name: 'Bundet kapital — gåvor och bidrag', type: 'EQUITY' },
  { number: 2078, name: 'Fritt eget kapital', type: 'EQUITY' },
  { number: 2079, name: 'Årets resultat', type: 'EQUITY' },
]

const EQUITY_BY_FORM: Record<CompanyForm, BasAccountSeed[]> = {
  AB: AB_EQUITY,
  ENSKILD_FIRMA: ENSKILD_FIRMA_EQUITY,
  HB: HB_KB_EQUITY,
  KB: HB_KB_EQUITY,
  FORENING: FORENING_EQUITY,
  STIFTELSE: STIFTELSE_EQUITY,
}

/**
 * Returnerar fullständig BAS-kontoplan för given företagsform.
 * Listan är immutabel — kopiera innan modifiering om så krävs.
 */
export function basChartFor(companyForm: CompanyForm): BasAccountSeed[] {
  return [...COMMON_ACCOUNTS, ...EQUITY_BY_FORM[companyForm]]
}
