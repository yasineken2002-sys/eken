-- HUVUDBOK-STEG1 (154): beständigt huvudboksval per organisation.
-- ADDITIV: ny enum + nullbara kolumner + NOT NULL med standard EVENO. Ingen befintlig
-- rad får annat värde än EVENO; ingen organisation blir FORTNOX av migrationen, oavsett
-- Fortnox-anslutning eller kundaktivering. Ingen datatransformation.

CREATE TYPE "LedgerOwner" AS ENUM ('EVENO', 'FORTNOX');

ALTER TABLE "Organization"
  ADD COLUMN "ledgerOwner" "LedgerOwner" NOT NULL DEFAULT 'EVENO',
  ADD COLUMN "ledgerOwnerActivationId" TEXT,
  ADD COLUMN "ledgerOwnerFortnoxDatabaseNumber" INTEGER,
  ADD COLUMN "ledgerOwnerFortnoxOrgNumber" TEXT,
  ADD COLUMN "ledgerOwnerSetAt" TIMESTAMP(3),
  ADD COLUMN "ledgerOwnerSetById" TEXT;

-- FORTNOX kräver hela bindningen; EVENO bär ingen.
ALTER TABLE "Organization" ADD CONSTRAINT "Organization_ledgerOwner_bindning_check" CHECK (
  "ledgerOwner" = 'EVENO'
  OR (
    "ledgerOwnerActivationId" IS NOT NULL
    AND "ledgerOwnerFortnoxDatabaseNumber" IS NOT NULL
    AND "ledgerOwnerFortnoxOrgNumber" IS NOT NULL
    AND "ledgerOwnerSetAt" IS NOT NULL
    AND "ledgerOwnerSetById" IS NOT NULL
  )
);

-- NO ACTION: prövas vid satsens slut, så organisationsradering (kaskad till aktiveringarna)
-- fungerar; en fristående radering av ägarbeslutets aktiveringsrad nekas.
ALTER TABLE "Organization" ADD CONSTRAINT "Organization_ledgerOwnerActivationId_fkey"
  FOREIGN KEY ("ledgerOwnerActivationId") REFERENCES "FortnoxCustomerActivation"("id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;
