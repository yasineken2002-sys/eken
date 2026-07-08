-- #69/#50 — regelverk för uppsägningstider (privatuthyrningslagen vs hyreslagen).

-- CreateEnum
CREATE TYPE "TenancyRegime" AS ENUM ('PRIVATE_RENTAL', 'TENANCY_ACT');

-- AlterTable: ny kolumn, default = hyreslagen (JB 12 kap) för ALLA rader.
-- Privatuthyrningslagen (2012:978) gäller bara uthyrning av egen bostad utanför
-- näringsverksamhet (§ 1) och kan inte härledas från enhetstyp — Evenos kundbas
-- är näringsidkare. PRIVATE_RENTAL sätts därför BARA som medvetet opt-in per
-- kontrakt (create-vägen), aldrig via backfill. Default TENANCY_ACT kan aldrig
-- ge en ogiltig (för kort) uppsägning; en ev. felklassning ger bara överskydd.
-- (Hyresjurist + användarbeslut 2026-07-08.)
ALTER TABLE "Lease" ADD COLUMN "tenancyRegime" "TenancyRegime" NOT NULL DEFAULT 'TENANCY_ACT';
