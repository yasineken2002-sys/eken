-- CreateEnum
CREATE TYPE "CustomerType" AS ENUM ('INDIVIDUAL', 'COMPANY');

-- DropForeignKey
ALTER TABLE "Invoice" DROP CONSTRAINT "Invoice_tenantId_fkey";

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "customerId" TEXT,
ALTER COLUMN "tenantId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "type" "CustomerType" NOT NULL,
    "firstName" TEXT,
    "lastName" TEXT,
    "personalNumber" TEXT,
    "companyName" TEXT,
    "orgNumber" TEXT,
    "contactPerson" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "street" TEXT,
    "city" TEXT,
    "postalCode" TEXT,
    "country" TEXT DEFAULT 'SE',
    "reference" TEXT,
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Customer_organizationId_idx" ON "Customer"("organizationId");

-- CreateIndex
CREATE INDEX "Customer_email_idx" ON "Customer"("email");

-- CreateIndex
CREATE INDEX "Invoice_customerId_idx" ON "Invoice"("customerId");

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- XOR-constraint: en faktura måste ha exakt en av tenantId och customerId.
-- Skydd mot bugs som länkar samma faktura till både hyresgäst och kund,
-- eller till ingen part alls.
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_tenant_xor_customer_chk"
  CHECK (("tenantId" IS NOT NULL) <> ("customerId" IS NOT NULL));
