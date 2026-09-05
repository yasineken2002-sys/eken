-- SKUGGLÄGET PÅ FELANMÄLAN (etapp 6) — förslag, konfidens, källa och facit.
--
-- ── DET PARTIELLA UNIKA INDEXET ÄR SJÄLVA IDEMPOTENSEN ─────────────────────
--
-- `prisma migrate diff` kan inte uttrycka ett partiellt index; det skrivs för
-- hand nedan och är INTE dekoration. Producenten körs av ett Bull-jobb OCH av
-- en sveparcron, och de kan mötas: två samtidiga körningar för samma ärende
-- ska ge EN rad. Ett `findFirst`-then-`create` hade förlorat den kapplöpningen
-- — den enda skrivning som inte kan det är databasens egen.
--
-- PARTIELLT (`WHERE "shadow"`) och inte totalt: ett SKARPT uppdrag kan mycket
-- väl produceras flera gånger ur samma källa, och ett totalt index hade tyst
-- förbjudit det. Samma form som lease_unit_active_unique.
--
-- ── TVÅ RADER UR `prisma migrate diff` ÄR MED FLIT BORTTAGNA ────────────────
--
-- Verktyget genererar alltid `CREATE EXTENSION IF NOT EXISTS "vector"` och ett
-- `DROP INDEX "LegalChunkEmbedding_embedding_hnsw_idx"`. HNSW-indexet är ett
-- pgvector-index Prisma inte kan uttrycka och som därför ser ut som drift vid
-- varje diff. Tas det med DROPPAS den semantiska sökningens index TYST vid
-- nästa deploy. check-critical-indexes.mjs fångar det; raderna får aldrig
-- kopieras in.

-- AlterTable
ALTER TABLE "AiAssignment" ADD COLUMN     "confidence" DOUBLE PRECISION,
ADD COLUMN     "outcome" JSONB,
ADD COLUMN     "outcomeAt" TIMESTAMP(3),
ADD COLUMN     "prediction" JSONB,
ADD COLUMN     "shadow" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "sourceId" TEXT,
ADD COLUMN     "sourceKind" TEXT;

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "shadowAgentEnabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "AiAssignment_organizationId_shadow_createdAt_idx" ON "AiAssignment"("organizationId", "shadow", "createdAt");

-- CreateIndex
CREATE INDEX "AiAssignment_organizationId_sourceKind_sourceId_idx" ON "AiAssignment"("organizationId", "sourceKind", "sourceId");


-- IDEMPOTENSEN. Se noten överst.
CREATE UNIQUE INDEX "AiAssignment_shadow_source_unique"
    ON "AiAssignment"("organizationId", "sourceKind", "sourceId")
    WHERE "shadow";
