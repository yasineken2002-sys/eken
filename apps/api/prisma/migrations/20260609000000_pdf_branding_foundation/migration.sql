-- Steg 3, PR 1 — fundament för PDF-/dokumentvarumärke. PENGANEUTRAL och
-- rendering-neutral: bara datafält läggs till, ingen PDF/e-post läser dem ännu.
-- Allt är additivt: enum + nytt fält med DEFAULT + en nullable kolumn. Befintliga
-- rader får brandFont = SYSTEM_SANS (= nuvarande hårdkodade typsnitt) och
-- brandSecondaryColor = NULL (= härleds vid inkoppling) → utseendet ändras inte.

-- CreateEnum
CREATE TYPE "BrandFont" AS ENUM ('SYSTEM_SANS', 'HELVETICA', 'GEORGIA', 'INTER');

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN "brandFont" "BrandFont" NOT NULL DEFAULT 'SYSTEM_SANS';
ALTER TABLE "Organization" ADD COLUMN "brandSecondaryColor" TEXT;
