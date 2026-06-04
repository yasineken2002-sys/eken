/**
 * PR2 deterministisk enhetsmatchning — ren logik.
 *
 * Verifierar exakt-EN-regeln, normalisering (versaler/mellanslag/skiljetecken/
 * lägenhetsprefix) och att tvetydiga/ofullständiga fall lämnas till människa.
 * Org-scoping testas i service-spec:en (matchern får bara in-org-kandidater).
 */

import {
  deterministicUnitMatcher,
  normalizeText,
  normalizeUnitNumber,
  MIN_MATCH_CONFIDENCE,
  type MatchCandidateUnit,
  type MatchInput,
} from './unit-matcher'

function unit(
  id: string,
  unitNumber: string,
  street: string,
  postalCode = '11451',
  city = 'Stockholm',
): MatchCandidateUnit {
  return { id, unitNumber, property: { street, postalCode, city } }
}

function input(over: Partial<MatchInput> = {}): MatchInput {
  return {
    propertyAddress: 'Storgatan 1, 114 51 Stockholm',
    unitDescription: '1201',
    confidence: 0.9,
    ...over,
  }
}

const m = (i: MatchInput, c: MatchCandidateUnit[]) => deterministicUnitMatcher.match(i, c)

describe('normalizeText', () => {
  it('gemener + släng mellanslag/skiljetecken, behåll å ä ö', () => {
    expect(normalizeText('Storgatan 1, 114 51 Stockholm')).toBe('storgatan111451stockholm')
    expect(normalizeText('ÖSTRA Ängsgatan 3')).toBe('östraängsgatan3')
    expect(normalizeText('Bäckgränd 2')).toBe('bäckgränd2')
  })
})

describe('normalizeUnitNumber', () => {
  it('strippar prefix följt av siffra', () => {
    expect(normalizeUnitNumber('Lägenhet 1201')).toBe('1201')
    expect(normalizeUnitNumber('Lgh 1201')).toBe('1201')
    expect(normalizeUnitNumber('LGH1201')).toBe('1201')
    expect(normalizeUnitNumber('1201')).toBe('1201')
    expect(normalizeUnitNumber('Lokal 5')).toBe('5')
  })
  it('strippar INTE ett prefix-liknande ord utan efterföljande siffra', () => {
    // "no" följs av "r" (inte siffra) → ordet ska inte kapas
    expect(normalizeUnitNumber('Nordica')).toBe('nordica')
  })
})

describe('deterministicUnitMatcher — exakt-EN-regeln', () => {
  it('exakt 1 kandidat → AUTO_MATCHED + unitId', () => {
    const res = m(input(), [unit('u1', '1201', 'Storgatan 1'), unit('u2', '1202', 'Storgatan 1')])
    expect(res.status).toBe('AUTO_MATCHED')
    expect(res.unitId).toBe('u1')
  })

  it('flera kandidater (samma nr + adress i två fastigheter) → AMBIGUOUS, ingen gissning', () => {
    const res = m(input(), [
      unit('u1', '1201', 'Storgatan 1'),
      unit('u2', '1201', 'Storgatan 1'), // dubblett-scenario över två properties
    ])
    expect(res.status).toBe('AMBIGUOUS')
    expect(res.unitId).toBeNull()
  })

  it('noll kandidater → NO_MATCH', () => {
    const res = m(input(), [unit('u1', '9999', 'Annangatan 5', '11122', 'Göteborg')])
    expect(res.status).toBe('NO_MATCH')
    expect(res.unitId).toBeNull()
  })

  it('tom kandidatlista → NO_MATCH', () => {
    expect(m(input(), []).status).toBe('NO_MATCH')
  })
})

describe('deterministicUnitMatcher — NEEDS_REVIEW', () => {
  it('saknad adress → NEEDS_REVIEW', () => {
    expect(m(input({ propertyAddress: null }), [unit('u1', '1201', 'Storgatan 1')]).status).toBe(
      'NEEDS_REVIEW',
    )
    expect(m(input({ propertyAddress: '   ' }), [unit('u1', '1201', 'Storgatan 1')]).status).toBe(
      'NEEDS_REVIEW',
    )
  })

  it('saknat lägenhetsfält → NEEDS_REVIEW', () => {
    expect(m(input({ unitDescription: null }), [unit('u1', '1201', 'Storgatan 1')]).status).toBe(
      'NEEDS_REVIEW',
    )
  })

  it('lägenhetsfält utan faktiskt nummer → NEEDS_REVIEW', () => {
    expect(
      m(input({ unitDescription: 'Lägenhet' }), [unit('u1', '1201', 'Storgatan 1')]).status,
    ).toBe('NEEDS_REVIEW')
  })

  it('låg skanningskonfidens → NEEDS_REVIEW (ingen auto-match)', () => {
    const res = m(input({ confidence: MIN_MATCH_CONFIDENCE - 0.01 }), [
      unit('u1', '1201', 'Storgatan 1'),
    ])
    expect(res.status).toBe('NEEDS_REVIEW')
    expect(res.unitId).toBeNull()
  })
})

describe('deterministicUnitMatcher — normalisering tolererar format', () => {
  it('versaler, extra mellanslag och skiljetecken i adress + lägenhet', () => {
    const res = m(
      {
        propertyAddress: '  STORGATAN  1 ,  114 51   STOCKHOLM ',
        unitDescription: 'Lgh 1201',
        confidence: 0.95,
      },
      [unit('u1', '1201', 'Storgatan 1')],
    )
    expect(res.status).toBe('AUTO_MATCHED')
    expect(res.unitId).toBe('u1')
  })

  it('matchar på stad när postnummer saknas i skannad adress', () => {
    const res = m(
      { propertyAddress: 'Storgatan 1, Stockholm', unitDescription: '1201', confidence: 0.9 },
      [unit('u1', '1201', 'Storgatan 1')],
    )
    expect(res.status).toBe('AUTO_MATCHED')
  })
})

describe('deterministicUnitMatcher — strikt: kräver ort utöver gata', () => {
  it('endast gata (ingen ort) i skannad adress → ingen adressmatch → NO_MATCH', () => {
    // Skydd mot att samma gatunamn i olika orter felmatchas.
    const res = m({ propertyAddress: 'Storgatan 1', unitDescription: '1201', confidence: 0.9 }, [
      unit('u1', '1201', 'Storgatan 1', '11451', 'Stockholm'),
    ])
    expect(res.status).toBe('NO_MATCH')
  })

  it('rätt gata men fel ort → NO_MATCH (korsar inte ort)', () => {
    const res = m(
      { propertyAddress: 'Storgatan 1, Göteborg', unitDescription: '1201', confidence: 0.9 },
      [unit('u1', '1201', 'Storgatan 1', '11451', 'Stockholm')],
    )
    expect(res.status).toBe('NO_MATCH')
  })
})
