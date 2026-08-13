/**
 * Korsreferens BAKÅT (#406, PR2) — kanttabellen är låst, inte beskriven.
 *
 * Kärnpåståendet som testas är RIKTNINGEN. Grafen går från en paragraf till dem
 * som REFERERAR TILL DEN, och lagen (1981:739) är fallet som gör skillnaden
 * synlig: 2 § bär rätten till ersättning, 4 § bär taket och skriver "…som avses
 * i 2 §". En bakåtgraf drar därför in taket när rätten hämtas. En framåtgraf
 * från 2 § hade gett TOMT — 2 § refererar inte vidare till någon paragraf alls.
 * Testet `2 § <- {4, 5}` OCH `4 § <- {}` är tillsammans det som skiljer de två
 * riktningarna åt; ett enskilt av dem hade passerat i båda.
 *
 * Ingen AI, ingen DB, inget nät.
 */
import {
  buildBackwardReferenceGraph,
  expandWithBackwardReferences,
  DEFAULT_MAX_PER_ANCHOR,
  DEFAULT_MAX_TOTAL_ADDED,
  __chunkKeyForTest,
} from './legal-cross-reference'
import { buildLegalChunks, legalChunkId, type LegalChunk } from './legal-chunk'
import { retrieveLegalChunks, type RetrievedChunk } from './legal-retrieval'

const chunks = buildLegalChunks()
const byId = new Map(chunks.map((c) => [legalChunkId(c), c]))
const graph = buildBackwardReferenceGraph()

/** Paragraf-labels för dem som refererar till `id`, i grafens ordning. */
function referrers(id: string): string[] {
  return (graph.get(id) ?? []).map((c) => c.paragraph)
}

function chunk(id: string): LegalChunk {
  const c = byId.get(id)
  if (!c) throw new Error(`Chunk saknas i korpusen: ${id}`)
  return c
}

function anchor(id: string): RetrievedChunk {
  return { chunk: chunk(id), score: 42, coverage: 0.75 }
}

describe('legal-cross-reference: bakåtgrafen', () => {
  describe('kanttabellen för lagen (1981:739) om ersättning för inkassokostnader', () => {
    // Uppmätt 2026-08-12 mot den skarpa 427-korpusen. Hela lagen ligger här,
    // alla sju paragrafer — inte ett urval — så en parser som drar in för
    // MYCKET fälls lika säkert som en som drar in för lite.
    const expected: Record<string, string[]> = {
      'inkassokostnadslagen:1': ['6'], // 6 §: "kostnader som avses i 1 § första stycket"
      'inkassokostnadslagen:2': ['4', '5'], // taket + undantaget pekar tillbaka på rätten
      'inkassokostnadslagen:3': ['4', '5'],
      'inkassokostnadslagen:4': [], // ← RIKTNINGSBEVISET: taket refereras inte av någon
      'inkassokostnadslagen:4 a': ['5', '6'],
      'inkassokostnadslagen:5': ['6'], // 6 §: "5 § andra stycket"
      'inkassokostnadslagen:6': [],
    }

    for (const [id, refs] of Object.entries(expected)) {
      it(`${id.split(':')[1]} § <- {${refs.join(', ') || '—'}}`, () => {
        expect(referrers(id)).toEqual(refs)
      })
    }

    it('2 § drar in 4 § — men 4 § drar INTE in 2 § (grafen är riktad)', () => {
      // Samma påstående som tabellen, uttryckt som den asymmetri hela PR:en
      // vilar på. Vore grafen oriktad vore båda sanna.
      expect(referrers('inkassokostnadslagen:2')).toContain('4')
      expect(referrers('inkassokostnadslagen:4')).not.toContain('2')
    })
  })

  describe('parser-formerna', () => {
    it('KORSLAGS-UTESLUTNING: "5§ inkassolagen (1974:182)" ger ingen kant', () => {
      // 3 § citerar en paragraf i EN ANNAN LAG. Den enda 5 § grafen känner till
      // är lagens egen, så utan uteslutningen hade citatet blivit en kant som
      // pekar på fel lag. Att 3 § inte finns bland 5 §:s referenter är beviset.
      expect(chunk('inkassokostnadslagen:3').text).toContain('5§ inkassolagen (1974:182)')
      expect(referrers('inkassokostnadslagen:5')).not.toContain('3')
      expect(referrers('inkassokostnadslagen:5')).toEqual(['6'])
    })

    it('"N och M §§" ger kant till BÅDA leden', () => {
      // 4 §: "Gäldenärens ersättningsskyldighet enligt 2 och 3 §§ …"
      expect(chunk('inkassokostnadslagen:4').text).toContain('enligt 2 och 3 §§')
      expect(referrers('inkassokostnadslagen:2')).toContain('4')
      expect(referrers('inkassokostnadslagen:3')).toContain('4')
    })

    it('"N a §" skiljs från "N §" — bokstaven slukas inte av uppräkningens "och"', () => {
      // 5 § och 6 § refererar till "4 a §", ingen refererar till "4 §".
      expect(chunk('inkassokostnadslagen:5').text).toContain('enligt 4 a §')
      expect(referrers('inkassokostnadslagen:4 a')).toEqual(['5', '6'])
      expect(referrers('inkassokostnadslagen:4')).toEqual([])
      // Spegelvänt: "2 och 3 §§" får inte läsas som "2 o §" (bokstavssuffix).
      expect(graph.has('inkassokostnadslagen:2 o')).toBe(false)
    })
  })

  describe('kapitel-resolution (kapitelindelade lagar)', () => {
    it('bostadsrättslagen 7 kap.: 2 § hänvisar till "1 §" i SAMMA kapitel', () => {
      // 7 kap. 2 §: "…inte i det skick som bostadsrättshavaren har rätt att
      // fordra enligt 1 §". Verklig samma-kapitel-hänvisning, utan kap.-markör.
      const referring = chunk('bostadsrattslagen:7:2')
      expect(referring.text).toContain('enligt 1 §')
      expect(referrers('bostadsrattslagen:7:1')).toContain('2')
      // Och den landade i RÄTT kapitel: 1 kap. 1 § får ingen kant från 7 kap. 2 §.
      expect(graph.get('bostadsrattslagen:1:1') ?? []).not.toContain(referring)
    })

    it('INGEN kant korsar lag- eller kapitelgräns (invariant över hela korpusen)', () => {
      for (const [targetId, referring] of graph) {
        const target = chunk(targetId)
        for (const source of referring) {
          expect(source.lawId).toBe(target.lawId)
          expect(source.chapter).toBe(target.chapter)
        }
      }
    })

    it('explicit "N kap."-markör till ANNAT kapitel ger ingen kant', () => {
      // 1 kap. 2 §: "Av 9 kap.12 och 26 §§ följer att …" — markören står
      // omedelbart före och pekar på 9 kap., inte på det egna kapitlet.
      expect(chunk('bostadsrattslagen:1:2').text).toContain('9 kap.12 och 26 §§')
      expect(referrers('bostadsrattslagen:1:12')).not.toContain('2')
      expect(referrers('bostadsrattslagen:1:26')).not.toContain('2')
    })
  })

  describe('grafens form', () => {
    it('nyckelformen är legalChunkId — de två kan inte glida isär', () => {
      for (const c of chunks) {
        expect(__chunkKeyForTest(c.lawId, c.chapter, c.paragraph)).toBe(legalChunkId(c))
      }
    })

    it('varje kant pekar på en chunk som faktiskt finns, utan självkanter', () => {
      for (const [targetId, referring] of graph) {
        expect(byId.has(targetId)).toBe(true)
        for (const source of referring) expect(legalChunkId(source)).not.toBe(targetId)
        // Deduplicerad: samma refererande chunk står bara en gång per mål.
        expect(new Set(referring.map(legalChunkId)).size).toBe(referring.length)
      }
    })

    it('är memoiserad (samma instans vid upprepade anrop)', () => {
      expect(buildBackwardReferenceGraph()).toBe(graph)
    })
  })
})

describe('expandWithBackwardReferences', () => {
  it('lämnar ankarna orörda och i ordning, grannarna sist', () => {
    const anchors = [anchor('inkassokostnadslagen:2'), anchor('inkassokostnadslagen:1')]
    const out = expandWithBackwardReferences(anchors)
    expect(out.slice(0, 2)).toEqual(anchors)
    expect(out.length).toBeGreaterThan(2)
    // 2 § drar in 4 § och 5 §; 1 § drar in 6 § — men taket (3) stoppar där.
    expect(out.slice(2).map((r) => r.chunk.paragraph)).toEqual(['4', '5', '6'])
  })

  it('grannar bär score 0, coverage 0 och INGEN cosine', () => {
    const out = expandWithBackwardReferences([anchor('inkassokostnadslagen:2')])
    for (const neighbour of out.slice(1)) {
      expect(neighbour.score).toBe(0)
      expect(neighbour.coverage).toBe(0)
      // Ingen påhittad semantisk signal: grannen gick aldrig genom den kanalen.
      expect('cosine' in neighbour).toBe(false)
    }
  })

  it('dedupliceras mot befintliga ankare och mot varandra', () => {
    // 4 § är redan ankare → får inte läggas till igen som granne till 2 §.
    const anchors = [anchor('inkassokostnadslagen:2'), anchor('inkassokostnadslagen:4')]
    const out = expandWithBackwardReferences(anchors)
    const ids = out.map((r) => legalChunkId(r.chunk))
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.filter((id) => id === 'inkassokostnadslagen:4')).toHaveLength(1)
    // 2 § och 3 § delar båda referenterna 4 § och 5 § — 5 § läggs till EN gång.
    const shared = expandWithBackwardReferences([
      anchor('inkassokostnadslagen:2'),
      anchor('inkassokostnadslagen:3'),
    ])
    expect(shared.filter((r) => r.chunk.paragraph === '5')).toHaveLength(1)
  })

  it('respekterar maxPerAnchor och maxTotalAdded', () => {
    const anchors = [anchor('inkassokostnadslagen:2'), anchor('inkassokostnadslagen:4 a')]
    expect(expandWithBackwardReferences(anchors, { maxPerAnchor: 1 })).toHaveLength(4)
    expect(expandWithBackwardReferences(anchors, { maxTotalAdded: 1 })).toHaveLength(3)
    // Defaultvärdena är de som produktionsvägen kör med.
    expect(DEFAULT_MAX_PER_ANCHOR).toBe(2)
    expect(DEFAULT_MAX_TOTAL_ADDED).toBe(3)
    expect(expandWithBackwardReferences(anchors).length).toBeLessThanOrEqual(
      anchors.length + DEFAULT_MAX_TOTAL_ADDED,
    )
  })

  it('tom in → tom ut, och ett ankare utan referenter växer inte', () => {
    expect(expandWithBackwardReferences([])).toEqual([])
    const lonely = [anchor('inkassokostnadslagen:6')] // 6 § <- {}
    expect(expandWithBackwardReferences(lonely)).toEqual(lonely)
  })

  it('MEKANIKEN: ett ensamt 2 §-ankare får sällskap av taket 4 §', () => {
    // Deterministiskt och nätfritt: BM25 med topK 1 ger ENBART 2 §, så 4 § kan
    // bara komma från expansionen. Det är eval-notens oro i testform — "rätten
    // utan taket är ett sämre svar än ingen träff alls".
    const retrieved = retrieveLegalChunks(
      'Får jag ta ut ersättning för en skriftlig betalningspåminnelse?',
      { topK: 1 },
    )
    expect(retrieved.map((r) => legalChunkId(r.chunk))).toEqual(['inkassokostnadslagen:2'])
    const expanded = expandWithBackwardReferences(retrieved)
    expect(expanded.map((r) => r.chunk.paragraph)).toContain('4')
    expect(expanded[0]).toBe(retrieved[0]!) // ankaret först och identiskt
  })
})
