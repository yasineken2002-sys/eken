-- CreateEnum
CREATE TYPE "DepositStatus" AS ENUM ('PENDING', 'PAID', 'REFUND_PENDING', 'REFUNDED', 'PARTIALLY_REFUNDED', 'FORFEITED');

-- CreateTable
CREATE TABLE "Deposit" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "leaseId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "status" "DepositStatus" NOT NULL DEFAULT 'PENDING',
    "invoiceId" TEXT,
    "paidAt" TIMESTAMP(3),
    "refundedAt" TIMESTAMP(3),
    "refundAmount" DECIMAL(10,2),
    "deductions" JSONB,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Deposit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Deposit_leaseId_key" ON "Deposit"("leaseId");

-- CreateIndex
CREATE UNIQUE INDEX "Deposit_invoiceId_key" ON "Deposit"("invoiceId");

-- CreateIndex
CREATE INDEX "Deposit_organizationId_idx" ON "Deposit"("organizationId");

-- CreateIndex
CREATE INDEX "Deposit_status_idx" ON "Deposit"("status");

-- CreateIndex
CREATE INDEX "Deposit_tenantId_idx" ON "Deposit"("tenantId");

-- AddForeignKey
ALTER TABLE "Deposit" ADD CONSTRAINT "Deposit_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deposit" ADD CONSTRAINT "Deposit_leaseId_fkey" FOREIGN KEY ("leaseId") REFERENCES "Lease"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deposit" ADD CONSTRAINT "Deposit_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deposit" ADD CONSTRAINT "Deposit_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;
