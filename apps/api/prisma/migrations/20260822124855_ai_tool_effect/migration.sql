-- UTFALLSKOPPLINGEN: AiToolExecution ska veta vad den orsakade.
--
-- HANDSKRIVEN, INTE GENERERAD. `prisma migrate diff` tar konsekvent med två
-- saker som inte hör hit: CREATE EXTENSION "vector" och — allvarligt —
-- DROP INDEX på LegalChunkEmbedding_embedding_hnsw_idx. HNSW-indexet går inte
-- att uttrycka i schema.prisma, så diffen vill ta bort det varje gång. Hade det
-- följt med hade juridik-RAG:ens vektorindex försvunnit i prod.
--
-- FK MED CASCADE till "AiToolExecution", till skillnad från
-- JournalEntry.aiToolExecutionId (som saknar FK därför att verifikatet skrivs
-- inne i verktygets transaktion medan auditraden kommer efteråt). Här skrivs
-- effekterna som en NÄSTLAD skrivning tillsammans med auditraden, så en effekt
-- kan aldrig finnas utan sin körning. Cascade är nödvändigt: AiRetentionService
-- gallrar AiToolExecution med deleteMany, och Restrict hade fällt gallringen.

CREATE TYPE "AiEffectOperation" AS ENUM ('CREATE', 'UPDATE', 'DELETE');

CREATE TABLE "AiToolEffect" (
    "id" TEXT NOT NULL,
    "aiToolExecutionId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "operation" "AiEffectOperation" NOT NULL,
    "rowCount" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiToolEffect_pkey" PRIMARY KEY ("id")
);

-- "vad orsakade den här körningen?"
CREATE INDEX "AiToolEffect_aiToolExecutionId_idx" ON "AiToolEffect"("aiToolExecutionId");
-- "vad har AI:n gjort med den här raden?"
CREATE INDEX "AiToolEffect_organizationId_entityType_entityId_idx" ON "AiToolEffect"("organizationId", "entityType", "entityId");
CREATE INDEX "AiToolEffect_organizationId_createdAt_idx" ON "AiToolEffect"("organizationId", "createdAt");

-- Revisionsspår: bevaras vid org-borttagning (Restrict), som AiToolExecution.
ALTER TABLE "AiToolEffect" ADD CONSTRAINT "AiToolEffect_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AiToolEffect" ADD CONSTRAINT "AiToolEffect_aiToolExecutionId_fkey"
  FOREIGN KEY ("aiToolExecutionId") REFERENCES "AiToolExecution"("id") ON DELETE CASCADE ON UPDATE CASCADE;
