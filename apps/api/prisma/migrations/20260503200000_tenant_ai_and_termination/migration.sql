-- AiUsageLog: lägg till tenantId + index för per-tenant kostnadsspårning
ALTER TABLE "AiUsageLog" ADD COLUMN "tenantId" TEXT;
CREATE INDEX "AiUsageLog_tenantId_createdAt_idx" ON "AiUsageLog"("tenantId", "createdAt");
ALTER TABLE "AiUsageLog"
  ADD CONSTRAINT "AiUsageLog_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AiToolExecution: gör userId valfritt + lägg till tenantId
ALTER TABLE "AiToolExecution" DROP CONSTRAINT "AiToolExecution_userId_fkey";
ALTER TABLE "AiToolExecution" ALTER COLUMN "userId" DROP NOT NULL;
ALTER TABLE "AiToolExecution" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "AiToolExecution"
  ADD CONSTRAINT "AiToolExecution_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiToolExecution"
  ADD CONSTRAINT "AiToolExecution_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "AiToolExecution_tenantId_createdAt_idx" ON "AiToolExecution"("tenantId", "createdAt");

-- AiTenantConversation
CREATE TABLE "AiTenantConversation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT 'Ny konversation',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiTenantConversation_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AiTenantConversation_tenantId_updatedAt_idx" ON "AiTenantConversation"("tenantId", "updatedAt");
ALTER TABLE "AiTenantConversation"
  ADD CONSTRAINT "AiTenantConversation_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AiTenantMessage
CREATE TABLE "AiTenantMessage" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiTenantMessage_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AiTenantMessage_conversationId_createdAt_idx" ON "AiTenantMessage"("conversationId", "createdAt");
ALTER TABLE "AiTenantMessage"
  ADD CONSTRAINT "AiTenantMessage_conversationId_fkey"
  FOREIGN KEY ("conversationId") REFERENCES "AiTenantConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- TerminationRequest enum + table
CREATE TYPE "TerminationRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

CREATE TABLE "TerminationRequest" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "leaseId" TEXT NOT NULL,
    "requestedEndDate" TIMESTAMP(3) NOT NULL,
    "reason" TEXT,
    "status" "TerminationRequestStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedAt" TIMESTAMP(3),
    "reviewedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TerminationRequest_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "TerminationRequest_organizationId_status_idx" ON "TerminationRequest"("organizationId", "status");
CREATE INDEX "TerminationRequest_tenantId_idx" ON "TerminationRequest"("tenantId");
CREATE INDEX "TerminationRequest_leaseId_idx" ON "TerminationRequest"("leaseId");
ALTER TABLE "TerminationRequest"
  ADD CONSTRAINT "TerminationRequest_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TerminationRequest"
  ADD CONSTRAINT "TerminationRequest_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TerminationRequest"
  ADD CONSTRAINT "TerminationRequest_leaseId_fkey"
  FOREIGN KEY ("leaseId") REFERENCES "Lease"("id") ON DELETE CASCADE ON UPDATE CASCADE;
