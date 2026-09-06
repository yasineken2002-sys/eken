-- MINNETS HÄRKOMST (etapp 8 PR 4) — vad agenten får läsa, och på vilka grunder.
--
-- ── DEFEKTEN ───────────────────────────────────────────────────────────────
--
-- `getMemories` läste ALLA rader för en användare, utan filter, och satte dem i
-- systemprompten under rubriken "INLÄRDA MINNEN FÖR DENNA ANVÄNDARE" följt av
-- meningen "Använd dessa som standard när användaren inte specificerar något
-- annat". Raderna skapades av `extractAndSaveMemories` — Haiku som sammanfattar
-- ett samtal. En modells gissning matades alltså tillbaka som en instruktion.
--
-- Mätt i prod 2026-09-06: 70 rader, varav 4 av typen `preference`. Två av dem
-- heter "Godkännande av innehåll" och "Bekräftelse före åtgärd" — alltså precis
-- den klass som låter som beteenderegler. NOLL av de 70 hade någon form av
-- härkomst, av det enkla skälet att modellen inte hade något fält för det.
--
-- ── VARFÖR KOLUMNER PÅ AiMemory OCH INTE EN NY MODELL ──────────────────────
--
-- Härkomsten är en egenskap HOS PÅSTÅENDET, inte ett eget subjekt: den svarar
-- "på vilka grunder får den här raden läsas". En sidomodell hade krävt en join i
-- varje läsväg, och den dagen någon glömmer joinen är utfallet att filtret tyst
-- slutar gälla — alltså exakt defekten igen, i ny form. Jämför `AiAssignment`,
-- där `authorityKind` sitter på raden av samma skäl.
--
-- ── DEFAULTEN ÄR ETT FAKTUM ────────────────────────────────────────────────
--
-- `ANTAGANDE` är inte försiktighet utan sanningen om de rader som fanns: alla 70
-- skapades av modellextraktionen, och ingen människa har sagt något om någon av
-- dem. Samma resonemang som `authorityKind DEFAULT 'APPROVAL'` i #803.
--
-- ── ETT AVVISAT ANTAGANDE RADERAS INTE ─────────────────────────────────────
--
-- Planens Del 7: *"Att säga nej är också lärande. En agent som bara lär av ja:n
-- lär sig fel."* Och mekaniskt: `@@unique([organizationId, userId, key])` gör att
-- extraktionen UPSERTAR på nyckeln, så en raderad post hade återuppstått som
-- ANTAGANDE nästa gång ämnet kom upp — hyresvärdens nej hade försvunnit utan att
-- någon märkte det.
--
-- OBS: `prisma migrate diff` ville här lägga till
--   CREATE EXTENSION IF NOT EXISTS "vector";
--   DROP INDEX "LegalChunkEmbedding_embedding_hnsw_idx";
-- Båda raderna är BORTTAGNA med flit, samma sak som i 20260906180000,
-- 20260906140000, 20260903160936, 20260902194148, 20260901090000,
-- 20260831212302 och 20260820120000. HNSW-indexet skapas av rå SQL i
-- 20260610000000 och finns därför inte i schema.prisma — en körd radering hade
-- gjort juridik-RAG:ens vektorsökning till en full scan utan att något blev rött.

-- CreateEnum
CREATE TYPE "AiMemoryProvenance" AS ENUM ('HUMAN_CONFIRMED', 'DECISION_DERIVED', 'ANTAGANDE');

-- AlterTable
ALTER TABLE "AiMemory" ADD COLUMN     "confirmedAt" TIMESTAMP(3),
ADD COLUMN     "confirmedByUserId" TEXT,
ADD COLUMN     "provenanceKind" "AiMemoryProvenance" NOT NULL DEFAULT 'ANTAGANDE',
ADD COLUMN     "rejectedAt" TIMESTAMP(3),
ADD COLUMN     "rejectedByUserId" TEXT,
ADD COLUMN     "sourceId" TEXT,
ADD COLUMN     "sourceKind" TEXT;

-- CreateIndex
CREATE INDEX "AiMemory_organizationId_userId_provenanceKind_idx" ON "AiMemory"("organizationId", "userId", "provenanceKind");

-- AddForeignKey
ALTER TABLE "AiMemory" ADD CONSTRAINT "AiMemory_confirmedByUserId_fkey" FOREIGN KEY ("confirmedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiMemory" ADD CONSTRAINT "AiMemory_rejectedByUserId_fkey" FOREIGN KEY ("rejectedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

