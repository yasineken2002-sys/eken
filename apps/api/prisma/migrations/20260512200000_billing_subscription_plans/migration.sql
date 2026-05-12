-- Migration: ersätt PlatformPlan → SubscriptionPlan, OrganizationStatus → OrgStatus
-- och lägg till billing-fält (aiCreditsBalance, planStartedAt, planMonthlyFee).
-- Mappning:
--   plan TRIAL    → subscriptionPlan TRIAL
--   plan BASIC    → subscriptionPlan STARTER
--   plan STANDARD → subscriptionPlan STANDARD
--   plan PREMIUM  → subscriptionPlan PRO
--   status ACTIVE (trial)    → TRIAL
--   status ACTIVE            → ACTIVE
--   status SUSPENDED         → SUSPENDED
--   status CANCELLED         → CANCELLED

-- 1) Skapa nya enums
CREATE TYPE "SubscriptionPlan" AS ENUM ('TRIAL', 'STARTER', 'MINI', 'STANDARD', 'PLUS', 'PRO');
CREATE TYPE "OrgStatus" AS ENUM ('TRIAL', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELLED');

-- 2) Lägg till nya kolumner (nullable först, för att hinna fylla i)
ALTER TABLE "Organization"
  ADD COLUMN "subscriptionPlan" "SubscriptionPlan" NOT NULL DEFAULT 'TRIAL',
  ADD COLUMN "planStartedAt"    TIMESTAMP(3)      NOT NULL DEFAULT NOW(),
  ADD COLUMN "aiCreditsBalance" INTEGER           NOT NULL DEFAULT 0,
  ADD COLUMN "planMonthlyFee"   DECIMAL(10, 2)    NOT NULL DEFAULT 0,
  ADD COLUMN "status_new"       "OrgStatus";

-- 3) Mappa befintlig "plan" → "subscriptionPlan"
UPDATE "Organization" SET "subscriptionPlan" = CASE "plan"::text
  WHEN 'TRIAL'    THEN 'TRIAL'::"SubscriptionPlan"
  WHEN 'BASIC'    THEN 'STARTER'::"SubscriptionPlan"
  WHEN 'STANDARD' THEN 'STANDARD'::"SubscriptionPlan"
  WHEN 'PREMIUM'  THEN 'PRO'::"SubscriptionPlan"
  ELSE 'TRIAL'::"SubscriptionPlan"
END;

-- 4) Kopiera tidigare monthlyFee → planMonthlyFee, createdAt → planStartedAt
UPDATE "Organization" SET "planMonthlyFee" = "monthlyFee";
UPDATE "Organization" SET "planStartedAt" = "createdAt";

-- 5) Mappa status_new (org med plan=TRIAL och trialEndsAt > now → status TRIAL)
UPDATE "Organization" SET "status_new" = CASE
  WHEN "status"::text = 'CANCELLED'                                            THEN 'CANCELLED'::"OrgStatus"
  WHEN "status"::text = 'SUSPENDED'                                            THEN 'SUSPENDED'::"OrgStatus"
  WHEN "plan"::text = 'TRIAL' AND ("trialEndsAt" IS NULL OR "trialEndsAt" > NOW()) THEN 'TRIAL'::"OrgStatus"
  ELSE 'ACTIVE'::"OrgStatus"
END;

-- 6) Byt ut status-kolumnen
ALTER TABLE "Organization" DROP COLUMN "status";
ALTER TABLE "Organization" RENAME COLUMN "status_new" TO "status";
ALTER TABLE "Organization" ALTER COLUMN "status" SET NOT NULL;
ALTER TABLE "Organization" ALTER COLUMN "status" SET DEFAULT 'TRIAL';

-- 7) Droppa gamla plan + monthlyFee (ersatta av subscriptionPlan + planMonthlyFee)
ALTER TABLE "Organization" DROP COLUMN "plan";
ALTER TABLE "Organization" DROP COLUMN "monthlyFee";

-- 8) Droppa gamla enums
DROP TYPE "PlatformPlan";
DROP TYPE "OrganizationStatus";

-- 9) Återskapa index (det gamla "plan"-indexet är borta automatiskt)
CREATE INDEX "Organization_subscriptionPlan_idx" ON "Organization"("subscriptionPlan");

-- 10) AiUsageLog: lägg till isAutomated + source + composite-index
ALTER TABLE "AiUsageLog"
  ADD COLUMN "isAutomated" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "source"      TEXT;

-- Backfill: alla existerande "daily-insights"-rader, "tenant-chat",
-- "contract-scan", "inspection-analyze" markeras automatiserade.
UPDATE "AiUsageLog" SET "isAutomated" = true, "source" = "endpoint"
WHERE "endpoint" IN ('daily-insights', 'tenant-chat', 'contract-scan', 'inspection-analyze');

UPDATE "AiUsageLog" SET "source" = 'manual_chat'
WHERE "endpoint" IN ('chat', 'stream') AND "source" IS NULL;

CREATE INDEX "AiUsageLog_organizationId_isAutomated_createdAt_idx"
  ON "AiUsageLog"("organizationId", "isAutomated", "createdAt");
