-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "morningReportEnabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "AiMemory" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiMemory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiMemory_organizationId_userId_idx" ON "AiMemory"("organizationId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "AiMemory_organizationId_userId_key_key" ON "AiMemory"("organizationId", "userId", "key");

-- AddForeignKey
ALTER TABLE "AiMemory" ADD CONSTRAINT "AiMemory_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiMemory" ADD CONSTRAINT "AiMemory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
