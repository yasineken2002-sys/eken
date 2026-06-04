/**
 * PR3 — om-validering av (redigerad) skanningsdata innan avtal skapas.
 * Ingen ovaliderad data får nå createWithTenant (sanitizeEdited-mönstret).
 */

import { buildLeaseDtoFromScan } from './contract-lease-builder'
import type { ScannedContract } from './contract-scanner.service'

function scan(over: Partial<ScannedContract> = {}): ScannedContract {
  return {
    tenantName: 'Anna Andersson',
    tenantType: 'INDIVIDUAL',
    tenantEmail: 'anna@example.se',
    tenantPhone: '0701234567',
    personalNumber: '19900101-1234',
    companyName: null,
    orgNumber: null,
    propertyAddress: 'Storgatan 1, Stockholm',
    unitDescription: '1201',
    monthlyRent: 12000,
    depositAmount: 24000,
    startDate: '2026-07-01',
    endDate: null,
    noticePeriodMonths: 3,
    confidence: 0.9,
    rawText: '',
    ...over,
  }
}

describe('buildLeaseDtoFromScan — giltig data', () => {
  it('bygger ett komplett DTO (privatperson, utkast)', () => {
    const dto = buildLeaseDtoFromScan(scan(), 'unit-1')
    expect(dto.unitId).toBe('unit-1')
    expect(dto.monthlyRent).toBe(12000)
    expect(dto.startDate).toBe('2026-07-01')
    expect(dto.depositAmount).toBe(24000)
    expect(dto.noticePeriodMonths).toBe(3)
    expect(dto.activate).toBe(false) // skapas ALLTID som utkast
    expect(dto.newTenant).toEqual(
      expect.objectContaining({
        type: 'INDIVIDUAL',
        firstName: 'Anna',
        lastName: 'Andersson',
        email: 'anna@example.se',
      }),
    )
  })

  it('delar upp namn med flera efternamn korrekt', () => {
    const dto = buildLeaseDtoFromScan(scan({ tenantName: 'Anna Maria Von Andersson' }), 'u1')
    expect(dto.newTenant!.firstName).toBe('Anna')
    expect(dto.newTenant!.lastName).toBe('Maria Von Andersson')
  })

  it('företag → companyName, inget krav på för-/efternamn', () => {
    const dto = buildLeaseDtoFromScan(
      scan({ tenantType: 'COMPANY', companyName: 'Acme AB', tenantName: 'Acme AB' }),
      'u1',
    )
    expect(dto.newTenant!.type).toBe('COMPANY')
    expect(dto.newTenant!.companyName).toBe('Acme AB')
  })

  it('endDate → FIXED_TERM', () => {
    const dto = buildLeaseDtoFromScan(scan({ endDate: '2027-07-01' }), 'u1')
    expect(dto.endDate).toBe('2027-07-01')
    expect(dto.leaseType).toBe('FIXED_TERM')
  })
})

describe('buildLeaseDtoFromScan — avvisar ogiltig/ofullständig data', () => {
  it('saknad enhet', () => {
    expect(() => buildLeaseDtoFromScan(scan(), '')).toThrow(/enhet/i)
  })

  it('ogiltig/saknad e-post', () => {
    expect(() => buildLeaseDtoFromScan(scan({ tenantEmail: null }), 'u1')).toThrow(/e-post/i)
    expect(() => buildLeaseDtoFromScan(scan({ tenantEmail: 'inte-en-epost' }), 'u1')).toThrow(
      /e-post/i,
    )
  })

  it('månadshyra saknas / ≤ 0 / orimligt hög', () => {
    expect(() => buildLeaseDtoFromScan(scan({ monthlyRent: null }), 'u1')).toThrow(/[Mm]ånadshyra/)
    expect(() => buildLeaseDtoFromScan(scan({ monthlyRent: 0 }), 'u1')).toThrow(/[Mm]ånadshyra/)
    expect(() => buildLeaseDtoFromScan(scan({ monthlyRent: 9_999_999 }), 'u1')).toThrow(
      /[Mm]ånadshyra/,
    )
  })

  it('ogiltigt/saknat startdatum', () => {
    expect(() => buildLeaseDtoFromScan(scan({ startDate: null }), 'u1')).toThrow(/startdatum/i)
    expect(() => buildLeaseDtoFromScan(scan({ startDate: 'igår' }), 'u1')).toThrow(/startdatum/i)
    expect(() => buildLeaseDtoFromScan(scan({ startDate: '2026-13-45' }), 'u1')).toThrow(
      /startdatum/i,
    )
  })

  it('privatperson utan både för- och efternamn', () => {
    expect(() => buildLeaseDtoFromScan(scan({ tenantName: 'Anna' }), 'u1')).toThrow(/[Ff]örnamn/)
    expect(() => buildLeaseDtoFromScan(scan({ tenantName: null }), 'u1')).toThrow(/[Ff]örnamn/)
  })

  it('företag utan företagsnamn', () => {
    expect(() =>
      buildLeaseDtoFromScan(
        scan({ tenantType: 'COMPANY', companyName: null, tenantName: null }),
        'u1',
      ),
    ).toThrow(/[Ff]öretagsnamn/)
  })
})
