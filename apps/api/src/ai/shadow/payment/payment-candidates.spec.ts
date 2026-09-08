import { provaKandidater, type Bankrad, type Kandidat } from './payment-candidates'

const post: Kandidat = {
  id: 'avi',
  sort: 'AVI',
  nummer: 'H-51',
  ocr: '73910284',
  utestaende: 7600,
  forfallodatum: new Date('2026-10-31'),
  motpartId: 'person',
  motpartNamn: 'Lovisa Strand',
}
const rad: Bankrad = {
  id: 'bank',
  datum: new Date('2026-11-02'),
  text: 'HYRA Lovisa Strand',
  belopp: 7600,
  rawOcr: null,
}

describe('hela bankraden måste rymmas på föreslagen fordran', () => {
  it.each([null, '73910284', '73910285'])('OCR %s får inte kringgå beloppsgränsen', (rawOcr) => {
    expect(provaKandidater({ ...rad, rawOcr, belopp: 7900 }, [post]).typ).toBe('INGEN')
  })

  it('summan av hyra och avgift blir inte ett förslag mot bara en av dem', () => {
    const avgift = { ...post, id: 'avgift', sort: 'FAKTURA' as const, utestaende: 300 }
    expect(provaKandidater({ ...rad, belopp: 7900 }, [post, avgift]).typ).toBe('INGEN')
  })

  it.each([0.01, 600, 7599, 7600, 7601])('behåller delbetalning/tolerans: %s kr', (belopp) => {
    const svar = provaKandidater({ ...rad, belopp }, [post])
    expect(svar.typ).toBe('KANDIDATER')
    if (svar.typ === 'KANDIDATER') expect(svar.kandidater.map((k) => k.id)).toEqual(['avi'])
  })

  it('en öre över toleransen utesluts', () => {
    expect(provaKandidater({ ...rad, belopp: 7601.01 }, [post]).typ).toBe('INGEN')
  })

  it('en slutbetald post blir inte kandidat för en liten ny betalning', () => {
    expect(provaKandidater({ ...rad, belopp: 0.5 }, [{ ...post, utestaende: 0 }]).typ).toBe('INGEN')
  })

  it('exakt OCR med belopp som ryms behåller ordinarie regelväg', () => {
    expect(provaKandidater({ ...rad, rawOcr: post.ocr }, [post]).typ).toBe('INGEN_FRAGA')
  })

  it('uteslutna OCR-träffar tar inte kandidatplatser från giltig delbetalning', () => {
    const små = Array.from({ length: 6 }, (_, i) => ({
      ...post,
      id: `liten-${i}`,
      utestaende: 100,
    }))
    const svar = provaKandidater({ ...rad, rawOcr: '73910285' }, [...små, post])
    expect(svar.typ).toBe('KANDIDATER')
    if (svar.typ === 'KANDIDATER') {
      expect(svar.kandidater.map((k) => k.id)).toEqual(['avi'])
      expect(svar.takNått).toBe(false)
    }
  })
})
