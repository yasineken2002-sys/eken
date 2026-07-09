-- T1.3: succession annullerar väntande hyreshöjningar på det ersatta avtalet.
-- Ny terminal status VOIDED + audit-kolumner (när/varför den aldrig applicerades).
ALTER TYPE "RentIncreaseStatus" ADD VALUE 'VOIDED';

ALTER TABLE "RentIncrease"
  ADD COLUMN "voidedAt" TIMESTAMP(3),
  ADD COLUMN "voidReason" TEXT;
