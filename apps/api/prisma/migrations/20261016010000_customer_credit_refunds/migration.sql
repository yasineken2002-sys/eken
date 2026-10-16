-- Ingen policy aktiveras. Återbetalning kräver ett uttryckligt bokföringskonto.
ALTER TABLE "CustomerCreditPolicy"
  ADD COLUMN "refundEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "refundBankLedgerAccountId" TEXT;
ALTER TABLE "CustomerCreditPolicy" ADD CONSTRAINT "CustomerCreditPolicy_refundBankLedgerAccountId_fkey"
  FOREIGN KEY ("refundBankLedgerAccountId") REFERENCES "Account"(id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CustomerCreditPolicy" ADD CONSTRAINT "customer_credit_refund_policy_mapping"
  CHECK (NOT "refundEnabled" OR "refundBankLedgerAccountId" IS NOT NULL);

CREATE TYPE "CustomerCreditRefundState" AS ENUM
  ('RESERVED', 'SUBMITTING', 'UNKNOWN', 'BANK_CONFIRMED', 'SETTLED', 'REJECTED', 'CANCELLED');

CREATE TABLE "CustomerCreditRefund" (
  id TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "creditId" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "leaseId" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  amount DECIMAL(10,2) NOT NULL,
  currency TEXT NOT NULL DEFAULT 'SEK',
  "liabilityAccountId" TEXT NOT NULL,
  "bankAccountId" TEXT NOT NULL,
  "bankLedgerAccountId" TEXT NOT NULL,
  provider TEXT NOT NULL,
  "providerAccountRef" TEXT NOT NULL,
  "recipientRef" TEXT NOT NULL,
  "recipientProofHash" TEXT NOT NULL,
  "recipientVerifiedAt" TIMESTAMP(3) NOT NULL,
  "recipientValidUntil" TIMESTAMP(3) NOT NULL,
  "instructionHash" TEXT NOT NULL,
  state "CustomerCreditRefundState" NOT NULL DEFAULT 'RESERVED',
  "preparedAt" TIMESTAMP(3) NOT NULL,
  "submissionStartedAt" TIMESTAMP(3),
  "providerTransferId" TEXT,
  "bankProofKey" TEXT,
  "bankProofHash" TEXT,
  "bankEvidence" JSONB,
  "bankConfirmedAt" TIMESTAMP(3),
  "bankBookedAt" TIMESTAMP(3),
  "bankTransactionId" TEXT,
  "journalEntryId" TEXT,
  "settledAt" TIMESTAMP(3),
  "cancelledAt" TIMESTAMP(3),
  "rejectedAt" TIMESTAMP(3),
  "rejectionProofHash" TEXT,
  "rejectionEvidence" JSONB,
  "recoveryAfter" TIMESTAMP(3),
  "recoveryAttempts" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "actorKind" "ActorKind",
  CONSTRAINT "CustomerCreditRefund_pkey" PRIMARY KEY (id)
);

CREATE TABLE "CustomerCreditRefundEvent" (
  id TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "refundId" TEXT NOT NULL,
  type TEXT NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "observationHash" TEXT,
  "reasonCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "actorKind" "ActorKind",
  CONSTRAINT "CustomerCreditRefundEvent_pkey" PRIMARY KEY (id)
);

CREATE UNIQUE INDEX "CustomerCreditRefund_organizationId_requestId_key" ON "CustomerCreditRefund"("organizationId", "requestId");
CREATE UNIQUE INDEX "CustomerCreditRefund_bankProofKey_key" ON "CustomerCreditRefund"("bankProofKey");
CREATE UNIQUE INDEX "CustomerCreditRefund_journalEntryId_key" ON "CustomerCreditRefund"("journalEntryId");
CREATE UNIQUE INDEX "CustomerCreditRefund_transfer_identity_key" ON "CustomerCreditRefund"(provider, "providerAccountRef", "providerTransferId");
-- En banks id är inte globalt unikt; både konto och leverantör hör till identiteten.
CREATE UNIQUE INDEX "CustomerCreditRefund_bank_proof_identity_key" ON "CustomerCreditRefund"(provider, "providerAccountRef", "bankTransactionId");
CREATE INDEX "CustomerCreditRefund_organizationId_creditId_idx" ON "CustomerCreditRefund"("organizationId", "creditId");
CREATE INDEX "CustomerCreditRefund_state_recoveryAfter_preparedAt_idx" ON "CustomerCreditRefund"(state, "recoveryAfter", "preparedAt");
CREATE INDEX "CustomerCreditRefundEvent_organizationId_refundId_occurredAt_idx" ON "CustomerCreditRefundEvent"("organizationId", "refundId", "occurredAt");

ALTER TABLE "CustomerCreditRefund" ADD CONSTRAINT "CustomerCreditRefund_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"(id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CustomerCreditRefund" ADD CONSTRAINT "CustomerCreditRefund_creditId_fkey" FOREIGN KEY ("creditId") REFERENCES "CustomerCredit"(id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CustomerCreditRefund" ADD CONSTRAINT "CustomerCreditRefund_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"(id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CustomerCreditRefund" ADD CONSTRAINT "CustomerCreditRefund_leaseId_fkey" FOREIGN KEY ("leaseId") REFERENCES "Lease"(id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CustomerCreditRefund" ADD CONSTRAINT "CustomerCreditRefund_liabilityAccountId_fkey" FOREIGN KEY ("liabilityAccountId") REFERENCES "Account"(id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CustomerCreditRefund" ADD CONSTRAINT "CustomerCreditRefund_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "BankAccount"(id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CustomerCreditRefund" ADD CONSTRAINT "CustomerCreditRefund_bankLedgerAccountId_fkey" FOREIGN KEY ("bankLedgerAccountId") REFERENCES "Account"(id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CustomerCreditRefund" ADD CONSTRAINT "CustomerCreditRefund_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "JournalEntry"(id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CustomerCreditRefundEvent" ADD CONSTRAINT "CustomerCreditRefundEvent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"(id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CustomerCreditRefundEvent" ADD CONSTRAINT "CustomerCreditRefundEvent_refundId_fkey" FOREIGN KEY ("refundId") REFERENCES "CustomerCreditRefund"(id) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CustomerCreditRefund" ADD CONSTRAINT "customer_credit_refund_shape" CHECK (
  amount > 0 AND currency = 'SEK' AND length(btrim("requestId")) BETWEEN 1 AND 200
  AND "requestHash" ~ '^[a-f0-9]{64}$' AND "instructionHash" ~ '^[a-f0-9]{64}$'
  AND "recipientProofHash" ~ '^[a-f0-9]{64}$'
  AND length(btrim(provider)) > 0 AND length(btrim("providerAccountRef")) > 0
  AND length(btrim("recipientRef")) > 0
  AND "recipientVerifiedAt" <= "preparedAt" AND "recipientValidUntil" > "preparedAt"
  AND "recoveryAttempts" >= 0
  AND ("submissionStartedAt" IS NULL OR "submissionStartedAt" >= "preparedAt")
  AND ("providerTransferId" IS NULL OR length(btrim("providerTransferId")) > 0)
  AND ("bankTransactionId" IS NULL OR length(btrim("bankTransactionId")) > 0)
  AND ("bankProofHash" IS NULL OR "bankProofHash" ~ '^[a-f0-9]{64}$')
  AND ("rejectionProofHash" IS NULL OR "rejectionProofHash" ~ '^[a-f0-9]{64}$')
  AND (
    (state = 'RESERVED' AND "submissionStartedAt" IS NULL AND "cancelledAt" IS NULL)
    OR (state = 'CANCELLED' AND "submissionStartedAt" IS NULL AND "cancelledAt" IS NOT NULL AND "cancelledAt" >= "preparedAt")
    OR (state IN ('SUBMITTING','UNKNOWN','BANK_CONFIRMED','SETTLED','REJECTED') AND "submissionStartedAt" IS NOT NULL AND "cancelledAt" IS NULL)
  )
  AND (
    (state = 'REJECTED' AND "rejectedAt" IS NOT NULL AND "rejectedAt" >= "submissionStartedAt" AND "rejectionProofHash" IS NOT NULL AND "providerTransferId" IS NOT NULL AND "rejectionEvidence" IS NOT NULL AND jsonb_typeof("rejectionEvidence") = 'object')
    OR (state <> 'REJECTED' AND "rejectedAt" IS NULL AND "rejectionProofHash" IS NULL AND "rejectionEvidence" IS NULL)
  )
  AND (
    (state IN ('BANK_CONFIRMED','SETTLED') AND "bankProofKey" IS NOT NULL AND "bankProofHash" IS NOT NULL
      AND "bankConfirmedAt" IS NOT NULL AND "bankConfirmedAt" >= "submissionStartedAt" AND "bankBookedAt" IS NOT NULL
      AND "bankEvidence" IS NOT NULL AND jsonb_typeof("bankEvidence") = 'object'
      AND "bankTransactionId" IS NOT NULL AND "providerTransferId" IS NOT NULL
      AND "bankProofKey"::jsonb = jsonb_build_array(provider, "providerAccountRef", "bankTransactionId"))
    OR (state NOT IN ('BANK_CONFIRMED','SETTLED') AND "bankProofKey" IS NULL AND "bankProofHash" IS NULL
      AND "bankConfirmedAt" IS NULL AND "bankBookedAt" IS NULL AND "bankTransactionId" IS NULL AND "bankEvidence" IS NULL)
  )
  AND (
    (state = 'SETTLED' AND "journalEntryId" IS NOT NULL AND "settledAt" IS NOT NULL AND "settledAt" >= "bankConfirmedAt")
    OR (state <> 'SETTLED' AND "journalEntryId" IS NULL AND "settledAt" IS NULL)
  )
);
ALTER TABLE "CustomerCreditRefundEvent" ADD CONSTRAINT "customer_credit_refund_event_shape" CHECK (
  type IN ('RESERVED','SUBMITTING','UNKNOWN','BANK_PENDING','BANK_NOT_FOUND','BANK_CONFIRMED','SETTLED','REJECTED','CANCELLED')
  AND ("observationHash" IS NULL OR "observationHash" ~ '^[a-f0-9]{64}$')
  AND ("reasonCode" IS NULL OR "reasonCode" ~ '^[A-Z0-9_]{1,80}$')
);

-- Samma beräknade saldo och samma radlås gäller båda förbrukningsvägarna.
-- Read Committed är nödvändigt även för direkt SQL: tillgodoraden uppdateras
-- aldrig, så Repeatable Read kan annars läsa en äldre SUMMA efter låsväntan.
CREATE OR REPLACE FUNCTION customer_credit_application_guard() RETURNS trigger AS $$
DECLARE
  credit_row "CustomerCredit"%ROWTYPE;
  target_row "RentNotice"%ROWTYPE;
  used_amount NUMERIC;
  refunded_amount NUMERIC;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'CUSTOMER_CREDIT_REQUIRES_READ_COMMITTED' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO credit_row FROM "CustomerCredit" WHERE id = NEW."creditId" FOR UPDATE;
  SELECT * INTO target_row FROM "RentNotice" WHERE id = NEW."rentNoticeId";
  IF credit_row.id IS NULL OR target_row.id IS NULL
     OR NEW."organizationId" <> credit_row."organizationId"
     OR target_row."organizationId" <> credit_row."organizationId"
     OR target_row."tenantId" <> credit_row."tenantId"
     OR target_row."leaseId" <> credit_row."leaseId" THEN
    RAISE EXCEPTION 'CUSTOMER_CREDIT_SCOPE_MISMATCH' USING ERRCODE = '23514';
  END IF;
  SELECT COALESCE(SUM(amount),0) INTO used_amount FROM "CustomerCreditApplication" WHERE "creditId" = NEW."creditId";
  SELECT COALESCE(SUM(amount),0) INTO refunded_amount FROM "CustomerCreditRefund"
    WHERE "creditId" = NEW."creditId" AND state NOT IN ('CANCELLED','REJECTED');
  IF used_amount + refunded_amount + NEW.amount > credit_row.amount THEN
    RAISE EXCEPTION 'CUSTOMER_CREDIT_INSUFFICIENT_BALANCE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION customer_credit_refund_guard() RETURNS trigger AS $$
DECLARE
  credit_row "CustomerCredit"%ROWTYPE;
  used_amount NUMERIC;
  refunded_amount NUMERIC;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'CUSTOMER_CREDIT_REQUIRES_READ_COMMITTED' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' OR (OLD.state = 'RESERVED' AND NEW.state = 'SUBMITTING') THEN
    IF NOT EXISTS (
      SELECT 1 FROM "CustomerCreditPolicy" p
      JOIN "Organization" o ON o.id = p."organizationId"
      JOIN "Tenant" t ON t.id = NEW."tenantId" AND t."organizationId" = p."organizationId"
      JOIN "Lease" l ON l.id = NEW."leaseId" AND l."tenantId" = t.id AND l."organizationId" = p."organizationId"
      WHERE p."organizationId" = NEW."organizationId" AND p.enabled AND p."refundEnabled"
        AND p."liabilityAccountId" = NEW."liabilityAccountId"
        AND p."bankAccountId" = NEW."bankAccountId"
        AND p."refundBankLedgerAccountId" = NEW."bankLedgerAccountId"
        AND o.status IN ('TRIAL','ACTIVE','PAST_DUE') AND t."anonymizedAt" IS NULL
    ) THEN
      RAISE EXCEPTION 'CUSTOMER_CREDIT_REFUND_NEW_EFFECT_DISABLED' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'RESERVED' THEN
      RAISE EXCEPTION 'CUSTOMER_CREDIT_REFUND_MUST_START_RESERVED' USING ERRCODE = '23514';
    END IF;
    SELECT * INTO credit_row FROM "CustomerCredit" WHERE id = NEW."creditId" FOR UPDATE;
    IF credit_row.id IS NULL OR NEW."organizationId" <> credit_row."organizationId"
       OR NEW."tenantId" <> credit_row."tenantId" OR NEW."leaseId" <> credit_row."leaseId"
       OR NEW."liabilityAccountId" <> credit_row."liabilityAccountId"
       OR NOT EXISTS (SELECT 1 FROM "BankTransaction" WHERE id = credit_row."sourceBankTransactionId" AND "bankAccountId" = NEW."bankAccountId" AND "organizationId" = NEW."organizationId")
       OR NOT EXISTS (SELECT 1 FROM "Account" WHERE id = NEW."bankLedgerAccountId" AND "organizationId" = NEW."organizationId" AND type = 'ASSET' AND "isActive")
       OR NOT EXISTS (SELECT 1 FROM "Account" WHERE id = NEW."liabilityAccountId" AND "organizationId" = NEW."organizationId" AND type = 'LIABILITY' AND "isActive")
       OR NOT EXISTS (SELECT 1 FROM "BankAccount" WHERE id = NEW."bankAccountId" AND "organizationId" = NEW."organizationId" AND "isActive") THEN
      RAISE EXCEPTION 'CUSTOMER_CREDIT_REFUND_SCOPE_MISMATCH' USING ERRCODE = '23514';
    END IF;
    SELECT COALESCE(SUM(amount),0) INTO used_amount FROM "CustomerCreditApplication" WHERE "creditId" = NEW."creditId";
    SELECT COALESCE(SUM(amount),0) INTO refunded_amount FROM "CustomerCreditRefund" WHERE "creditId" = NEW."creditId" AND state NOT IN ('CANCELLED','REJECTED');
    IF used_amount + refunded_amount + NEW.amount > credit_row.amount THEN
      RAISE EXCEPTION 'CUSTOMER_CREDIT_INSUFFICIENT_BALANCE' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  -- Ingen övergång kan ta en frigiven reservation i bruk igen. Därför kräver
  -- UPDATE inget nytt saldoanspråk eller omvänt Refund→Credit-lås.
  IF (to_jsonb(NEW) - ARRAY['state','submissionStartedAt','providerTransferId','bankProofKey','bankProofHash','bankEvidence','bankConfirmedAt','bankBookedAt','bankTransactionId','journalEntryId','settledAt','cancelledAt','rejectedAt','rejectionProofHash','rejectionEvidence','recoveryAfter','recoveryAttempts','updatedAt'])
     IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['state','submissionStartedAt','providerTransferId','bankProofKey','bankProofHash','bankEvidence','bankConfirmedAt','bankBookedAt','bankTransactionId','journalEntryId','settledAt','cancelledAt','rejectedAt','rejectionProofHash','rejectionEvidence','recoveryAfter','recoveryAttempts','updatedAt']) THEN
    RAISE EXCEPTION 'CUSTOMER_CREDIT_REFUND_INSTRUCTION_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF (OLD."submissionStartedAt" IS NOT NULL AND NEW."submissionStartedAt" IS DISTINCT FROM OLD."submissionStartedAt")
     OR (OLD."providerTransferId" IS NOT NULL AND NEW."providerTransferId" IS DISTINCT FROM OLD."providerTransferId")
     OR (OLD."bankProofKey" IS NOT NULL AND NEW."bankProofKey" IS DISTINCT FROM OLD."bankProofKey")
     OR (OLD."bankProofHash" IS NOT NULL AND NEW."bankProofHash" IS DISTINCT FROM OLD."bankProofHash")
     OR (OLD."bankEvidence" IS NOT NULL AND NEW."bankEvidence" IS DISTINCT FROM OLD."bankEvidence")
     OR (OLD."bankConfirmedAt" IS NOT NULL AND NEW."bankConfirmedAt" IS DISTINCT FROM OLD."bankConfirmedAt")
     OR (OLD."bankBookedAt" IS NOT NULL AND NEW."bankBookedAt" IS DISTINCT FROM OLD."bankBookedAt")
     OR (OLD."bankTransactionId" IS NOT NULL AND NEW."bankTransactionId" IS DISTINCT FROM OLD."bankTransactionId")
     OR (OLD."journalEntryId" IS NOT NULL AND NEW."journalEntryId" IS DISTINCT FROM OLD."journalEntryId")
     OR (OLD."settledAt" IS NOT NULL AND NEW."settledAt" IS DISTINCT FROM OLD."settledAt")
     OR (OLD."cancelledAt" IS NOT NULL AND NEW."cancelledAt" IS DISTINCT FROM OLD."cancelledAt")
     OR (OLD."rejectedAt" IS NOT NULL AND NEW."rejectedAt" IS DISTINCT FROM OLD."rejectedAt")
     OR (OLD."rejectionProofHash" IS NOT NULL AND NEW."rejectionProofHash" IS DISTINCT FROM OLD."rejectionProofHash")
     OR (OLD."rejectionEvidence" IS NOT NULL AND NEW."rejectionEvidence" IS DISTINCT FROM OLD."rejectionEvidence")
     OR NEW."recoveryAttempts" < OLD."recoveryAttempts" THEN
    RAISE EXCEPTION 'CUSTOMER_CREDIT_REFUND_EVIDENCE_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF NEW.state <> OLD.state AND NOT (
    (OLD.state = 'RESERVED' AND NEW.state IN ('SUBMITTING','CANCELLED'))
    OR (OLD.state = 'SUBMITTING' AND NEW.state IN ('UNKNOWN','BANK_CONFIRMED','REJECTED'))
    OR (OLD.state = 'UNKNOWN' AND NEW.state IN ('BANK_CONFIRMED','REJECTED'))
    OR (OLD.state = 'BANK_CONFIRMED' AND NEW.state = 'SETTLED')
  ) THEN
    RAISE EXCEPTION 'CUSTOMER_CREDIT_REFUND_INVALID_TRANSITION' USING ERRCODE = '23514';
  END IF;
  IF NEW.state = 'SUBMITTING' AND OLD.state = 'RESERVED' AND NEW."submissionStartedAt" >= NEW."recipientValidUntil" THEN
    RAISE EXCEPTION 'CUSTOMER_CREDIT_REFUND_DESTINATION_EXPIRED' USING ERRCODE = '23514';
  END IF;
  -- Även en direkt SQL-skrivning måste bevara bankfaktans fulla identitet.
  -- Själva auktoriteten kommer från serverns bankport, aldrig en HTTP-DTO.
  IF NEW.state IN ('BANK_CONFIRMED','SETTLED') AND (
    NEW."bankEvidence" IS NULL OR NOT (NEW."bankEvidence" @> jsonb_build_object(
      'kind', 'BOOKED_DEBIT', 'instructionId', NEW.id,
      'instructionHash', NEW."instructionHash", 'organizationId', NEW."organizationId",
      'tenantId', NEW."tenantId", 'bankAccountId', NEW."bankAccountId",
      'provider', NEW.provider, 'providerAccountRef', NEW."providerAccountRef",
      'recipientRef', NEW."recipientRef", 'amount', NEW.amount::text, 'currency', NEW.currency,
      'providerTransferId', NEW."providerTransferId", 'bankTransactionId', NEW."bankTransactionId"
    )) OR ((NEW."bankEvidence"->>'bankBookedAt')::timestamptz AT TIME ZONE 'UTC') IS DISTINCT FROM NEW."bankBookedAt"
  ) THEN
    RAISE EXCEPTION 'CUSTOMER_CREDIT_REFUND_BANK_EVIDENCE_MISMATCH' USING ERRCODE = '23514';
  END IF;
  IF NEW.state = 'REJECTED' AND (
    NEW."rejectionEvidence" IS NULL OR NOT (NEW."rejectionEvidence" @> jsonb_build_object(
      'kind', 'VERIFIED_NOT_EXECUTED', 'instructionId', NEW.id,
      'instructionHash', NEW."instructionHash", 'organizationId', NEW."organizationId",
      'tenantId', NEW."tenantId", 'bankAccountId', NEW."bankAccountId",
      'provider', NEW.provider, 'providerAccountRef', NEW."providerAccountRef",
      'recipientRef', NEW."recipientRef", 'amount', NEW.amount::text, 'currency', NEW.currency,
      'providerTransferId', NEW."providerTransferId"
    )) OR COALESCE(NEW."rejectionEvidence"->>'reasonCode', '') NOT IN ('BANK_REJECTED','BANK_CANCELLED')
  ) THEN
    RAISE EXCEPTION 'CUSTOMER_CREDIT_REFUND_REJECTION_EVIDENCE_MISMATCH' USING ERRCODE = '23514';
  END IF;
  IF NEW.state = 'SETTLED' AND OLD.state <> 'SETTLED' THEN
    IF NOT EXISTS (
      SELECT 1 FROM "JournalEntry" j
      WHERE j.id = NEW."journalEntryId" AND j."organizationId" = NEW."organizationId"
        AND j.source = 'PAYMENT' AND j."sourceId" = 'customer-credit-refund:' || NEW.id
        AND j.date = (NEW."bankBookedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Stockholm')::date
        AND NOT EXISTS (SELECT 1 FROM "JournalEntry" r WHERE r."reversalOfEntryId" = j.id)
        AND (SELECT COUNT(*) FROM "JournalEntryLine" l WHERE l."journalEntryId" = j.id) = 2
        AND EXISTS (SELECT 1 FROM "JournalEntryLine" l WHERE l."journalEntryId" = j.id AND l."accountId" = NEW."liabilityAccountId" AND l.debit = NEW.amount AND COALESCE(l.credit,0) = 0)
        AND EXISTS (SELECT 1 FROM "JournalEntryLine" l WHERE l."journalEntryId" = j.id AND l."accountId" = NEW."bankLedgerAccountId" AND l.credit = NEW.amount AND COALESCE(l.debit,0) = 0)
    ) THEN
      RAISE EXCEPTION 'CUSTOMER_CREDIT_REFUND_JOURNAL_MISMATCH' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER customer_credit_refund_lifecycle BEFORE INSERT OR UPDATE ON "CustomerCreditRefund"
  FOR EACH ROW EXECUTE FUNCTION customer_credit_refund_guard();

CREATE FUNCTION customer_credit_refund_no_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'CUSTOMER_CREDIT_REFUND_PERMANENT_RECORD' USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER customer_credit_refund_no_delete BEFORE DELETE ON "CustomerCreditRefund"
  FOR EACH ROW EXECUTE FUNCTION customer_credit_refund_no_delete();
CREATE TRIGGER append_only_customer_credit_refund_event BEFORE UPDATE ON "CustomerCreditRefundEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION append_only_guard();
CREATE TRIGGER customer_credit_refund_event_no_delete BEFORE DELETE ON "CustomerCreditRefundEvent"
  FOR EACH ROW EXECUTE FUNCTION customer_credit_refund_no_delete();

CREATE FUNCTION customer_credit_refund_event_scope() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "CustomerCreditRefund" WHERE id = NEW."refundId" AND "organizationId" = NEW."organizationId") THEN
    RAISE EXCEPTION 'CUSTOMER_CREDIT_REFUND_EVENT_SCOPE_MISMATCH' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER customer_credit_refund_event_scope BEFORE INSERT ON "CustomerCreditRefundEvent"
  FOR EACH ROW EXECUTE FUNCTION customer_credit_refund_event_scope();

-- En gammal avi-allokering kan inte raderas för att frigöra samma pengar när
-- tillgodoposten ingår i återbetalning. Org-purge vägrar dessa organisationer.
CREATE FUNCTION customer_credit_application_refund_delete_guard() RETURNS trigger AS $$
BEGIN
  PERFORM id FROM "CustomerCredit" WHERE id = OLD."creditId" FOR UPDATE;
  IF EXISTS (SELECT 1 FROM "CustomerCreditRefund" WHERE "creditId" = OLD."creditId") THEN
    RAISE EXCEPTION 'CUSTOMER_CREDIT_REFUND_PERMANENT_RECORD' USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER customer_credit_application_refund_delete BEFORE DELETE ON "CustomerCreditApplication"
  FOR EACH ROW EXECUTE FUNCTION customer_credit_application_refund_delete_guard();
