-- #710 — hjärtslag per låst cron-jobb.
--
-- EN rad per låsnyckel, överskriven vid varje körning. Ingen historik: frågan
-- är "när kördes jobbet sist och hur gick det", inte "hur har det gått över
-- tid". Den andra frågan är en annan tabell och ett annat beslut.
--
-- Ingen backfill: tabellen är tom tills första körningen skriver. /v1/health
-- rapporterar då `lastRunAt: null` med boot-tiden som referens, vilket är
-- sanningen — inte "stale".

CREATE TABLE "CronHeartbeat" (
  "key"            TEXT NOT NULL,
  "lastRunAt"      TIMESTAMP(3) NOT NULL,
  "lastOutcome"    TEXT NOT NULL,
  "lastDurationMs" INTEGER NOT NULL,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CronHeartbeat_pkey" PRIMARY KEY ("key")
);
