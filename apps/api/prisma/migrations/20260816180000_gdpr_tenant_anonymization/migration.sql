-- GDPR Art. 17: avidentifiering som operatörsväg.
--
-- `anonymizedAt` gör tillståndet läsbart (utan det är enda spåret ett
-- e-postmönster) och gör hårdraderingens grind möjlig.
--
-- `TenantAnonymizationLog` speglar `ImpersonationLog`: samma fråga ("vem gjorde
-- vad mot vem, när, varifrån") och samma Restrict på organisationen — ett
-- revisionsspår som försvinner med organisationen bevisar ingenting.
-- `performedById` är nullbar: null betyder att hyresgästen verkställde själv via
-- portalen, där ingen `User` finns att peka på.

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "anonymizedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "TenantAnonymizationLog" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "performedById" TEXT,
    "performedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "reason" TEXT,

    CONSTRAINT "TenantAnonymizationLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TenantAnonymizationLog_organizationId_idx" ON "TenantAnonymizationLog"("organizationId");

-- CreateIndex
CREATE INDEX "TenantAnonymizationLog_tenantId_idx" ON "TenantAnonymizationLog"("tenantId");

-- CreateIndex
CREATE INDEX "TenantAnonymizationLog_performedAt_idx" ON "TenantAnonymizationLog"("performedAt");

-- AddForeignKey
ALTER TABLE "TenantAnonymizationLog" ADD CONSTRAINT "TenantAnonymizationLog_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenantAnonymizationLog" ADD CONSTRAINT "TenantAnonymizationLog_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenantAnonymizationLog" ADD CONSTRAINT "TenantAnonymizationLog_performedById_fkey" FOREIGN KEY ("performedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
