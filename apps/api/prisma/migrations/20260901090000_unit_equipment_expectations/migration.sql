-- FÖRVÄNTANSFÄLT PÅ UTRUSTNING (etapp 1c).
--
-- Första stället i systemet där en deklarerad förväntan kan bo på OBJEKTNIVÅ.
-- Fram till nu fanns exakt en konfigurerad återkommande förväntan —
-- `MaintenancePlan.interval` — och den är fastighetsbunden.
--
-- BÅDA NULLBARA UTAN DEFAULT, med flit. Ett default vore en förväntan som
-- koden hittat på, och den skulle börja larma på hela beståndet utifrån en
-- siffra ingen bestämt. Ingen backfill av samma skäl: befintliga rader har
-- ingen uttalad förväntan, och det ska synas som ODEFINIERAD i luckberäkningen
-- i stället för att tyst bli "allt är bra".
--
-- ── HANDSKRIVEN, INTE GENERERAD — TREDJE GÅNGEN PÅ SAMMA FÄLLA ─────────────
--
-- `prisma migrate diff` producerade TRE satser:
--
--     CREATE EXTENSION IF NOT EXISTS "vector";        ← icke-destruktiv drift
--     DROP INDEX "LegalChunkEmbedding_embedding_hnsw_idx";   ← ALLVARLIG
--     ALTER TABLE "UnitEquipment" ADD COLUMN …        ← den som hör hit
--
-- HNSW-indexet går inte att uttrycka i schema.prisma, så diffen vill ta bort
-- det varje gång. Hade raden följt med hade juridik-RAG:ens vektorindex
-- försvunnit i prod — en tyst prestandakollaps utan samband med utrustning.
-- Samma sak dokumenterad i 20260820120000, 20260822113144 och 20260831212302,
-- där den senast fångades av `schema:drift`-vakten först EFTER commit.
--
-- Bara ALTER TABLE står kvar nedan. `CREATE EXTENSION` utelämnas också: den är
-- redan kvitterad som icke-destruktiv drift och hör inte till den här ändringen.

ALTER TABLE "UnitEquipment"
  ADD COLUMN "expectedLifespanYears" INTEGER,
  ADD COLUMN "serviceIntervalMonths" INTEGER;
