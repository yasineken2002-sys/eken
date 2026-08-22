-- Turtaket blir MÄTBART.
--
-- Frågan "hur ofta nås turtaket?" gick inte att besvara i efterhand: varken
-- AiToolExecution eller AiUsageLog bar iterationsantal eller stop_reason, och
-- AiToolExecution-rader går inte att gruppera till turer (parallella
-- verktygsanrop i EN omgång är oskiljbara från sekventiella över flera).
-- AiUsageLog har redan EN rad per tur — rätt granularitet — och får därför bära
-- svaret.
--
-- HANDSKRIVEN, INTE GENERERAD. `prisma migrate diff` tog med två saker som inte
-- hör hit: CREATE EXTENSION "vector" och — allvarligt — DROP INDEX på
-- LegalChunkEmbedding_embedding_hnsw_idx. HNSW-indexet går inte att uttrycka i
-- schema.prisma, så diffen vill ta bort det varje gång. Hade det följt med hade
-- juridik-RAG:ens vektorindex försvunnit i prod.

ALTER TABLE "AiUsageLog" ADD COLUMN "toolRounds" INTEGER;
ALTER TABLE "AiUsageLog" ADD COLUMN "capReached" BOOLEAN NOT NULL DEFAULT false;

-- Frekvensfrågan ska inte bli en seq scan över hela användningsloggen.
CREATE INDEX "AiUsageLog_capReached_createdAt_idx" ON "AiUsageLog"("capReached", "createdAt");
