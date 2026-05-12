-- Plattformsfakturering: utöka PlatformInvoice med type, period, send/payment-fält.
-- Splittas i två migrationer: enum ADD VALUE kan inte användas i samma migration
-- som lägger till en kolumn med default på det nya värdet (Postgres-restriktion).

-- 1) Nya enum-värden på PlatformInvoiceStatus
ALTER TYPE "PlatformInvoiceStatus" ADD VALUE IF NOT EXISTS 'DRAFT';
ALTER TYPE "PlatformInvoiceStatus" ADD VALUE IF NOT EXISTS 'SENT';

-- 2) Ny enum för faktura-typ
CREATE TYPE "PlatformInvoiceType" AS ENUM ('PLAN_FEE', 'AI_CREDITS', 'OTHER');

-- 3) Nya kolumner på PlatformInvoice (status-default lämnas som PENDING; vi
--    sätter explicit 'DRAFT' i koden för nya fakturor och uppdaterar default
--    i nästa migration när enum-värdet är committat).
ALTER TABLE "PlatformInvoice"
  ADD COLUMN "type"             "PlatformInvoiceType" NOT NULL DEFAULT 'OTHER',
  ADD COLUMN "planPeriodStart"  TIMESTAMP(3),
  ADD COLUMN "planPeriodEnd"    TIMESTAMP(3),
  ADD COLUMN "sentAt"           TIMESTAMP(3),
  ADD COLUMN "paymentMethod"    TEXT,
  ADD COLUMN "paymentReference" TEXT,
  ADD COLUMN "notes"             TEXT,
  ADD COLUMN "reminderCount"     INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastReminderAt"    TIMESTAMP(3);

-- 4) Backfill: alla existerande PENDING-fakturor är credit-köpsfakturor
--    (CR-prefix). Markera dem som AI_CREDITS.
UPDATE "PlatformInvoice" SET "type" = 'AI_CREDITS' WHERE "invoiceNumber" LIKE 'CR-%';

-- 5) Nya index
CREATE INDEX "PlatformInvoice_type_idx" ON "PlatformInvoice"("type");
CREATE INDEX "PlatformInvoice_planPeriodStart_idx" ON "PlatformInvoice"("planPeriodStart");
