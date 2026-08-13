/**
 * Korsreferens-expansion av fönstret (#406, PR2) — BAKÅT.
 *
 * PROBLEMET: en hämtad paragraf kan bära RÄTTEN utan att bära TAKET. Frågar en
 * hyresvärd "får jag ta ut en påminnelseavgift?" hämtas 2 § lagen (1981:739)
 * — rätten till ersättning — medan beloppstaket står i 4 §. Eval-notens egna
 * ord: "rätten utan taket är ett sämre svar än ingen träff alls."
 *
 * RIKTNINGEN ÄR AVSIKTLIGT BAKÅT, och det är inte en stilfråga. Grafen går från
 * en paragraf till de paragrafer som REFERERAR TILL DEN:
 *
 *   4 §: "…sextio kronor för skriftlig betalningspåminnelse SOM AVSES I 2 §"
 *
 * Taket pekar tillbaka på rätten. Hämtas 2 § drar en bakåtgraf därför in 4 §
 * automatiskt. En FRAMÅTgraf från 2 § hade dragit in ingenting alls — 2 §
 * refererar inte vidare till någon annan paragraf. Den hade sett lika rimlig ut
 * och gjort noll. (Låst av specen: kanttabellen är riktad.)
 *
 * AVGRÄNSNING — DETTA ÄR FÖNSTER, INTE GRIND. Expansionen verkar på ett REDAN
 * INSLÄPPT ankare och körs EFTER `evaluateLegalCandidate`. Den kan alltså inte
 * rädda de sex weak-retrieval-fall i #406 där rätt paragraf aldrig tar sig
 * genom grinden: en domare som aldrig ser en kandidat kan inte välja den.
 * Grannarna får score 0 / coverage 0 och når per konstruktion aldrig
 * grindsignalerna (`retrieval.lexical`, `retrieval.semanticTopCosine`), som
 * beräknas före och oberoende av denna modul.
 *
 * Ingen AI, ingen DB, inget nät — ren text→text-logik över buildLegalChunks(),
 * memoiserad precis som legal-chunk.ts. Lagtexten är ORÖRD: modulen läser
 * chunk.text, ändrar den aldrig, så content-hasharna är oförändrade och ingen
 * omembedding behövs.
 */
import { buildLegalChunks, legalChunkId, type LegalChunk } from './legal-chunk'
import type { RetrievedChunk } from './legal-retrieval'

/**
 * En paragrafhänvisning i löptext, inklusive uppräkningsform.
 *
 * Formerna som känns igen (mätta mot den skarpa korpusen):
 *   "2 §"        — enkel
 *   "4 a §"      — bokstavsparagraf. Bokstaven måste stå ENSAM: negativa
 *                  lookaheaden `(?![a-zåäö])` är det som skiljer "4 a §" från
 *                  "2 och 3 §§" (där 'o' i "och" annars hade lästs som
 *                  bokstavssuffix och gett en hänvisning till "2 o §").
 *   "2 och 3 §§" — uppräkning. Även "," och "eller" tas, samma form.
 *   "5§"         — utan mellanslag. Förekommer i den verifierade texten
 *                  (3 § skriver "5§ inkassolagen") och MÅSTE matchas för att
 *                  korslags-uteslutningen nedan ska kunna fälla den.
 *
 * `(?<![\d:])` hindrar att SFS-nummer och årtal plockas isär ("1974:182").
 *
 * INTE igenkänt, medvetet: intervall ("18--25 §§") expanderas inte till alla
 * paragrafer däremellan — sista ledet blir en kant, resten uteblir. Ett
 * uteblivet led är en FALSK NEGATIV (färre grannar), aldrig en falsk kant.
 */
const PARAGRAPH_REFERENCE =
  /(?<![\d:])(\d+(?:\s+[a-zåäö](?![a-zåäö]))?(?:\s*(?:,|och|eller)\s*\d+(?:\s+[a-zåäö](?![a-zåäö]))?)*)\s*§§?/g

/**
 * KORSLAGS-UTESLUTNINGEN. Ett paragrafnummer omedelbart följt av ett lagnamn
 * eller ett SFS-nummer hänvisar till en ANNAN lag och får inte bli en kant.
 *
 * FÄLLAN ÄR MÄTT OCH VERKLIG: 3 § inkassokostnadslagen citerar "5§ inkassolagen
 * (1974:182)". Utan denna regel hade lagen (1981:739) fått en kant 5 § <- 3 §
 * som pekar på FEL LAG — den enda 5 § grafen känner till är den egna.
 *
 * Formen, inte uppräkningen, är det som spärrar (samma lärdom som #382): ett
 * ord som slutar på -lagen/-balken, eller ett SFS "(ÅÅÅÅ:NNN)". Mellanslaget är
 * valfritt — den verifierade texten innehåller "§§socialförsäkringsbalken".
 *
 * REGELN KRÄVER OMEDELBAR NÄRHET, och det valet är MÄTT — inte förenkling.
 * Ett bredare fönster ("lagnamn inom 40 tecken efter §") skulle fånga
 * mellanliggande led som "3 § andra stycket lagen (1998:1591)". Uppmätt över
 * hela korpusen finns 12 sådana fördröjda fall; bara TVÅ av dem överlever till
 * en kant (resten fälls redan av kapitelregeln eller för att målparagrafen inte
 * finns i korpusen):
 *   bokforingslagen 4:3 <- 4:5   FALSK  ("3 § andra stycket lagen (1998:1591)")
 *   hyreslagen 55 e   <- 53      SANN   ("54 och 55-55 e §§ … följer av den lagen")
 * Fönsterregeln hade alltså bytt en falsk kant mot en sann — och den sanna är
 * den värdefullare av de två (53 § är just den paragraf som avgränsar 54–55 e §§
 * för en hyresvärd). Nettot är noll eller negativt, så adjacensregeln står kvar.
 */
const CROSS_LAW_AFTER = /^\s*(?:\(\d{4}:\d+\)|[a-zåäöé]*(?:lagen|lagens|balken|balkens)\b)/

/** "9 kap." / "9 kap.12" — kapitelmarkör OMEDELBART före hänvisningen. */
const CHAPTER_IMMEDIATELY_BEFORE = /(\d+(?:\s+[a-zåäö])?)\s*kap\.\s*$/
/** Samma markör var som helst (används inom meningen). */
const CHAPTER_ANYWHERE = /(\d+(?:\s+[a-zåäö])?)\s*kap\./g
/** Meningsgräns: punkt/frågetecken/utropstecken + versal, eller radbrytning.
 *  Versalkravet är det som gör att "9 kap.12" INTE läses som meningsslut. */
const SENTENCE_BREAK = /[.!?]\s+(?=[A-ZÅÄÖ])|\n/g

/**
 * Samma nyckelform som `legalChunkId` — grafen slår upp på den strängen, så de
 * två får aldrig glida isär. Låst av specen (`chunkKey(chunk) === legalChunkId(chunk)`).
 */
function chunkKey(lawId: string, chapter: string | null, paragraph: string): string {
  return chapter ? `${lawId}:${chapter}:${paragraph}` : `${lawId}:${paragraph}`
}

function normalizeLabel(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim()
}

/**
 * Vilket kapitel en hänvisning gäller, sett från positionen i texten:
 * `null` = ingen explicit markör → SAMMA kapitel som den refererande paragrafen.
 *
 * Regeln är avsiktligt PRECISIONS-tung. En markör tidigare i samma mening
 * styr hela meningen ("…avses i 2 kap. 8 § eller 9 § första stycket" — även
 * "9 §" gäller 2 kap.). Det gör att en samma-kapitel-hänvisning som råkar stå i
 * en mening med en annan kapitelmarkör tappas. Det är valt medvetet: en utebliven
 * granne är brus som saknas, en felaktig granne är brus som visas för domaren.
 */
function referencedChapter(textBefore: string): string | null {
  const immediate = CHAPTER_IMMEDIATELY_BEFORE.exec(textBefore)
  if (immediate) return normalizeLabel(immediate[1]!)

  let sentenceStart = 0
  SENTENCE_BREAK.lastIndex = 0
  for (let m = SENTENCE_BREAK.exec(textBefore); m; m = SENTENCE_BREAK.exec(textBefore)) {
    sentenceStart = m.index + m[0].length
  }
  const sentence = textBefore.slice(sentenceStart)

  let last: string | null = null
  CHAPTER_ANYWHERE.lastIndex = 0
  for (let m = CHAPTER_ANYWHERE.exec(sentence); m; m = CHAPTER_ANYWHERE.exec(sentence)) {
    last = normalizeLabel(m[1]!)
  }
  return last
}

/**
 * Alla legalChunkId:n som `chunk` hänvisar till i SAMMA lag (och, för
 * kapitelindelade lagar, samma kapitel). Självhänvisningar ingår inte —
 * paragrafens egen rubrik ("## 4 a §") och de inledande labels som förekommer i
 * brödtexten ("12 a § Om bostadsrättshavaren…") är hänvisningar till sig själv.
 */
function sameLawReferences(chunk: LegalChunk): string[] {
  const self = legalChunkId(chunk)
  const out: string[] = []
  PARAGRAPH_REFERENCE.lastIndex = 0
  for (let m = PARAGRAPH_REFERENCE.exec(chunk.text); m; m = PARAGRAPH_REFERENCE.exec(chunk.text)) {
    const after = chunk.text.slice(m.index + m[0].length)
    if (CROSS_LAW_AFTER.test(after)) continue

    const explicitChapter = referencedChapter(chunk.text.slice(0, m.index))
    // Explicit markör måste vara paragrafens EGET kapitel. För lagar utan
    // kapitelindelning (chapter === null) betyder varje markör "annan lag" och
    // fälls här.
    if (explicitChapter !== null && explicitChapter !== chunk.chapter) continue

    for (const raw of m[1]!.split(/\s*(?:,|och|eller)\s*/)) {
      const label = normalizeLabel(raw)
      if (!label) continue
      const id = chunkKey(chunk.lawId, chunk.chapter, label)
      if (id !== self) out.push(id)
    }
  }
  return out
}

let graphCache: Map<string, LegalChunk[]> | null = null

/**
 * BAKÅTGRAFEN: `referenced legalChunkId` → de chunkar som REFERERAR till den,
 * i korpusordning och deduplicerade. Härledd ur buildLegalChunks() och
 * memoiserad (ren funktion av lagtexten, som legal-chunk.ts).
 *
 * En kant skapas bara om målet FINNS som chunk — en hänvisning till en paragraf
 * korpusen inte bär (utelämnat kapitel) ger ingen kant.
 */
export function buildBackwardReferenceGraph(): Map<string, LegalChunk[]> {
  if (graphCache) return graphCache

  const chunks = buildLegalChunks()
  const known = new Set(chunks.map(legalChunkId))
  const graph = new Map<string, LegalChunk[]>()

  for (const chunk of chunks) {
    for (const target of sameLawReferences(chunk)) {
      if (!known.has(target)) continue
      const list = graph.get(target)
      if (!list) {
        graph.set(target, [chunk])
      } else if (!list.includes(chunk)) {
        list.push(chunk)
      }
    }
  }

  graphCache = graph
  return graph
}

/** Högst så många grannar per ankare … */
export const DEFAULT_MAX_PER_ANCHOR = 2
/** … och högst så många totalt, oavsett antal ankare. */
export const DEFAULT_MAX_TOTAL_ADDED = 3

export interface BackwardExpansionOptions {
  maxPerAnchor?: number
  maxTotalAdded?: number
}

/**
 * Utvidgar ett REDAN INSLÄPPT retrieval-resultat med de samma-lags-paragrafer
 * som refererar till dess ankare. Ankare först (orörda, i ordning), grannar
 * sist.
 *
 * Grannarna får `score: 0`, `coverage: 0` och INGEN cosine. Det är inte
 * kosmetika: fälten är råsignaler från kanaler grannen aldrig gick igenom, och
 * ett påhittat värde hade varit ett obelagt påstående om en mätning som inte
 * skett. Att de är noll är också ofarligt — grinden har redan kört och läser
 * ändå aldrig denna lista (den läser `retrieval.lexical` /
 * `retrieval.semanticTopCosine`, se legal-grounding.ts).
 */
export function expandWithBackwardReferences(
  retrieved: readonly RetrievedChunk[],
  opts?: BackwardExpansionOptions,
): RetrievedChunk[] {
  const maxPerAnchor = opts?.maxPerAnchor ?? DEFAULT_MAX_PER_ANCHOR
  const maxTotalAdded = opts?.maxTotalAdded ?? DEFAULT_MAX_TOTAL_ADDED
  const anchors = [...retrieved]
  if (anchors.length === 0 || maxPerAnchor < 1 || maxTotalAdded < 1) return anchors

  const graph = buildBackwardReferenceGraph()
  const seen = new Set(anchors.map((r) => legalChunkId(r.chunk)))
  const added: RetrievedChunk[] = []

  for (const anchor of anchors) {
    if (added.length >= maxTotalAdded) break
    let perAnchor = 0
    for (const neighbour of graph.get(legalChunkId(anchor.chunk)) ?? []) {
      if (perAnchor >= maxPerAnchor || added.length >= maxTotalAdded) break
      const id = legalChunkId(neighbour)
      if (seen.has(id)) continue
      seen.add(id)
      added.push({ chunk: neighbour, score: 0, coverage: 0 })
      perAnchor++
    }
  }

  return [...anchors, ...added]
}

/** Testhjälpare: nyckelformen grafen slår upp på (låses mot legalChunkId). */
export const __chunkKeyForTest = chunkKey
