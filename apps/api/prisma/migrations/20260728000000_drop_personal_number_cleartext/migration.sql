-- Contract-fasen av personnummer-krypteringen (expand → migrate → contract).
--
-- Expand-migrationen (20260727190000) la till personalNumberEnc/Hash och
-- src/scripts/backfill-personal-numbers.ts krypterade befintliga rader. Den här
-- migrationen tar bort klartextkolumnen.
--
-- Handskriven med flit: `prisma migrate diff` drar in orelaterade DROP INDEX på
-- skarpa HNSW-vektorindex.
--
-- GRINDEN NEDAN ÄR POÄNGEN. DROP COLUMN är oåterkalleligt, så migrationen vägrar
-- köra om det finns klartext kvar att förlora — hellre en stoppad deploy än ett
-- tyst dataförlust. Situationen uppstår bara i en databas där backfillen aldrig
-- kördes; åtgärden står i felmeddelandet.

DO $$
DECLARE
  tenant_rows  BIGINT;
  cust_rows    BIGINT;
BEGIN
  SELECT count(*) INTO tenant_rows FROM "Tenant"   WHERE "personalNumber" IS NOT NULL;
  SELECT count(*) INTO cust_rows   FROM "Customer" WHERE "personalNumber" IS NOT NULL;

  IF tenant_rows > 0 OR cust_rows > 0 THEN
    RAISE EXCEPTION
      'Avbryter: % Tenant- och % Customer-rader har personnummer kvar i klartext. '
      'DROP COLUMN hade raderat dem permanent. Kör backfillen först (checka ut '
      'commit 0247456, kör dist/scripts/backfill-personal-numbers.js med '
      'SIGNING_PII_KEY/SIGNING_PII_PEPPER satta) och deploya sedan om.',
      tenant_rows, cust_rows;
  END IF;
END $$;

ALTER TABLE "Tenant"   DROP COLUMN "personalNumber";
ALTER TABLE "Customer" DROP COLUMN "personalNumber";
