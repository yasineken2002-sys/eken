/**
 * Chunkning av den verifierade lagtexten — per paragraf (§).
 *
 * Källan är redan paragraf-indelad (rubriker "## N §" / "## N a §"), så en chunk
 * = en specifik paragraf med exakt label. Varje chunk bär sin egen källmetadata
 * (lag-id, SFS, verifieradPer, paragraf) HÄMTAD UR LEGAL_KNOWLEDGE-strukturen —
 * aldrig härledd eller gissad. Det är grunden för citat-integritet (gap A): i
 * PR 2.3 ska AI:n bara kunna citera det en chunk faktiskt bär.
 *
 * Ingen AI, ingen modell — ren textbearbetning.
 */
import { LEGAL_KNOWLEDGE } from '../legal-knowledge'

export interface LegalChunk {
  /** Lag-id, matchar LEGAL_KNOWLEDGE, t.ex. "hyreslagen". */
  lawId: string
  /** SFS-nummer, ur lagens metadata. */
  sfs: string
  /** Verifieringsdatum, ur lagens metadata. */
  verifieradPer: string
  /** Paragraf-label exakt som i rubriken, t.ex. "45", "54 a". */
  paragraph: string
  /** Rubrikraden, t.ex. "## 45 §". */
  heading: string
  /** Paragrafens fulltext (inkl. rubrik), ordagrant ur källan. */
  text: string
}

// Matchar en paragraf-rubrik på egen rad: "## 45 §", "## 54 a §".
const PARAGRAPH_HEADING = /^## (.+?) §[ \t]*$/gm

let cache: LegalChunk[] | null = null

/** Bygger (och memoiserar) alla paragraf-chunkar ur LEGAL_KNOWLEDGE. */
export function buildLegalChunks(): LegalChunk[] {
  if (cache) return cache

  const chunks: LegalChunk[] = []
  for (const doc of LEGAL_KNOWLEDGE) {
    const matches = [...doc.innehall.matchAll(PARAGRAPH_HEADING)]
    for (let i = 0; i < matches.length; i++) {
      const current = matches[i]!
      const next = matches[i + 1]
      const start = current.index ?? 0
      const end = next?.index ?? doc.innehall.length
      chunks.push({
        lawId: doc.id,
        sfs: doc.sfs,
        verifieradPer: doc.verifieradPer,
        paragraph: current[1]!.trim(),
        heading: current[0]!.trim(),
        text: doc.innehall.slice(start, end).trim(),
      })
    }
  }

  cache = chunks
  return chunks
}
