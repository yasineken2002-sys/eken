/**
 * Publik åtkomst till den runtime-inbäddade, verifierade lagtext-kunskapsbasen.
 *
 * Etapp 1 = BARA fundamentet: katalogen finns tillgänglig i drift. Ingen
 * retrieval, ingen AI-/prompt-koppling, ingen sökning här ännu — det byggs i
 * Etapp 2 (med citat-integritet, retrieval-miss-grind, operator-före-tenant och
 * versionering enligt de fyra säkerhetsgapen).
 */
import type { LegalKnowledgeDocument } from './legal-knowledge.types'
import { GENERATED_LEGAL_DOCUMENTS } from './generated/index.generated'

export type { LegalKnowledgeDocument }

/** Alla verifierade lagtexter, inbäddade i bundlen (oberoende av `.claude/`). */
export const LEGAL_KNOWLEDGE: readonly LegalKnowledgeDocument[] = GENERATED_LEGAL_DOCUMENTS

const BY_ID: ReadonlyMap<string, LegalKnowledgeDocument> = new Map(
  LEGAL_KNOWLEDGE.map((doc) => [doc.id, doc]),
)

/** Alla id:n i katalogen, t.ex. ["bokforingslagen", "hyreslagen", ...]. */
export const LEGAL_DOCUMENT_IDS: readonly string[] = LEGAL_KNOWLEDGE.map((doc) => doc.id)

/** Hämtar en lagtext på id, eller undefined om den inte finns. */
export function getLegalDocument(id: string): LegalKnowledgeDocument | undefined {
  return BY_ID.get(id)
}
