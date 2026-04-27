-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "ocrNumber" TEXT;

-- CreateIndex
CREATE INDEX "Invoice_ocrNumber_idx" ON "Invoice"("ocrNumber");
