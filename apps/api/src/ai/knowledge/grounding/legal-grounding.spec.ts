/**
 * Etapp 2, PR 2.3a + 2.3b — juridisk grundning av operator-AI:n med
 * CITAT-INTEGRITET (gap A) och MISS-GRIND (gap B) som bevisade invarianter:
 *
 *   1. Källhänvisningen byggs av KOD ur de hämtade chunkarnas metadata.
 *      `buildSourceCitation` kan per signatur inte se AI-text → ett svar kan
 *      ALDRIG bära en källhänvisning till en paragraf som inte hämtades.
 *   2. Skriver AI:n (mot instruktion) ett eget lagrum i sin prosa är det inte
 *      det som blir den auktoritativa källan — den kod-bundna källraden
 *      (allt efter SOURCE_SUFFIX_MARKER) är identisk oavsett AI-text.
 *   3. MISS-GRINDEN (2.3b): ingen/svag träff → miss med ärlighetsblock och
 *      INGEN källrad. Steg 1 (deterministisk) kalibreras här mot eval-setet;
 *      steg 2 (Haiku-relevansdomaren) testas via prompt + verdiktparser här
 *      och end-to-end i ai-grounded-citation.spec.
 *   4. Gap C: tenant-AI:n är orörd — den importerar inte grundningsmodulen.
 *
 * Denna spec: ren text→text-logik — ingen AI, ingen modell, inga Anthropic-anrop.
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  isLegalQuestion,
  evaluateLegalRetrieval,
  groundLegalCandidate,
  buildLegalGroundingMiss,
  buildRelevanceJudgePrompt,
  parseRelevanceVerdict,
  buildSourceCitation,
  appendCodeBoundSource,
  formatSourceSuffix,
  SOURCE_SUFFIX_MARKER,
  type LegalGrounding,
} from './legal-grounding'
import { chunksToSources } from '../retrieval/legal-retrieval-runner'
import { scoreRun } from '../eval/legal-eval-harness'
import { LEGAL_EVAL_SET } from '../eval/legal-eval-set'
import { getLegalDocument } from '../legal-knowledge'

const ANSWERABLE = LEGAL_EVAL_SET.filter((c) => c.expectedOutcome === 'answerable')

function caseById(id: string) {
  const found = LEGAL_EVAL_SET.find((c) => c.id === id)
  if (!found) throw new Error(`Okänt eval-fall: ${id}`)
  return found
}

/** Grundar en fråga som om relevansdomaren sagt JA (testhjälpare — bypassar steg 2). */
function groundIfCandidate(question: string): LegalGrounding | null {
  const candidate = evaluateLegalRetrieval(question)
  return candidate?.outcome === 'candidate' ? groundLegalCandidate(candidate.retrieved) : null
}

/** Den auktoritativa (kod-skrivna) källsektionen = allt efter sista markören. */
function authoritativeSourceSection(reply: string): string {
  const idx = reply.lastIndexOf(SOURCE_SUFFIX_MARKER)
  return idx === -1 ? '' : reply.slice(idx + SOURCE_SUFFIX_MARKER.length)
}

// De 12 answerable-fall där BM25-retrieval träffar rätt paragraf (PR 2.2-mätningen).
const RETRIEVAL_HIT_IDS = [
  'besittningsskydd-lokal',
  'uppsagningstid-bostad-tillsvidare',
  'uppsagningstid-lokal',
  'uppsagning-skriftlig-form',
  'delgivning-uppsagning',
  'kontrakt-skriftligt',
  'hyra-forfallodag',
  'drojsmalsranta-sen-hyra',
  'forverkande-obetald-hyra',
  'storning-uppsagning',
  'andrahand-utan-samtycke',
  'tilltrade-arbeten',
]

describe('Legal grounding (Etapp 2, PR 2.3a + 2.3b)', () => {
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
        expect(evaluateLegalRetrieval(msg)).toBeNull()
      }
    })
  })

  describe('MISS-GRIND steg 1 (gap B): deterministisk kalibrering mot eval-setet', () => {
    it('alla 12 retrieval-träffade answerable-fall passerar som kandidater (grinden kväver inte)', () => {
      for (const id of RETRIEVAL_HIT_IDS) {
        const candidate = evaluateLegalRetrieval(caseById(id).question)
        expect({ id, outcome: candidate?.outcome }).toEqual({ id, outcome: 'candidate' })
      }
    })

    it('mätbart svaga träffar fastnar deterministiskt (utan domaranrop)', () => {
      const weakIds = [
        'deposition-storlek', // no-clear-rule: 10.58/0.33 — täckningsgolvet fäller
        'hyresgastval-diskriminering', // 9.42 — under score-golvet
        'hyreshojning-formkrav', // 7.49
        'hyressattning-bruksvarde', // 6.35
        'kontrakt-tidsbestamt-forlangning', // 8.94
      ]
      for (const id of weakIds) {
        const candidate = evaluateLegalRetrieval(caseById(id).question)
        expect({ id, result: candidate }).toEqual({
          id,
          result: { outcome: 'miss', reason: 'weak-retrieval' },
        })
      }
    })

    it('skattefrågan utanför hyresjuridiken fastnar redan i ingångsgrinden', () => {
      expect(evaluateLegalRetrieval(caseById('agandeform-skatt-paketering').question)).toBeNull()
    })

    it('lexikalt starka men semantiskt fel träffar går vidare till domaren (steg 2 fäller dem)', () => {
      // Uppmätt omöjliga att skilja på score/täckning (altan 22.4/0.50 dominerar
      // t.ex. dröjsmålsräntans 16.3/0.50) — därför finns relevansdomaren.
      for (const id of [
        'altan-utan-lov-tvist',
        'besittningsskydd-eget-behov',
        'besittningsskydd-forstahand-1ar',
        'besittningsskydd-andrahand-2ar',
      ]) {
        const candidate = evaluateLegalRetrieval(caseById(id).question)
        expect({ id, outcome: candidate?.outcome }).toEqual({ id, outcome: 'candidate' })
      }
    })

    it('juridisk fråga utan någon träff alls → miss (no-hits)', () => {
      expect(evaluateLegalRetrieval('Är blorptaxa laglig?')).toEqual({
        outcome: 'miss',
        reason: 'no-hits',
      })
    })
  })

  describe('MISS-utfallet: ärlighetsblock, ingen källrad', () => {
    it('miss-blocket instruerar ärlighet + jurist och förbjuder lagrum ur minnet', () => {
      const miss = buildLegalGroundingMiss('weak-retrieval')
      expect(miss.outcome).toBe('miss')
      expect(miss.contextBlock).toContain('UTAN TILLRÄCKLIGT LAGSTÖD')
      expect(miss.contextBlock).toContain('hittade INGEN tillräckligt')
      expect(miss.contextBlock).toMatch(/jurist/i)
      expect(miss.contextBlock).toMatch(/Skriv ALDRIG paragrafnummer/i)
      expect(miss.contextBlock).toMatch(/Besvara INTE frågan ur ditt eget minne/i)
    })

    it('miss bär ingen källhänvisning — det finns inget fält att visa som källa', () => {
      const miss = buildLegalGroundingMiss('judge-rejected')
      expect('sourceCitation' in miss).toBe(false)
      expect('chunks' in miss).toBe(false)
    })
  })

  describe('Relevansdomaren (steg 2): prompt + strikt verdiktparser', () => {
    it('domarprompten innehåller frågan, kandidaternas ordagranna lagtext och JA/NEJ-kravet', () => {
      const candidate = evaluateLegalRetrieval(caseById('forverkande-obetald-hyra').question)
      expect(candidate?.outcome).toBe('candidate')
      if (candidate?.outcome !== 'candidate') return
      const prompt = buildRelevanceJudgePrompt(
        caseById('forverkande-obetald-hyra').question,
        candidate.retrieved.map((r) => r.chunk),
      )
      expect(prompt).toContain(caseById('forverkande-obetald-hyra').question)
      for (const r of candidate.retrieved) {
        expect(prompt).toContain(r.chunk.text)
      }
      expect(prompt).toContain('MATERIELLA regel')
      expect(prompt).toContain('Är du tveksam till om regeln verkligen finns i texten: svara NEJ.')
      expect(prompt).toContain('JA eller NEJ')
    })

    it('verdiktparsern är strikt: JA→true, NEJ→false, allt annat→null (fail-safe)', () => {
      expect(parseRelevanceVerdict('JA')).toBe(true)
      expect(parseRelevanceVerdict(' ja.')).toBe(true)
      expect(parseRelevanceVerdict('NEJ')).toBe(false)
      expect(parseRelevanceVerdict('nej, texten rör fel regel')).toBe(false)
      expect(parseRelevanceVerdict('Kanske')).toBeNull()
      expect(parseRelevanceVerdict('')).toBeNull()
      expect(parseRelevanceVerdict('Jag tror ja')).toBeNull()
    })
  })

  describe('Grundningens innehåll (lagtext injiceras, inte bara metadata)', () => {
    const grounding = groundIfCandidate(
      'Kan jag säga upp min hyresgäst? Hon har ett förstahands-bostadskontrakt och har bott här i ett år.',
    )

    it('bygger grundning med hämtade chunkar för en kandidat-fråga', () => {
      expect(grounding).not.toBeNull()
      expect(grounding!.outcome).toBe('grounded')
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
        const grounding = groundIfCandidate(c.question)
        if (!grounding) continue // miss/ej juridisk → ingen källrad alls
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
      const grounding = groundIfCandidate('Vilken dröjsmålsränta får jag ta ut på en sen hyra?')!
      const citation = buildSourceCitation(grounding.chunks)
      expect(citation).toBe(grounding.sourceCitation)
      expect(citation).toMatch(/^Detta svar bygger på verifierad lagtext: /)
      expect(citation).toContain('gällande lydelse verifierad')
      for (const c of grounding.chunks) {
        expect(citation).toContain(`${c.paragraph} §`)
      }
    })

    it('AI-text kan ALDRIG påverka källraden: hallucinerat lagrum i prosan blir inte källa', () => {
      const grounding = groundIfCandidate(
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
      const grounding = groundIfCandidate('Måste en uppsägning vara skriftlig?')!
      expect(formatSourceSuffix(grounding)).toBe(
        `${SOURCE_SUFFIX_MARKER}${grounding.sourceCitation}`,
      )
    })
  })

  describe('Uppmätt grundningstäckning mot eval-setet (regressionsspärr)', () => {
    it('steg 1 + godkänd domare träffar rätt paragraf i minst 12/18 answerable-fall', () => {
      // Övre gräns för grinden: med domaren bypassad (JA på alla kandidater)
      // ska kandidat-vägen prestera exakt som PR 2.2:s retrieval-mätning.
      // Domaren (steg 2) kan bara byta felgrundade svar mot ärliga missar —
      // live-utfallet rapporteras separat i PR-rapporten.
      let hits = 0
      for (const c of ANSWERABLE) {
        const candidate = evaluateLegalRetrieval(c.question)
        if (candidate?.outcome !== 'candidate') continue
        const output = {
          retrievedSources: chunksToSources(candidate.retrieved),
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
      expect(tenantSrc).not.toContain('LegalGrounding')
      expect(tenantSrc).not.toContain('VERIFIERAD LAGTEXT')
    })
  })
})
