/**
 * #406 PR2 — INVARIANTEN: "döm på originalen, grunda på de utökade."
 *
 * Korsreferens-expansionen rör FÖNSTRET. Den får aldrig ändra ett grindutfall
 * och aldrig ett domarutfall — de två är skillnaden mellan ett grundat juridiskt
 * svar och en ärlig jurist-hänvisning.
 *
 * MOT GRINDEN är invarianten strukturell: `evaluateLegalCandidate` läser
 * kanal-rena signaler (`retrieval.lexical`, `retrieval.semanticTopCosine`) som
 * expansionen aldrig skriver till, och grannarna bär 0/0/ingen cosine.
 *
 * MOT DOMAREN är den en ORDNINGSFÖLJD, och den ordningen är dyrköpt. Första
 * versionen av PR2 matade domaren med den expanderade listan. Mätt med isolerad
 * probe (samma retrieval, 5 anrop per variant, temperature 0) flippade
 * besittningsskydd-lokal 5/5 från ärlig miss till självsäkert grundat svar UTAN
 * §57: grannen hyreslagen 56 § säger "Bestämmelserna i 57-60 §§ gäller för
 * upplåtelser av lokaler…" och domaren godtog PEKAREN som om den vore regeln.
 * En paragraf som hänvisar till rätt regel är inte rätt regel — och ett svar som
 * grundas på hänvisningen är sämre än inget svar. Därav: domaren ser
 * `candidate.retrieved`, aldrig `enriched`.
 *
 * Testerna nedan MÄTER båda invarianterna i stället för att läsa koden; ett
 * regex på radordningen hade varit ett textpåstående. Domar-invarianten låses
 * dessutom end-to-end i ai-grounded-citation.spec, där promptargumentet fångas
 * från en mockad klient.
 *
 * Ingen AI, ingen modell, inget nät.
 */
import {
  evaluateLegalCandidate,
  evaluateLegalRetrieval,
  groundLegalCandidate,
  buildRelevanceJudgePrompt,
  GROUNDING_TOP_K,
} from './legal-grounding'
import { expandWithBackwardReferences } from '../retrieval/legal-cross-reference'
import { retrieveLegalChunks, type RetrievedChunk } from '../retrieval/legal-retrieval'
import { buildLegalChunks, legalChunkId, type LegalChunk } from '../retrieval/legal-chunk'
import { LEGAL_EVAL_SET } from '../eval/legal-eval-set'

const QUESTIONS = LEGAL_EVAL_SET.map((c) => c.question)

function chunkByParagraph(lawId: string, paragraph: string): LegalChunk {
  const found = buildLegalChunks().find((c) => c.lawId === lawId && c.paragraph === paragraph)
  if (!found) throw new Error(`Saknar ${lawId} ${paragraph} § i korpusen`)
  return found
}

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

describe('#406 PR2: domaren dömer på originalen', () => {
  it('domarprompten på originalen bär INTE grannarnas text — de två är inte utbytbara', () => {
    // Att valet spelar roll är själva poängen: hade prompterna varit lika hade
    // "döm på originalen" varit en tom regel. Här mäts skillnaden.
    let compared = 0
    for (const question of QUESTIONS) {
      const candidate = evaluateLegalRetrieval(question)
      if (candidate?.outcome !== 'candidate') continue
      const enriched = expandWithBackwardReferences(candidate.retrieved)
      const added = enriched.slice(candidate.retrieved.length)
      if (added.length === 0) continue
      compared++

      const onOriginals = buildRelevanceJudgePrompt(
        question,
        candidate.retrieved.map((r) => r.chunk),
      )
      const onEnriched = buildRelevanceJudgePrompt(
        question,
        enriched.map((r) => r.chunk),
      )
      expect(onOriginals).not.toBe(onEnriched)
      for (const neighbour of added) {
        expect(onOriginals).not.toContain(neighbour.chunk.text)
        expect(onEnriched).toContain(neighbour.chunk.text)
      }
    }
    expect(compared).toBeGreaterThan(0)
  })

  it('MOTFALLET besittningsskydd-lokal: 56 § är en granne, inte en kandidat', () => {
    // Det uppmätta haveriet i konkret form. 56 § kommer in som granne till
    // ankaret 28 § och HÄNVISAR till 57-60 §§ utan att innehålla regeln. Den får
    // synas i grundningen men aldrig i domarens underlag.
    const anchor: RetrievedChunk = {
      chunk: chunkByParagraph('hyreslagen', '28'),
      score: 12,
      coverage: 0.5,
    }
    const neighbours = expandWithBackwardReferences([anchor]).slice(1)
    const p56 = neighbours.find((r) => r.chunk.paragraph === '56')
    expect(p56).toBeDefined()
    expect(p56!.chunk.text).toContain('Bestämmelserna i 57-60 §§ gäller')
    // …och den innehåller alltså INTE §57:s materiella regel.
    expect(p56!.chunk.paragraph).not.toBe('57')
    // Domarprompten på ankaret ensamt kan per konstruktion inte se den.
    expect(buildRelevanceJudgePrompt('fråga', [anchor.chunk])).not.toContain(p56!.chunk.text)
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
