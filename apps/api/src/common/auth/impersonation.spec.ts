/**
 * `impersonatorOf` — den faktiska människan bakom en impersonerad handling.
 *
 * Testet bevakar utläsningen, inte attributionen. Att verifikatets
 * `createdById` fortfarande namnger org-användaren är ett känt, öppet beslut
 * (#379) — inte något det här specet påstår är löst.
 */

import type { JwtPayload } from '@eken/shared'

import { impersonatorOf } from './impersonation'

const bas: JwtPayload = {
  sub: 'org-user-1',
  email: 'a@b.se',
  organizationId: 'org-1',
  role: 'OWNER',
}

describe('impersonatorOf', () => {
  it('normalfallet: ingen impersonation → null', () => {
    expect(impersonatorOf(bas)).toBeNull()
  })

  it('impersonation → plattformsanvändarens id, INTE sub', () => {
    const payload = { ...bas, impersonatedBy: 'platform-user-9' } as JwtPayload

    expect(impersonatorOf(payload)).toBe('platform-user-9')
    // Diskriminerande: de två id:na är olika strängar. Sammanföll de kunde
    // testet inte se att rätt fält lästes.
    expect(impersonatorOf(payload)).not.toBe(bas.sub)
  })

  it('tom sträng räknas inte som impersonation', () => {
    expect(impersonatorOf({ ...bas, impersonatedBy: '' } as JwtPayload)).toBeNull()
  })

  it('icke-sträng i claimen räknas inte — token är inte betrodd att ha rätt form', () => {
    // Claimen kommer från en JWT och kan bära vad som helst om något går fel i
    // utfärdandet. Fail-closed: bara en icke-tom sträng godtas.
    expect(impersonatorOf({ ...bas, impersonatedBy: 42 } as unknown as JwtPayload)).toBeNull()
    expect(impersonatorOf({ ...bas, impersonatedBy: null } as unknown as JwtPayload)).toBeNull()
    expect(impersonatorOf({ ...bas, impersonatedBy: {} } as unknown as JwtPayload)).toBeNull()
  })
})
