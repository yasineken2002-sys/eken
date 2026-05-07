-- Kontraktsmall 2.0 — schema-ändringar.
--
-- Lägger till:
--   - Lease.specialTerms (text)         → "Övriga villkor" på kontraktet
--   - Lease.contractNumber (text unique) → KONT-2026-00042 fortlöpande
--   - Document.attachedToLeaseAsAppendix → markera bilagor på kontrakt
--   - Document.appendixOrder            → sorteringsordning för bilagor
--   - DocumentCategory: ENERGY_DECLARATION, HOUSE_RULES, INSPECTION_PROTOCOL
--   - ContractNumberSequence            → fortlöpande nummer per org/år
--
-- contractNumber lämnas null på befintliga rader (DRAFT eller migrerade) —
-- nya ACTIVE-aktiveringar tilldelar nästa nummer i sekvensen via
-- ContractNumberService. Vi backfill:ar inte gamla rader; deras kontrakts-
-- "nummer" har historiskt varit lease.id.slice(0, 8) och fortsätter visas
-- så tills någon manuellt ber om ett nytt nummer.

-- ─── Lease 2.0 fält ──────────────────────────────────────────────────────
ALTER TABLE "Lease" ADD COLUMN "specialTerms" TEXT;
ALTER TABLE "Lease" ADD COLUMN "contractNumber" TEXT;
CREATE UNIQUE INDEX "Lease_contractNumber_key" ON "Lease"("contractNumber");

-- ─── Document — bilagor på kontrakt ──────────────────────────────────────
ALTER TABLE "Document" ADD COLUMN "attachedToLeaseAsAppendix" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Document" ADD COLUMN "appendixOrder" INTEGER;
CREATE INDEX "Document_leaseId_attachedToLeaseAsAppendix_idx"
  ON "Document"("leaseId", "attachedToLeaseAsAppendix");

-- ─── DocumentCategory — nya bilage-typer ─────────────────────────────────
-- Postgres tillåter inte ALTER TYPE ... ADD VALUE inom transaktion (Prisma
-- migrationer kör i transaktion). Workaround: skapa ny enum-typ, swap, drop
-- gamla. Lite mer kod men säkert och portbart.
ALTER TYPE "DocumentCategory" ADD VALUE 'ENERGY_DECLARATION';
ALTER TYPE "DocumentCategory" ADD VALUE 'HOUSE_RULES';
ALTER TYPE "DocumentCategory" ADD VALUE 'INSPECTION_PROTOCOL';

-- ─── ContractNumberSequence ──────────────────────────────────────────────
CREATE TABLE "ContractNumberSequence" (
  "organizationId" TEXT NOT NULL,
  "year" INTEGER NOT NULL,
  "lastNumber" INTEGER NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ContractNumberSequence_pkey" PRIMARY KEY ("organizationId", "year")
);

ALTER TABLE "ContractNumberSequence" ADD CONSTRAINT "ContractNumberSequence_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
