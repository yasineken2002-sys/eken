-- CreateEnum
CREATE TYPE "PlatformPlan" AS ENUM ('TRIAL', 'BASIC', 'STANDARD', 'PREMIUM');

-- CreateEnum
CREATE TYPE "OrganizationStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PlatformInvoiceStatus" AS ENUM ('PENDING', 'PAID', 'OVERDUE', 'VOID');

-- CreateEnum
CREATE TYPE "ErrorSeverity" AS ENUM ('CRITICAL', 'ERROR', 'WARNING');

-- CreateEnum
CREATE TYPE "ErrorSource" AS ENUM ('API', 'WEB', 'PORTAL', 'ADMIN');

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "billingEmail" TEXT,
ADD COLUMN     "cancellationReason" TEXT,
ADD COLUMN     "monthlyFee" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN     "plan" "PlatformPlan" NOT NULL DEFAULT 'TRIAL',
ADD COLUMN     "status" "OrganizationStatus" NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN     "suspendedAt" TIMESTAMP(3),
ADD COLUMN     "trialEndsAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "PlatformUser" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "totpSecret" TEXT,
    "totpEnabled" BOOLEAN NOT NULL DEFAULT false,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformInvoice" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "invoiceNumber" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "status" "PlatformInvoiceStatus" NOT NULL DEFAULT 'PENDING',
    "description" TEXT,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImpersonationLog" (
    "id" TEXT NOT NULL,
    "platformUserId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "targetUserId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "reason" TEXT,

    CONSTRAINT "ImpersonationLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ErrorLog" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "severity" "ErrorSeverity" NOT NULL,
    "source" "ErrorSource" NOT NULL,
    "message" TEXT NOT NULL,
    "stack" TEXT,
    "context" JSONB NOT NULL DEFAULT '{}',
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ErrorLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PlatformUser_email_key" ON "PlatformUser"("email");

-- CreateIndex
CREATE INDEX "PlatformUser_email_idx" ON "PlatformUser"("email");

-- CreateIndex
CREATE UNIQUE INDEX "PlatformInvoice_invoiceNumber_key" ON "PlatformInvoice"("invoiceNumber");

-- CreateIndex
CREATE INDEX "PlatformInvoice_organizationId_idx" ON "PlatformInvoice"("organizationId");

-- CreateIndex
CREATE INDEX "PlatformInvoice_status_idx" ON "PlatformInvoice"("status");

-- CreateIndex
CREATE INDEX "PlatformInvoice_dueDate_idx" ON "PlatformInvoice"("dueDate");

-- CreateIndex
CREATE INDEX "ImpersonationLog_platformUserId_idx" ON "ImpersonationLog"("platformUserId");

-- CreateIndex
CREATE INDEX "ImpersonationLog_organizationId_idx" ON "ImpersonationLog"("organizationId");

-- CreateIndex
CREATE INDEX "ImpersonationLog_targetUserId_idx" ON "ImpersonationLog"("targetUserId");

-- CreateIndex
CREATE INDEX "ImpersonationLog_startedAt_idx" ON "ImpersonationLog"("startedAt");

-- CreateIndex
CREATE INDEX "ErrorLog_organizationId_severity_resolved_idx" ON "ErrorLog"("organizationId", "severity", "resolved");

-- CreateIndex
CREATE INDEX "ErrorLog_createdAt_idx" ON "ErrorLog"("createdAt");

-- CreateIndex
CREATE INDEX "Organization_status_idx" ON "Organization"("status");

-- CreateIndex
CREATE INDEX "Organization_plan_idx" ON "Organization"("plan");

-- AddForeignKey
ALTER TABLE "PlatformInvoice" ADD CONSTRAINT "PlatformInvoice_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImpersonationLog" ADD CONSTRAINT "ImpersonationLog_platformUserId_fkey" FOREIGN KEY ("platformUserId") REFERENCES "PlatformUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImpersonationLog" ADD CONSTRAINT "ImpersonationLog_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImpersonationLog" ADD CONSTRAINT "ImpersonationLog_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ErrorLog" ADD CONSTRAINT "ErrorLog_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

