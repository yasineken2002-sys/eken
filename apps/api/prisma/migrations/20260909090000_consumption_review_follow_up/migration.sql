-- Egen opt-in. Befintliga organisationer förblir avstängda.
ALTER TABLE "Organization"
  ADD COLUMN "consumptionReviewFollowUpEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "consumptionReviewFollowUpEnabledAt" TIMESTAMP(3),
  ADD COLUMN "consumptionReviewFollowUpCheckedAt" TIMESTAMP(3),
  ADD COLUMN "consumptionReviewFollowUpErrorAt" TIMESTAMP(3),
  ADD COLUMN "consumptionReviewFollowUpRevision" INTEGER NOT NULL DEFAULT 0;
