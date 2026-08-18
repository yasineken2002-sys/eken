-- Ämneskoppling AI-rad → hyresgäst (#510).
--
-- STRIKT ADDITIV: två nya tabeller, inga ändringar av befintliga tabeller,
-- ingen backfill, ingen NOT NULL på något som redan finns, ingen DROP.
-- Befintliga rader påverkas inte alls — de får helt enkelt inga kopplingar.

-- CreateTable
CREATE TABLE "AiMessageTenant" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'tool',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiMessageTenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiMemoryTenant" (
    "id" TEXT NOT NULL,
    "memoryId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'tool',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiMemoryTenant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiMessageTenant_tenantId_idx" ON "AiMessageTenant"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "AiMessageTenant_messageId_tenantId_key" ON "AiMessageTenant"("messageId", "tenantId");

-- CreateIndex
CREATE INDEX "AiMemoryTenant_tenantId_idx" ON "AiMemoryTenant"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "AiMemoryTenant_memoryId_tenantId_key" ON "AiMemoryTenant"("memoryId", "tenantId");

-- AddForeignKey
ALTER TABLE "AiMessageTenant" ADD CONSTRAINT "AiMessageTenant_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "AiMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiMessageTenant" ADD CONSTRAINT "AiMessageTenant_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiMemoryTenant" ADD CONSTRAINT "AiMemoryTenant_memoryId_fkey" FOREIGN KEY ("memoryId") REFERENCES "AiMemory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiMemoryTenant" ADD CONSTRAINT "AiMemoryTenant_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
