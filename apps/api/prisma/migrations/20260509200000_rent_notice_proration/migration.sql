-- Hyresavi-flöde enligt 12 kap. 20 § JB: hyran betalas i FÖRSKOTT, sista
-- vardagen i månaden FÖRE den hyresperiod avin avser. För in-/utflyttnings-
-- månader proportioneras beloppet enligt faktiskt antal dagar.
--
-- Denna migration:
--  1. Inför RentNoticeType-enum (RENT vs DEPOSIT)
--  2. Lägger periodfält + dagsräkning på RentNotice
--  3. Byter idempotency-nyckel från (org,tenant,month,year) till
--     (lease,year,month,type) — för en tenant kan ha flera kontrakt och
--     samma månad kan innehålla både en RENT- och en DEPOSIT-avi.
--  4. Lägger daysBeforeMoveInForFirstPayment på Organization (default 7).

-- ── 1. Enum för avi-typ ──────────────────────────────────────────────────────
CREATE TYPE "RentNoticeType" AS ENUM ('RENT', 'DEPOSIT');

-- ── 2. Nya kolumner på RentNotice ───────────────────────────────────────────
ALTER TABLE "RentNotice"
  ADD COLUMN "type" "RentNoticeType" NOT NULL DEFAULT 'RENT',
  ADD COLUMN "periodStart" DATE,
  ADD COLUMN "periodEnd" DATE,
  ADD COLUMN "daysCharged" INTEGER,
  ADD COLUMN "totalDays" INTEGER,
  ADD COLUMN "isProrated" BOOLEAN NOT NULL DEFAULT false;

-- ── 3. Idempotency-byte ─────────────────────────────────────────────────────
DROP INDEX "RentNotice_organizationId_tenantId_month_year_key";

CREATE UNIQUE INDEX "RentNotice_leaseId_year_month_type_key"
  ON "RentNotice" ("leaseId", "year", "month", "type");

CREATE INDEX "RentNotice_leaseId_idx" ON "RentNotice" ("leaseId");

-- ── 4. Organization-inställning ─────────────────────────────────────────────
ALTER TABLE "Organization"
  ADD COLUMN "daysBeforeMoveInForFirstPayment" INTEGER NOT NULL DEFAULT 7;
