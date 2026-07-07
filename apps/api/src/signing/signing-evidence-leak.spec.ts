/**
 * Läcktätning: SAFE_SIGNATURE_EVIDENCE_SELECT är den ENDA vägen SignatureEvidence
 * lämnar backend. Känsliga fält (personnr, signaturpayload, certifikat, orderRef,
 * signerad hash, org-id) får ALDRIG exponeras. Mönster från tenant-portal.leak.spec.
 */

jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import { SAFE_SIGNATURE_EVIDENCE_SELECT } from './signing.service'

const FORBIDDEN = [
  'personalNumberEnc',
  'personalNumberHash',
  'signaturePayload',
  'certificate',
  'orderRef',
  'signedContentHash',
  'organizationId',
  'ip',
  'userAgent',
]

describe('SAFE_SIGNATURE_EVIDENCE_SELECT — allow-list', () => {
  it('exponerar ENDAST ofarliga fält', () => {
    expect(Object.keys(SAFE_SIGNATURE_EVIDENCE_SELECT).sort()).toEqual(
      ['id', 'signedAt', 'signerName', 'signerRole'].sort(),
    )
  })

  it('inget känsligt fält är med i allow-listen', () => {
    for (const f of FORBIDDEN) {
      expect(SAFE_SIGNATURE_EVIDENCE_SELECT).not.toHaveProperty(f)
    }
  })
})
