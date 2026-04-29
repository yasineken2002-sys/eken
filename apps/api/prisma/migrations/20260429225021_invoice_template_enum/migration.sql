-- CreateEnum
CREATE TYPE "InvoiceTemplate" AS ENUM ('classic', 'modern', 'minimal');

-- AlterTable
ALTER TABLE "Organization" DROP COLUMN "invoiceTemplate",
ADD COLUMN     "invoiceTemplate" "InvoiceTemplate";

