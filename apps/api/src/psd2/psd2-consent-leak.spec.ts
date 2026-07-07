/**
 * Läcktätning: SAFE_BANK_CONSENT_SELECT är den ENDA vägen BankConsent lämnar
 * backend. Tokens (accessTokenEnc/refreshTokenEnc), scope, syncCursor och consentId
 * får ALDRIG exponeras mot frontend/AI. (Mönster från signering/tenant-portal.)
 */

import { SAFE_BANK_CONSENT_SELECT } from './psd2-consent.service'

const FORBIDDEN = [
  'accessTokenEnc',
  'refreshTokenEnc',
  'scope',
  'syncCursor',
  'consentId',
  'organizationId',
  'createdByUserId',
]

describe('SAFE_BANK_CONSENT_SELECT — allow-list', () => {
  it('exponerar ENDAST ofarliga fält', () => {
    expect(Object.keys(SAFE_BANK_CONSENT_SELECT).sort()).toEqual(
      ['id', 'provider', 'status', 'expiresAt', 'lastSyncedAt', 'revokedAt', 'createdAt'].sort(),
    )
  })

  it('inget känsligt fält (särskilt tokens) är med i allow-listen', () => {
    for (const f of FORBIDDEN) {
      expect(SAFE_BANK_CONSENT_SELECT).not.toHaveProperty(f)
    }
  })
})
