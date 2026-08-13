/**
 * Söktermerna (#406 PR3) — gränserna och utfallet.
 *
 * Testerna är deterministiska och NÄTFRIA: BM25 är synkron och ren, så hela
 * den lexikala kedjan kan mätas utan Voyage, utan databas och utan domare.
 *
 * Tre av dem skyddar GRÄNSER som är dyra att bryta (hash, läckage, kalibrering)
 * och två låser UTFALLET som motiverade ändringen. Ett test som bara verifierar
 * att listan finns hade varit mekanik utan innebörd.
 */
import { createHash } from 'crypto'
import { buildLegalChunks, legalChunkId, legalChunkContentHash } from './legal-chunk'
import { LEGAL_SEARCH_TERMS, searchTermsFor } from './legal-search-terms'
import { retrieveLegalChunks, scoreAllLegalChunks } from './legal-retrieval'
import {
  evaluateLegalRetrieval,
  buildSourceCitation,
  buildRelevanceJudgePrompt,
  groundLegalCandidate,
  MIN_TOP_SCORE_CALIBRATED_AT_CHUNKS,
} from '../grounding/legal-grounding'
import { LEGAL_EVAL_SET } from '../eval/legal-eval-set'
import { getLegalDocument } from '../legal-knowledge'

const chunks = buildLegalChunks()
const byId = new Map(chunks.map((c) => [legalChunkId(c), c]))
const withTerms = Object.keys(LEGAL_SEARCH_TERMS).map((id) => byId.get(id)!)

/** Score för en namngiven paragraf i en given fråga (0 om den inte når listan). */
function scoreOf(question: string, lawId: string, paragraph: string): number {
  const hit = scoreAllLegalChunks(question).find(
    (r) => r.chunk.lawId === lawId && r.chunk.paragraph === paragraph,
  )
  return hit?.score ?? 0
}

function questionFor(caseId: string): string {
  const c = LEGAL_EVAL_SET.find((x) => x.id === caseId)
  if (!c) throw new Error(`eval-fall saknas: ${caseId}`)
  return c.question
}

/** De åtta inkassokostnadsfallen — hämtade ur eval-setet, inte kopierade hit. */
const INKASSO_CASES = LEGAL_EVAL_SET.filter(
  (c) => c.id.startsWith('paminnelseavgift-') || c.id === 'kravbrev-avgift',
)

describe('legal-search-terms — integritet (e)', () => {
  it('varje nyckel resolvar till en chunk som faktiskt finns', () => {
    for (const id of Object.keys(LEGAL_SEARCH_TERMS)) {
      expect(byId.has(id)).toBe(true)
    }
  })

  it('har åtta inkassofall och sju paragrafposter — mätningens omfång', () => {
    expect(INKASSO_CASES).toHaveLength(8)
    expect(Object.keys(LEGAL_SEARCH_TERMS)).toHaveLength(7)
  })

  it('ingen term står redan ordagrant i chunkens egen text (en no-op som gömmer sig)', () => {
    const redundant: string[] = []
    for (const [id, entry] of Object.entries(LEGAL_SEARCH_TERMS)) {
      const text = byId.get(id)!.text.toLowerCase()
      for (const term of entry.terms) {
        if (text.includes(term.toLowerCase())) redundant.push(`${id} → "${term}"`)
      }
    }
    expect(redundant).toEqual([])
  })

  it('varje post bär en motivering med substans — ingen tyst uppräkning', () => {
    for (const [id, entry] of Object.entries(LEGAL_SEARCH_TERMS)) {
      expect(entry.terms.length).toBeGreaterThan(0)
      // Motiveringen ska säga VILKET mätt gap posten stänger. Ett fallnamn ur
      // eval-setet eller en uppmätt siffra är minimikravet; en rad som bara
      // upprepar paragrafens rubrik hjälper ingen som ska ta bort en term.
      expect(entry.reason.length).toBeGreaterThan(80)
      // Antingen ett fallnamn/en uppmätt siffra, ELLER ett uttryckligt besked om
      // att inget eval-fall täcker paragrafen. Det senare är ett giltigt skäl
      // (1 § och 5 § är sådana) men måste stå utskrivet, inte underförstås.
      expect(`${id}: ${entry.reason}`).toMatch(
        /paminnelseavgift-|kravbrev-avgift|BM25|score|golvet|\d+,\d+|[Ii]nget eval-fall|Ingen fråga i eval-setet/,
      )
    }
  })

  it('searchTermsFor är ren och ger tom lista för chunkar utan poster', () => {
    const untouched = chunks.find((c) => !LEGAL_SEARCH_TERMS[legalChunkId(c)])!
    expect(searchTermsFor(untouched)).toEqual([])
    // Memoiseringen får inte läcka en delad, muterbar array mellan anrop.
    const first = searchTermsFor(withTerms[0]!)
    expect(searchTermsFor(withTerms[0]!)).toEqual(first)
  })
})

describe('legal-search-terms — hash-invarianten (a)', () => {
  it('legalChunkContentHash hashar ENBART chunk.text, aldrig söktermerna', () => {
    for (const chunk of chunks) {
      expect(legalChunkContentHash(chunk.text)).toBe(
        createHash('sha256').update(chunk.text, 'utf8').digest('hex'),
      )
    }
  })

  it('hashen är identisk med och utan söktermer — embeddingarna förblir giltiga', () => {
    for (const chunk of withTerms) {
      const terms = searchTermsFor(chunk)
      const indexText = `${chunk.text}\n${terms.join(' ')}`
      // Grinden: hashen följer texten, inte den indexerade strängen.
      expect(legalChunkContentHash(chunk.text)).not.toBe(legalChunkContentHash(indexText))
      // …och det är chunk.text-hashen produktionen använder.
      expect(legalChunkContentHash(chunk.text)).toBe(
        createHash('sha256').update(chunk.text, 'utf8').digest('hex'),
      )
    }
  })

  it('N är oförändrat 427 — ingen chunk skapas av söktermerna', () => {
    expect(chunks).toHaveLength(427)
    expect(chunks).toHaveLength(MIN_TOP_SCORE_CALIBRATED_AT_CHUNKS)
  })
})

describe('legal-search-terms — läckage (b)', () => {
  /**
   * VAD SOM FAKTISKT SKA MÄTAS: att ingenting i den synliga utdatan kommer ur
   * söktermsfältet. Ett naivt "termen får inte förekomma" mäter fel sak, och
   * två falska positiva visade det:
   *
   *   - `inkassokostnader` (term på 1 §) står i lagens TITEL, som källraden
   *     visar ur metadata.
   *   - `amorteringsplan` (term på 3 §) står i 4 §:s LAGTEXT ("upprättande av
   *     amorteringsplan som avses i 3 § 2") — alltså i en annan paragrafs egen
   *     text, inte i 3 §:s, så integritetstestet (e) släpper igenom den.
   *
   * Testet delar därför upp termerna: de som INTE går att förklara ur lagtext
   * eller metadata får aldrig synas, och den förklarade mängden låses vid
   * exakt de två kända — så att den inte kan växa tyst.
   */
  // Omfånget är de chunkar som FAKTISKT skickas in — inte hela korpusen. Med
  // hela korpusen som referens blev `avbetalningsplan` och `ersättning för
  // kostnader` "förklarade" av paragrafer som inte ens ingår i utdatan, vilket
  // hade gjort testet slappare än det ser ut.
  const legitimateSources = [
    ...withTerms.map((c) => c.text),
    ...withTerms.map((c) => getLegalDocument(c.lawId)?.titel ?? ''),
  ]
    .join('\n')
    .toLowerCase()

  const allTerms = Object.values(LEGAL_SEARCH_TERMS).flatMap((e) => e.terms)
  const explained = allTerms.filter((t) => legitimateSources.includes(t.toLowerCase()))
  const mustNeverAppear = allTerms.filter((t) => !legitimateSources.includes(t.toLowerCase()))

  it('endast två termer går att förklara ur lagtext/metadata — och de är kända', () => {
    expect(explained.sort()).toEqual(['amorteringsplan', 'inkassokostnader'])
    expect(mustNeverAppear.length).toBe(allTerms.length - 2)
  })

  it('ingen oförklarad sökterm når källraden', () => {
    const citation = buildSourceCitation(withTerms).toLowerCase()
    for (const term of mustNeverAppear) expect(citation).not.toContain(term.toLowerCase())
  })

  it('ingen oförklarad sökterm når relevansdomarens prompt', () => {
    // Frågan citeras ordagrant i prompten, så en term får förekomma DÄR.
    // Källdelen är den som ska vara ren.
    const prompt = buildRelevanceJudgePrompt('Får jag ta ut en påminnelseavgift?', withTerms)
    const sources = prompt.slice(prompt.indexOf('HÄMTAD LAGTEXT')).toLowerCase()
    for (const term of mustNeverAppear) expect(sources).not.toContain(term.toLowerCase())
  })

  it('ingen oförklarad sökterm når AI:ns kontextblock', () => {
    // buildContextBlock är privat; enda vägen ut är groundLegalCandidate. Att gå
    // den vägen mäter också att grundningen inte bär termer vidare.
    const grounding = groundLegalCandidate(
      withTerms.map((chunk) => ({ chunk, score: 10, coverage: 1 })),
    )
    const block = grounding.contextBlock.toLowerCase()
    for (const term of mustNeverAppear) expect(block).not.toContain(term.toLowerCase())
  })

  it('den citerbara texten är ordagrant chunk.text — söktermerna finns inte där', () => {
    // Den bärande gränsen, uttryckt direkt: allt som visas om en paragraf är
    // dess egen text. Faller detta har indexeringen läckt in i citatvägen.
    const grounding = groundLegalCandidate(
      withTerms.map((chunk) => ({ chunk, score: 10, coverage: 1 })),
    )
    for (const chunk of withTerms) {
      expect(grounding.contextBlock).toContain(chunk.text)
      const withSearchTerms = `${chunk.text}\n${searchTermsFor(chunk).join(' ')}`
      expect(grounding.contextBlock).not.toContain(withSearchTerms)
    }
  })
})

describe('legal-search-terms — utfallet (c)', () => {
  /**
   * HUVUDFALLET — och en gräns för vad ett nätfritt test kan påstå.
   *
   * Mätningen visade att 2 § når DOMARENS fönster (fused topp-3) för den här
   * frågan. Fönstret är RRF över två kanaler, och 2 § kommer dit på rank 4 i
   * BÅDA: lexikalt 4 (9,69, bakom hyreslagen 20/55 och bostadsrättslagen 16)
   * och semantiskt 4. Den lexikala topp-3 innehåller den alltså INTE, och kan
   * per konstruktion inte göra det utan att något av de tre andra faller.
   *
   * Ett nätfritt test kan bara mäta den lexikala kanalen — fusionen kräver
   * Voyage + pgvector. Testet låser därför det lexikala villkor som gör
   * fönsterplatsen möjlig (2 § högst av inkassoparagraferna, topp-5, över
   * 4 a §), och fönsterplatsen i sig verifieras av knowledge:eval.
   */
  it('huvudfallet: 2 § är högst rankade inkassoparagrafen och ligger i topp-5', () => {
    const q = questionFor('paminnelseavgift-ratten')
    const ranked = scoreAllLegalChunks(q)
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score || a.chunk.paragraph.localeCompare(b.chunk.paragraph))
    const rankOfTwo = ranked.findIndex(
      (r) => r.chunk.lawId === 'inkassokostnadslagen' && r.chunk.paragraph === '2',
    )
    expect(rankOfTwo).toBeGreaterThanOrEqual(0)
    expect(rankOfTwo).toBeLessThan(5)

    const inkassoRanked = ranked.filter((r) => r.chunk.lawId === 'inkassokostnadslagen')
    expect(inkassoRanked[0]!.chunk.paragraph).toBe('2')
    expect(scoreOf(q, 'inkassokostnadslagen', '2')).toBeGreaterThan(
      scoreOf(q, 'inkassokostnadslagen', '4 a'),
    )
  })

  it.each(INKASSO_CASES.map((c) => [c.id, c.question]))(
    '%s: 2 § rankar över 4 a § (mätt 8/8)',
    (_id, question) => {
      const two = scoreOf(question, 'inkassokostnadslagen', '2')
      const foura = scoreOf(question, 'inkassokostnadslagen', '4 a')
      expect(two).toBeGreaterThan(0)
      expect(two).toBeGreaterThan(foura)
    },
  )

  it('kravbrev-avgift lyfts av SIN EGEN paragraf (3 §), inte av 2 §', () => {
    const q = questionFor('kravbrev-avgift')
    const top = retrieveLegalChunks(q, { topK: 1 })[0]!
    expect(top.chunk.lawId).toBe('inkassokostnadslagen')
    expect(top.chunk.paragraph).toBe('3')
    expect(evaluateLegalRetrieval(q)?.outcome).toBe('candidate')
  })

  it('4 a § tas ALDRIG in i topp-3 för något inkassofall (#406:s fälla)', () => {
    for (const c of INKASSO_CASES) {
      const top3 = retrieveLegalChunks(c.question, { topK: 3 })
      expect(
        top3.some((r) => r.chunk.lawId === 'inkassokostnadslagen' && r.chunk.paragraph === '4 a'),
      ).toBe(false)
    }
  })
})

describe('legal-search-terms — kalibreringen håller (d)', () => {
  it('negativkontrollen deposition-storlek fälls fortfarande av grinden', () => {
    const result = evaluateLegalRetrieval(questionFor('deposition-storlek'))
    expect(result?.outcome).toBe('miss')
  })

  it('negativkontrollen hyresgastval-diskriminering fälls fortfarande av grinden', () => {
    const result = evaluateLegalRetrieval(questionFor('hyresgastval-diskriminering'))
    expect(result?.outcome).toBe('miss')
  })

  it('besittningsskydd-lokal passerar fortfarande — golvets svagaste godkända', () => {
    const q = questionFor('besittningsskydd-lokal')
    expect(evaluateLegalRetrieval(q)?.outcome).toBe('candidate')
    // Uppmätt 9,51 både före och efter PR3: söktermerna rör inte det här fallet.
    expect(retrieveLegalChunks(q, { topK: 1 })[0]!.score).toBeCloseTo(9.51, 1)
  })

  it('fall utanför inkassokostnadslagen rörs inte mätbart av söktermerna', () => {
    // Låsta MED söktermerna aktiva (fyra decimaler, raka värden ur retrieval).
    // Kommentaren bär baslinjen före PR3 så att rörelsen är avläsbar här och
    // inte bara i rapporten. En tidigare version jämförde mot rapportens
    // AVRUNDADE baslinjetal och föll på 0,036 — ren avrundningsartefakt, inte
    // en verklig rörelse. Att låsa de faktiska värdena har dessutom mer bett:
    // en ny term som rubbar dem faller här, oavsett åt vilket håll.
    // Baslinjerna är UPPMÄTTA med söktermerna avstängda, inte avlästa ur
    // rapportens avrundade tabell. Skillnaden är inte akademisk: tre av dem
    // avvek på tredje decimalen från vad tabellen antydde.
    const locked: [string, number, number][] = [
      // id, förväntat nu (med söktermer), baslinje före PR3
      ['besittningsskydd-forstahand-1ar', 18.6716, 18.6695],
      ['besittningsskydd-lokal', 9.5148, 9.5117],
      ['uppsagningstid-bostad-tillsvidare', 25.6093, 25.6052],
      ['hyra-forfallodag', 22.7949, 22.8034],
      ['forverkande-obetald-hyra', 21.3363, 21.3048],
      ['storning-uppsagning', 28.6748, 28.6523],
      ['hyreshojning-formkrav', 6.8246, 6.8165],
    ]
    for (const [id, expected, baseline] of locked) {
      const score = retrieveLegalChunks(questionFor(id), { topK: 1 })[0]!.score
      expect(score).toBeCloseTo(expected, 3)
      // Största uppmätta rörelse är forverkande-obetald-hyra: +0,0315.
      expect(Math.abs(score - baseline)).toBeLessThanOrEqual(0.032)
    }
  })
})
