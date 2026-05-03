-- Lägg till SENT_TO_COLLECTION i InvoiceStatus
ALTER TYPE "InvoiceStatus" ADD VALUE 'SENT_TO_COLLECTION';

-- Ny enum för påminnelsetyper
CREATE TYPE "PaymentReminderType" AS ENUM ('REMINDER_FRIENDLY', 'REMINDER_FORMAL', 'READY_FOR_COLLECTION');

-- Invoice: pause-flagga, kollektions-tidpunkt, R2-nyckel för senaste underlag
ALTER TABLE "Invoice"
  ADD COLUMN "remindersPaused" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "remindersPausedAt" TIMESTAMP(3),
  ADD COLUMN "remindersPausedReason" TEXT,
  ADD COLUMN "sentToCollectionAt" TIMESTAMP(3),
  ADD COLUMN "collectionExportKey" TEXT;

-- Organisation: påminnelse- och inkasso-inställningar
ALTER TABLE "Organization"
  ADD COLUMN "remindersEnabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "reminderFeeSek" DECIMAL(10,2) NOT NULL DEFAULT 60,
  ADD COLUMN "reminderFormalDay" INTEGER NOT NULL DEFAULT 14,
  ADD COLUMN "reminderCollectionDay" INTEGER NOT NULL DEFAULT 30,
  ADD COLUMN "collectionAgencyName" TEXT;

-- PaymentReminder
CREATE TABLE "PaymentReminder" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "type" "PaymentReminderType" NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "feeAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "emailMessageId" TEXT,

    CONSTRAINT "PaymentReminder_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PaymentReminder_invoiceId_type_key" ON "PaymentReminder"("invoiceId", "type");
CREATE INDEX "PaymentReminder_invoiceId_idx" ON "PaymentReminder"("invoiceId");
CREATE INDEX "PaymentReminder_sentAt_idx" ON "PaymentReminder"("sentAt");

ALTER TABLE "PaymentReminder"
  ADD CONSTRAINT "PaymentReminder_invoiceId_fkey"
  FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
