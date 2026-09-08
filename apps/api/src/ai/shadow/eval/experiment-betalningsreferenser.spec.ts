import { berikaReferenser, harHelReferens } from './experiment-betalningsreferenser'
import { provaKandidater, type Bankrad, type Kandidat } from '../payment/payment-candidates'

const post: Kandidat = {
  id: 'a',
  sort: 'AVI',
  nummer: 'AV-701',
  ocr: '12345678901',
  utestaende: 7000,
  forfallodatum: new Date('2026-11-30'),
  motpartId: 'u1',
  motpartNamn: 'Eva Norberg',
}
const andra: Kandidat = {
  ...post,
  id: 'b',
  nummer: 'FA-702',
  ocr: '87654321098',
  utestaende: 300,
  motpartId: 'u2',
  motpartNamn: 'Peter Norberg',
}
const rad: Bankrad = {
  id: 'r',
  datum: new Date('2026-12-02'),
  text: 'Norberg',
  belopp: 500,
  rawOcr: null,
}

describe('experiment: explicita referenser utan borttagna kandidater', () => {
  it.each(['AV-701', 'avi av-701.', '(AV-701)'])('hittar hel referens: %s', (text) => {
    expect(harHelReferens(text, 'AV-701')).toBe(true)
  })
  it.each(['AV-7012', 'XAV-701', 'AV-70', ''])('delreferens räcker inte: %s', (text) => {
    expect(harHelReferens(text, 'AV-701')).toBe(false)
  })
  it('behåller alla gamla kandidater och tillför avgiften trots att totalsumman är större', () => {
    const r = { ...rad, text: 'AV-701 och FA-702', belopp: 7300 }
    const regel = provaKandidater(r, [post, andra])
    const gamla = regel.typ === 'KANDIDATER' ? regel.kandidater : []
    const svar = berikaReferenser(r, [post, andra], gamla)
    expect(svar.kandidater.map((k) => k.id)).toEqual(expect.arrayContaining(gamla.map((k) => k.id)))
    expect(svar.referenser).toEqual(['a', 'b'])
    expect(svar.kandidater.map((k) => k.id)).toContain('b')
    expect(new Set(svar.kandidater.map((k) => k.id)).size).toBe(svar.kandidater.length)
  })
  it('markera gemensamt efternamn som tvetydigt', () => {
    expect(berikaReferenser(rad, [post, andra], []).tvetydigtNamn).toBe(true)
  })
  it.each([
    { text: 'Eva Norberg', rawOcr: null },
    { text: 'Norberg AV-701', rawOcr: null },
    { text: 'Norberg', rawOcr: '12345678901' },
    { text: 'Norberg', rawOcr: '12345678902' },
  ])('fullständigt namn, referens eller OCR bevaras: %o', (identifiering) => {
    expect(berikaReferenser({ ...rad, ...identifiering }, [post, andra], []).tvetydigtNamn).toBe(
      false,
    )
  })
  it('två avier för samma person är inte två personidentiteter', () => {
    expect(berikaReferenser(rad, [post, { ...andra, motpartId: 'u1' }], []).tvetydigtNamn).toBe(
      false,
    )
  })
  it('två fullständiga namn utan referens avgör inte betalare', () => {
    expect(
      berikaReferenser({ ...rad, text: 'Eva Norberg Peter Norberg' }, [post, andra], [])
        .tvetydigtNamn,
    ).toBe(true)
  })
})
