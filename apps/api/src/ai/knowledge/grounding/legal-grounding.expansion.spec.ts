/**
 * #406 PR2 — INVARIANTEN: korsreferens-expansionen rör FÖNSTRET, inte GRINDEN.
 *
 * Hela PR:en vilar på en ordningsföljd i koden: `evaluateLegalCandidate` körs
 * FÖRE `expandWithBackwardReferences` och läser kanal-rena signaler
 * (`retrieval.lexical`, `retrieval.semanticTopCosine`) som expansionen aldrig
 * skriver till. Håller inte det, har PR2 tyst flyttat ett grindutfall — och ett
 * grindutfall är skillnaden mellan ett grundat juridiskt svar och en ärlig
 * jurist-hänvisning.
 *
 * Ordningsföljden är dock inte något ett test kan LÄSA sig till; den bevisas
 * här genom att MÄTA att grinden ger bit-för-bit samma utfall vare sig
 * expansionen körts eller ej, och att grannarna bär signaler (0/0/ingen cosine)
 * som inte kan lyfta någon över ett golv. Ett kodläsande test (regex på
 * radordningen) hade varit ett textpåstående, inte en mätning.
 *
 * Ingen AI, ingen modell, inget nät.
 */
import {
  evaluateLegalCandidate,
  evaluateLegalRetrieval,
  groundLegalCandidate,
  GROUNDING_TOP_K,
} from './legal-grounding'
import { expandWithBackwardReferences } from '../retrieval/legal-cross-reference'
import { retrieveLegalChunks } from '../retrieval/legal-retrieval'
import { legalChunkId } from '../retrieval/legal-chunk'
import { LEGAL_EVAL_SET } from '../eval/legal-eval-set'

const QUESTIONS = LEGAL_EVAL_SET.map((c) => c.question)

describe('#406 PR2: grinden är orörd av expansionen', () => {
  it('evaluateLegalCandidate ger IDENTISKT utfall med och utan expanderad indata', () => {
    for (const question of QUESTIONS) {
      const lexical = retrieveLegalChunks(question, { topK: GROUNDING_TOP_K })
      const before = evaluateLegalCandidate(question, {
        lexical,
        fused: lexical,
        semanticTopCosine: null,
      })
      // Samma grind, men matad med den EXPANDERADE listan i båda kanalerna —
      // alltså värsta tänkbara fall: att expansionen läckt in i grindens indata.
      const expanded = expandWithBackwardReferences(lexical)
      const after = evaluateLegalCandidate(question, {
        lexical: expanded,
        fused: expanded,
        semanticTopCosine: null,
      })
      expect(after?.outcome).toBe(before?.outcome)
      if (before?.outcome === 'miss' && after?.outcome === 'miss') {
        expect(after.reason).toBe(before.reason)
      }
    }
  })

  it('varje weak-retrieval-miss FÖRBLIR en miss — expansionen räddar ingen', () => {
    // #406:s grind-halva. Sex inkassofall fälls av golven; en granne som bara
    // kan läggas till EFTER grinden kan per konstruktion inte flytta dem.
    const misses = QUESTIONS.filter((q) => evaluateLegalRetrieval(q)?.outcome === 'miss')
    expect(misses.length).toBeGreaterThan(0)
    for (const question of misses) {
      const candidate = evaluateLegalRetrieval(question)
      expect(candidate?.outcome).toBe('miss')
      // Det finns ingen retrieved-lista att expandera på en miss — vägen till
      // expansionen är stängd redan av returtypen.
      expect(candidate && 'retrieved' in candidate).toBe(false)
    }
  })

  it('grannar kan aldrig mata grindsignalerna: 0 poäng, 0 täckning, ingen cosine', () => {
    for (const question of QUESTIONS) {
      const candidate = evaluateLegalRetrieval(question)
      if (candidate?.outcome !== 'candidate') continue
      const added = expandWithBackwardReferences(candidate.retrieved).slice(
        candidate.retrieved.length,
      )
      for (const neighbour of added) {
        expect(neighbour.score).toBe(0)
        expect(neighbour.coverage).toBe(0)
        expect('cosine' in neighbour).toBe(false)
      }
    }
  })

  it('ankarna passerar oförändrade och i ordning genom expansionen', () => {
    for (const question of QUESTIONS) {
      const candidate = evaluateLegalRetrieval(question)
      if (candidate?.outcome !== 'candidate') continue
      const expanded = expandWithBackwardReferences(candidate.retrieved)
      expect(expanded.slice(0, candidate.retrieved.length)).toEqual(candidate.retrieved)
    }
  })
})

describe('#406 PR2: fönstret — vad expansionen faktiskt levererar', () => {
  it('MEKANIKEN, hela vägen till grundningen: 2 §-ankare → källrad med 4 §', () => {
    // Deterministisk BM25-väg, inget nät och ingen domare: topK 1 ger ENBART
    // 2 § lagen (1981:739), så taket 4 § kan bara komma från korsreferensen.
    // Speglar completeness-målet i eval-noten ("rätten utan taket är ett sämre
    // svar än ingen träff alls") utan att kräva Voyage- eller Haiku-anrop.
    const anchor = retrieveLegalChunks(
      'Får jag ta ut ersättning för en skriftlig betalningspåminnelse?',
      { topK: 1 },
    )
    expect(anchor.map((r) => legalChunkId(r.chunk))).toEqual(['inkassokostnadslagen:2'])

    const grounding = groundLegalCandidate(expandWithBackwardReferences(anchor))
    expect(grounding.chunks.map((c) => c.paragraph)).toEqual(expect.arrayContaining(['2', '4']))
    // Källraden är fortfarande kod-bunden (gap A) och bär nu BÅDA paragraferna.
    expect(grounding.sourceCitation).toContain('2 §, 4 §')
    expect(grounding.sourceCitation).toContain('SFS 1981:739')
    // Grundningsblocket bär takets faktiska belopp — det AI:n ska förklara.
    expect(grounding.contextBlock).toContain('sextio kronor')
  })

  it('expansionen kan bara LÄGGA TILL källor, aldrig ta bort en träff', () => {
    // sourceHit i eval-harnessen är "minst en förväntad källa hämtad". Eftersom
    // ankarna passerar oförändrade är en tidigare träff bevarad per konstruktion
    // — mätt här över hela eval-setet i stället för antaget.
    for (const question of QUESTIONS) {
      const candidate = evaluateLegalRetrieval(question)
      if (candidate?.outcome !== 'candidate') continue
      const beforeIds = candidate.retrieved.map((r) => legalChunkId(r.chunk))
      const afterIds = expandWithBackwardReferences(candidate.retrieved).map((r) =>
        legalChunkId(r.chunk),
      )
      for (const id of beforeIds) expect(afterIds).toContain(id)
      expect(afterIds.length).toBeLessThanOrEqual(beforeIds.length + 3)
      expect(new Set(afterIds).size).toBe(afterIds.length)
    }
  })
})
