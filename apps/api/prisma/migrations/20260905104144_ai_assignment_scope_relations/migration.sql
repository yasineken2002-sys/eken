-- UPPDRAGETS OMFÅNG — tre nullbara FK:er på `AiAssignment` (etapp 4).
--
-- Utan dem är uppdragskön OSYNLIG för `check-history-registry.mjs`: vakten kan
-- bara kräva en historikkälla för en modell som är ett relationsfält på
-- `Tenant`, `Unit` eller `Property`. Noll av 20 källor läste `AiAssignment`,
-- och ingenting blev rött.
--
-- INGEN BACKFILL, OCH INGEN BEHÖVS. `SELECT count(*) FROM "AiAssignment"` gav
-- 0 rader vid migrationstillfället, och det är strukturellt: producenten är
-- etapp 8-9, controllern har inget POST, och `skapa()` har ingen anropare
-- utanför sin egen katalog. Noll befintliga rader blir alltså utan relation.
--
-- NULL betyder "uppdraget rör inget enskilt objekt" och inte "vi vet inte":
-- 17 av de 23 dugliga verktygen har ingen objektparameter alls. Kolumnerna är
-- därför nullbara och inte NOT NULL med sentinel — de ingår inte i något unikt
-- villkor, så regeln om NULL i unika index gäller inte här.
--
-- ── TVÅ RADER UR `prisma migrate diff` ÄR MED FLIT BORTTAGNA ────────────────
--
-- Verktyget genererar alltid `CREATE EXTENSION IF NOT EXISTS "vector"` och ett
-- `DROP INDEX "LegalChunkEmbedding_embedding_hnsw_idx"`. Ingetdera hör till den
-- här ändringen: HNSW-indexet är ett pgvector-index som Prisma inte kan
-- uttrycka i schemat och som därför ser ut som drift vid varje diff. Tas det
-- med DROPPAS den semantiska sökningens index TYST vid nästa deploy.
--
-- Kontrollen som fångar den är check-critical-indexes.mjs; raderna får aldrig
-- kopieras in.

-- AlterTable
ALTER TABLE "AiAssignment" ADD COLUMN     "propertyId" TEXT,
ADD COLUMN     "tenantId" TEXT,
ADD COLUMN     "unitId" TEXT;

-- CreateIndex
CREATE INDEX "AiAssignment_organizationId_tenantId_idx" ON "AiAssignment"("organizationId", "tenantId");

-- CreateIndex
CREATE INDEX "AiAssignment_organizationId_unitId_idx" ON "AiAssignment"("organizationId", "unitId");

-- CreateIndex
CREATE INDEX "AiAssignment_organizationId_propertyId_idx" ON "AiAssignment"("organizationId", "propertyId");

-- AddForeignKey
ALTER TABLE "AiAssignment" ADD CONSTRAINT "AiAssignment_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiAssignment" ADD CONSTRAINT "AiAssignment_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiAssignment" ADD CONSTRAINT "AiAssignment_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE SET NULL ON UPDATE CASCADE;

