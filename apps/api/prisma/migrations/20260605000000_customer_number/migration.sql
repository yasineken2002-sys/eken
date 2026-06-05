-- AlterTable: kort, plattformsglobalt och permanent kundnummer (K-100001 …).
-- Nullable i detta steg så befintliga rader inte bryter migrationen; görs
-- NOT NULL i en separat PR efter prod-verifierad backfill.
ALTER TABLE "Organization" ADD COLUMN "customerNumber" TEXT;

-- CreateTable: plattformsglobal singleton-sekvens för kundnummer. En enda rad,
-- vaktad av ett konstant id ('GLOBAL'); allokeras via atomär UPSERT-increment.
CREATE TABLE "CustomerNumberSequence" (
    "id" TEXT NOT NULL DEFAULT 'GLOBAL',
    "lastNumber" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerNumberSequence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Organization_customerNumber_key" ON "Organization"("customerNumber");

-- CreateIndex
CREATE INDEX "Organization_customerNumber_idx" ON "Organization"("customerNumber");

-- Backfill: tilldela befintliga organisationer kundnummer i kronologisk
-- (createdAt) ordning. ROW_NUMBER ger 1, 2, 3 … → K-100001, K-100002 …
-- (formatCustomerNumber: 100000 + löpnummer). id som tiebreaker för stabil
-- ordning om två rader delar createdAt.
WITH ordered AS (
  SELECT "id", ROW_NUMBER() OVER (ORDER BY "createdAt", "id") AS rn
  FROM "Organization"
)
UPDATE "Organization" o
SET "customerNumber" = 'K-' || (100000 + ordered.rn)::text
FROM ordered
WHERE o."id" = ordered."id";

-- Seed sekvensraden så nästa allokering (UPSERT-increment) fortsätter direkt
-- efter sista backfillade numret → gap-free. lastNumber = antal organisationer
-- (0 om tom DB; första allokeringen ger då K-100001).
INSERT INTO "CustomerNumberSequence" ("id", "lastNumber", "updatedAt")
VALUES ('GLOBAL', (SELECT COUNT(*)::int FROM "Organization"), NOW());
