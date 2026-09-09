import { skapaKundflode, testUuid } from './kundflode-2000'

describe('kundflödets underlag och facit', () => {
  const kund = skapaKundflode()

  it('har 2 000 olika bankhändelser och fullständiga kopplingar till kundens avtal/period', () => {
    expect(kund.betalningar).toHaveLength(2000)
    expect(new Set(kund.betalningar.map((p) => p.id)).size).toBe(2000)
    expect(new Set(kund.avier.map((a) => a.id)).size).toBe(2000)
    expect(new Set(kund.hyresgaster.map((h) => h.fastighet)).size).toBe(10)
    const avier = new Map(kund.avier.map((a) => [a.id, a]))
    for (const p of kund.betalningar) {
      const avsedd = avier.get(p.facit.avseddAvi)!
      expect(avsedd.hyresgast).toBe(p.hyresgast)
      expect(avsedd.period).toBe(p.period)
      for (const a of p.facit.allokeringar) {
        expect(avier.get(a.avi)?.hyresgast).toBe(p.hyresgast)
        expect(avier.get(a.avi)!.period).toBeLessThanOrEqual(p.period)
      }
    }
  })

  it('bevarar varje öre i facit och reglerar en avi exakt en gång även vid del/samling', () => {
    const summaPerAvi = new Map<string, number>()
    for (const p of kund.betalningar) {
      expect(Number.isSafeInteger(p.beloppOre)).toBe(true)
      expect(p.beloppOre).toBeGreaterThan(0)
      if (p.facit.granskningKravsAvUnderlaget) {
        expect(p.facit.allokeringar).toEqual([])
        continue
      }
      expect(p.facit.allokeringar.reduce((n, a) => n + a.beloppOre, 0)).toBe(p.beloppOre)
      for (const a of p.facit.allokeringar)
        summaPerAvi.set(a.avi, (summaPerAvi.get(a.avi) ?? 0) + a.beloppOre)
    }
    for (const avi of kund.avier) {
      if ([56, 57, 58].includes(avi.hyresgast)) expect(summaPerAvi.has(avi.id)).toBe(false)
      else expect(summaPerAvi.get(avi.id)).toBe(avi.beloppOre)
    }
  })

  it('konfliktfallen kan inte klaras genom belopp och läcker inte betalaren via OCR', () => {
    for (const p of kund.betalningar.filter((p) => p.typ === 'MOTSTRIDIGA_IDENTIFIERARE')) {
      const betalare = kund.hyresgaster[p.hyresgast]!
      const ocrAgare = kund.hyresgaster[p.ocrFranHyresgast!]!
      expect(ocrAgare.index).not.toBe(betalare.index)
      expect(ocrAgare.hyraOre).toBe(betalare.hyraOre)
      expect(p.facit.granskningKravsAvUnderlaget).toBe(true)
    }
  })

  it('är reproducerbar och låter id:n skilja testkopior utan att ändra facit', () => {
    expect(skapaKundflode()).toEqual(kund)
    expect(testUuid('AGENT_AV:org')).not.toBe(testUuid('AGENT_PA:org'))
    expect(testUuid('AGENT_AV:org')).toBe(testUuid('AGENT_AV:org'))
    expect(kund.betalningar.map((p) => p.datum)).toEqual(
      kund.betalningar.map((p) => p.datum).sort(),
    )
  })
})
