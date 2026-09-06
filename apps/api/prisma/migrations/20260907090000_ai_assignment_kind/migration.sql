-- DELEGATIONSFÖRSLAGET (etapp 8 PR 5a) — agenten FÖRESLÅR, den tar sig aldrig rätt.
--
-- ── VARFÖR ETT EGET FÄLT OCH INTE `shadow` ─────────────────────────────────
--
-- `shadow` svarar på "utförs något om detta godkänns?". För ett skuggförslag är
-- svaret nej — godkännandet är ett FACIT. En delegationsförfrågan utför inget
-- verktyg, men ett ja på den SKAPAR en rättighet. Att låta `shadow: true` bära
-- den hade gjort "godkännandet gör ingenting" osant för en hel klass av rader.
--
-- ── IDEMPOTENSEN ───────────────────────────────────────────────────────────
--
-- Det partiella unika indexet nedan gör "samma mönster ger ETT förslag" till en
-- egenskap hos DATABASEN, inte hos en kontroll som kan förlora en kapplöpning
-- mellan två sveppass. Nyckeln är `sourceId = <verktyg>|<typ>|<nivå>`, där nivån
-- är den tröskel mönstret nått (3, 6, 9 …).
--
-- PARTIELLT på `kind = 'DELEGATION_PROPOSAL'`, av samma skäl som skuggindexet är
-- partiellt på `shadow`: ett verktygsförslag kan mycket väl produceras flera
-- gånger ur samma källa, och ett totalt index hade spärrat det.
--
-- Nivån i nyckeln bär dessutom regeln "ett avvisat förslag återkommer inte
-- förrän mönstret vuxit": avvisas förslaget på nivå 3 är nästa nyckel nivå 6,
-- som kräver tre nya godkännanden i sviten.
--
-- OBS: `prisma migrate diff` ville här lägga till
--   CREATE EXTENSION IF NOT EXISTS "vector";
--   DROP INDEX "LegalChunkEmbedding_embedding_hnsw_idx";
-- Båda raderna är BORTTAGNA med flit, samma sak som i 20260906210000,
-- 20260906180000, 20260906140000, 20260903160936, 20260902194148,
-- 20260901090000, 20260831212302 och 20260820120000. HNSW-indexet skapas av rå
-- SQL i 20260610000000 och finns därför inte i schema.prisma — en körd radering
-- hade gjort juridik-RAG:ens vektorsökning till en full scan utan att något blev
-- rött.

-- CreateEnum
CREATE TYPE "AiAssignmentKind" AS ENUM ('TOOL_PROPOSAL', 'DELEGATION_PROPOSAL');

-- AlterTable
ALTER TABLE "AiAssignment" ADD COLUMN     "kind" "AiAssignmentKind" NOT NULL DEFAULT 'TOOL_PROPOSAL';


-- IDEMPOTENSEN. Se noten överst. Prisma kan inte uttrycka partiella index, så
-- den här raden bor i SQL och är dokumenterad i schema.prisma vid `kind`.
CREATE UNIQUE INDEX "AiAssignment_delegation_proposal_unique"
    ON "AiAssignment"("organizationId", "sourceKind", "sourceId")
    WHERE "kind" = 'DELEGATION_PROPOSAL';

-- Sveppasset frågar "finns ett ÖPPET förslag för det här mönstret".
--
-- NAMNET ÄR PRISMAS EGET, och indexet är deklarerat i schema.prisma. Ett
-- handnamngivet index utanför schemat blir drift som `schema-drift-guard`
-- föreslår att DROPPA — uppmätt i den här PR:ens första CI-körning.
CREATE INDEX "AiAssignment_organizationId_kind_status_idx"
    ON "AiAssignment"("organizationId", "kind", "status");
