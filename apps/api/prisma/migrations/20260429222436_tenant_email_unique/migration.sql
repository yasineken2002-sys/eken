-- DropIndex
DROP INDEX "Tenant_email_idx";

-- CreateIndex
CREATE UNIQUE INDEX "Tenant_organizationId_email_key" ON "Tenant"("organizationId", "email");

