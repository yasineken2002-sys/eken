-- Bankavstämnings-härdning PR 4 (B): betalningsdatans färskhet (datakälls-agnostisk).
-- Tre additiva Organization-fält. paymentDataStaleDays NOT NULL DEFAULT 3 — befintliga
-- rader får tröskeln 3 dagar utan backfill. De två DateTime-fälten är nullable
-- (NULL paymentDataThrough = ingen data ingestad → grinden engagerar ej).
ALTER TABLE "Organization" ADD COLUMN "paymentDataThrough" DATE;
ALTER TABLE "Organization" ADD COLUMN "paymentDataStaleDays" INTEGER NOT NULL DEFAULT 3;
ALTER TABLE "Organization" ADD COLUMN "paymentDataStaleAlertedAt" TIMESTAMP(3);
