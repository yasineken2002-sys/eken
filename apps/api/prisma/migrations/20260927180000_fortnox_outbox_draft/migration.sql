-- Fortnox skiva 01 — DRAFT, OANSLUTEN. Beständig utkorg.
--
-- ADDITIV. Tre nya enum-typer, en ny tabell, två index, ett unikt villkor och en
-- främmande nyckel. Ingen befintlig tabell, kolumn eller rad rörs, ingen backfill.
--
-- FÅR INTE MERGAS till main utan separat beslut: Railway kör `prisma migrate
-- deploy` vid varje push till main (checkSuites av), så en merge vore en
-- produktionsmigration. I skiva 01 prövas den bara i egen syntetisk DB och i
-- draft-PR:ens CI.
--
-- Ingenting i dagens kod skriver eller läser tabellen.

-- CreateEnum
CREATE TYPE "FortnoxEventType" AS ENUM ('RENT_NOTICE', 'RENT_PAYMENT', 'RENT_CREDIT');

-- CreateEnum
CREATE TYPE "FortnoxOperation" AS ENUM ('INVOICE_CREATE', 'INVOICE_BOOKKEEP', 'PAYMENT_CREATE', 'PAYMENT_BOOKKEEP', 'CREDIT_CREATE', 'CREDIT_BOOKKEEP');

-- CreateEnum
CREATE TYPE "FortnoxOutboxState" AS ENUM ('READY', 'SENDING', 'RETRY_WAIT', 'ACKNOWLEDGED', 'UNKNOWN', 'AUTH_REQUIRED', 'REJECTED', 'MANUAL_REVIEW');

-- CreateTable
CREATE TABLE "FortnoxOutboxEntry" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "fortnoxTenantId" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "eventType" "FortnoxEventType" NOT NULL,
    "sourceId" TEXT NOT NULL,
    "immutableVersion" INTEGER NOT NULL,
    "operation" "FortnoxOperation" NOT NULL,
    "dependsOnEventKey" TEXT,
    "payload" JSONB NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "state" "FortnoxOutboxState" NOT NULL DEFAULT 'READY',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attemptToken" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "externalId" TEXT,
    "bookedConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "lastErrorClass" TEXT,
    "lastErrorAt" TIMESTAMP(3),
    "lastLookupAt" TIMESTAMP(3),
    "acknowledgedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FortnoxOutboxEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FortnoxOutboxEntry_organizationId_connectionId_state_nextAt_idx" ON "FortnoxOutboxEntry"("organizationId", "connectionId", "state", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "FortnoxOutboxEntry_organizationId_externalId_idx" ON "FortnoxOutboxEntry"("organizationId", "externalId");

-- Dubblettskyddet. Båda kolumnerna NOT NULL — två NULL hade varit distinkta.
-- CreateIndex
CREATE UNIQUE INDEX "FortnoxOutboxEntry_organizationId_eventKey_key" ON "FortnoxOutboxEntry"("organizationId", "eventKey");

-- Restrict: raden kan vara enda lokala spåret av en extern ekonomisk effekt.
-- AddForeignKey
ALTER TABLE "FortnoxOutboxEntry" ADD CONSTRAINT "FortnoxOutboxEntry_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
