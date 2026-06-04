-- AlterEnum
ALTER TYPE "ContractImportBatchStatus" ADD VALUE 'COMPLETED';

-- AlterEnum
ALTER TYPE "ContractImportRowStatus" ADD VALUE 'COMMITTED';
ALTER TYPE "ContractImportRowStatus" ADD VALUE 'SKIPPED';

-- AlterTable
ALTER TABLE "ContractImportRow" ADD COLUMN     "confirmedData" JSONB,
ADD COLUMN     "createdLeaseId" TEXT;
