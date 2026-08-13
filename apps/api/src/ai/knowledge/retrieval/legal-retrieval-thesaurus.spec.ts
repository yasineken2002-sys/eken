/**
 * Tesaurus-grupperna för inkassokostnader (#406 PR4) — variant T5.
 *
 * Testerna är deterministiska och NÄTFRIA: BM25 och tesaurus-expansionen är
 * synkrona och rena, så hela den lexikala kedjan kan mätas utan Voyage, utan
 * databas och utan domare. Grinden anropas via `evaluateLegalRetrieval`, som
 * är den rena BM25-vägen (semanticTopCosine = null) — samma väg mätningen i
 * `docs/research/406-tesaurus-inkasso.md` kallar `lexikalt insläpp`.
 *
 * VAD DE LÅSER, och varför just det:
 *
 * 1. De fem fall #406 fällde passerar nu, med facit i topp-3. Det är PR:ens
 *    syfte, och utan testet kan en "förenkling" av grupperna ta bort det utan
 *    att något blir rött.
 * 2. `hogre-i-avtal` rankar 6 § FÖRST. Insläpp utan rätt ranking är den
 *    dokumenterade minan: fallet grundas då på rätten (2 §) och taket (4 §)
 *    utan regeln som gör svaret sant — att taket inte kan avtalas bort uppåt.
 * 3. INGEN inkassoparagraf tar förstaplatsen i frågor som inte handlar om
 *    inkassokostnader. Det är hela skillnaden mellan T5 och den förkastade
 *    T1: delsträngsutlösning gjorde att "formkrav" drog in 2 § som etta.
 * 4. Negativkontrollerna hålls ute, och resten av korpusen rör sig inte alls.
 *
 * Sonderingsfrågorna i punkt 3 är KONSTRUERADE (samma kvarstående svaghet som
 * #390) och är ordagrant de fyra ur mätningen. De hör hemma här och inte i
 * LEGAL_EVAL_SET: de har inget juridiskt facit och mäter en bieffekt, inte
 * produktens förmåga att svara.
 */
import { buildLegalChunks } from './legal-chunk'
import { retrieveLegalChunks, INKASSO_CONCEPT_GROUPS } from './legal-retrieval'
import {
  evaluateLegalRetrieval,
  MIN_TOP_SCORE_CALIBRATED_AT_CHUNKS,
} from '../grounding/legal-grounding'
import { LEGAL_EVAL_SET } from '../eval/legal-eval-set'

function caseFor(id: string): (typeof LEGAL_EVAL_SET)[number] {
  const c = LEGAL_EVAL_SET.find((x) => x.id === id)
  if (!c) throw new Error(`eval-fall saknas: ${id}`)
  return c
}

/** Facitparagraferna som `lag:paragraf`, hämtade ur eval-setet — aldrig skrivna här. */
function facitOf(id: string): string[] {
  return caseFor(id).expectedSources.flatMap((s) => s.paragraphs.map((p) => `${s.lawId}:${p}`))
}

function topKIds(question: string, k = 3): string[] {
  return retrieveLegalChunks(question, { topK: k }).map(
    (r) => `${r.chunk.lawId}:${r.chunk.paragraph}`,
  )
}

/** #406:s fem kvarvarande fall, uppmätta som fällda före PR4. */
const FIVE_REMAINING = [
  'paminnelseavgift-taket',
  'paminnelseavgift-avtalskravet',
  'paminnelseavgift-vad-galler',
  'paminnelseavgift-vad-sager-lagen',
  'paminnelseavgift-hogre-i-avtal',
]

const INKASSO_CASE_IDS = LEGAL_EVAL_SET.filter(
  (c) => c.id.startsWith('paminnelseavgift-') || c.id === 'kravbrev-avgift',
).map((c) => c.id)

/**
 * De fyra sonderingsfrågorna ur mätningen, ordagrant. Var och en innehåller
 * delsträngen "krav" — det är det som gör dem till ett prov på T1:s fällpunkt.
 */
const CONTAMINATION_PROBES = [
  'Vilka formkrav gäller för en uppsägning?',
  'Vad ställer lagen för krav på en besiktning vid avflyttning?',
  'Vilka krav gäller för att få hyra ut i andra hand?',
  'Kan jag ställa krav på inkomst när jag väljer hyresgäst?',
]

describe('#406 PR4 — tesaurus för inkassokostnader (variant T5)', () => {
  describe('De fem fall som #406 fällde', () => {
    for (const id of FIVE_REMAINING) {
      it(`${id} släpps in av grinden och har sin facitparagraf i topp-3`, () => {
        const q = caseFor(id).question
        expect(evaluateLegalRetrieval(q)?.outcome).toBe('candidate')
        const top3 = topKIds(q)
        expect(facitOf(id).some((f) => top3.includes(f))).toBe(true)
      })
    }
  })

  describe('Ranking — insläpp räcker inte', () => {
    it('hogre-i-avtal rankar 6 § FÖRST, inte bara någonstans i topp-3', () => {
      // Minan: utan ogiltighetsgruppen ligger 6 § på lexikal rank 11 och når
      // aldrig domarens fönster. Kandidaten skulle då grundas på 2 § + 4 § —
      // "du får ta ut en avgift" utan begränsningen som gör svaret sant.
      const q = caseFor('paminnelseavgift-hogre-i-avtal').question
      expect(topKIds(q, 1)).toEqual(['inkassokostnadslagen:6'])
    })

    it('kravbrev-avgift behåller 3 § först — krav (3 §) är inte påminnelse (2 §)', () => {
      // Skiljefallet. T1 lade påminnelse- och krav-termer i SAMMA grupp och
      // tappade den här förstaplatsen till 2 §; separationen är vad som
      // återställer den.
      expect(topKIds(caseFor('kravbrev-avgift').question, 1)).toEqual(['inkassokostnadslagen:3'])
    })

    it('1 § — tillämpningsparagrafen, aldrig ett svar — når aldrig topp-3', () => {
      // T1 gav den en topp-3-plats i 8 av 8 inkassofall, eftersom dess termer
      // ("ersättning för kostnader", "förfallen skuld") delas av hela lagen.
      for (const id of INKASSO_CASE_IDS) {
        expect(topKIds(caseFor(id).question)).not.toContain('inkassokostnadslagen:1')
      }
    })
  })

  describe('Kontaminering: gruppen får inte dra in inkassolagen i andra frågor', () => {
    it('sonderingsfrågorna innehåller faktiskt delsträngen "krav"', () => {
      // Vakt mot ett tyst tomt test: utan den här raden kan någon skriva om
      // frågorna till sådana som inte längre prövar delsträngsutlösningen, och
      // resten av beskrivningen skulle fortsätta se grön ut.
      for (const q of CONTAMINATION_PROBES) expect(q.toLowerCase()).toContain('krav')
    })

    for (const q of CONTAMINATION_PROBES) {
      it(`"${q}" får ingen inkassokostnadslagen-chunk som etta`, () => {
        const top = retrieveLegalChunks(q, { topK: 1 })[0]
        expect(top).toBeDefined()
        expect(top!.chunk.lawId).not.toBe('inkassokostnadslagen')
      })
    }
  })

  describe('Negativkontrollerna hålls ute', () => {
    for (const id of ['deposition-storlek', 'hyresgastval-diskriminering']) {
      it(`${id} fälls fortfarande av grinden`, () => {
        expect(evaluateLegalRetrieval(caseFor(id).question)?.outcome).toBe('miss')
      })
    }
  })

  describe('Resten av korpusen är orörd', () => {
    it('ingen icke-inkassofråga i eval-setet utlöser någon av de nya grupperna', () => {
      // Det här är BEVISET för att inget annat fall kan röra sig: en grupp
      // påverkar bara frågor som utlöser den, och indexet (docFreq, avgLength,
      // N) rörs inte alls av en frågesidig expansion. Utlöses ingen grupp är
      // stammängden — och därmed både score och täckning — bit-för-bit
      // oförändrad. Starkare än en toleransgräns, och oberoende av korpusens
      // storlek.
      const nonInkasso = LEGAL_EVAL_SET.filter((c) => !INKASSO_CASE_IDS.includes(c.id))
      for (const c of nonInkasso) {
        const lower = c.question.toLowerCase()
        for (const group of INKASSO_CONCEPT_GROUPS) {
          const hit = group.find((term) => lower.includes(term))
          expect(hit ? `${c.id}: "${hit}"` : 'ingen träff').toBe('ingen träff')
        }
      }
    })

    it('sentinellfallen ligger kvar på sina uppmätta poäng', () => {
      // besittningsskydd-lokal är golvets svagaste godkända (9,51 mot golv 9) —
      // det fall som först skulle falla om skalan rörde sig. De övriga tre
      // ligger strax under golvet och skulle först börja SLÄPPAS IN.
      // Uppmätt 2026-08-13, N = 427. Rör sig något av dem har antingen
      // korpusen eller tokeniseringen ändrats — mät om, ändra inte siffran.
      const sentinels: [string, number][] = [
        ['besittningsskydd-lokal', 9.51],
        ['kontrakt-tidsbestamt-forlangning', 8.01],
        ['hyreshojning-formkrav', 6.82],
        ['hyresgastval-diskriminering', 8.66],
      ]
      for (const [id, expected] of sentinels) {
        const top = retrieveLegalChunks(caseFor(id).question, { topK: 1 })[0]
        expect(top).toBeDefined()
        expect(top!.score).toBeCloseTo(expected, 1)
      }
    })

    it('korpusen är oförändrad: N = golvets kalibrerings-N', () => {
      // En tesaurusgrupp får aldrig lägga till eller ta bort en chunk. Gör den
      // det är golvet 9 kalibrerat mot ett annat N och betyder inte längre det
      // det mättes till.
      expect(buildLegalChunks().length).toBe(MIN_TOP_SCORE_CALIBRATED_AT_CHUNKS)
    })
  })
})
