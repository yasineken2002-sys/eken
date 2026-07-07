-- PSD2 P2 — bankkoppling (samtycke + sync). Allt inert bakom PSD2_ENABLED.
-- BankConsent: ett samtycke per bankkoppling, access/refresh-tokens app-layer-
-- krypterade (kolumnerna innehåller ENDAST chiffertext, aldrig klartext).
-- Psd2ConsentState: efemär single-use CSRF-bindning för consent-redirecten.

-- CreateEnum
CREATE TYPE "BankConsentStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'REVOKED', 'ERROR');

-- CreateTable
CREATE TABLE "BankConsent" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "consentId" TEXT NOT NULL,
    "status" "BankConsentStatus" NOT NULL DEFAULT 'ACTIVE',
    "accessTokenEnc" TEXT NOT NULL,
    "refreshTokenEnc" TEXT,
    "scope" TEXT,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "lastSyncedAt" TIMESTAMP(3),
    "syncCursor" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BankConsent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Psd2ConsentState" (
    "id" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "initiatedByUserId" TEXT,
    "consumedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Psd2ConsentState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BankConsent_organizationId_idx" ON "BankConsent"("organizationId");

-- CreateIndex
CREATE INDEX "BankConsent_status_idx" ON "BankConsent"("status");

-- CreateIndex
CREATE UNIQUE INDEX "BankConsent_organizationId_provider_consentId_key" ON "BankConsent"("organizationId", "provider", "consentId");

-- CreateIndex
CREATE UNIQUE INDEX "Psd2ConsentState_state_key" ON "Psd2ConsentState"("state");

-- CreateIndex
CREATE INDEX "Psd2ConsentState_organizationId_idx" ON "Psd2ConsentState"("organizationId");

-- CreateIndex
CREATE INDEX "Psd2ConsentState_expiresAt_idx" ON "Psd2ConsentState"("expiresAt");

-- AddForeignKey
ALTER TABLE "BankConsent" ADD CONSTRAINT "BankConsent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
