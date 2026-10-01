-- Fortnox A (2026-10-01): anslutning, OAuth-state, dimensionsmappning, återläsning, exportkö.
-- Endast tillägg. Inga ändringar av befintliga tabeller utöver nya FK mot Organization/Property/JournalEntry.

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateEnum
CREATE TYPE "FortnoxConnectionStatus" AS ENUM ('ACTIVE', 'AUTH_LOST', 'DISCONNECTED');

-- CreateEnum
CREATE TYPE "FortnoxDimensionType" AS ENUM ('COST_CENTER', 'PROJECT');

-- CreateEnum
CREATE TYPE "FortnoxReadStatus" AS ENUM ('RUNNING', 'COMPLETE', 'COMPLETE_WITH_UNCERTAINTY', 'PARTIAL', 'FAILED', 'AUTH_LOST', 'WRONG_COMPANY');

-- CreateEnum
CREATE TYPE "FortnoxExportState" AS ENUM ('DRY_RUN_READY', 'BLOCKED', 'UNKNOWN', 'CONFIRMED');

-- CreateTable
CREATE TABLE "FortnoxConnection" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "status" "FortnoxConnectionStatus" NOT NULL DEFAULT 'ACTIVE',
    "fortnoxDatabaseNumber" INTEGER NOT NULL,
    "fortnoxOrgNumber" TEXT,
    "fortnoxCompanyName" TEXT,
    "scope" TEXT,
    "accessTokenEnc" TEXT NOT NULL DEFAULT '',
    "refreshTokenEnc" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "tokenVersion" INTEGER NOT NULL DEFAULT 0,
    "refreshLeaseUntil" TIMESTAMP(3),
    "refreshAttemptId" TEXT,
    "generation" INTEGER NOT NULL DEFAULT 0,
    "exportVoucherSeries" TEXT,
    "exportOmitDimensionsAt" TIMESTAMP(3),
    "exportOmitDimensionsBy" TEXT,
    "lastErrorClass" TEXT,
    "lastErrorAt" TIMESTAMP(3),
    "connectedByUserId" TEXT,
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "disconnectedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FortnoxConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FortnoxOAuthState" (
    "id" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "initiatedByUserId" TEXT NOT NULL,
    "codeVerifierEnc" TEXT NOT NULL,
    "expectedGeneration" INTEGER,
    "consumedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FortnoxOAuthState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FortnoxDimensionMapping" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "dimensionType" "FortnoxDimensionType" NOT NULL,
    "code" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FortnoxDimensionMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FortnoxReadRun" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "fortnoxDatabaseNumber" INTEGER NOT NULL,
    "status" "FortnoxReadStatus" NOT NULL DEFAULT 'RUNNING',
    "financialYearId" INTEGER NOT NULL,
    "financialYearStart" DATE,
    "financialYearEnd" DATE,
    "periodFrom" DATE NOT NULL,
    "periodTo" DATE NOT NULL,
    "costAccounts" INTEGER[],
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "summary" JSONB,
    "rows" JSONB,
    "coverage" JSONB NOT NULL DEFAULT '{}',
    "uncertainties" JSONB NOT NULL DEFAULT '[]',
    "reason" TEXT,
    "triggeredByUserId" TEXT,

    CONSTRAINT "FortnoxReadRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FortnoxVoucherExport" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "journalEntryId" TEXT NOT NULL,
    "state" "FortnoxExportState" NOT NULL,
    "draft" JSONB,
    "draftHash" TEXT,
    "blockReason" TEXT,
    "fortnoxDatabaseNumber" INTEGER,
    "externalSeries" TEXT,
    "externalNumber" INTEGER,
    "externalYear" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FortnoxVoucherExport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FortnoxConnection_organizationId_key" ON "FortnoxConnection"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "FortnoxOAuthState_state_key" ON "FortnoxOAuthState"("state");

-- CreateIndex
CREATE INDEX "FortnoxOAuthState_organizationId_idx" ON "FortnoxOAuthState"("organizationId");

-- CreateIndex
CREATE INDEX "FortnoxOAuthState_expiresAt_idx" ON "FortnoxOAuthState"("expiresAt");

-- CreateIndex
CREATE INDEX "FortnoxDimensionMapping_propertyId_idx" ON "FortnoxDimensionMapping"("propertyId");

-- CreateIndex
CREATE UNIQUE INDEX "FortnoxDimensionMapping_organizationId_dimensionType_code_key" ON "FortnoxDimensionMapping"("organizationId", "dimensionType", "code");

-- CreateIndex
CREATE INDEX "FortnoxReadRun_organizationId_startedAt_idx" ON "FortnoxReadRun"("organizationId", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "FortnoxVoucherExport_journalEntryId_key" ON "FortnoxVoucherExport"("journalEntryId");

-- CreateIndex
CREATE INDEX "FortnoxVoucherExport_organizationId_state_idx" ON "FortnoxVoucherExport"("organizationId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "FortnoxVoucherExport_organizationId_journalEntryId_key" ON "FortnoxVoucherExport"("organizationId", "journalEntryId");

-- AddForeignKey
ALTER TABLE "FortnoxConnection" ADD CONSTRAINT "FortnoxConnection_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FortnoxOAuthState" ADD CONSTRAINT "FortnoxOAuthState_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FortnoxDimensionMapping" ADD CONSTRAINT "FortnoxDimensionMapping_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FortnoxDimensionMapping" ADD CONSTRAINT "FortnoxDimensionMapping_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FortnoxReadRun" ADD CONSTRAINT "FortnoxReadRun_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FortnoxVoucherExport" ADD CONSTRAINT "FortnoxVoucherExport_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FortnoxVoucherExport" ADD CONSTRAINT "FortnoxVoucherExport_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "JournalEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

