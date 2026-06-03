-- IMD · PR 1 — Datamodell för förbrukningsdebitering (el/vatten/värme)
--
-- Ren persistens. Fyra entiteter (Meter, MeterReading, ConsumptionTariff,
-- ConsumptionCharge) + leverans-skelett (RentNoticeLine, RentNotice.consumption-
-- Amount) + konfiguration (Property/Lease.consumptionBillingMode). Inget läses
-- eller skrivs ännu; intake (PR 2), bokföring (PR 3), leveranssätt (PR 4) och
-- bokslut (PR 5) bygger ovanpå.
--
-- Mätunderlag (MeterReading) och debiterbara poster (ConsumptionCharge) är
-- räkenskapsinformation (BFL 1999:1078) → onDelete: Restrict, append-only.
--
-- Sist i migrationen: backfill av BAS-konton 3970 (vattenersättning) och 1790
-- (upplupna intäkter) för befintliga organisationer. Nya orgs får dem via
-- basChartFor (bas-chart.ts).

-- CreateEnum
CREATE TYPE "MeterType" AS ENUM ('ELECTRICITY', 'WATER_COLD', 'WATER_HOT', 'HEATING');

-- CreateEnum
CREATE TYPE "MeterStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'REMOVED');

-- CreateEnum
CREATE TYPE "ReadingSource" AS ENUM ('MANUAL', 'IMPORT', 'API');

-- CreateEnum
CREATE TYPE "ReadingType" AS ENUM ('CUMULATIVE', 'PERIOD_VOLUME');

-- CreateEnum
CREATE TYPE "ConsumptionChargeStatus" AS ENUM ('DRAFT', 'CONFIRMED', 'ATTACHED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ConsumptionChargeKind" AS ENUM ('ACTUAL', 'ESTIMATE', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "ConsumptionVatStatus" AS ENUM ('EXEMPT', 'TAXABLE_25');

-- CreateEnum
CREATE TYPE "ConsumptionBillingMode" AS ENUM ('RENT_NOTICE_LINE', 'SEPARATE_INVOICE', 'NONE');

-- CreateEnum
CREATE TYPE "TariffScope" AS ENUM ('ORGANIZATION', 'PROPERTY', 'UNIT');

-- AlterTable
ALTER TABLE "Lease" ADD COLUMN     "consumptionBillingMode" "ConsumptionBillingMode";

-- AlterTable
ALTER TABLE "Property" ADD COLUMN     "consumptionBillingMode" "ConsumptionBillingMode" NOT NULL DEFAULT 'RENT_NOTICE_LINE';

-- AlterTable
ALTER TABLE "RentNotice" ADD COLUMN     "consumptionAmount" DECIMAL(10,2) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "RentNoticeLine" (
    "id" TEXT NOT NULL,
    "rentNoticeId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(10,4) NOT NULL,
    "unitPrice" DECIMAL(10,2) NOT NULL,
    "vatRate" INTEGER NOT NULL DEFAULT 0,
    "total" DECIMAL(10,2) NOT NULL,
    "consumptionChargeId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RentNoticeLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Meter" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "type" "MeterType" NOT NULL,
    "unitOfMeasure" TEXT NOT NULL,
    "serialNumber" TEXT,
    "status" "MeterStatus" NOT NULL DEFAULT 'ACTIVE',
    "provider" TEXT,
    "externalId" TEXT,
    "installedAt" TIMESTAMP(3),
    "removedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Meter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MeterReading" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "meterId" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "leaseId" TEXT,
    "value" DECIMAL(14,3) NOT NULL,
    "readingType" "ReadingType" NOT NULL DEFAULT 'CUMULATIVE',
    "readingDate" TIMESTAMP(3) NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "source" "ReadingSource" NOT NULL,
    "externalId" TEXT,
    "registeredById" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MeterReading_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConsumptionTariff" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "scope" "TariffScope" NOT NULL DEFAULT 'ORGANIZATION',
    "propertyId" TEXT,
    "unitId" TEXT,
    "meterType" "MeterType" NOT NULL,
    "pricePerUnit" DECIMAL(10,4) NOT NULL,
    "fixedMonthlyFee" DECIMAL(10,2),
    "validFrom" DATE NOT NULL,
    "validTo" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConsumptionTariff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConsumptionCharge" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "leaseId" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "meterReadingId" TEXT NOT NULL,
    "meterType" "MeterType" NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "pricePerUnit" DECIMAL(10,4) NOT NULL,
    "netAmount" DECIMAL(10,2) NOT NULL,
    "vatStatus" "ConsumptionVatStatus" NOT NULL DEFAULT 'EXEMPT',
    "vatRate" INTEGER NOT NULL DEFAULT 0,
    "vatAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "totalAmount" DECIMAL(10,2) NOT NULL,
    "kind" "ConsumptionChargeKind" NOT NULL DEFAULT 'ACTUAL',
    "status" "ConsumptionChargeStatus" NOT NULL DEFAULT 'DRAFT',
    "deliveryMode" "ConsumptionBillingMode" NOT NULL DEFAULT 'RENT_NOTICE_LINE',
    "invoiceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConsumptionCharge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RentNoticeLine_consumptionChargeId_key" ON "RentNoticeLine"("consumptionChargeId");

-- CreateIndex
CREATE INDEX "RentNoticeLine_rentNoticeId_idx" ON "RentNoticeLine"("rentNoticeId");

-- CreateIndex
CREATE INDEX "Meter_organizationId_idx" ON "Meter"("organizationId");

-- CreateIndex
CREATE INDEX "Meter_unitId_idx" ON "Meter"("unitId");

-- CreateIndex
CREATE INDEX "Meter_status_idx" ON "Meter"("status");

-- CreateIndex
CREATE INDEX "MeterReading_organizationId_idx" ON "MeterReading"("organizationId");

-- CreateIndex
CREATE INDEX "MeterReading_meterId_idx" ON "MeterReading"("meterId");

-- CreateIndex
CREATE INDEX "MeterReading_periodEnd_idx" ON "MeterReading"("periodEnd");

-- CreateIndex
CREATE UNIQUE INDEX "MeterReading_meterId_externalId_key" ON "MeterReading"("meterId", "externalId");

-- CreateIndex
CREATE INDEX "ConsumptionTariff_organizationId_idx" ON "ConsumptionTariff"("organizationId");

-- CreateIndex
CREATE INDEX "ConsumptionTariff_meterType_idx" ON "ConsumptionTariff"("meterType");

-- CreateIndex
CREATE INDEX "ConsumptionTariff_scope_idx" ON "ConsumptionTariff"("scope");

-- CreateIndex
CREATE INDEX "ConsumptionCharge_organizationId_idx" ON "ConsumptionCharge"("organizationId");

-- CreateIndex
CREATE INDEX "ConsumptionCharge_leaseId_idx" ON "ConsumptionCharge"("leaseId");

-- CreateIndex
CREATE INDEX "ConsumptionCharge_status_idx" ON "ConsumptionCharge"("status");

-- CreateIndex
CREATE INDEX "ConsumptionCharge_periodEnd_idx" ON "ConsumptionCharge"("periodEnd");

-- AddForeignKey
ALTER TABLE "RentNoticeLine" ADD CONSTRAINT "RentNoticeLine_rentNoticeId_fkey" FOREIGN KEY ("rentNoticeId") REFERENCES "RentNotice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RentNoticeLine" ADD CONSTRAINT "RentNoticeLine_consumptionChargeId_fkey" FOREIGN KEY ("consumptionChargeId") REFERENCES "ConsumptionCharge"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Meter" ADD CONSTRAINT "Meter_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Meter" ADD CONSTRAINT "Meter_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeterReading" ADD CONSTRAINT "MeterReading_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeterReading" ADD CONSTRAINT "MeterReading_meterId_fkey" FOREIGN KEY ("meterId") REFERENCES "Meter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsumptionTariff" ADD CONSTRAINT "ConsumptionTariff_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsumptionCharge" ADD CONSTRAINT "ConsumptionCharge_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsumptionCharge" ADD CONSTRAINT "ConsumptionCharge_leaseId_fkey" FOREIGN KEY ("leaseId") REFERENCES "Lease"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsumptionCharge" ADD CONSTRAINT "ConsumptionCharge_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsumptionCharge" ADD CONSTRAINT "ConsumptionCharge_meterReadingId_fkey" FOREIGN KEY ("meterReadingId") REFERENCES "MeterReading"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsumptionCharge" ADD CONSTRAINT "ConsumptionCharge_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ── Backfill: BAS-konton för IMD (befintliga organisationer) ─────────────────
-- 3970 Hyresgästers vattenersättning (bruttoredovisning, skild från 3920 el/värme).
-- 1790 Upplupna intäkter (bokslutspost för levererad men ofakturerad förbrukning).
-- Samma idempotenta mönster som FIX 9 PR 1 (bas_chart_fastighet_accounts).
INSERT INTO "Account" (id, "organizationId", number, name, type, "isActive")
SELECT gen_random_uuid(), o.id, v.number, v.name, v.type::"AccountType", true
FROM "Organization" o
CROSS JOIN (VALUES
  (3970, 'Hyresgästers vattenersättning', 'REVENUE'),
  (1790, 'Övriga förutbetalda kostnader och upplupna intäkter', 'ASSET')
) AS v(number, name, type)
-- Bara organisationer som redan har en kontoplan.
WHERE EXISTS (SELECT 1 FROM "Account" a WHERE a."organizationId" = o.id)
  -- Idempotent: hoppa över konton som redan finns (unikt per org + nummer).
  AND NOT EXISTS (
    SELECT 1 FROM "Account" a2
    WHERE a2."organizationId" = o.id AND a2.number = v.number
  );
