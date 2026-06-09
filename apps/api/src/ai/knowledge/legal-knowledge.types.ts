/**
 * Runtime-typ för en verifierad svensk lagtext som produkt-AI:n ska kunna
 * grunda sina svar i (Etapp 1 — fundamentet; ingen retrieval/AI-koppling ännu).
 *
 * Sanningskällan är de människoverifierade `.md`-filerna i
 * `.claude/knowledge/lagar/`. De filerna följer INTE med i prod-imagen
 * (`.claude/` kopieras aldrig in i runtime-containern), så lagtexten
 * kompileras in som strängmoduler via `scripts/generate-legal-knowledge.ts`.
 * Modulerna under `generated/` är DERIVAT — redigera aldrig dem för hand.
 */
export interface LegalKnowledgeDocument {
  /** Stabil identifierare, t.ex. "hyreslagen". */
  id: string
  /** Människovänlig titel, t.ex. "Hyreslagen (jordabalken 12 kap.)". */
  titel: string
  /** SFS-nummer, t.ex. "1970:994". */
  sfs: string
  /**
   * Datum (YYYY-MM-DD) då den verifierade texten senast granskades/committades.
   * Säkerhetsgap D (versionering): svar bör kunna ange "gällande lag per X" och
   * texten har en känd ägare/granskningspunkt — annars blir en korrekt
   * kunskapsbas tyst inaktuell.
   */
  verifieradPer: string
  /** Källa (URL) för den verifierade texten. */
  kalla: string
  /** Hela den verifierade lagtexten (markdown), ordagrant från källfilen. */
  innehall: string
}
