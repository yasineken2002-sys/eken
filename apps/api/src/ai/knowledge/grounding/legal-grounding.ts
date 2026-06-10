/**
 * Juridisk grundning av operator-AI:n (Etapp 2, PR 2.3a) — kopplar retrieval
 * (PR 2.2) till produktchatten med CITAT-INTEGRITET (gap A) som bärande invariant:
 *
 *   AI:n skriver SVARET i ord, men får ALDRIG skriva den auktoritativa källan.
 *   KODEN binder källhänvisningen ur de hämtade chunkarnas metadata
 *   (lag + paragraf + SFS + verifieradPer). `buildSourceCitation` kan per
 *   signatur bara se chunkar — aldrig AI-text — så en hallucinerad källa är
 *   FYSISKT OMÖJLIG, inte bara upptäckbar.
 *
 * Avgränsningar (medvetna, per PR-plan):
 *   - Gap B (miss-grind: svag/ingen träff → "fråga jurist") byggs i PR 2.3b.
 *     Här gäller: hämtar retrieval inget → ingen grundning → AI:n svarar som
 *     idag (konservativt per #129-prompten).
 *   - Gap C: endast operator-AI:n. Tenant-AI:n importerar INTE denna modul.
 *
 * Ingen AI, ingen modell, inga sidoeffekter — ren text→text-logik.
 */
import { retrieveLegalChunks } from '../retrieval/legal-retrieval'
import type { LegalChunk } from '../retrieval/legal-chunk'
import { getLegalDocument } from '../legal-knowledge'

export interface LegalGrounding {
  /** De hämtade paragraf-chunkarna — den ENDA tillåtna källan till källhänvisning. */
  chunks: LegalChunk[]
  /** Systemblock: verifierad lagtext + grundningsinstruktion (injiceras i AI:ns kontext). */
  contextBlock: string
  /** Kod-bunden källhänvisning — byggd ENBART ur chunk-metadata, aldrig ur AI-text. */
  sourceCitation: string
}

/**
 * Heuristisk ingångsgrind: är detta en juridisk fråga alls? Skiljer juridik
 * ("kan jag säga upp...?") från drift ("skapa en faktura till Anna"), så att
 * lagtext inte injiceras — och källrader inte appendas — på operativa svar.
 * Falsk negativ är ofarlig: AI:n svarar då som idag (konservativt per #129).
 * Den finare miss-/svagträffsgrinden (gap B) byggs i PR 2.3b.
 *
 * OBS: matchas mot lowercase. Undvik \b intill å/ä/ö (icke-\w i JS-regex).
 */
const LEGAL_TRIGGERS: readonly RegExp[] = [
  // Explicit juridik-/lagvokabulär
  /juridi|jurist|lagrum|paragraf|§|formkrav|hyresnämnd|domstol|stämma|stämning/,
  /\blag(en|ens|arna|stiftning|lig|ligt)\b/, // "lagen", "lagligt" — men inte "förslag"/"underlag"
  /hyreslag|jordabalk|räntelag|bokföringslag|mervärdesskattelag|diskrimineringslag|bostadsrättslag/,
  // Uppsägning / förverkande / avhysning / besittning
  /uppsäg|säga upp|säger upp|sagt upp|sägs upp|förverk|vräk|avhys/,
  /besittning|förläng|delgiv/,
  // Andrahand, störningar, diskriminering, tillträde
  /andrahand|andra hand/,
  /störande|störning/,
  /diskriminer|etnicitet|etnisk|religion|sexuell läggning|funktionsneds|missgynna/,
  /tillträde|gå in i lägenheten|förbättringsarbet/,
  // Hyresvillkor med rättsregler/formkrav
  /hyreshöjning|(höj\w*|höjning).{0,20}hyra/,
  /bruksvärde|skälig hyra|ta i hyra|ta ut i hyra/,
  /deposition|dröjsmålsränt|referensränt|skriftlig/,
  /förfallodag|när ska hyran( senast)? betalas/,
  /vad gäller|har jag rätt|har hyresgästen rätt|får jag kräva|vad säger lagen/,
]

/** Sant om meddelandet ser ut som en juridisk fråga (se LEGAL_TRIGGERS). */
export function isLegalQuestion(message: string): boolean {
  const lower = message.toLowerCase()
  return LEGAL_TRIGGERS.some((re) => re.test(lower))
}

/** Samma topK som retrieval-mätningen i PR 2.2 (12/18 answerable). */
export const GROUNDING_TOP_K = 3

/**
 * Bygger grundningen för ett användarmeddelande, eller null om frågan inte är
 * juridisk eller retrieval inte hämtar något (miss-grinden förfinas i 2.3b).
 */
export function buildLegalGrounding(message: string): LegalGrounding | null {
  if (!isLegalQuestion(message)) return null
  const retrieved = retrieveLegalChunks(message, { topK: GROUNDING_TOP_K })
  if (retrieved.length === 0) return null
  const chunks = retrieved.map((r) => r.chunk)
  return {
    chunks,
    contextBlock: buildContextBlock(chunks),
    sourceCitation: buildSourceCitation(chunks),
  }
}

function lawTitle(lawId: string): string {
  return getLegalDocument(lawId)?.titel ?? lawId
}

/**
 * CITAT-INTEGRITET (gap A): den auktoritativa källhänvisningen. Signaturen tar
 * ENBART chunkar — funktionen kan inte se (och kan därmed aldrig påverkas av)
 * vad AI:n skrev. Varje lag/paragraf/SFS/datum i strängen kommer ordagrant ur
 * de hämtade chunkarnas metadata, som i sin tur (per PR 2.2-testerna) alltid
 * är hämtad ur LEGAL_KNOWLEDGE-strukturen — aldrig härledd eller gissad.
 */
export function buildSourceCitation(chunks: readonly LegalChunk[]): string {
  const lawOrder: string[] = []
  const byLaw = new Map<string, LegalChunk[]>()
  for (const chunk of chunks) {
    if (!byLaw.has(chunk.lawId)) {
      byLaw.set(chunk.lawId, [])
      lawOrder.push(chunk.lawId)
    }
    const list = byLaw.get(chunk.lawId)!
    if (!list.some((c) => c.paragraph === chunk.paragraph)) list.push(chunk)
  }
  const parts = lawOrder.map((lawId) => {
    const list = byLaw.get(lawId)!
    const paragraphs = list.map((c) => `${c.paragraph} §`).join(', ')
    const { sfs, verifieradPer } = list[0]!
    return `${lawTitle(lawId)} ${paragraphs} (SFS ${sfs}, gällande lydelse verifierad ${verifieradPer})`
  })
  return `Detta svar bygger på verifierad lagtext: ${parts.join('; ')}.`
}

/**
 * Avskiljare mellan AI:ns text och den kod-bundna källraden. Allt EFTER den
 * sista förekomsten av denna markör i ett svar är skrivet av kod, inte av AI:n.
 */
export const SOURCE_SUFFIX_MARKER = '\n\n---\n'

/** Källsuffixet som koden appendar på ett grundat svar (även SSE-vägen). */
export function formatSourceSuffix(grounding: LegalGrounding): string {
  return `${SOURCE_SUFFIX_MARKER}${grounding.sourceCitation}`
}

/**
 * Appendar den kod-bundna källan på AI:ns text. AI-texten passerar opåverkad —
 * skriver AI:n (mot instruktion) ett eget lagrum blir det kvar som prosa, men
 * det är ALDRIG källhänvisningen: den auktoritativa källan är alltid suffixet,
 * byggt ur metadata innan AI:n ens svarat.
 */
export function appendCodeBoundSource(aiText: string, grounding: LegalGrounding): string {
  return `${aiText.trimEnd()}${formatSourceSuffix(grounding)}`
}

/** Systemblocket med den hämtade lagtexten + grundningsregler för AI:n. */
function buildContextBlock(chunks: readonly LegalChunk[]): string {
  const sources = chunks
    .map(
      (c, i) =>
        `[Källa ${i + 1}: ${lawTitle(c.lawId)}, ${c.paragraph} § — SFS ${c.sfs}, verifierad ${c.verifieradPer}]\n${c.text}`,
    )
    .join('\n\n')

  return [
    'VERIFIERAD LAGTEXT (hämtad av systemet för användarens senaste fråga)',
    '',
    'Nedan följer ordagrann, människoverifierad svensk lagtext som systemet hämtat',
    'ur sin kunskapsbas. GRUNDA ditt juridiska svar i denna text — inte i ditt minne.',
    '',
    'REGLER FÖR DENNA LAGTEXT (absoluta):',
    '- Förklara reglernas innebörd i klartext, pedagogiskt och på svenska.',
    '- Skriv ALDRIG paragrafnummer, §-hänvisningar eller SFS-nummer i ditt svar —',
    '  inte ens de som står nedan. Systemet lägger AUTOMATISKT till den',
    '  auktoritativa källhänvisningen (lag + paragraf + SFS + verifieringsdatum)',
    '  efter ditt svar, hämtad direkt ur källmetadatan.',
    '- Om lagtexten nedan inte räcker för att besvara frågan: säg det öppet och',
    '  rekommendera jurist i stället för att fylla i ur minnet.',
    '- Vid juridiskt känsliga frågor (uppsägning, förverkande, besittningsskydd,',
    '  tvister) gäller fortfarande: rekommendera avstämning med jurist innan',
    '  bindande åtgärd.',
    '',
    sources,
  ].join('\n')
}
