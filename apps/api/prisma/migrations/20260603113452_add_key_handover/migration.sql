-- CreateEnum
CREATE TYPE "KeyType" AS ENUM ('APARTMENT', 'ENTRANCE', 'MAILBOX', 'LAUNDRY_TAG', 'GARAGE', 'STORAGE', 'FOB_TAG', 'OTHER');

-- CreateEnum
CREATE TYPE "KeyStatus" AS ENUM ('ISSUED', 'RETURNED', 'LOST', 'REPLACED');

-- CreateTable
CREATE TABLE "KeyHandover" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "leaseId" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "type" "KeyType" NOT NULL,
    "label" TEXT,
    "status" "KeyStatus" NOT NULL DEFAULT 'ISSUED',
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "issuedToName" TEXT,
    "issuedById" TEXT,
    "returnedAt" TIMESTAMP(3),
    "receivedById" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KeyHandover_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "KeyHandover_organizationId_idx" ON "KeyHandover"("organizationId");

-- CreateIndex
CREATE INDEX "KeyHandover_leaseId_idx" ON "KeyHandover"("leaseId");

-- CreateIndex
CREATE INDEX "KeyHandover_unitId_idx" ON "KeyHandover"("unitId");

-- CreateIndex
CREATE INDEX "KeyHandover_tenantId_idx" ON "KeyHandover"("tenantId");

-- CreateIndex
CREATE INDEX "KeyHandover_status_idx" ON "KeyHandover"("status");

-- AddForeignKey
ALTER TABLE "KeyHandover" ADD CONSTRAINT "KeyHandover_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KeyHandover" ADD CONSTRAINT "KeyHandover_leaseId_fkey" FOREIGN KEY ("leaseId") REFERENCES "Lease"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KeyHandover" ADD CONSTRAINT "KeyHandover_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KeyHandover" ADD CONSTRAINT "KeyHandover_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
