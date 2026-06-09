import { getLegalDocument, LEGAL_DOCUMENT_IDS } from '../legal-knowledge'
import { buildLegalChunks } from './legal-chunk'
import { retrieveLegalChunks } from './legal-retrieval'
import { runRetrievalEval, chunksToSources } from './legal-retrieval-runner'

/**
 * Etapp 2, PR 2.2 — retrieval-mekaniken. Ren text→text-sökning, ingen AI.
 * Testar chunkning, citat-integritet (gap A) och den uppmätta träffsäkerheten
 * mot eval-setet (regressionsspärr för retrieval-kvaliteten).
 */
describe('Legal retrieval (Etapp 2, PR 2.2)', () => {
  const chunks = buildLegalChunks()

  describe('Chunkning per paragraf', () => {
    it('producerar paragraf-chunkar med strukturell metadata', () => {
      expect(chunks.length).toBeGreaterThan(100)
      for (const c of chunks) {
        expect(LEGAL_DOCUMENT_IDS).toContain(c.lawId)
        expect(c.paragraph.length).toBeGreaterThan(0)
        expect(c.heading).toMatch(/^## .+ §$/)
        expect(c.text.startsWith(c.heading)).toBe(true)
      }
    })

    it('hyreslagens § 45-chunk bär rätt källa och den verifierade besittningstexten', () => {
      const h45 = chunks.find((c) => c.lawId === 'hyreslagen' && c.paragraph === '45')
      expect(h45).toBeDefined()
      expect(h45!.sfs).toBe('1970:994')
      expect(h45!.verifieradPer).toBe('2026-05-29')
      expect(h45!.text).toContain('i andra hand')
      expect(h45!.text).toContain('längre än två år i följd')
    })
  })

  describe('Citat-integritet (gap A): metadata kommer ur strukturen, aldrig gissad', () => {
    it('varje chunks SFS/verifieradPer är identisk med källdokumentets', () => {
      for (const c of chunks) {
        const doc = getLegalDocument(c.lawId)
        expect(doc).toBeDefined()
        expect(c.sfs).toBe(doc!.sfs)
        expect(c.verifieradPer).toBe(doc!.verifieradPer)
        // Paragraf-rubriken finns faktiskt i lagtexten (ingen påhittad paragraf)
        expect(doc!.innehall).toContain(`## ${c.paragraph} §`)
      }
    })
  })

  describe('Retrieval på tydliga nyckelord', () => {
    it('hämtar rätt lag/paragraf för entydiga frågor, med medföljande källa', () => {
      const lokal = retrieveLegalChunks('Vilken uppsägningstid gäller för en lokal?', { topK: 3 })
      expect(lokal.some((r) => r.chunk.lawId === 'hyreslagen' && r.chunk.paragraph === '4')).toBe(
        true,
      )

      const ranta = retrieveLegalChunks('Vilken dröjsmålsränta får jag ta på en sen hyra?', {
        topK: 3,
      })
      expect(ranta.some((r) => r.chunk.lawId === 'ranteslagen')).toBe(true)

      const diskr = retrieveLegalChunks('Får jag välja bort en sökande pga etnicitet?', {
        topK: 3,
      })
      expect(diskr.some((r) => r.chunk.lawId === 'diskrimineringslagen')).toBe(true)
    })

    it('varje träff bär sin egen metadata (lag + paragraf + score)', () => {
      const r = retrieveLegalChunks('Måste en uppsägning vara skriftlig?', { topK: 3 })
      expect(r.length).toBeGreaterThan(0)
      for (const hit of r) {
        expect(hit.score).toBeGreaterThan(0)
        expect(LEGAL_DOCUMENT_IDS).toContain(hit.chunk.lawId)
        expect(hit.chunk.paragraph.length).toBeGreaterThan(0)
      }
    })

    it('returnerar inget för en fråga utan ämnesord (grinden i 2.3 avgör)', () => {
      expect(retrieveLegalChunks('hej hej tjena').length).toBe(0)
    })

    it('chunksToSources grupperar per lag och bevarar paragraf-labels', () => {
      const r = retrieveLegalChunks('uppsägningstid lokal', { topK: 3 })
      const sources = chunksToSources(r)
      for (const s of sources) {
        expect(LEGAL_DOCUMENT_IDS).toContain(s.lawId)
        expect(s.paragraphs.length).toBeGreaterThan(0)
      }
    })
  })

  describe('Uppmätt träffsäkerhet mot eval-setet (ärlig baslinje)', () => {
    it('BM25-retrieval når minst 12/18 answerable-fall (uppmätt baslinje)', async () => {
      const report = await runRetrievalEval()
      expect(report.answerableTotal).toBe(18)
      // Uppmätt: 12/18 med BM25 (naiv substräng-räkning gav 8/18). Floor-assertion
      // = regressionsspärr; höj den om retrieval förbättras.
      expect(report.answerableHits).toBeGreaterThanOrEqual(12)
    })

    it('de entydiga fallen träffar tillförlitligt', async () => {
      const report = await runRetrievalEval()
      const hitIds = new Set(report.rows.filter((r) => r.sourceHit).map((r) => r.id))
      for (const id of [
        'uppsagningstid-lokal',
        'uppsagning-skriftlig-form',
        'hyra-forfallodag',
        'drojsmalsranta-sen-hyra',
        'forverkande-obetald-hyra',
        'andrahand-utan-samtycke',
      ]) {
        expect(hitIds).toContain(id)
      }
    })
  })
})
