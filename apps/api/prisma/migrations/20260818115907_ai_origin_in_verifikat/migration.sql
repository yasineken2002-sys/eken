-- AI-ursprung i verifikatet (#494 beslut 4). ENBART ADDITIVT:
-- två nya enum-varianter och två nullbara kolumner. Inget befintligt värde
-- ändras, ingen kolumn blir NOT NULL, ingen backfill.
--
-- Kolumnerna är MJUKA referenser till "AiToolExecution"."id" och saknar
-- avsiktligt främmande nyckel: verktygsloggen skrivs efter verifikatet och
-- gallras efter 730/365/90 dagar, medan verifikatet bevaras i sju år. Se noten
-- i schema.prisma.
--
-- `IF NOT EXISTS` gör enum-satserna omkörbara. Varianterna ANVÄNDS inte i den
-- här migrationen — PostgreSQL tillåter inte att ett nytt enum-värde används i
-- samma transaktion som det läggs till.

-- AlterEnum
ALTER TYPE "EventActorType" ADD VALUE IF NOT EXISTS 'AI';

-- AlterEnum
ALTER TYPE "JournalEntrySource" ADD VALUE IF NOT EXISTS 'AI';

-- AlterTable
ALTER TABLE "JournalEntry" ADD COLUMN "aiToolExecutionId" TEXT;

-- AlterTable
ALTER TABLE "InvoiceEvent" ADD COLUMN "aiToolExecutionId" TEXT;
