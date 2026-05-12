-- Sätt default på status till DRAFT nu när enum-värdet är committat.
ALTER TABLE "PlatformInvoice" ALTER COLUMN "status" SET DEFAULT 'DRAFT';
