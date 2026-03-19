export const VAT_RATES = [0, 6, 12, 25] as const
export type VatRate = (typeof VAT_RATES)[number]

export const DEFAULT_NOTICE_PERIOD_MONTHS = 3
export const DEFAULT_PAGE_SIZE = 20
export const MAX_PAGE_SIZE = 100

export const CURRENCY = 'SEK'
export const LOCALE = 'sv-SE'

// BAS account ranges
export const ACCOUNT_RANGES = {
  ASSET: { min: 1000, max: 1999 },
  LIABILITY: { min: 2000, max: 2999 },
  EQUITY: { min: 3000, max: 3999 },
  REVENUE: { min: 3000, max: 3999 },
  EXPENSE: { min: 4000, max: 8999 },
} as const

// Standard BAS accounts for real estate
export const STANDARD_ACCOUNTS = {
  RENT_REVENUE: 3010,
  VAT_OUTPUT: 2610,
  ACCOUNTS_RECEIVABLE: 1510,
  BANK: 1930,
  DEPOSIT_LIABILITY: 2350,
} as const

export const USER_ROLES = ['OWNER', 'ADMIN', 'MANAGER', 'ACCOUNTANT', 'VIEWER'] as const
