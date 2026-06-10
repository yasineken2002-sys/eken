/**
 * Etapp 2, PR 2.3a — juridisk grundning av operator-AI:n med CITAT-INTEGRITET
 * (gap A) som bevisad invariant:
 *
 *   1. Källhänvisningen byggs av KOD ur de hämtade chunkarnas metadata.
 *      `buildSourceCitation` kan per signatur inte se AI-text → ett svar kan
 *      ALDRIG bära en källhänvisning till en paragraf som inte hämtades.
 *   2. Skriver AI:n (mot instruktion) ett eget lagrum i sin prosa är det inte
 *      det som blir den auktoritativa källan — den kod-bundna källraden
 *      (allt efter SOURCE_SUFFIX_MARKER) är identisk oavsett AI-text.
 *   3. Ingångsgrinden skiljer juridik från drift, och hela det grundade
 *      produktionsflödet mäts mot eval-setet (PR 2.1) som regressionsspärr.
 *   4. Gap C: tenant-AI:n är orörd — den importerar inte grundningsmodulen.
 *
 * Ren text→text-logik: ingen AI, ingen modell, inga Anthropic-anrop.
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  isLegalQuestion,
  buildLegalGrounding,
  buildSourceCitation,
  appendCodeBoundSource,
  formatSourceSuffix,
  SOURCE_SUFFIX_MARKER,
} from './legal-grounding'
import { chunksToSources } from '../retrieval/legal-retrieval-runner'
import { scoreRun } from '../eval/legal-eval-harness'
import { LEGAL_EVAL_SET } from '../eval/legal-eval-set'
import { getLegalDocument } from '../legal-knowledge'

const ANSWERABLE = LEGAL_EVAL_SET.filter((c) => c.expectedOutcome === 'answerable')

/** Den auktoritativa (kod-skrivna) källsektionen = allt efter sista markören. */
function authoritativeSourceSection(reply: string): string {
  const idx = reply.lastIndexOf(SOURCE_SUFFIX_MARKER)
  return idx === -1 ? '' : reply.slice(idx + SOURCE_SUFFIX_MARKER.length)
}

describe('Legal grounding (Etapp 2, PR 2.3a)', () => {
  describe('Ingångsgrind: juridik vs drift', () => {
    it('alla answerable eval-frågor passerar grinden (grinden stryper aldrig retrieval)', () => {
      for (const c of ANSWERABLE) {
        expect({ id: c.id, legal: isLegalQuestion(c.question) }).toEqual({
          id: c.id,
          legal: true,
        })
      }
    })

    it('operativa kommandon triggar INTE juridisk grundning', () => {
      const operational = [
        'Skapa en faktura på 8 500 kr till Anna Svensson med förfallodatum 2026-07-01',
        'Hur många lediga lägenheter har jag?',
        'Visa mina förfallna fakturor',
        'Skicka påminnelser till alla med obetalda avier',
        'Skapa ett kontrakt för Anna i lägenhet 1101',
        'Ge mig ett förslag på underlag till styrelsemötet',
        'Bokför utgiften på 2 000 kr för fastighetsskötsel',
      ]
      for (const msg of operational) {
        expect({ msg, legal: isLegalQuestion(msg) }).toEqual({ msg, legal: false })
        expect(buildLegalGrounding(msg)).toBeNull()
      }
    })
  })

  describe('Grundningens innehåll (lagtext injiceras, inte bara metadata)', () => {
    const grounding = buildLegalGrounding(
      'Kan jag säga upp min hyresgäst? Hon har ett förstahands-bostadskontrakt och har bott här i ett år.',
    )

    it('bygger grundning med hämtade chunkar för en juridisk fråga', () => {
      expect(grounding).not.toBeNull()
      expect(grounding!.chunks.length).toBeGreaterThan(0)
    })

    it('contextBlock innehåller varje chunks ordagranna lagtext + källmetadata', () => {
      for (const c of grounding!.chunks) {
        expect(grounding!.contextBlock).toContain(c.text)
        expect(grounding!.contextBlock).toContain(`SFS ${c.sfs}`)
        expect(grounding!.contextBlock).toContain(`verifierad ${c.verifieradPer}`)
      }
    })

    it('contextBlock instruerar AI:n att grunda sig i texten och ALDRIG själv skriva lagrum', () => {
      expect(grounding!.contextBlock).toContain('VERIFIERAD LAGTEXT')
      expect(grounding!.contextBlock).toMatch(/GRUNDA ditt juridiska svar/i)
      expect(grounding!.contextBlock).toMatch(/Skriv ALDRIG paragrafnummer/i)
      expect(grounding!.contextBlock).toMatch(/Systemet lägger AUTOMATISKT till/i)
      expect(grounding!.contextBlock).toMatch(/rekommendera jurist/i)
    })
  })

  describe('CITAT-INTEGRITET (gap A): källan är kod-bunden och fysiskt omöjlig att hallucinera', () => {
    it('varje lag/paragraf/SFS i källraden finns bland de hämtade chunkarna — sveper hela eval-setet', () => {
      for (const c of LEGAL_EVAL_SET) {
        const grounding = buildLegalGrounding(c.question)
        if (!grounding) continue // ingen grundning → ingen källrad alls
        const chunkParagraphs = new Set(grounding.chunks.map((ch) => `${ch.paragraph} §`))
        const chunkSfs = new Set(grounding.chunks.map((ch) => ch.sfs))
        const chunkTitles = new Set(grounding.chunks.map((ch) => getLegalDocument(ch.lawId)!.titel))

        // Paragraf-tokens i källraden ("45 §", "54 a §") måste alla vara hämtade.
        const citedParagraphs = [...grounding.sourceCitation.matchAll(/(\d+(?: [a-z])?) §/g)]
        expect(citedParagraphs.length).toBeGreaterThan(0)
        for (const m of citedParagraphs) {
          expect(chunkParagraphs).toContain(`${m[1]} §`)
        }
        // SFS-tokens måste alla komma ur hämtade chunkar.
        for (const m of grounding.sourceCitation.matchAll(/SFS ([0-9:]+)/g)) {
          expect(chunkSfs).toContain(m[1])
        }
        // Varje nämnd lagtitel måste vara en hämtad lags titel.
        for (const title of chunkTitles) {
          if (grounding.sourceCitation.includes(title)) chunkTitles.delete(title)
        }
        expect(chunkTitles.size).toBe(0)
      }
    })

    it('buildSourceCitation citerar exakt de chunkar den får — med verifieringsdatum', () => {
      const grounding = buildLegalGrounding('Vilken dröjsmålsränta får jag ta ut på en sen hyra?')!
      const citation = buildSourceCitation(grounding.chunks)
      expect(citation).toBe(grounding.sourceCitation)
      expect(citation).toMatch(/^Detta svar bygger på verifierad lagtext: /)
      expect(citation).toContain('gällande lydelse verifierad')
      for (const c of grounding.chunks) {
        expect(citation).toContain(`${c.paragraph} §`)
      }
    })

    it('AI-text kan ALDRIG påverka källraden: hallucinerat lagrum i prosan blir inte källa', () => {
      const grounding = buildLegalGrounding(
        'Hyresgästen har inte betalat hyran på två månader — kan jag vräka direkt?',
      )!
      const honest = 'Nej, du kan inte vräka direkt. Hyresgästen har en återvinningsfrist.'
      const hallucinating =
        'Enligt 999 § hyreslagen (SFS 9999:999) och 12:77 JB får du vräka direkt imorgon.'

      const replyHonest = appendCodeBoundSource(honest, grounding)
      const replyHallucinating = appendCodeBoundSource(hallucinating, grounding)

      // Den auktoritativa källsektionen är identisk oavsett vad AI:n skrev —
      // och exakt lika med den metadata-byggda källraden.
      expect(authoritativeSourceSection(replyHonest)).toBe(grounding.sourceCitation)
      expect(authoritativeSourceSection(replyHallucinating)).toBe(grounding.sourceCitation)
      // Det påhittade lagrummet finns inte i källsektionen.
      expect(authoritativeSourceSection(replyHallucinating)).not.toContain('9999:999')
      expect(authoritativeSourceSection(replyHallucinating)).not.toContain('999 §')
      expect(authoritativeSourceSection(replyHallucinating)).not.toContain('12:77')
    })

    it('formatSourceSuffix börjar med markören så källsektionen alltid är avskiljbar', () => {
      const grounding = buildLegalGrounding('Måste en uppsägning vara skriftlig?')!
      expect(formatSourceSuffix(grounding)).toBe(
        `${SOURCE_SUFFIX_MARKER}${grounding.sourceCitation}`,
      )
    })
  })

  describe('Uppmätt grundningstäckning mot eval-setet (produktionsvägen, regressionsspärr)', () => {
    it('grundningen träffar rätt paragraf i minst 12/18 answerable-fall (= retrieval-baslinjen)', () => {
      // Eftersom grinden släpper igenom alla answerable-frågor (testas ovan)
      // ska den grundade produktionsvägen prestera exakt som PR 2.2:s
      // retrieval-mätning: 12/18. Floor-assertion — höj när retrieval förbättras.
      let hits = 0
      for (const c of ANSWERABLE) {
        const grounding = buildLegalGrounding(c.question)
        if (!grounding) continue
        const output = {
          retrievedSources: chunksToSources(grounding.chunks.map((chunk) => ({ chunk, score: 1 }))),
          answer: '',
          recommendedJurist: false,
        }
        if (scoreRun(c, output).sourceHit) hits++
      }
      expect(ANSWERABLE.length).toBe(18)
      expect(hits).toBeGreaterThanOrEqual(12)
    })
  })

  describe('Gap C: tenant-AI:n är orörd', () => {
    it('tenant-ai.service.ts importerar inte grundningsmodulen', () => {
      const tenantSrc = readFileSync(join(__dirname, '..', '..', 'tenant-ai.service.ts'), 'utf8')
      expect(tenantSrc).not.toContain('legal-grounding')
      expect(tenantSrc).not.toContain('buildLegalGrounding')
      expect(tenantSrc).not.toContain('VERIFIERAD LAGTEXT')
    })
  })
})
