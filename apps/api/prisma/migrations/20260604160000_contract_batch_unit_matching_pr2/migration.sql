-- CreateEnum
CREATE TYPE "ContractRowMatchStatus" AS ENUM ('AUTO_MATCHED', 'AMBIGUOUS', 'NO_MATCH', 'NEEDS_REVIEW');

-- AlterTable
ALTER TABLE "ContractImportRow" ADD COLUMN     "matchStatus" "ContractRowMatchStatus",
ADD COLUMN     "matchedUnitId" TEXT;

-- CreateIndex
CREATE INDEX "ContractImportRow_matchedUnitId_idx" ON "ContractImportRow"("matchedUnitId");

-- AddForeignKey
ALTER TABLE "ContractImportRow" ADD CONSTRAINT "ContractImportRow_matchedUnitId_fkey" FOREIGN KEY ("matchedUnitId") REFERENCES "Unit"("id") ON DELETE SET NULL ON UPDATE CASCADE;
