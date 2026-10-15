-- AlterEnum
ALTER TYPE "RentNoticePaymentSource" ADD VALUE 'CUSTOMER_CREDIT';

-- AlterTable
ALTER TABLE "RentNoticePayment" ADD COLUMN     "customerCreditApplicationId" TEXT;

-- CreateTable
CREATE TABLE "CustomerCreditPolicy" (
    "organizationId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "carryForwardEnabled" BOOLEAN NOT NULL DEFAULT false,
    "liabilityAccountId" TEXT NOT NULL,
    "bankAccountId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorKind" "ActorKind",

    CONSTRAINT "CustomerCreditPolicy_pkey" PRIMARY KEY ("organizationId")
);

-- CreateTable
CREATE TABLE "CustomerCredit" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "leaseId" TEXT NOT NULL,
    "sourceRentNoticeId" TEXT NOT NULL,
    "sourceBankTransactionId" TEXT NOT NULL,
    "sourcePaymentId" TEXT NOT NULL,
    "liabilityAccountId" TEXT NOT NULL,
    "journalEntryId" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorKind" "ActorKind",

    CONSTRAINT "CustomerCredit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerCreditApplication" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "creditId" TEXT NOT NULL,
    "rentNoticeId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "journalEntryId" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "appliedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorKind" "ActorKind",

    CONSTRAINT "CustomerCreditApplication_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CustomerCredit_sourceBankTransactionId_key" ON "CustomerCredit"("sourceBankTransactionId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerCredit_sourcePaymentId_key" ON "CustomerCredit"("sourcePaymentId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerCredit_journalEntryId_key" ON "CustomerCredit"("journalEntryId");

-- CreateIndex
CREATE INDEX "CustomerCredit_organizationId_leaseId_idx" ON "CustomerCredit"("organizationId", "leaseId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerCreditApplication_journalEntryId_key" ON "CustomerCreditApplication"("journalEntryId");

-- CreateIndex
CREATE INDEX "CustomerCreditApplication_rentNoticeId_idx" ON "CustomerCreditApplication"("rentNoticeId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerCreditApplication_organizationId_requestId_key" ON "CustomerCreditApplication"("organizationId", "requestId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerCreditApplication_creditId_rentNoticeId_key" ON "CustomerCreditApplication"("creditId", "rentNoticeId");

-- CreateIndex
CREATE UNIQUE INDEX "RentNoticePayment_customerCreditApplicationId_key" ON "RentNoticePayment"("customerCreditApplicationId");

-- AddForeignKey
ALTER TABLE "RentNoticePayment" ADD CONSTRAINT "RentNoticePayment_customerCreditApplicationId_fkey" FOREIGN KEY ("customerCreditApplicationId") REFERENCES "CustomerCreditApplication"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerCreditPolicy" ADD CONSTRAINT "CustomerCreditPolicy_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerCreditPolicy" ADD CONSTRAINT "CustomerCreditPolicy_liabilityAccountId_fkey" FOREIGN KEY ("liabilityAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerCreditPolicy" ADD CONSTRAINT "CustomerCreditPolicy_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "BankAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerCredit" ADD CONSTRAINT "CustomerCredit_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerCredit" ADD CONSTRAINT "CustomerCredit_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerCredit" ADD CONSTRAINT "CustomerCredit_leaseId_fkey" FOREIGN KEY ("leaseId") REFERENCES "Lease"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerCredit" ADD CONSTRAINT "CustomerCredit_sourceRentNoticeId_fkey" FOREIGN KEY ("sourceRentNoticeId") REFERENCES "RentNotice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerCredit" ADD CONSTRAINT "CustomerCredit_sourceBankTransactionId_fkey" FOREIGN KEY ("sourceBankTransactionId") REFERENCES "BankTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerCredit" ADD CONSTRAINT "CustomerCredit_sourcePaymentId_fkey" FOREIGN KEY ("sourcePaymentId") REFERENCES "RentNoticePayment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerCredit" ADD CONSTRAINT "CustomerCredit_liabilityAccountId_fkey" FOREIGN KEY ("liabilityAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerCredit" ADD CONSTRAINT "CustomerCredit_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "JournalEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerCreditApplication" ADD CONSTRAINT "CustomerCreditApplication_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerCreditApplication" ADD CONSTRAINT "CustomerCreditApplication_creditId_fkey" FOREIGN KEY ("creditId") REFERENCES "CustomerCredit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerCreditApplication" ADD CONSTRAINT "CustomerCreditApplication_rentNoticeId_fkey" FOREIGN KEY ("rentNoticeId") REFERENCES "RentNotice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerCreditApplication" ADD CONSTRAINT "CustomerCreditApplication_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "JournalEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Ingen historisk bankallokering ändras. Endast den nya källtypen kräver
-- länken till en bokförd tillgodoanvändning och saknar ny banktransaktion.
ALTER TABLE "RentNoticePayment" ADD CONSTRAINT "customer_credit_payment_source_check"
CHECK (
  ("source"::text = 'CUSTOMER_CREDIT' AND "customerCreditApplicationId" IS NOT NULL AND "bankTransactionId" IS NULL)
  OR ("source"::text <> 'CUSTOMER_CREDIT' AND "customerCreditApplicationId" IS NULL)
);
ALTER TABLE "CustomerCredit" ADD CONSTRAINT "customer_credit_positive_amount" CHECK ("amount" > 0);
ALTER TABLE "CustomerCreditApplication" ADD CONSTRAINT "customer_credit_application_positive_amount" CHECK ("amount" > 0);

-- Samma append-only-mekanik som befintliga finansiella händelser.
CREATE TRIGGER append_only_customer_credit
  BEFORE UPDATE ON "CustomerCredit"
  FOR EACH STATEMENT EXECUTE FUNCTION append_only_guard();
CREATE TRIGGER append_only_customer_credit_application
  BEFORE UPDATE ON "CustomerCreditApplication"
  FOR EACH STATEMENT EXECUTE FUNCTION append_only_guard();

-- Skyddar även mot en ny skrivväg som glömmer tjänstens saldolås. Samma radlås
-- som tjänsten; två samtidiga insättningar kan inte spendera samma öre.
CREATE FUNCTION customer_credit_application_guard() RETURNS trigger AS $$
DECLARE
  credit_row "CustomerCredit"%ROWTYPE;
  target_row "RentNotice"%ROWTYPE;
  used_amount NUMERIC;
BEGIN
  SELECT * INTO credit_row FROM "CustomerCredit" WHERE id = NEW."creditId" FOR UPDATE;
  SELECT * INTO target_row FROM "RentNotice" WHERE id = NEW."rentNoticeId";
  IF credit_row.id IS NULL OR target_row.id IS NULL
     OR NEW."organizationId" <> credit_row."organizationId"
     OR target_row."organizationId" <> credit_row."organizationId"
     OR target_row."tenantId" <> credit_row."tenantId"
     OR target_row."leaseId" <> credit_row."leaseId" THEN
    RAISE EXCEPTION 'CUSTOMER_CREDIT_SCOPE_MISMATCH' USING ERRCODE = '23514';
  END IF;
  SELECT COALESCE(SUM(amount), 0) INTO used_amount FROM "CustomerCreditApplication" WHERE "creditId" = NEW."creditId";
  IF used_amount + NEW.amount > credit_row.amount THEN
    RAISE EXCEPTION 'CUSTOMER_CREDIT_INSUFFICIENT_BALANCE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER customer_credit_application_balance
  BEFORE INSERT ON "CustomerCreditApplication"
  FOR EACH ROW EXECUTE FUNCTION customer_credit_application_guard();
