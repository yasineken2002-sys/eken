-- AKTÖRSMODELLEN (G1, etapp 8): de tre utförandestatusarna.
--
-- EXECUTED · FAILED · LAPSED — se docblocket vid enumen i schema.prisma för
-- varför de får läggas till innan skrivaren finns, och hur det är BEVISAT att
-- ingen produktionsväg kan sätta dem i dag (`assignment-status-writers.spec.ts`,
-- med kanariefågel).
--
-- ── TRE VÄRDEN I EN MIGRATION ──────────────────────────────────────────────
--
-- Prisma varnar för att PostgreSQL 11 och tidigare inte klarar det. Railway kör
-- pg16 (image `pgvector/pgvector:pg16`, samma som CI), där `ALTER TYPE … ADD
-- VALUE` är tillåtet flera gånger i samma transaktion. Varningen är alltså
-- korrekt och gäller inte oss — den står kvar oredigerad nedan därför att en
-- borttagen varning ser ut som att ingen läste den.
--
-- OBS: `prisma migrate diff` ville här lägga till
--   CREATE EXTENSION IF NOT EXISTS "vector";
--   DROP INDEX "LegalChunkEmbedding_embedding_hnsw_idx";
-- Båda raderna är BORTTAGNA med flit, samma sak som i 20260906140000,
-- 20260903160936, 20260902194148, 20260901090000, 20260831212302 och
-- 20260820120000. HNSW-indexet skapas av rå SQL i 20260610000000 och finns
-- därför inte i schema.prisma — en körd radering hade gjort juridik-RAG:ens
-- vektorsökning till en full scan utan att något blev rött.

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AiAssignmentStatus" ADD VALUE 'EXECUTED';
ALTER TYPE "AiAssignmentStatus" ADD VALUE 'FAILED';
ALTER TYPE "AiAssignmentStatus" ADD VALUE 'LAPSED';


