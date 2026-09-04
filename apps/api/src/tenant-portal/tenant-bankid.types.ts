import type { Tenant } from '@prisma/client'

/** Ett hyresförhållande BankID-identifieringen matchade. */
export interface TenantBankIdCandidate {
  tenantId: string
  /** Hyresvärdens namn — det som gör valet begripligt för hyresgästen. */
  organizationName: string
  /**
   * Lägenhetens adress, eller null när hyresgästen saknar aktivt kontrakt.
   *
   * Orgnamnet ensamt räcker inte: en hyresgäst känner ofta igen sin ADRESS men
   * inte sitt fastighetsbolags juridiska namn. Fältet är därför inte pynt utan
   * det som gör valet möjligt att göra rätt.
   */
  address: string | null
}

export interface TenantBankIdStartResult {
  orderRef: string
  autoStartToken?: string
  qrData?: string
}

export type TenantBankIdCollectResult =
  | { status: 'pending'; hintCode?: string }
  | { status: 'failed'; reason: string }
  | {
      status: 'complete'
      sessionToken: string
      expiresAt: string
      tenant: Pick<Tenant, 'id' | 'firstName' | 'lastName' | 'companyName' | 'email'>
    }
  | { status: 'choose'; chooseToken: string; candidates: TenantBankIdCandidate[] }
