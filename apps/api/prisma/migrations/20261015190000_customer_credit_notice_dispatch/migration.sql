-- Additiv: befintliga aviutskick och påminnelser behåller null i alla nya fält.
-- Ingen kundpolicy aktiveras och inga gamla ekonomiska uppgifter fylls i.
ALTER TABLE "RentNoticeSend"
  ADD COLUMN "dispatchKey" TEXT,
  ADD COLUMN "snapshotVersion" INTEGER,
  ADD COLUMN "snapshot" JSONB,
  ADD COLUMN "customerCreditAmount" DECIMAL(10,2),
  ADD COLUMN "payableAmount" DECIMAL(10,2),
  ADD COLUMN "preparedAt" TIMESTAMP(3),
  ADD COLUMN "mailPayload" JSONB,
  ADD COLUMN "queuedAt" TIMESTAMP(3),
  ADD COLUMN "dispatchStartedAt" TIMESTAMP(3),
  ADD COLUMN "acceptedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "RentNoticeSend_dispatchKey_key" ON "RentNoticeSend"("dispatchKey");

ALTER TABLE "RentNoticeSend" ADD CONSTRAINT "customer_credit_notice_dispatch_shape" CHECK (
  (
    "dispatchKey" IS NULL AND "snapshotVersion" IS NULL AND "snapshot" IS NULL
    AND "customerCreditAmount" IS NULL AND "payableAmount" IS NULL AND "preparedAt" IS NULL
    AND "mailPayload" IS NULL AND "queuedAt" IS NULL
    AND "dispatchStartedAt" IS NULL AND "acceptedAt" IS NULL
  ) OR (
    "dispatchKey" IS NOT NULL AND "kind" = 'NOTICE'
    AND "dispatchKey" = 'customer-credit-notice:' || "rentNoticeId"
    AND "snapshotVersion" IS NOT NULL AND "snapshotVersion" = 1
    AND "snapshot" IS NOT NULL AND jsonb_typeof("snapshot") = 'object'
    AND "customerCreditAmount" IS NOT NULL AND "customerCreditAmount" >= 0
    AND "payableAmount" IS NOT NULL AND "payableAmount" >= 0
    AND "customerCreditAmount" + "payableAmount" > 0
    AND "preparedAt" IS NOT NULL
    AND "toHash" IS NOT NULL AND "toHash" ~ '^[a-f0-9]{64}$'
    AND ("mailPayload" IS NULL OR jsonb_typeof("mailPayload") = 'object')
    AND ("queuedAt" IS NULL OR ("mailPayload" IS NOT NULL AND "queuedAt" >= "preparedAt"))
    AND ("dispatchStartedAt" IS NULL OR ("mailPayload" IS NOT NULL AND "dispatchStartedAt" >= "preparedAt"))
    AND ("acceptedAt" IS NULL OR (
      "dispatchStartedAt" IS NOT NULL AND "messageId" IS NOT NULL
      AND "acceptedAt" >= "dispatchStartedAt"
    ))
  )
);

-- Dokumentet är bokföringens sparade underlag. Leveransfälten sätts senare,
-- men samma id får aldrig börja bära ett annat belopp, dokument eller mejl.
CREATE FUNCTION customer_credit_notice_dispatch_guard() RETURNS trigger AS $$
BEGIN
  IF OLD."dispatchKey" IS NULL THEN
    IF NEW."dispatchKey" IS NOT NULL THEN
      RAISE EXCEPTION 'CUSTOMER_CREDIT_DISPATCH_MUST_BE_CREATED_ATOMICALLY' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW."rentNoticeId" IS DISTINCT FROM OLD."rentNoticeId"
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW."dispatchKey" IS DISTINCT FROM OLD."dispatchKey"
     OR NEW."snapshotVersion" IS DISTINCT FROM OLD."snapshotVersion"
     OR NEW.snapshot IS DISTINCT FROM OLD.snapshot
     OR NEW."customerCreditAmount" IS DISTINCT FROM OLD."customerCreditAmount"
     OR NEW."payableAmount" IS DISTINCT FROM OLD."payableAmount"
     OR NEW."preparedAt" IS DISTINCT FROM OLD."preparedAt"
     OR NEW."toHash" IS DISTINCT FROM OLD."toHash"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'CUSTOMER_CREDIT_DISPATCH_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF (OLD."mailPayload" IS NOT NULL AND NEW."mailPayload" IS DISTINCT FROM OLD."mailPayload")
     OR (OLD."jobId" IS NOT NULL AND NEW."jobId" IS DISTINCT FROM OLD."jobId")
     OR (OLD."messageId" IS NOT NULL AND NEW."messageId" IS DISTINCT FROM OLD."messageId")
     OR (OLD."queuedAt" IS NOT NULL AND NEW."queuedAt" IS DISTINCT FROM OLD."queuedAt")
     OR (OLD."dispatchStartedAt" IS NOT NULL AND NEW."dispatchStartedAt" IS DISTINCT FROM OLD."dispatchStartedAt")
     OR (OLD."acceptedAt" IS NOT NULL AND NEW."acceptedAt" IS DISTINCT FROM OLD."acceptedAt") THEN
    RAISE EXCEPTION 'CUSTOMER_CREDIT_DISPATCH_ACK_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER customer_credit_notice_dispatch_immutable
  BEFORE UPDATE ON "RentNoticeSend"
  FOR EACH ROW EXECUTE FUNCTION customer_credit_notice_dispatch_guard();

-- En alternativ framtida skrivväg får inte ändra tillgodot efter reservation.
-- Applikationens avilås samordnar detta med prepareNoticeForSend. Radlåset här
-- gör skyddet bindande även för en SQL-insättning utan servicens låsning.
CREATE FUNCTION customer_credit_application_dispatch_guard() RETURNS trigger AS $$
BEGIN
  PERFORM id FROM "RentNotice" WHERE id = NEW."rentNoticeId" FOR UPDATE;
  IF EXISTS (
    SELECT 1 FROM "RentNoticeSend"
    WHERE "rentNoticeId" = NEW."rentNoticeId" AND "dispatchKey" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'CUSTOMER_CREDIT_NOTICE_ALREADY_PREPARED' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER customer_credit_application_00_dispatch
  BEFORE INSERT ON "CustomerCreditApplication"
  FOR EACH ROW EXECUTE FUNCTION customer_credit_application_dispatch_guard();
