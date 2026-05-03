-- CreateTable
CREATE TABLE "ClosedAccountingPeriod" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "month" INTEGER NOT NULL,
    "year" INTEGER NOT NULL,
    "closedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedById" TEXT,
    "summary" JSONB,

    CONSTRAINT "ClosedAccountingPeriod_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClosedAccountingPeriod_organizationId_idx" ON "ClosedAccountingPeriod"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "ClosedAccountingPeriod_organizationId_year_month_key" ON "ClosedAccountingPeriod"("organizationId", "year", "month");

-- AddForeignKey
ALTER TABLE "ClosedAccountingPeriod" ADD CONSTRAINT "ClosedAccountingPeriod_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClosedAccountingPeriod" ADD CONSTRAINT "ClosedAccountingPeriod_closedById_fkey" FOREIGN KEY ("closedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
