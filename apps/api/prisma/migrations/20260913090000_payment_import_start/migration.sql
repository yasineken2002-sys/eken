BEGIN;
ALTER TABLE "Organization" ADD COLUMN "paymentImportStartedAt" TIMESTAMP(3);

-- Endast dokumenterade försök. Ospårade gamla CSV/BgMax-fel fabriceras inte.
UPDATE "Organization" o
SET "paymentImportStartedAt" = h.started
FROM (
  SELECT "organizationId", MIN("uploadedAt") AS started
  FROM "BankStatementImport" GROUP BY "organizationId"
) h WHERE o.id = h."organizationId";

CREATE FUNCTION payment_import_started_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."paymentImportStartedAt" IS NOT NULL
     AND NEW."paymentImportStartedAt" IS DISTINCT FROM OLD."paymentImportStartedAt" THEN
    RAISE EXCEPTION 'PAYMENT_IMPORT_START_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER payment_import_started_immutable
BEFORE UPDATE OF "paymentImportStartedAt" ON "Organization"
FOR EACH ROW EXECUTE FUNCTION payment_import_started_immutable();
COMMIT;
