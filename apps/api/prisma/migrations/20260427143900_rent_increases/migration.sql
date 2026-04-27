-- CreateEnum
CREATE TYPE "RentIncreaseStatus" AS ENUM ('DRAFT', 'NOTICE_SENT', 'ACCEPTED', 'REJECTED', 'WITHDRAWN', 'APPLIED');

-- CreateTable
CREATE TABLE "RentIncrease" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "leaseId" TEXT NOT NULL,
    "currentRent" DECIMAL(10,2) NOT NULL,
    "newRent" DECIMAL(10,2) NOT NULL,
    "increasePercent" DECIMAL(6,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "noticeDate" TIMESTAMP(3),
    "effectiveDate" DATE NOT NULL,
    "status" "RentIncreaseStatus" NOT NULL DEFAULT 'DRAFT',
    "respondedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RentIncrease_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RentIncrease_organizationId_idx" ON "RentIncrease"("organizationId");

-- CreateIndex
CREATE INDEX "RentIncrease_leaseId_idx" ON "RentIncrease"("leaseId");

-- CreateIndex
CREATE INDEX "RentIncrease_status_idx" ON "RentIncrease"("status");

-- CreateIndex
CREATE INDEX "RentIncrease_effectiveDate_idx" ON "RentIncrease"("effectiveDate");

-- AddForeignKey
ALTER TABLE "RentIncrease" ADD CONSTRAINT "RentIncrease_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RentIncrease" ADD CONSTRAINT "RentIncrease_leaseId_fkey" FOREIGN KEY ("leaseId") REFERENCES "Lease"("id") ON DELETE CASCADE ON UPDATE CASCADE;
