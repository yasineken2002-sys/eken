import { buildLegalChunks, legalChunkId } from './legal-chunk'

/**
 * Regression-lås för embedding-identiteten (Etapp 3, PR 3.2).
 *
 * Svenska lagar är kapitelindelade och §-numreringen börjar om per kapitel, så
 * `lawId:paragraph` är INTE unikt ("1 §" finns i varje kapitel). Den buggen
 * gjorde att embedding-tabellen kollapsade från 560 → 272 rader. Dessa tester
 * låser att den kapitelmedvetna identiteten (`legalChunkId`) är entydig.
 */
describe('legal-chunk identitet', () => {
  const chunks = buildLegalChunks()

  it('producerar paragraf-chunkar för alla verifierade lagar', () => {
    expect(chunks.length).toBeGreaterThan(500)
  })

  it('legalChunkId är UNIKT över alla chunkar (annars skrivs embeddings över)', () => {
    const ids = chunks.map(legalChunkId)
    expect(new Set(ids).size).toBe(chunks.length)
  })

  it('kapitelindelade lagar disambigueras: samma § i olika kapitel får olika id', () => {
    const brlEttor = chunks.filter((c) => c.lawId === 'bostadsrattslagen' && c.paragraph === '1')
    // "1 §" förekommer i flera kapitel i bostadsrättslagen.
    expect(brlEttor.length).toBeGreaterThan(1)
    const ids = brlEttor.map(legalChunkId)
    expect(new Set(ids).size).toBe(brlEttor.length) // alla distinkta
    expect(ids).toContain('bostadsrattslagen:1:1')
    expect(ids).toContain('bostadsrattslagen:7:1')
  })

  it('lagar utan kapitelindelning har chapter=null och flat id', () => {
    const hyra = chunks.filter((c) => c.lawId === 'hyreslagen')
    expect(hyra.every((c) => c.chapter === null)).toBe(true)
    const p45 = hyra.find((c) => c.paragraph === '45')
    expect(p45).toBeDefined()
    expect(legalChunkId(p45!)).toBe('hyreslagen:45')
  })

  it('befintliga fält är oförändrade (additiv ändring): paragraph/heading/text/sfs', () => {
    const c = chunks.find((x) => x.lawId === 'hyreslagen' && x.paragraph === '45')!
    expect(c.heading).toBe('## 45 §')
    expect(c.text.startsWith('## 45 §')).toBe(true)
    expect(c.sfs).toBeTruthy()
  })
})
