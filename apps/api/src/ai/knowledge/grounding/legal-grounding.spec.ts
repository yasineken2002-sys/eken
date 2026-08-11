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
  MIN_TOP_SCORE_CALIBRATED_AT_CHUNKS,
  type LegalGrounding,
} from './legal-grounding'
import { buildLegalChunks } from '../retrieval/legal-chunk'
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

    // #382 PR3: momsfrågor nådde inte grinden alls — de besvarades utan att
    // grindutfallet ens beräknades och utan källrad. Nu går de samma väg som
    // varje annan rättsfråga. Detta löser INTE #386 (systemprompten svarar
    // självsäkert även på en miss) — det är ett produktbeslut, inte en trigger.
    describe('Moms som rättsfråga (#382 PR3)', () => {
      it('rättsfrågor om moms passerar ingångsgrinden', () => {
        const legal = [
          'Måste jag lägga moms på hyran för en lokal?',
          'Ska jag ta ut moms när jag vidarefakturerar el till hyresgästen?',
          'Vilken momssats gäller för vatten jag debiterar hyresgästen?',
          'Vad gäller för frivillig skattskyldighet för moms vid uthyrning av lokal?',
          'Måste jag redovisa moms på depositionen?',
        ]
        for (const q of legal) {
          expect({ q, legal: isLegalQuestion(q) }).toEqual({ q, legal: true })
        }
      })

      // Den dyra riktningen. Grindas en datafråga hedgar AI:n om ett tal den
      // kan hämta — produkten blir sämre, inte säkrare. Varje rad här drogs in
      // av ett tidigare utkast som listade normativa ORD (momsplikt, momsfri,
      // momssats, skattskyldig) i stället för frågans FORM.
      it('datafrågor om moms grindas INTE — de handlar om bokförda belopp', () => {
        const data = [
          'Vad blev momsen på förra månadens fakturor?',
          'Hur mycket moms har jag redovisat i år?',
          'Hur mycket moms ska jag betala in den här perioden?',
          'Visa momsrapporten för Q2',
          'Summera utgående moms per fastighet',
          'Vilka fakturor saknar moms?',
          'Vilka fakturor är momsfria?',
          'Vilka fakturor är momspliktiga?',
          'Vilka lokaler är skattskyldiga just nu?',
          'Lista alla momsfria hyresintäkter',
          'Hur många av mina enheter har momssats 25?',
          'Bokför utgiften på 2 000 kr med 500 kr moms',
          'Skapa en faktura på 8 500 kr exklusive moms till Anna',
        ]
        for (const q of data) {
          expect({ q, legal: isLegalQuestion(q) }).toEqual({ q, legal: false })
        }
      })

      // Mönstren är oankrade och överlever därför inledande text — det
      // vanligaste i en chattprodukt. Ett ^-ankrat ja/nej-mönster prövades och
      // ströks just för att det missade 5 av 9 sådana formuleringar utan att
      // bära någon uppmätt miss (se #390).
      it('inledande hälsningsfras avväpnar inte mönstren', () => {
        expect(isLegalQuestion('Jag undrar en sak. Ska jag ta ut moms på el?')).toBe(true)
        expect(isLegalQuestion('Snabb fråga: måste jag lägga moms på hyran?')).toBe(true)
        expect(isLegalQuestion('Hej! Vilken momssats gäller för vatten?')).toBe(true)
      })
    })

    // #400: "får jag ta ut" saknades och lät en tillåtelsefråga om
    // påminnelseavgift passera som icke-juridisk. Låst åt BÅDA håll, för det
    // nakna ordvalet drog in 8 av 8 prövade datafrågor — "ta ut" är också ett
    // operativt verb här (ta ut en rapport, en export). Se kalibreringsblocket i
    // legal-grounding.ts för de tre formkraven mönstret kodar.
    describe('"Får jag ta ut …" — tillåtelsefråga vs datafråga (#400)', () => {
      it('tillåtelsefrågor om en rättslig påföljd grindas', () => {
        const legal = [
          'Får jag ta ut en påminnelseavgift när hyran betalas för sent?',
          'Får jag ta ut en avgift för sen betalning?',
          'Får jag ta ut avgifter för påminnelser?',
          'Får jag ta ut avgiften i förskott?',
          'Får jag ta ut ersättning för ett inkassokrav?',
          'Får jag ta ut ersättningen för inkassokravet?',
          'Får jag ta ut ränta på obetald hyra?',
          'Får jag ta ut räntan från förfallodagen?',
          'Får jag ta ut en avgift för att skicka pappersfaktura?',
          // Regelfråga om TAKET — "hur mycket" är avsiktligt inte spärrat.
          'Hur mycket får jag ta ut i påminnelseavgift?',
          // Oankrat i praktiken: inledande text och flera rader ska överleva.
          'Hej! Får jag ta ut en påminnelseavgift på en obetald avi?',
          'Tack för hjälpen.\nEn sak till: får jag ta ut en avgift för påminnelser?',
        ]
        for (const q of legal) {
          expect({ q, legal: isLegalQuestion(q) }).toEqual({ q, legal: true })
        }
      })

      it('uppräkningar och driftfrågor grindas INTE, trots samma verb', () => {
        const data = [
          // Uppräkningsformen — rättsligt objekt, men frågan är en lista.
          'Vilka avgifter får jag ta ut för påminnelser?',
          'Vilken ersättning får jag ta ut vid inkasso?',
          'Vilket belopp får jag ta ut i avgift?',
          'Lista vad jag får jag ta ut för avgifter',
          'Hur många påminnelseavgifter får jag ta ut i ersättning per år?',
          // Sammansättningar: objektet är ett PREFIX, inte frågans ämne.
          'Får jag ta ut avgiftsrapporten?',
          'Får jag ta ut avgiftsunderlaget för juni?',
          'Får jag ta ut ersättningsrapporten?',
          'Får jag ta ut räntespecifikationen?',
          'Får jag ta ut påminnelselistan?',
          'Får jag ta ut påminnelserapporten för Q2?',
          'Får jag ta ut avgiftsjournalen?',
          // Rent operativa uttag.
          'Får jag ta ut rapporten för juni?',
          'Får jag ta ut en kopia av kontraktet ur systemet?',
          'Får jag ta ut listan på förfallna avier?',
          'Får jag ta ut bokföringsunderlaget för Q2?',
          'Får jag ta ut en export av hyresgästerna?',
          'Får jag ta ut saldot på Annas konto?',
        ]
        for (const q of data) {
          expect({ q, legal: isLegalQuestion(q) }).toEqual({ q, legal: false })
          expect(evaluateLegalRetrieval(q)).toBeNull()
        }
      })
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

  // #382: golvet är en tröskel på en KORPUS-BEROENDE skala. Utan den här
  // spärren kan korpusen ändras — t.ex. när en verifierad mervärdesskattelag
  // (2023:200) läggs tillbaka — utan att någon tvingas mäta om golvet, och
  // ingenting ser trasigt ut. Det är samma tysta felläge som gjorde att en
  // upphävd lag kunde citeras som "gällande lydelse" i två månader.
  describe('Golvet är bundet till korpusstorleken (tripwire)', () => {
    it('en ändrad korpus tvingar fram ommätning av MIN_TOP_SCORE', () => {
      const faktiskt = buildLegalChunks().length
      if (faktiskt !== MIN_TOP_SCORE_CALIBRATED_AT_CHUNKS) {
        throw new Error(
          [
            `KORPUSEN HAR ÄNDRATS: ${faktiskt} chunkar, men MIN_TOP_SCORE är kalibrerat ` +
              `vid ${MIN_TOP_SCORE_CALIBRATED_AT_CHUNKS}.`,
            '',
            'Det här är INTE ett tal som ska uppdateras för att få testet grönt.',
            'BM25 är korpus-globalt (N, docFreq, avgLength i legal-retrieval.ts',
            'buildIndex), så en ändrad korpus flyttar HELA poängskalan — golvet',
            'betyder inte längre det det mättes till.',
            `  • Fler chunkar (${faktiskt > MIN_TOP_SCORE_CALIBRATED_AT_CHUNKS ? 'som nu' : 'ej nu'}): alla poäng STIGER → golvet blir för TILLÅTANDE,`,
            '    svaga träffar släpps in till relevansdomaren.',
            `  • Färre chunkar (${faktiskt < MIN_TOP_SCORE_CALIBRATED_AT_CHUNKS ? 'som nu' : 'ej nu'}): alla poäng SJUNKER → golvet blir för STRÄNGT,`,
            '    giltiga fall fälls (så gick besittningsskydd-lokal förlorat i #382).',
            '',
            'GÖR SÅ HÄR:',
            '  1. Mät topp-BM25 och täckning för hela eval-setet mot den nya korpusen.',
            '  2. Välj nytt golv i det uppmätta gapet mellan svagast GODKÄNDA träff',
            '     och starkaste som ska fällas AV POÄNGEN (täckning >= 0.4).',
            '  3. Kör negativkontrollen: deposition-storlek och',
            '     hyresgastval-diskriminering MÅSTE förbli utanför. Ett golv som',
            '     släpper in dem är inget golv.',
            '  4. Kör knowledge:eval före och efter — invariant 5 (>= 14/18) ska hålla.',
            '  5. Uppdatera kalibreringsblocket i legal-grounding.ts med de NYA',
            `     uppmätta talen, och sätt MIN_TOP_SCORE_CALIBRATED_AT_CHUNKS = ${faktiskt}.`,
          ].join('\n'),
        )
      }
      expect(faktiskt).toBe(MIN_TOP_SCORE_CALIBRATED_AT_CHUNKS)
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
      // Tal uppmätta på 427-chunks-korpusen (#400 — se MIN_TOP_SCORE-blocket i
      // legal-grounding.ts. Rörelsen från 420 är under 0.05 på alla fem.)
      const weakIds = [
        'deposition-storlek', // 9.70/0.33 — täckningsgolvet fäller, TROTS högre poäng
        'hyresgastval-diskriminering', // 8.65/0.29 — under BÅDE score-golvet och täckningen
        'hyreshojning-formkrav', // 6.82/0.50 — bara score-golvet fäller den
        'hyressattning-bruksvarde', // 5.82/0.50 — bara score-golvet
        'kontrakt-tidsbestamt-forlangning', // 8.02/0.38
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
      // Uppmätt omöjliga att skilja på score/täckning (altan 20.5/0.50 dominerar
      // t.ex. dröjsmålsräntans 15.6/0.50) — därför finns relevansdomaren.
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
